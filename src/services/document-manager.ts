/**
 * Document management service for Scrivener projects
 */

import { LRUCache } from '../core/cache.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { ScrivenerDocument } from '../types/index.js';
import type { ProjectStructure } from '../types/internal.js';
import { handleError, isValidUUID, validateInput } from '../utils/common.js';
import type { RTFContent } from './parsers/rtf-handler.js';
import { RTFHandler } from './parsers/rtf-handler.js';
import { DocumentTree } from './document-tree.js';
import { BinderEditor } from './binder-editor.js';
import { DocumentWriter } from './document-writer.js';
import {
	documentRevision,
	type CommitOptions,
	type MutationRecord,
	type MutationCoordinator,
} from './editorial/mutation-coordinator.js';

const logger = getLogger('document-manager');

export class DocumentManager {
	private writer: DocumentWriter;
	private binder: BinderEditor;
	private tree: DocumentTree;
	private projectPath: string;
	private rtfHandler: RTFHandler;
	private documentCache: LRUCache<RTFContent>;
	private readonly cachedRevisions = new Map<string, string>();
	private readonly observedRevisions = new Map<string, string>();
	private projectStructure?: ProjectStructure;
	private operationQueue: Map<string, Promise<unknown>>;
	private readonly batchSize = 10;
	private flushInterval: NodeJS.Timeout;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
		this.rtfHandler = new RTFHandler();
		this.documentCache = new LRUCache<RTFContent>({
			ttl: 5 * 60 * 1000, // 5 minutes
			maxEntries: 50,
			onEvict: (key, _value) => {
				logger.debug(`Document ${key} evicted from cache`);
			},
		});
		this.operationQueue = new Map();

		// Auto-flush pending writes every 5 seconds
		this.flushInterval = setInterval(() => {
			void this.flushPendingWrites().catch(() =>
				logger.error('Queued manuscript writes failed; pending writes retained for retry')
			);
		}, 5000);
		this.flushInterval.unref();

		this.tree = new DocumentTree(
			this.projectPath,
			this.rtfHandler,
			() => this.projectStructure
		);

		this.binder = new BinderEditor(
			() => this.projectStructure,
			(id, content) => this.writeDocument(id, content)
		);

		this.writer = new DocumentWriter(
			this.projectPath,
			this.rtfHandler,
			this.documentCache,
			(key, operation) => this.dedupedOperation(key, operation),
			(documentId) => this.observedRevisions.get(documentId),
			(documentId, revision) => this.observedRevisions.set(documentId, revision)
		);
	}

	setProjectStructure(structure: ProjectStructure): void {
		this.projectStructure = structure;
	}

	getProjectStructureData(): ProjectStructure | undefined {
		return this.projectStructure;
	}

	/**
	 * Read document content with deduplication
	 */
	async readDocument(documentId: string): Promise<string> {
		try {
			// Validate input
			validateInput(
				{ documentId },
				{
					documentId: { type: 'string', required: true },
				}
			);

			if (!isValidUUID(documentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Invalid document ID format'
				);
			}

			return this.dedupedOperation(`read:${documentId}`, async () => {
				const rtfContent = await this.readDocumentFormatted(documentId);
				return rtfContent.plainText || '';
			});
		} catch (error) {
			throw handleError(error, 'readDocument');
		}
	}

	/**
	 * Deduplicate operations to prevent redundant work
	 */
	private async dedupedOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
		if (this.operationQueue.has(key)) {
			return this.operationQueue.get(key) as Promise<T>;
		}

		const promise = operation().finally(() => {
			this.operationQueue.delete(key);
		});

		this.operationQueue.set(key, promise);
		return promise;
	}

	/**
	 * Read raw RTF document content (for annotation extraction)
	 */
	async readDocumentRaw(documentId: string): Promise<string> {
		const saved = await this.writer.coordinator.readRaw(documentId);
		this.observedRevisions.set(documentId, saved.revision);
		return saved.raw;
	}

	/**
	 * Read document with formatting preserved
	 */
	async readDocumentFormatted(documentId: string): Promise<RTFContent> {
		try {
			// Validate input
			validateInput(
				{ documentId },
				{
					documentId: { type: 'string', required: true },
				}
			);

			if (!isValidUUID(documentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Invalid document ID format'
				);
			}

			const cacheKey = `doc:${documentId}`;
			const saved = await this.writer.coordinator.readRaw(documentId);
			this.observedRevisions.set(documentId, saved.revision);
			const cached = this.documentCache.get(cacheKey);

			if (cached && this.cachedRevisions.get(documentId) === saved.revision) {
				logger.debug(`Cache hit for document ${documentId}`);
				return cached;
			}

			if (!saved.exists) return { plainText: '', formattedText: [], metadata: {} };
			const rtfContent = await this.rtfHandler.parseRTF(saved.raw);
			this.documentCache.set(cacheKey, rtfContent);
			this.cachedRevisions.set(documentId, saved.revision);
			return rtfContent;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				logger.warn(`Document ${documentId} not found`);
				return {
					plainText: '',
					formattedText: [],
					metadata: {},
				};
			}
			throw handleError(error, 'readDocumentFormatted');
		}
	}

	async writeDocument(
		documentId: string,
		content: string | RTFContent,
		immediate = false,
		options: CommitOptions = {}
	): Promise<void> {
		return this.writer.writeDocument(documentId, content, immediate, options);
	}

	/**
	 * Write raw RTF bytes to a document's content.rtf, backing up the prior version
	 * first (fail-closed like writeDocumentImmediate). Used by the fidelity-preserving
	 * write path, which produces the exact bytes to store and must not have them
	 * re-serialized by the RTF writer. Invalidates the parsed cache.
	 */
	async writeRawContent(
		documentId: string,
		rawRtf: string,
		options: CommitOptions = {}
	): Promise<MutationRecord> {
		return this.writer.writeRawContent(documentId, rawRtf, options);
	}

	getMutationCoordinator(): MutationCoordinator {
		return this.writer.coordinator;
	}

	async readDocumentRevision(documentId: string): Promise<string> {
		return documentRevision(await this.readDocumentRaw(documentId));
	}

	getObservedRevision(documentId: string): string | undefined {
		return this.observedRevisions.get(documentId);
	}

	async readDocumentVersion(documentId: string): Promise<{ text: string; revision: string }> {
		const saved = await this.writer.coordinator.readRaw(documentId);
		const parsed = saved.exists ? await this.rtfHandler.parseRTF(saved.raw) : { plainText: '', formattedText: [], metadata: {} };
		this.documentCache.set(`doc:${documentId}`, parsed);
		this.cachedRevisions.set(documentId, saved.revision);
		this.observedRevisions.set(documentId, saved.revision);
		return { text: parsed.plainText, revision: saved.revision };
	}

	/**
	 * Flush pending writes in batches
	 * Takes a snapshot of pending writes and clears the map before processing,
	 * so new writes during processing go into the fresh map.
	 */
	private async flushPendingWrites(): Promise<void> {
		return this.writer.flushPendingWrites();
	}

	/**
	 * Create a new document
	 */
	async createDocument(
		title: string,
		content = '',
		parentId?: string,
		type: 'Text' | 'Folder' = DOCUMENT_TYPES.TEXT
	): Promise<string> {
		return this.binder.createDocument(title, content, parentId, type);
	}

	/**
	 * Delete a document (move to trash)
	 */
	async deleteDocument(documentId: string): Promise<void> {
		return this.binder.deleteDocument(documentId);
	}

	/**
	 * Rename a document
	 */
	async renameDocument(documentId: string, newTitle: string): Promise<void> {
		return this.binder.renameDocument(documentId, newTitle);
	}

	/**
	 * Move a document to a different parent
	 */
	async moveDocument(documentId: string, newParentId: string | null): Promise<void> {
		return this.binder.moveDocument(documentId, newParentId);
	}

	/**
	 * Recover a document from trash
	 */
	async recoverFromTrash(documentId: string, targetParentId?: string): Promise<void> {
		return this.binder.recoverFromTrash(documentId, targetParentId);
	}

	/**
	 * Get word count for a document
	 */
	async getWordCount(documentId?: string): Promise<{ words: number; characters: number }> {
		try {
			// Validate input if provided
			if (documentId) {
				validateInput(
					{ documentId },
					{
						documentId: { type: 'string', required: true },
					}
				);

				if (!isValidUUID(documentId)) {
					throw createError(
						ErrorCode.INVALID_INPUT,
						{ documentId },
						'Invalid document ID format'
					);
				}
			}

			let totalWords = 0;
			let totalChars = 0;

			if (documentId) {
				const content = await this.readDocument(documentId);
				const words = content
					.trim()
					.split(/\s+/)
					.filter((w) => w.length > 0);
				totalWords = words.length;
				totalChars = content.length;
			} else {
				// Count all documents using AsyncUtils for better performance
				const documents = await this.getAllDocuments();
				const textDocuments = documents.filter(
					(doc) => doc.type === DOCUMENT_TYPES.TEXT && doc.id
				);

				// Process documents in batches
				const results: Array<{ words: number; characters: number }> = [];
				for (let i = 0; i < textDocuments.length; i += this.batchSize) {
					const batch = textDocuments.slice(i, i + this.batchSize);
					const batchPromises = batch.map(async (doc: ScrivenerDocument) => {
						const content = await this.readDocument(doc.id!);
						const words = content
							.trim()
							.split(/\s+/)
							.filter((w) => w.length > 0);
						return { words: words.length, characters: content.length };
					});
					const batchResults = await Promise.all(batchPromises);
					results.push(...batchResults);
				}

				// Sum up results
				for (const result of results) {
					totalWords += result.words;
					totalChars += result.characters;
				}
			}

			return { words: totalWords, characters: totalChars };
		} catch (error) {
			throw handleError(error, 'getWordCount');
		}
	}

	/**
	 * Get all documents in the project
	 */
	async getAllDocuments(includeTrash = false): Promise<ScrivenerDocument[]> {
		return this.tree.getAllDocuments(includeTrash);
	}

	/**
	 * Flat list of every document beneath the folder with the given id
	 * (descendants only, not the folder itself), each with its path threaded.
	 * Returns an empty list when the id is unknown or names a leaf document.
	 */
	async getDocumentsUnderFolder(folderId: string): Promise<ScrivenerDocument[]> {
		return this.tree.getDocumentsUnderFolder(folderId);
	}

	/**
	 * Get project structure as hierarchical documents
	 */
	async getProjectStructure(includeTrash = false): Promise<ScrivenerDocument[]> {
		return this.tree.getProjectStructure(includeTrash);
	}

	/**
	 * Clear document cache
	 */
	clearCache(documentId?: string): void {
		if (documentId) {
			this.documentCache.delete(`doc:${documentId}`);
			this.cachedRevisions.delete(documentId);
		} else {
			this.documentCache.clear();
			this.cachedRevisions.clear();
		}
	}

	/**
	 * Clean up resources
	 */
	async close(): Promise<void> {
		if (this.flushInterval) {
			clearInterval(this.flushInterval);
		}

		// Ensure any pending writes are saved
		await this.flushPendingWrites();

		this.documentCache.clear();
		this.cachedRevisions.clear();
		this.observedRevisions.clear();
		this.writer.close();
	}
}
