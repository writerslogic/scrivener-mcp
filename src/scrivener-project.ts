/**
 * Scrivener Project class using modular services
 */

import * as path from 'path';
import { homedir } from 'node:os';
import { ContentAnalyzer, ContextAnalyzer } from './analysis/index.js';
import { DOCUMENT_TYPES } from './core/constants.js';

import { createError, ErrorCode } from './core/errors.js';

import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';
import { DatabaseService } from './handlers/database/index.js';
import { ContextSyncService, type SyncStatus } from './sync/context-sync.js';
import { CleanupManager, safeReadFile } from './utils/common.js';
import type {
	ScrivenerProjectOptions,
	DocumentSnapshots,
	SnapshotContent,
	WriteFidelityReport,
	ManuscriptBriefing,
	SnapshotComparison,
} from './project-types.js';

import { ensureProjectDataDirectory } from './utils/project-utils.js';

// Import service modules
import { CompilationService } from './services/compilation-service.js';
import { documentIndexer } from './services/document-indexer.js';
import { DocumentManager } from './services/document-manager.js';
import { MetadataManager } from './services/metadata-manager.js';

import { buildCompileMetadata, type CompileMetadata } from './services/compile-settings.js';
import type { SnapshotEntry } from './services/snapshots.js';

import type { ChapterContext } from './analysis/context-analyzer.js';
import type { RTFContent } from './services/parsers/rtf-handler.js';
import type {
	ExportOptions,
	ProjectStatistics,
	ProjectStructure,
	ScrivenerDocument,
	ScrivenerMetadata,
} from './types/index.js';

import type { HolographicMemorySystem } from './services/memory/hhm/holographic-memory-system.js';

import { getLogger } from './core/logger.js';
import { ProjectLoader } from './services/project-loader.js';
import { ProjectSnapshots } from './services/project-snapshots.js';
import { ProjectReports } from './services/project-reports.js';
import { ProjectExporter } from './services/project-exporter.js';
import { ProjectMetadataEditor } from './services/project-metadata-editor.js';
import { ProjectContent } from './services/project-content.js';
import { ProjectContextBridge } from './services/project-context-bridge.js';
import { ProjectTrash } from './services/project-trash.js';
import { ProjectWriter } from './services/project-writer.js';
import { ProjectDocumentInfo } from './services/project-document-info.js';
import type { WriteOptions } from './services/project-writer.js';
import { PersistentStore } from './services/editorial/persistent-store.js';
import { ProjectSource } from './services/editorial/project-source.js';
import {
	manuscriptDocuments,
	registerProject,
	resolveRegisteredProject,
} from './services/editorial/project-registry.js';
import { ReviewService } from './services/editorial/review-service.js';
import { SeriesBible } from './services/editorial/series-bible.js';
import { ContinuityService } from './services/editorial/continuity-service.js';
import { PassageSearch } from './services/editorial/passage-search.js';
import { WorkflowService } from './services/editorial/workflow-service.js';
import type { PresetOptions } from './services/export/export-presets.js';

export interface EditorialServices {
	source: ProjectSource;
	store: PersistentStore;
	seriesStore: PersistentStore;
	review: ReviewService;
	bible: SeriesBible;
	continuity: ContinuityService;
	search: PassageSearch;
	workflows: WorkflowService;
}

const logger = getLogger('scrivener-project');

export type {
	ScrivenerProjectOptions,
	DocumentSnapshots,
	SnapshotContent,
	WriteFidelityReport,
	ManuscriptBriefing,
	SnapshotComparison,
} from './project-types.js';

export class ScrivenerProject {
	private editorial?: EditorialServices;
	private savedRefresh?: Promise<void>;
	private documentInfo: ProjectDocumentInfo;
	private writer: ProjectWriter;
	private trash: ProjectTrash;
	private contextBridge: ProjectContextBridge;
	private content: ProjectContent;
	private metadataEditor: ProjectMetadataEditor;
	private exporter: ProjectExporter;
	private reports: ProjectReports;
	private snapshots: ProjectSnapshots;
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

		this.snapshots = new ProjectSnapshots(
			this.projectPath,
			(includeTrash) => this.getAllDocuments(includeTrash),
			(documentId) => this.readDocument(documentId)
		);

		this.reports = new ProjectReports(
			this.projectPath,
			this.documentManager,
			this.compilationService,
			(documentId) => this.readDocument(documentId),
			() => this.getProjectMetadata(),
			() => this.getCompileMetadata()
		);

		this.exporter = new ProjectExporter(
			this.compilationService,
			() => this.getProjectStructure(),
			() => this.getProjectMetadata(),
			(documentId) => this.readDocument(documentId),
			this.projectPath,
			(documentId) => this.documentManager.readDocumentRaw(documentId),
			() => this.getCompileMetadata()
		);

		this.metadataEditor = new ProjectMetadataEditor(
			this.projectPath,
			this.projectLoader,
			this.metadataManager,
			() => this.saveProject(),
			() => this.indexInitialized
		);

		this.content = new ProjectContent(
			this.documentManager,
			this.compilationService,
			(documentId) => this.readDocument(documentId),
			(includeTrash) => this.getAllDocuments(includeTrash),
			(documentId) => this.getDocumentInfo(documentId),
			() => this.getCompileMetadata(),
			() => this.indexInitialized
		);

		this.contextBridge = new ProjectContextBridge(
			this.projectPath,
			this.databaseService,
			() => this.contextSync,
			() => this.contextAnalyzer,
			(includeTrash) => this.getAllDocuments(includeTrash),
			(documentId) => this.readDocument(documentId),
			(documentId) => this.getDocumentInfo(documentId),
			() => this.indexInitialized
		);

		this.trash = new ProjectTrash(
			this.documentManager,
			this.compilationService,
			() => this.saveProject(),
			(documentId) => this.readDocument(documentId),
			(includeTrash) => this.getProjectStructure(includeTrash)
		);

		this.writer = new ProjectWriter(
			this.projectPath,
			this.documentManager,
			this.hhmSystem,
			() => this.saveProject(),
			(documentId) => this.markDocumentChanged(documentId),
			(documentId) => this.getDocumentInfo(documentId),
			(documentId, title) => this.takeSnapshot(documentId, title)
		);

		this.documentInfo = new ProjectDocumentInfo(
			this.documentManager,
			this.compilationService,
			(includeTrash) => this.getProjectStructure(includeTrash),
			() => this.indexInitialized
		);
	}

	/**
	 * Load the project
	 */
	async loadProject(): Promise<void> {
		logger.info('Loading Scrivener project');
		this.documentManager
			.getMutationCoordinator()
			.assertProjectPath(path.join(this.projectPath, '.scrivener-mcp'));

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
		await this.refreshSavedStructure();
		return await this.documentManager.getProjectStructure(includeTrash);
	}

	/**
	 * Get all documents
	 */
	async getAllDocuments(includeTrash = false): Promise<ScrivenerDocument[]> {
		await this.refreshSavedStructure();
		return await this.documentManager.getAllDocuments(includeTrash);
	}

	async getDocumentsUnderFolder(folderId: string): Promise<ScrivenerDocument[]> {
		await this.refreshSavedStructure();
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
		return this.writer.ensureWritable(force);
	}

	async writeDocument(
		documentId: string,
		content: string | RTFContent,
		options: WriteOptions = {}
	): Promise<void> {
		return this.writer.writeDocument(documentId, content, options);
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
		newText: string,
		options: WriteOptions = {}
	): Promise<WriteFidelityReport> {
		return this.writer.writeDocumentPreserving(documentId, newText, options);
	}

	async readDocumentVersion(documentId: string): Promise<{ text: string; revision: string }> {
		return this.documentManager.readDocumentVersion(documentId);
	}

	getEditorialServices(): EditorialServices {
		if (this.editorial) return this.editorial;
		this.documentManager
			.getMutationCoordinator()
			.assertProjectPath(path.join(this.projectPath, '.scrivener-mcp', 'editorial.sqlite'));
		const store = new PersistentStore(
			path.join(this.projectPath, '.scrivener-mcp', 'editorial.sqlite')
		);
		const seriesStore = new PersistentStore(
			path.join(
				process.env.SCRIVENER_DATA_DIR || path.join(homedir(), '.scrivener-mcp'),
				'series.sqlite'
			)
		);
		try {
			const source = new ProjectSource(
				this.projectPath,
				store,
				async () => {
					if (await this.isProjectModified()) await this.refreshProject();
					return manuscriptDocuments(await this.getProjectStructure());
				},
				(id) => this.documentManager.readDocumentRaw(id),
				() => this.getAllDocuments()
			);
			registerProject(seriesStore, source);
			const review = new ReviewService(
				this.projectPath,
				this.documentManager,
				this.writer,
				store,
				async (id) => {
					const document = (await this.getAllDocuments()).find(
						(item) => item.id === id && item.type === 'Text'
					);
					if (!document)
						throw new Error(
							'Review target is not an active text document in the selected project'
						);
				}
			);
			const bible = new SeriesBible(source, store, seriesStore, (id) =>
				id === source.projectId
					? Promise.resolve(source)
					: resolveRegisteredProject(seriesStore, id)
			);
			const continuity = new ContinuityService(source, store, bible);
			const search = new PassageSearch(source, store);
			const workflows = new WorkflowService(source, store, search, {
				propose: (input) => review.propose(input),
				auditContinuity: (input) => continuity.analyze(input),
				exportBeta: async ({ documentIds, outputPath, allowWarnings }) => {
					const options = { preset: 'beta-reader' as const, documentIds, allowWarnings };
					const preflight = await this.exporter.preflight(options);
					if (!preflight.ready)
						throw new Error(
							`Beta-reader export preflight: ${preflight.findings.map((finding) => finding.message).join(' ')} Review these findings before resuming with allowExportWarnings: true.`
						);
					return this.exporter.exportPreset(options, outputPath);
				},
			});
			this.editorial = {
				source,
				store,
				seriesStore,
				review,
				bible,
				continuity,
				search,
				workflows,
			};
			return this.editorial;
		} catch (error) {
			seriesStore.close();
			store.close();
			throw error;
		}
	}

	async preflightExport(options: PresetOptions) {
		return this.exporter.preflight(options);
	}

	async exportManuscript(options: PresetOptions, outputPath?: string) {
		return this.exporter.exportPreset(options, outputPath);
	}

	async createDocument(
		title: string,
		content = '',
		parentId?: string,
		type: 'Text' | 'Folder' = DOCUMENT_TYPES.TEXT
	): Promise<string> {
		return this.writer.createDocument(title, content, parentId, type);
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
		return this.content.compileDocuments(documentIds, separator, outputFormat);
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
		return this.content.compileStructured(options);
	}

	/**
	 * The manuscript's Text documents in binder order, with content -- the same
	 * scope and ordering as compileStructured, but keeping each document's id
	 * (compileStructured's StructuredEntry drops it once headings are flattened
	 * into a single string). Used by scene-sequenced analyzers that need to
	 * attribute a finding back to a document.
	 */
	async getManuscriptDocuments(
		includeExcluded = false
	): Promise<Array<{ id: string; title: string; content: string }>> {
		return this.content.getManuscriptDocuments(includeExcluded);
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
		return this.content.searchContent(query, options);
	}

	async exportProject(
		format: string,
		outputPath?: string,
		options?: Partial<ExportOptions>
	): Promise<unknown> {
		return this.exporter.exportProject(format, outputPath, options);
	}

	async getStatistics(): Promise<ProjectStatistics> {
		return this.reports.getStatistics();
	}

	/**
	 * A single "where am I?" orientation of the manuscript: total words against
	 * the project's draft target (with percent-to-goal and deadline), document and
	 * folder counts, the per-status and per-label breakdown, and the longest and
	 * shortest documents. Composes getStatistics with the project's word targets so
	 * a caller does not have to stitch several tools together after open_project.
	 */
	async getManuscriptBriefing(): Promise<ManuscriptBriefing> {
		return this.reports.getManuscriptBriefing();
	}

	// Metadata operations
	async updateMetadata(documentId: string, metadata: Record<string, unknown>): Promise<void> {
		return this.metadataEditor.updateMetadata(documentId, metadata);
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
		return this.metadataEditor.updateDocumentMetadata(documentId, metadata);
	}

	async updateSynopsisAndNotes(
		documentId: string,
		synopsis?: string,
		notes?: string
	): Promise<void> {
		return this.metadataEditor.updateSynopsisAndNotes(documentId, synopsis, notes);
	}

	async batchUpdateSynopsisAndNotes(
		updates: Array<{
			documentId: string;
			synopsis?: string;
			notes?: string;
		}>
	): Promise<Array<{ documentId: string; success: boolean; error?: string }>> {
		return this.metadataEditor.batchUpdateSynopsisAndNotes(updates);
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
		return this.snapshots.listSnapshots(documentId);
	}

	/**
	 * Create a Scrivener-native snapshot of a document's current content, restorable
	 * from Scrivener's own Snapshots browser. Use this before a lossy edit to give
	 * the writer a native rollback point. Requires the document to have content.
	 */
	async takeSnapshot(documentId: string, title = 'Snapshot'): Promise<SnapshotEntry> {
		return this.snapshots.takeSnapshot(documentId, title);
	}

	/**
	 * Read the text of a single snapshot. `snapshotId` must name an actual
	 * snapshot of `documentId` (as returned by `listSnapshots`); unknown ids
	 * throw NOT_FOUND rather than reading outside the snapshot set. Returns the
	 * snapshot's title, date, plain text, and word count.
	 */
	async readSnapshot(documentId: string, snapshotId: string): Promise<SnapshotContent> {
		return this.snapshots.readSnapshot(documentId, snapshotId);
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
		return this.snapshots.compareSnapshot(documentId, snapshotId, againstSnapshotId);
	}

	// Project management
	async refreshProject(): Promise<void> {
		this.documentManager.clearCache();
		const structure = await this.projectLoader.reloadProject();
		this.documentManager.setProjectStructure(structure);
		if (this.indexInitialized)
			await documentIndexer.buildIndex(await this.documentManager.getAllDocuments());
	}

	private async refreshSavedStructure(): Promise<void> {
		if (!(await this.projectLoader.isProjectModified())) return;
		this.savedRefresh ??= this.refreshProject().finally(() => {
			this.savedRefresh = undefined;
		});
		await this.savedRefresh;
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
		return this.contextBridge.analyzeChapterEnhanced(documentId);
	}

	async buildStoryContext(): Promise<unknown> {
		return this.contextBridge.buildStoryContext();
	}

	getSyncStatus(): SyncStatus | { enabled: false; message: string } {
		return this.contextBridge.getSyncStatus();
	}

	markDocumentChanged(documentId: string): void {
		return this.contextBridge.markDocumentChanged(documentId);
	}

	async exportContextFiles(exportPath: string): Promise<void> {
		return this.contextBridge.exportContextFiles(exportPath);
	}

	// Additional methods
	async getDocumentInfo(documentId: string): Promise<{
		document: ScrivenerDocument | null;
		path: Array<{ id: string; title: string; type: string }>;
		metadata: Record<string, string>;
		location: 'active' | 'trash' | 'unknown';
	}> {
		await this.refreshSavedStructure();
		return this.documentInfo.getDocumentInfo(documentId);
	}

	async getTrashDocuments(): Promise<ScrivenerDocument[]> {
		return this.trash.getTrashDocuments();
	}

	async searchTrash(
		query: string,
		options?: { caseSensitive?: boolean; regex?: boolean }
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		return this.trash.searchTrash(query, options);
	}

	async recoverFromTrash(documentId: string, targetParentId?: string): Promise<void> {
		return this.trash.recoverFromTrash(documentId, targetParentId);
	}

	async getProjectStructureLimited(options?: {
		maxDepth?: number;
		folderId?: string;
		includeTrash?: boolean;
		summaryOnly?: boolean;
	}): Promise<ProjectStructure> {
		return this.documentInfo.getProjectStructureLimited(options);
	}

	async getDocumentAnnotations(documentId: string): Promise<Map<string, string>> {
		return this.documentInfo.getDocumentAnnotations(documentId);
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
		return this.contextBridge.performInitialSync();
	}

	// Cleanup
	async close(): Promise<void> {
		logger.info('Closing Scrivener project');
		if (this.editorial) {
			await this.editorial.workflows.close();
			await this.editorial.search.close();
			this.editorial.seriesStore.close();
			this.editorial.store.close();
			this.editorial = undefined;
		}

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

		const resources = await Promise.allSettled([
			this.databaseService.close(),
			this.documentManager.close(),
			Promise.resolve().then(() => this.projectLoader.close()),
		]);
		const failures = resources.filter(
			(result): result is PromiseRejectedResult => result.status === 'rejected'
		);
		if (failures.length === 1) throw failures[0].reason;
		if (failures.length > 1)
			throw new Error('Multiple project resources failed to close', {
				cause: failures.map((result) => result.reason),
			});

		logger.info('Project closed');
	}
}
