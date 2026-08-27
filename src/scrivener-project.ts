/**
 * Scrivener Project class using modular services
 */

import * as path from 'path';
import { ContentAnalyzer, ContextAnalyzer } from './analysis/index.js';
import { DOCUMENT_TYPES } from './core/constants.js';
import { createError, ErrorCode } from './core/errors.js';
import { getLogger } from './core/logger.js';
import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';
import { DatabaseService } from './handlers/database/index.js';
import { ContextSyncService, type SyncStatus } from './sync/context-sync.js';
import { CleanupManager, safeReadFile, safeWriteFile } from './utils/common.js';
import { ensureProjectDataDirectory } from './utils/project-utils.js';
import { findBinderItem, getDocumentPath } from './utils/scrivener-utils.js';

// Import service modules
import { CompilationService, type StructuredEntry } from './services/compilation-service.js';
import { documentIndexer, type SearchResult } from './services/document-indexer.js';
import { DocumentManager } from './services/document-manager.js';
import { MetadataManager } from './services/metadata-manager.js';
import { ProjectLoader } from './services/project-loader.js';
import { exportBinary, type ExportSection } from './services/export/manuscript-exporters.js';
import { buildCompileMetadata, type CompileMetadata } from './services/compile-settings.js';
import {
	listAllSnapshots,
	listDocumentSnapshots,
	findSnapshot,
	createSnapshot,
	type SnapshotEntry,
} from './services/snapshots.js';
import { RTFHandler } from './services/parsers/rtf-handler.js';
import { spliceRtfText, describeReplacedConstructs } from './services/parsers/rtf-splice.js';
import { getAccurateWordCount } from './utils/text-metrics.js';
import { diffParagraphs, diffWordCounts } from './utils/text-diff.js';
import { isProjectOpenInScrivener } from './utils/scrivener-app.js';
import {
	createDocument as createDocumentUtil,
	type DocumentOperationContext,
} from './utils/document-operations.js';

import type {
	ScrivenerDocument as AnalyzerDocument,
	ChapterContext,
} from './analysis/context-analyzer.js';
import type { RTFContent } from './services/parsers/rtf-handler.js';
import type {
	DocumentInfo,
	ExportOptions,
	ProjectStatistics,
	ProjectStructure,
	ScrivenerDocument,
	ScrivenerMetadata,
} from './types/index.js';

import type { HolographicMemorySystem } from './services/memory/hhm/holographic-memory-system.js';

const logger = getLogger('scrivener-project');

export interface ScrivenerProjectOptions {
	autoSave?: boolean;
	autoBackup?: boolean;
	cacheSize?: number;
	syncInterval?: number;
	scrivxPath?: string;
	hhmSystem?: HolographicMemorySystem;
}

/** A document and its snapshots, as returned by `listSnapshots`. */
export interface DocumentSnapshots {
	documentId: string;
	documentTitle?: string;
	snapshots: Array<{ snapshotId: string; title: string; date: string }>;
}

/** A single snapshot's metadata and text, as returned by `readSnapshot`. */
export interface SnapshotContent {
	documentId: string;
	snapshotId: string;
	title: string;
	date: string;
	text: string;
	wordCount: number;
}

/** A "where am I?" orientation of the manuscript, from `getManuscriptBriefing`. */
/** Outcome of a fidelity-preserving document write. */
export interface WriteFidelityReport {
	documentId: string;
	/** 'preserved': spliced, untouched RTF kept byte-for-byte. 'regenerated': rebuilt
	 *  from plain text (lossy). 'created': first write, nothing to preserve. */
	mode: 'preserved' | 'regenerated' | 'created';
	/** Id of a snapshot taken before the write when fidelity was at risk. */
	snapshotId?: string;
	/** Human-readable constructs the edit could not preserve (empty on a clean edit). */
	atRisk: string[];
}

export interface ManuscriptBriefing {
	title?: string;
	author?: string;
	words: {
		total: number;
		draftTarget?: number;
		percentToTarget?: number;
		deadline?: string;
	};
	documents: { total: number; folders: number; textDocuments: number };
	averageDocumentLength: number;
	byStatus: Record<string, number>;
	byLabel: Record<string, number>;
	longest: { id: string; title: string; wordCount: number } | null;
	shortest: { id: string; title: string; wordCount: number } | null;
}

/** A paragraph-level comparison between a snapshot and current/another snapshot. */
export interface SnapshotComparison {
	documentId: string;
	from: { snapshotId: string; title: string; date: string; wordCount: number };
	to: { snapshotId: string; wordCount: number };
	wordDelta: number;
	wordsAdded: number;
	wordsRemoved: number;
	addedParagraphs: string[];
	removedParagraphs: string[];
	unchangedParagraphs: number;
}

/** Depth-first search for a node by id in a nested binder tree. */
function findSubtree(nodes: ScrivenerDocument[], id: string): ScrivenerDocument | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		if (node.children?.length) {
			const found = findSubtree(node.children, id);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Find the Draft/Manuscript folder (BinderItem Type "DraftFolder") — the root of
 * the compilable manuscript. Returns undefined when the project has none (rare;
 * some templates rename or omit it), so callers can fall back to the whole binder.
 */
function findDraftFolder(nodes: ScrivenerDocument[]): ScrivenerDocument | undefined {
	for (const node of nodes) {
		if ((node.type as string) === 'DraftFolder') return node;
		if (node.children?.length) {
			const found = findDraftFolder(node.children);
			if (found) return found;
		}
	}
	return undefined;
}

export class ScrivenerProject {
	private projectPath: string;
	private documentManager: DocumentManager;
	private projectLoader: ProjectLoader;
	private compilationService: CompilationService;
	private metadataManager: MetadataManager;
	private databaseService: DatabaseService;
	private contentAnalyzer: ContentAnalyzer;
	private contextAnalyzer?: ContextAnalyzer;
	private contextSync?: ContextSyncService;
	private cleanupManager: CleanupManager;
	private options: ScrivenerProjectOptions;
	private indexInitialized = false;
	private hhmSystem?: HolographicMemorySystem;
	/** Short-lived cache of the "open in Scrivener" probe, to avoid spawning an
	 * osascript per write in a batch. */
	private openStateCache?: { state: 'open' | 'closed' | 'unknown'; expiresAt: number };

	constructor(projectPath: string, options: ScrivenerProjectOptions = {}) {
		this.projectPath = path.resolve(projectPath);
		this.options = {
			autoSave: false,
			autoBackup: false,
			cacheSize: 50,
			syncInterval: 30000,
			...options,
		};
		this.hhmSystem = options.hhmSystem;

		// Initialize services
		this.documentManager = new DocumentManager(this.projectPath);
		this.projectLoader = new ProjectLoader(this.projectPath, {
			autoBackup: this.options.autoBackup,
			scrivxPath: this.options.scrivxPath,
		});
		this.compilationService = new CompilationService();
		this.metadataManager = new MetadataManager();
		this.databaseService = new DatabaseService(this.projectPath);
		this.contentAnalyzer = new ContentAnalyzer();
		this.cleanupManager = new CleanupManager();

		// Register cleanup
		this.cleanupManager.register(async () => {
			await this.close();
		});
	}

	/**
	 * Load the project
	 */
	async loadProject(): Promise<void> {
		logger.info('Loading Scrivener project');

		// Create .scrivener-mcp directory for project-specific data
		await ensureProjectDataDirectory(this.projectPath);

		// Load project structure
		const structure = await this.projectLoader.loadProject();
		this.documentManager.setProjectStructure(structure);

		// Initialize document indexer
		const documents = await this.getAllDocuments();
		await documentIndexer.buildIndex(documents);
		this.indexInitialized = true;
		logger.info('Document index built');

		// Initialize database
		await this.databaseService.initialize();

		// Initialize async services (job queue, AI services)
		await initializeAsyncServices({
			projectPath: this.projectPath,
			databasePath: path.join(this.projectPath, 'scrivener.db'),
			openaiApiKey: process.env.OPENAI_API_KEY,
		});

		// Initialize enhanced services
		this.contextAnalyzer = new ContextAnalyzer(this.databaseService, this.contentAnalyzer);

		this.contextSync = new ContextSyncService(
			this.projectPath,
			this.databaseService,
			this.contextAnalyzer,
			{
				autoSync: true,
				syncInterval: this.options.syncInterval || 30000,
				contextFileFormat: 'both',
				includeAnalysis: true,
				includeRelationships: true,
			}
		);

		// Perform initial sync
		await this.performInitialSync();
		logger.info('Project loaded successfully');
	}

	/**
	 * Save the project
	 */
	async saveProject(): Promise<void> {
		const structure = this.projectLoader.getProjectStructure();
		await this.projectLoader.saveProject(structure);
	}

	/**
	 * Get project structure
	 */
	async getProjectStructure(includeTrash = false): Promise<ScrivenerDocument[]> {
		return await this.documentManager.getProjectStructure(includeTrash);
	}

	/**
	 * Get all documents
	 */
	async getAllDocuments(includeTrash = false): Promise<ScrivenerDocument[]> {
		return await this.documentManager.getAllDocuments(includeTrash);
	}

	async getDocumentsUnderFolder(folderId: string): Promise<ScrivenerDocument[]> {
		return await this.documentManager.getDocumentsUnderFolder(folderId);
	}

	// Document operations
	async readDocument(documentId: string): Promise<string> {
		return await this.documentManager.readDocument(documentId);
	}

	async readDocumentFormatted(documentId: string): Promise<RTFContent> {
		return await this.documentManager.readDocumentFormatted(documentId);
	}

	/**
	 * Guard against writing while the project is open in Scrivener. Scrivener
	 * holds the manuscript in memory and rewrites it on save, so an external edit
	 * to a live project can be silently clobbered. Throws when the project is
	 * detected open and `force` is false; allows the write when detection is
	 * unavailable or ambiguous (never a false positive). The probe result is
	 * cached briefly so a batch of writes spawns at most one detection call.
	 */
	async ensureWritable(force = false): Promise<void> {
		if (force) return;
		const now = Date.now();
		if (!this.openStateCache || this.openStateCache.expiresAt <= now) {
			const state = await isProjectOpenInScrivener(this.projectPath);
			this.openStateCache = { state, expiresAt: now + 5000 };
		}
		if (this.openStateCache.state === 'open') {
			throw createError(
				ErrorCode.INVALID_STATE,
				{ projectPath: this.projectPath },
				'This project is currently open in Scrivener. Editing it now risks your changes ' +
					'being overwritten when Scrivener next saves. Close the project in Scrivener, ' +
					'or pass force: true to write anyway.'
			);
		}
	}

	async writeDocument(documentId: string, content: string | RTFContent): Promise<void> {
		// Immediate: a single explicit document write must be durable and visible
		// to a subsequent read. The batched/queued path only reaches disk on a 5s
		// timer, a full queue, or close(), which breaks read-your-own-write.
		await this.documentManager.writeDocument(documentId, content, true);
		this.markDocumentChanged(documentId);

		// Update HHM if available
		if (this.hhmSystem) {
			try {
				const doc = await this.getDocumentInfo(documentId);
				if (doc.document) {
					// Ensure we have plain text content
					let plainText = '';
					if (typeof content === 'string') {
						plainText = content;
					} else {
						plainText = content.plainText;
					}

					// Update document object with new content
					const updatedDoc = { ...doc.document, content: plainText };
					await this.hhmSystem.memorizeDocument(updatedDoc);
				}
			} catch (error) {
				logger.warn('Failed to update HHM memory for document', { documentId, error });
			}
		}
	}

	/**
	 * Replace a document's text while preserving all Scrivener RTF the edit did not
	 * touch (stylesheet, style refs, images, footnotes, `\Scrv_` groups). Splices the
	 * changed span into the original raw RTF and commits ONLY if re-parsing the result
	 * yields exactly the intended text; otherwise it snapshots and falls back to a full
	 * regenerate. When the changed span dropped non-round-trippable content it also
	 * snapshots first, so the writer always has a native rollback point. Returns a
	 * report of what happened.
	 */
	async writeDocumentPreserving(
		documentId: string,
		newText: string
	): Promise<WriteFidelityReport> {
		const oldRaw = await this.documentManager.readDocumentRaw(documentId);

		// New/empty document: nothing to preserve or lose — write plainly.
		if (!oldRaw) {
			await this.writeDocument(documentId, newText);
			return { documentId, mode: 'created', atRisk: [] };
		}

		const rtf = new RTFHandler();
		const canonical = (await rtf.parseRTF(oldRaw)).plainText.trim();
		const intended = newText.trim();
		const splice = spliceRtfText(oldRaw, canonical, intended);

		// Commit the splice only if the result provably reads back as the intended
		// text — this gate makes a scanner imperfection a fallback, never a corruption.
		if (splice) {
			const roundTrip = (await rtf.parseRTF(splice.rtf)).plainText.trim();
			if (roundTrip === intended) {
				const atRisk = describeReplacedConstructs(splice.replacedRaw);
				let snapshotId: string | undefined;
				if (atRisk.length > 0) {
					snapshotId = (await this.takeSnapshot(documentId, 'Before AI edit')).snapshotId;
				}
				await this.documentManager.writeRawContent(documentId, splice.rtf);
				this.markDocumentChanged(documentId);
				return { documentId, mode: 'preserved', snapshotId, atRisk };
			}
		}

		// Fallback: cannot safely splice. Snapshot first (native rollback), then
		// regenerate from plain text — which drops formatting/annotations/images.
		const snapshotId = (await this.takeSnapshot(documentId, 'Before AI edit')).snapshotId;
		await this.writeDocument(documentId, newText);
		return {
			documentId,
			mode: 'regenerated',
			snapshotId,
			atRisk: ['formatting, styles, images, footnotes, and annotations were not preserved'],
		};
	}

	async createDocument(
		title: string,
		content = '',
		parentId?: string,
		type: 'Text' | 'Folder' = DOCUMENT_TYPES.TEXT
	): Promise<string> {
		// Use unified document creation utility with transaction support
		const context: DocumentOperationContext = {
			projectStructure: this.documentManager.getProjectStructureData(),
			projectPath: this.projectPath,
			writeDocument: (id, content) => this.documentManager.writeDocument(id, content),
			saveProject: () => this.saveProject(),
		};

		const result = await createDocumentUtil({ title, content, parentId, type }, context);

		// Add to HHM if available
		if (this.hhmSystem && result.id) {
			try {
				const doc = await this.getDocumentInfo(result.id);
				if (doc.document) {
					const docWithContent = { ...doc.document, content };
					await this.hhmSystem.memorizeDocument(docWithContent);
				}
			} catch (error) {
				logger.warn('Failed to add new document to HHM', { documentId: result.id, error });
			}
		}

		return result.id;
	}

	async deleteDocument(documentId: string): Promise<void> {
		await this.documentManager.deleteDocument(documentId);
		await this.saveProject();
	}

	async renameDocument(documentId: string, newTitle: string): Promise<void> {
		await this.documentManager.renameDocument(documentId, newTitle);
		await this.saveProject();
	}

	async moveDocument(
		documentId: string,
		newParentId: string | null,
		_position?: number
	): Promise<void> {
		await this.documentManager.moveDocument(documentId, newParentId);
		await this.saveProject();
	}

	async getWordCount(documentId?: string): Promise<{ words: number; characters: number }> {
		return await this.documentManager.getWordCount(documentId);
	}

	async getTotalWordCount(): Promise<number> {
		const count = await this.documentManager.getWordCount();
		return count.words;
	}

	// Compilation operations
	async compileDocuments(
		documentIds: string[],
		separator = '\n\n---\n\n',
		outputFormat: 'text' | 'markdown' | 'html' | 'latex' | 'json' = 'text'
	): Promise<string | object> {
		const documents = [];
		for (const id of documentIds) {
			try {
				const content = await this.documentManager.readDocumentFormatted(id);
				const doc = await this.getDocumentInfo(id);
				documents.push({
					id,
					content,
					title: doc.document?.title || 'Untitled',
				});
			} catch (error) {
				logger.warn(`Failed to read document ${id}:`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return await this.compilationService.compileDocuments(documents, {
			separator,
			outputFormat,
		});
	}

	/**
	 * Deterministically compile the binder into a structured manuscript, applying
	 * the binder hierarchy as headings and a scene separator between sibling
	 * documents. Needs no AI/API key. Optionally scoped to a folder's descendants.
	 * Reflects the binder structure, not Scrivener's compile-format section layouts.
	 */
	async compileStructured(
		options: {
			rootFolderId?: string;
			outputFormat?: 'text' | 'markdown' | 'html';
			sceneSeparator?: string;
			includeTitles?: boolean;
			includeExcluded?: boolean;
			/** Apply this compile format's standard section-layout behavior (see CompilationService.compileStructured). */
			compileFormatId?: string;
		} = {}
	): Promise<string> {
		// Walk the nested binder tree so heading depth comes from actual structure,
		// not from splitting the title-joined path (titles may contain "/"). Honor
		// Scrivener's per-document "Include in Compile" flag unless includeExcluded.
		const tree = await this.documentManager.getProjectStructure();
		// Default to the Draft/Manuscript folder like Scrivener's own compile — not
		// the whole binder, which would pull in Research (images), Trash, character
		// sheets, and templates. Fall back to the whole binder only if no draft exists.
		const scope = options.rootFolderId
			? findSubtree(tree, options.rootFolderId)
			: findDraftFolder(tree);
		const roots = scope ? (scope.children ?? []) : tree;

		const entries: StructuredEntry[] = [];
		const includeExcluded = options.includeExcluded ?? false;
		const walk = async (nodes: ScrivenerDocument[], depth: number): Promise<void> => {
			for (const node of nodes) {
				// Only 'Text' items carry compilable body content; every container type
				// (Folder, DraftFolder, ResearchFolder, ...) is treated as a heading.
				const isText = node.type === DOCUMENT_TYPES.TEXT;
				const excluded = node.includeInCompile === false;
				if (isText && excluded && !includeExcluded) continue;

				let content = '';
				if (isText) {
					try {
						content = await this.readDocument(node.id);
					} catch (error) {
						logger.warn(`Structured compile: failed to read ${node.id}`, {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				entries.push({
					title: node.title,
					content,
					depth,
					isFolder: !isText,
					sectionTypeId: node.sectionTypeId,
				});
				if (node.children?.length) await walk(node.children, depth + 1);
			}
		};
		await walk(roots, 1);

		let sectionLayouts: Record<string, string> | undefined;
		if (options.compileFormatId) {
			const metadata = await this.getCompileMetadata().catch(() => null);
			sectionLayouts = metadata?.compileFormats.find(
				(f) => f.id === options.compileFormatId
			)?.sectionLayouts;
		}

		return this.compilationService.compileStructured(entries, {
			outputFormat: options.outputFormat ?? 'text',
			sceneSeparator: options.sceneSeparator ?? '',
			includeTitles: options.includeTitles ?? true,
			sectionLayouts,
		});
	}

	async searchContent(
		query: string,
		options?: {
			caseSensitive?: boolean;
			regex?: boolean;
			searchMetadata?: boolean;
			includeTrash?: boolean;
		}
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		// Use the document indexer for efficient search if available
		if (this.indexInitialized && !options?.searchMetadata) {
			const results = await documentIndexer.searchContent(query, {
				caseSensitive: options?.caseSensitive,
				regex: options?.regex,
				limit: 100,
			});

			// Update index for accessed documents
			for (const result of results.slice(0, 10)) {
				try {
					const content = await this.readDocument(result.documentId);
					await documentIndexer.updateDocumentInIndex(result.documentId, content);
				} catch (err) {
					logger.debug('Skipped document index update', {
						id: result.documentId,
						error: err,
					});
				}
			}

			return results.map((r: SearchResult) => ({
				documentId: r.documentId,
				title: r.title,
				matches: r.matches,
			}));
		}

		// Fallback to full scan for metadata search or if index not available
		const documents = await this.getAllDocuments(options?.includeTrash);
		const docsWithContent = [];

		for (const doc of documents) {
			if (doc.type === DOCUMENT_TYPES.TEXT) {
				try {
					const content = await this.readDocument(doc.id);
					const metadata: Record<string, string> = {};
					if (doc.synopsis) metadata.synopsis = doc.synopsis;
					if (doc.notes) metadata.notes = doc.notes;
					if (doc.keywords && doc.keywords.length > 0) {
						metadata.keywords = doc.keywords.join(', ');
					}

					docsWithContent.push({
						id: doc.id,
						title: doc.title,
						content,
						metadata,
					});

					// Update index while we have the content
					if (this.indexInitialized) {
						await documentIndexer.updateDocumentInIndex(doc.id, content);
					}
				} catch (err) {
					logger.debug('Skipped document during content scan', {
						id: doc.id,
						error: err,
					});
				}
			}
		}

		return this.compilationService.searchInDocuments(docsWithContent, query, options);
	}

	async exportProject(
		format: string,
		outputPath?: string,
		options?: Partial<ExportOptions>
	): Promise<unknown> {
		if (format === 'docx' || format === 'epub' || format === 'pdf') {
			const sections = await this.gatherManuscriptSections();
			const meta = await this.getProjectMetadata();
			const buffer = await exportBinary(format, sections, {
				title: meta.title || 'Untitled',
				author: meta.author,
			});
			const filePath = await this.writeExportFile(buffer, format, outputPath, meta.title);
			return {
				format,
				path: filePath,
				bytes: buffer.length,
				metadata: {
					exportDate: new Date().toISOString(),
					format,
					documentCount: sections.filter((s) => !s.isFolder).length,
				},
			};
		}

		const structure = await this.getProjectStructure();
		return await this.compilationService.exportProject(structure, format, options);
	}

	/**
	 * Walk the binder in order, reading each text document's content, to build the
	 * ordered manuscript sections the binary exporters consume.
	 */
	private async gatherManuscriptSections(): Promise<ExportSection[]> {
		const structure = await this.getProjectStructure();
		const sections: ExportSection[] = [];

		const walk = async (docs: ScrivenerDocument[], depth: number): Promise<void> => {
			for (const doc of docs) {
				const isText = doc.type === 'Text';
				let text = '';
				if (isText) {
					try {
						text = await this.readDocument(doc.id);
					} catch (error) {
						logger.warn('Skipping unreadable document during export', {
							documentId: doc.id,
							error,
						});
					}
				}
				sections.push({ title: doc.title || 'Untitled', text, depth, isFolder: !isText });
				if (doc.children && doc.children.length > 0) {
					await walk(doc.children, depth + 1);
				}
			}
		};

		await walk(structure, 0);
		return sections;
	}

	/** Resolve the output path (given, or a default in the working directory) and write the export. */
	private async writeExportFile(
		buffer: Buffer,
		ext: string,
		outputPath: string | undefined,
		title: string | undefined
	): Promise<string> {
		if (outputPath && outputPath.includes('\0')) {
			throw createError(ErrorCode.INVALID_INPUT, { outputPath }, 'Invalid output path');
		}
		const safeTitle = (title || 'manuscript').replace(/[^\w.-]+/g, '_') || 'manuscript';
		const target = outputPath
			? path.resolve(outputPath)
			: path.join(process.cwd(), `${safeTitle}.${ext}`);
		await safeWriteFile(target, buffer);
		return target;
	}

	async getStatistics(): Promise<ProjectStatistics> {
		// getAllDocuments carries neither content nor a word count, so statistics over
		// it report zero words. Read content into the tree first, then aggregate.
		const tree = await this.documentManager.getProjectStructure();
		await this.annotateWordCounts(tree);
		return this.compilationService.getStatistics(tree);
	}

	/**
	 * Read each Text node's content and set its wordCount in place, so statistics
	 * over the tree reflect real prose (the binder tree stores no counts). Content
	 * is capped per document as defense against any binary/outlier; embedded images
	 * are already stripped by the RTF handler. Unreadable documents count as zero.
	 */
	private async annotateWordCounts(nodes: ScrivenerDocument[]): Promise<void> {
		const CONTENT_CAP = 2_000_000;
		for (const node of nodes) {
			if (node.type === DOCUMENT_TYPES.TEXT) {
				try {
					const text = await this.readDocument(node.id);
					node.wordCount = getAccurateWordCount(
						text.length > CONTENT_CAP ? text.slice(0, CONTENT_CAP) : text
					);
				} catch {
					node.wordCount = 0;
				}
			}
			if (node.children?.length) await this.annotateWordCounts(node.children);
		}
	}

	/**
	 * A single "where am I?" orientation of the manuscript: total words against
	 * the project's draft target (with percent-to-goal and deadline), document and
	 * folder counts, the per-status and per-label breakdown, and the longest and
	 * shortest documents. Composes getStatistics with the project's word targets so
	 * a caller does not have to stitch several tools together after open_project.
	 */
	async getManuscriptBriefing(): Promise<ManuscriptBriefing> {
		// Scope to the Draft/Manuscript folder (like Scrivener) and count words from
		// document content (annotateWordCounts), since the binder tree stores none.
		const tree = await this.documentManager.getProjectStructure();
		const draft = findDraftFolder(tree);
		const scopeNodes = draft?.children ?? tree;
		await this.annotateWordCounts(scopeNodes);

		const stats = this.compilationService.getStatistics(scopeNodes);
		const meta = await this.getProjectMetadata();

		// Label and Status are stored on documents as taxonomy ids; resolve them to
		// human names via the compile metadata so the breakdown is readable.
		const taxonomy = await this.getCompileMetadata().catch(() => null);
		const nameById = (
			defs: Array<{ id: string; title: string }> | undefined
		): Map<string, string> => new Map((defs ?? []).map((d) => [d.id, d.title]));
		const labelNames = nameById(taxonomy?.labels);
		const statusNames = nameById(taxonomy?.statuses);
		const relabel = (counts: Record<string, number>, names: Map<string, string>) => {
			const out: Record<string, number> = {};
			for (const [key, n] of Object.entries(counts)) out[names.get(key) ?? key] = n;
			return out;
		};

		// A project with no draft target parses to NaN/undefined; treat only a finite
		// positive number as a real goal so percent-to-target isn't NaN.
		const rawTarget = meta.projectTargets?.draft;
		const draftTarget =
			typeof rawTarget === 'number' && Number.isFinite(rawTarget) && rawTarget > 0
				? rawTarget
				: undefined;
		const slim = (d: DocumentInfo | null) =>
			d ? { id: d.id, title: d.title, wordCount: d.wordCount ?? 0 } : null;

		return {
			// Many projects store no ProjectTitle (Scrivener shows the .scriv filename);
			// fall back to the package basename so the briefing is never nameless.
			title: meta.title || path.basename(this.projectPath, '.scriv'),
			author: meta.author,
			words: {
				total: stats.totalWords,
				draftTarget,
				percentToTarget: draftTarget
					? Math.round((stats.totalWords / draftTarget) * 100)
					: undefined,
				deadline: meta.projectTargets?.deadline,
			},
			documents: {
				total: stats.totalDocuments,
				folders: stats.totalFolders,
				textDocuments: stats.totalDocuments - stats.totalFolders,
			},
			averageDocumentLength: stats.averageDocumentLength,
			byStatus: relabel(stats.documentsByStatus, statusNames),
			byLabel: relabel(stats.documentsByLabel, labelNames),
			longest: slim(stats.longestDocument),
			shortest: slim(stats.shortestDocument),
		};
	}

	// Metadata operations
	async updateMetadata(documentId: string, metadata: Record<string, unknown>): Promise<void> {
		const structure = this.projectLoader.getProjectStructure();
		if (!structure) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const item = this.findBinderItem(
			structure as unknown as Record<string, unknown>,
			documentId
		);
		if (!item) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		this.metadataManager.updateDocumentMetadata(item, metadata);
		await this.saveProject();
	}

	async updateDocumentMetadata(
		documentId: string,
		metadata: {
			synopsis?: string;
			notes?: string;
			label?: string;
			status?: string;
			customMetadata?: Record<string, string>;
		}
	): Promise<void> {
		await this.updateMetadata(documentId, metadata);
	}

	async updateSynopsisAndNotes(
		documentId: string,
		synopsis?: string,
		notes?: string
	): Promise<void> {
		await this.updateMetadata(documentId, { synopsis, notes });
	}

	async batchUpdateSynopsisAndNotes(
		updates: Array<{
			documentId: string;
			synopsis?: string;
			notes?: string;
		}>
	): Promise<Array<{ documentId: string; success: boolean; error?: string }>> {
		const results = [];
		for (const update of updates) {
			try {
				await this.updateSynopsisAndNotes(update.documentId, update.synopsis, update.notes);
				results.push({ documentId: update.documentId, success: true });
			} catch (error) {
				results.push({
					documentId: update.documentId,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return results;
	}

	async getProjectMetadata(): Promise<ScrivenerMetadata> {
		const structure = this.projectLoader.getProjectStructure();
		if (!structure) {
			return {};
		}
		return this.metadataManager.getProjectMetadata(structure);
	}

	/**
	 * Read Scrivener's compile-format definitions (Settings/compile.xml) and the
	 * project taxonomy (labels, statuses, collections, section types) as
	 * read-only metadata. Absent or unreadable compile.xml degrades to
	 * `hasCompileSettings: false` with taxonomy still populated from the .scrivx.
	 */
	async getCompileMetadata(): Promise<CompileMetadata> {
		const structure = this.projectLoader.getProjectStructure();
		const scrivenerProject = structure?.ScrivenerProject;

		let compileXml: string | undefined;
		try {
			compileXml = await safeReadFile(
				path.join(this.projectPath, 'Settings', 'compile.xml'),
				'utf-8'
			);
		} catch (error) {
			logger.warn('compile.xml not readable; returning taxonomy only', {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return buildCompileMetadata(scrivenerProject, compileXml);
	}

	/**
	 * List document snapshots stored in the project's `Snapshots/` directory,
	 * for one document (`documentId`) or the whole project. Read-only metadata:
	 * each entry carries the owning document's id and title, the snapshot id
	 * (used by `readSnapshot`), its recorded title, and its date. Returns an
	 * empty array when the project or document has no snapshots.
	 */
	async listSnapshots(documentId?: string): Promise<DocumentSnapshots[]> {
		const entries = documentId
			? await listDocumentSnapshots(this.projectPath, documentId)
			: await listAllSnapshots(this.projectPath);
		if (entries.length === 0) return [];

		const titles = new Map<string, string>();
		for (const doc of await this.getAllDocuments(true)) {
			titles.set(doc.id, doc.title);
		}

		const grouped = new Map<string, DocumentSnapshots>();
		for (const entry of entries) {
			let group = grouped.get(entry.documentId);
			if (!group) {
				group = {
					documentId: entry.documentId,
					documentTitle: titles.get(entry.documentId),
					snapshots: [],
				};
				grouped.set(entry.documentId, group);
			}
			group.snapshots.push({
				snapshotId: entry.snapshotId,
				title: entry.title,
				date: entry.date,
			});
		}
		return Array.from(grouped.values());
	}

	/**
	 * Read the text of a single snapshot. `snapshotId` must name an actual
	 * snapshot of `documentId` (as returned by `listSnapshots`); unknown ids
	 * throw NOT_FOUND rather than reading outside the snapshot set. Returns the
	 * snapshot's title, date, plain text, and word count.
	 */
	/**
	 * Create a Scrivener-native snapshot of a document's current content, restorable
	 * from Scrivener's own Snapshots browser. Use this before a lossy edit to give
	 * the writer a native rollback point. Requires the document to have content.
	 */
	async takeSnapshot(documentId: string, title = 'Snapshot'): Promise<SnapshotEntry> {
		return createSnapshot(this.projectPath, documentId, title, new Date());
	}

	async readSnapshot(documentId: string, snapshotId: string): Promise<SnapshotContent> {
		const found = await findSnapshot(this.projectPath, documentId, snapshotId);
		if (!found) {
			throw createError(
				ErrorCode.NOT_FOUND,
				{ documentId, snapshotId },
				`No snapshot "${snapshotId}" for document ${documentId}`
			);
		}

		const { plainText } = await new RTFHandler().readRTF(found.rtfPath);
		const text = plainText ?? '';
		return {
			documentId,
			snapshotId,
			title: found.entry.title,
			date: found.entry.date,
			text,
			wordCount: getAccurateWordCount(text),
		};
	}

	/**
	 * Compare a snapshot against the document's current text, or against another
	 * snapshot when `againstSnapshotId` is given. Returns a paragraph-level diff
	 * (added/removed paragraphs) and the net word-count change — the "what did I
	 * change since this version?" question snapshots exist to answer.
	 */
	async compareSnapshot(
		documentId: string,
		snapshotId: string,
		againstSnapshotId?: string
	): Promise<SnapshotComparison> {
		const from = await this.readSnapshot(documentId, snapshotId);

		let toLabel: string;
		let toText: string;
		let toWordCount: number;
		if (againstSnapshotId) {
			const to = await this.readSnapshot(documentId, againstSnapshotId);
			toLabel = againstSnapshotId;
			toText = to.text;
			toWordCount = to.wordCount;
		} else {
			toLabel = 'current';
			toText = await this.readDocument(documentId);
			toWordCount = getAccurateWordCount(toText);
		}

		const diff = diffParagraphs(from.text, toText);
		const words = diffWordCounts(from.text, toText);
		return {
			documentId,
			from: { snapshotId, title: from.title, date: from.date, wordCount: from.wordCount },
			to: { snapshotId: toLabel, wordCount: toWordCount },
			wordDelta: toWordCount - from.wordCount,
			wordsAdded: words.added,
			wordsRemoved: words.removed,
			addedParagraphs: diff.added,
			removedParagraphs: diff.removed,
			unchangedParagraphs: diff.unchanged,
		};
	}

	// Project management
	async refreshProject(): Promise<void> {
		this.documentManager.clearCache();
		const structure = await this.projectLoader.reloadProject();
		this.documentManager.setProjectStructure(structure);
	}

	async isProjectModified(): Promise<boolean> {
		return await this.projectLoader.isProjectModified();
	}

	clearCache(documentId?: string): void {
		this.documentManager.clearCache(documentId);
	}

	// Database and analysis
	getDatabaseService(): DatabaseService {
		return this.databaseService;
	}

	getContextAnalyzer(): ContextAnalyzer | undefined {
		return this.contextAnalyzer;
	}

	getContextSync(): ContextSyncService | undefined {
		return this.contextSync;
	}

	async analyzeChapterEnhanced(documentId: string): Promise<ChapterContext> {
		if (!this.contextAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, 'Context analyzer not initialized');
		}

		const document = await this.getDocumentInfo(documentId);
		if (!document.document) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		const content = await this.readDocument(documentId);
		const allDocuments = await this.getAllDocuments();

		const addCharCount = (doc: ScrivenerDocument): AnalyzerDocument => ({
			id: doc.id,
			title: doc.title,
			type: doc.type,
			synopsis: doc.synopsis,
			notes: doc.notes,
			characterCount: doc.content?.length || 0,
			wordCount: doc.wordCount || 0,
			children: doc.children?.map(addCharCount),
		});
		const documentsWithCharCount = allDocuments.map(addCharCount);
		const documentWithCharCount = addCharCount(document.document);
		return (await this.contextAnalyzer.analyzeChapter(
			documentWithCharCount,
			content,
			documentsWithCharCount
		)) as ChapterContext;
	}

	async buildStoryContext(): Promise<unknown> {
		if (!this.contextAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, 'Context analyzer not initialized');
		}

		const documents = await this.getAllDocuments();
		const contexts = [];

		for (const doc of documents) {
			if (doc.type === DOCUMENT_TYPES.TEXT) {
				const context = await this.contextAnalyzer.getChapterContext(doc.id);
				if (context) {
					contexts.push(context);
				}
			}
		}

		const addCharCount = (doc: ScrivenerDocument): AnalyzerDocument => ({
			id: doc.id,
			title: doc.title,
			type: doc.type,
			synopsis: doc.synopsis,
			notes: doc.notes,
			characterCount: doc.content?.length || 0,
			wordCount: doc.wordCount || 0,
			children: doc.children?.map(addCharCount),
		});
		const documentsWithCharCount = documents.map(addCharCount);
		return await this.contextAnalyzer.buildStoryContext(documentsWithCharCount, contexts);
	}

	getSyncStatus(): SyncStatus | { enabled: false; message: string } {
		if (!this.contextSync) {
			return {
				enabled: false,
				message: 'Context sync not initialized',
			};
		}
		return this.contextSync.getSyncStatus();
	}

	markDocumentChanged(documentId: string): void {
		// Track in document indexer for efficient syncing
		if (this.indexInitialized) {
			documentIndexer.markDocumentChanged(documentId);
		}

		// Also track in context sync if available
		if (this.contextSync) {
			this.contextSync.markDocumentChanged(documentId);
		}
	}

	async exportContextFiles(exportPath: string): Promise<void> {
		if (!this.contextSync) {
			throw createError(ErrorCode.INVALID_STATE, 'Context sync not initialized');
		}
		await this.contextSync.exportContextFiles(exportPath);
	}

	// Additional methods
	async getDocumentInfo(documentId: string): Promise<{
		document: ScrivenerDocument | null;
		path: Array<{ id: string; title: string; type: string }>;
		metadata: Record<string, string>;
		location: 'active' | 'trash' | 'unknown';
	}> {
		// Use document indexer for O(1) lookup if available
		if (this.indexInitialized) {
			const docInfo = documentIndexer.getDocumentInfo(documentId);
			if (docInfo) {
				const metadata: Record<string, string> = {};
				if (docInfo.document.synopsis) metadata.synopsis = docInfo.document.synopsis;
				if (docInfo.document.notes) metadata.notes = docInfo.document.notes;
				if (docInfo.document.keywords && docInfo.document.keywords.length > 0) {
					metadata.keywords = docInfo.document.keywords.join(', ');
				}
				if (docInfo.document.status) metadata.status = docInfo.document.status;
				if (docInfo.document.label) metadata.label = docInfo.document.label;

				return {
					document: docInfo.document,
					path: docInfo.path,
					metadata,
					location: docInfo.location,
				};
			}
		}

		// Fallback to tree search if index not available or document not found
		const structure = await this.getProjectStructure(true);
		let foundDoc: ScrivenerDocument | null = null;
		let path: Array<{ id: string; title: string; type: string }> = [];
		let location: 'active' | 'trash' | 'unknown' = 'unknown';

		const searchInDocs = (
			docs: ScrivenerDocument[],
			currentPath: Array<{ id: string; title: string; type: string }>
		): boolean => {
			for (const doc of docs) {
				const newPath = [...currentPath, { id: doc.id, title: doc.title, type: doc.type }];

				if (doc.id === documentId) {
					foundDoc = doc;
					path = newPath;
					return true;
				}

				if (doc.children && searchInDocs(doc.children, newPath)) {
					return true;
				}
			}
			return false;
		};

		if (searchInDocs(structure, [])) {
			location = 'active';
		}

		const metadata: Record<string, string> = {};
		if (foundDoc) {
			const doc = foundDoc as ScrivenerDocument;
			if (doc.synopsis) metadata.synopsis = doc.synopsis;
			if (doc.notes) metadata.notes = doc.notes;
			if (doc.label) metadata.label = doc.label;
			if (doc.status) metadata.status = doc.status;
			if (doc.keywords && doc.keywords.length > 0) {
				metadata.keywords = doc.keywords.join(', ');
			}
			if (doc.includeInCompile !== undefined) {
				metadata.includeInCompile = doc.includeInCompile ? 'true' : 'false';
			}

			if (doc.customMetadata) {
				Object.assign(metadata, doc.customMetadata);
			}
		}

		return { document: foundDoc, path, metadata, location };
	}

	async getTrashDocuments(): Promise<ScrivenerDocument[]> {
		const allDocs = await this.getProjectStructure(true);
		const trashDocs: ScrivenerDocument[] = [];

		// Find trash folder
		for (const doc of allDocs) {
			if (doc.path && doc.path.startsWith('Trash/')) {
				trashDocs.push(doc);
			}
		}

		return trashDocs;
	}

	async searchTrash(
		query: string,
		options?: { caseSensitive?: boolean; regex?: boolean }
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		const trashDocs = await this.getTrashDocuments();
		const docsWithContent = [];

		for (const doc of trashDocs) {
			if (doc.type === DOCUMENT_TYPES.TEXT) {
				try {
					const content = await this.readDocument(doc.id);
					docsWithContent.push({
						id: doc.id,
						title: `[TRASH] ${doc.title}`,
						content,
						metadata: {},
					});
				} catch (err) {
					logger.debug('Skipped trash document during scan', { id: doc.id, error: err });
				}
			}
		}

		return this.compilationService.searchInDocuments(docsWithContent, query, options);
	}

	async recoverFromTrash(documentId: string, targetParentId?: string): Promise<void> {
		await this.documentManager.recoverFromTrash(documentId, targetParentId);
		await this.saveProject();
	}

	async getProjectStructureLimited(options?: {
		maxDepth?: number;
		folderId?: string;
		includeTrash?: boolean;
		summaryOnly?: boolean;
	}): Promise<ProjectStructure> {
		const structure = await this.getProjectStructure(options?.includeTrash);

		// Convert ScrivenerDocument[] to ProjectStructure format. Root is a synthetic
		// wrapper over every top-level item, not just structure[0] — otherwise the
		// binder collapses to its first entry.
		const root = {
			id: 'root',
			title: 'Project Root',
			type: 'Folder' as const,
			path: '',
			children: structure,
		};

		const convertToDocumentInfo = (doc: ScrivenerDocument): DocumentInfo => ({
			...doc,
			path: typeof doc.path === 'string' ? doc.path.split('/') : doc.path,
			children: doc.children ? doc.children.map(convertToDocumentInfo) : undefined,
		});

		const draft = structure.find((doc) => doc.title === 'Manuscript' || doc.title === 'Draft');
		const research = structure.find((doc) => doc.title === 'Research');
		const trash = options?.includeTrash
			? structure.find((doc) => doc.title === 'Trash')
			: undefined;

		return {
			root: convertToDocumentInfo(root),
			draft: draft ? convertToDocumentInfo(draft) : undefined,
			research: research ? convertToDocumentInfo(research) : undefined,
			trash: trash ? convertToDocumentInfo(trash) : undefined,
			templates: [],
		};
	}

	async getDocumentAnnotations(documentId: string): Promise<Map<string, string>> {
		try {
			// Get the raw RTF content for the document
			const rtfContent = await this.documentManager.readDocumentRaw(documentId);

			// Extract annotations using the RTF handler
			return this.compilationService.extractAnnotations(rtfContent);
		} catch (error) {
			logger.warn(`Failed to extract annotations for document ${documentId}`, { error });
			return new Map<string, string>();
		}
	}

	// Compatibility aliases for handlers
	async getDocument(documentId: string): Promise<ScrivenerDocument> {
		const info = await this.getDocumentInfo(documentId);
		const doc = await this.readDocument(documentId);

		if (!info.document) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		return {
			...info.document,
			content: doc || '',
		};
	}

	async getStructure(options?: {
		includeContent?: boolean;
		maxDepth?: number;
	}): Promise<ProjectStructure> {
		return this.getProjectStructureLimited(options);
	}

	get metadata(): ScrivenerMetadata {
		return {
			draftFolder: 'draft', // Default draft folder ID
		};
	}

	get title(): string {
		return this.metadataManager?.getProjectTitle() || 'Untitled Project';
	}

	get structure(): Promise<ProjectStructure> {
		// Alias for getStructure
		return this.getStructure();
	}

	// Private helpers
	private async performInitialSync(): Promise<void> {
		const allDocs = await this.getAllDocuments();
		const BATCH_SIZE = 50;

		const syncErrors: Array<{ docId: string; error: string }> = [];
		for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
			const batch = allDocs.slice(i, i + BATCH_SIZE);
			const results = await Promise.allSettled(
				batch.map((doc) => this.syncDocumentToDatabase(doc))
			);
			for (let j = 0; j < results.length; j++) {
				const result = results[j];
				if (result.status === 'rejected') {
					syncErrors.push({
						docId: batch[j].id,
						error:
							result.reason instanceof Error
								? result.reason.message
								: String(result.reason),
					});
				}
			}
			logger.debug(
				`Synced ${Math.min(i + BATCH_SIZE, allDocs.length)}/${allDocs.length} documents`
			);
		}
		if (syncErrors.length > 0) {
			logger.error(`Database sync completed with ${syncErrors.length} error(s)`, {
				syncErrors,
			});
		}
	}

	private async syncDocumentToDatabase(doc: ScrivenerDocument): Promise<void> {
		try {
			let wordCount = 0;
			let characterCount = 0;

			if (doc.type === DOCUMENT_TYPES.TEXT) {
				try {
					const content = await this.readDocument(doc.id);
					const words = content
						.trim()
						.split(/\s+/)
						.filter((w) => w.length > 0);
					wordCount = words.length;
					characterCount = content.length;
				} catch (err) {
					logger.debug('Document has no readable content', { id: doc.id, error: err });
				}
			}

			await this.databaseService.syncDocumentData({
				id: doc.id,
				title: doc.title,
				type: doc.type,
				path: getDocumentPath(this.projectPath, doc.id),
				synopsis: doc.synopsis,
				notes: doc.notes,
				wordCount,
				characterCount,
			});
		} catch (error) {
			logger.error(`Failed to sync document ${doc.id}:`, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	private findBinderItem(
		structure: Record<string, unknown>,
		documentId: string
	): Record<string, unknown> | null {
		const scrivenerProject = structure.ScrivenerProject as Record<string, unknown> | undefined;
		if (!scrivenerProject?.Binder) return null;

		const binder = scrivenerProject.Binder;
		const found = findBinderItem(binder, documentId);
		return found as Record<string, unknown> | null;
	}

	// Cleanup
	async close(): Promise<void> {
		logger.info('Closing Scrivener project');

		// Flush any pending changes in the indexer
		if (this.indexInitialized) {
			await documentIndexer.flushChanges();
			documentIndexer.dispose();
			this.indexInitialized = false;
		}

		if (this.contextSync) {
			this.contextSync.close();
		}

		// Shutdown async services (job queue, AI services)
		await shutdownAsyncServices();

		await this.databaseService.close();
		await this.documentManager.close();

		logger.info('Project closed');
	}
}
