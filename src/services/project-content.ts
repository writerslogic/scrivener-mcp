import { getLogger } from '../core/logger.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import { findDraftFolder, findSubtree } from '../utils/binder-tree.js';
import type { CompilationService } from './compilation-service.js';
import { type StructuredEntry } from './compilation-service.js';
import { documentIndexer, type SearchResult } from './document-indexer.js';
import type { DocumentManager } from './document-manager.js';
import type { CompileMetadata } from './compile-settings.js';
import type { ScrivenerDocument } from '../types/index.js';
import type { ScrivenerProject } from '../scrivener-project.js';

const logger = getLogger('scrivener-project');

/** Compilation, manuscript selection and content search for a project. */
export class ProjectContent {
	constructor(
		private readonly documentManager: DocumentManager,
		private readonly compilationService: CompilationService,
		private readonly readDocument: (documentId: string) => Promise<string>,
		private readonly getAllDocuments: (includeTrash?: boolean) => Promise<ScrivenerDocument[]>,
		private readonly getDocumentInfo: ScrivenerProject['getDocumentInfo'],
		private readonly getCompileMetadata: () => Promise<CompileMetadata>,
		private readonly isIndexInitialized: () => boolean
	) {}

	private get indexInitialized(): boolean {
		return this.isIndexInitialized();
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
		const tree = await this.documentManager.getProjectStructure();
		const draft = findDraftFolder(tree);
		const roots = draft ? (draft.children ?? []) : tree;

		const result: Array<{ id: string; title: string; content: string }> = [];
		const walk = async (nodes: ScrivenerDocument[]): Promise<void> => {
			for (const node of nodes) {
				if (node.type === DOCUMENT_TYPES.TEXT) {
					if (node.includeInCompile !== false || includeExcluded) {
						let content = '';
						try {
							content = await this.readDocument(node.id);
						} catch (error) {
							logger.warn(`getManuscriptDocuments: failed to read ${node.id}`, {
								error: error instanceof Error ? error.message : String(error),
							});
						}
						result.push({ id: node.id, title: node.title, content });
					}
				}
				if (node.children?.length) await walk(node.children);
			}
		};
		await walk(roots);
		return result;
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
}
