/**
 * Document management service for Scrivener projects
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LRUCache } from '../core/cache.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { ScrivenerDocument } from '../types/index.js';
import type { ProjectStructure } from '../types/internal.js';
import {
	ensureDir,
	handleError,
	isValidUUID,
	safeReadFile,
	safeWriteFile,
	truncate,
	validateInput,
} from '../utils/common.js';
import { getDocumentPath } from '../utils/scrivener-utils.js';
import { FileUtils, PathUtils } from '../utils/shared-patterns.js';
import type { RTFContent } from './parsers/rtf-handler.js';
import { RTFHandler } from './parsers/rtf-handler.js';
import { DocumentTree } from './document-tree.js';
import { BinderEditor } from './binder-editor.js';

const logger = getLogger('document-manager');

export class DocumentManager {
	private binder: BinderEditor;
	private tree: DocumentTree;
	private projectPath: string;
	private rtfHandler: RTFHandler;
	private documentCache: LRUCache<RTFContent>;
	private projectStructure?: ProjectStructure;
	private operationQueue: Map<string, Promise<unknown>>;
	private readonly batchSize = 10;
	private pendingWrites: Map<string, { content: RTFContent | string; timestamp: number }>;
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
		this.pendingWrites = new Map();

		// Auto-flush pending writes every 5 seconds
		this.flushInterval = setInterval(() => void this.flushPendingWrites(), 5000);

		this.tree = new DocumentTree(
			this.projectPath,
			this.rtfHandler,
			() => this.projectStructure
		);

		this.binder = new BinderEditor(
			() => this.projectStructure,
			(id, content) => this.writeDocument(id, content)
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
		const filePath = getDocumentPath(this.projectPath, documentId);
		logger.debug(`Reading raw document from ${filePath}`);

		try {
			if (await FileUtils.exists(filePath)) {
				return await safeReadFile(filePath, 'utf-8');
			} else {
				logger.warn(`Document ${documentId} not found at ${filePath}`);
				return '';
			}
		} catch (error) {
			logger.error(`Error reading document ${documentId}:`, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
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
			const cached = this.documentCache.get(cacheKey);

			if (cached) {
				logger.debug(`Cache hit for document ${documentId}`);
				return cached;
			}

			// Use PathUtils for path operations
			const filePath = PathUtils.build(
				this.projectPath,
				'Files',
				'Data',
				`${documentId}`,
				'content.rtf'
			);
			logger.debug(`Reading document from ${filePath}`);

			const rtfString = await safeReadFile(filePath, 'utf-8');
			const rtfContent = await this.rtfHandler.parseRTF(rtfString);
			this.documentCache.set(cacheKey, rtfContent);
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

	/**
	 * Write document content with batching and deduplication
	 */
	async writeDocument(
		documentId: string,
		content: string | RTFContent,
		immediate = false
	): Promise<void> {
		if (immediate) {
			return this.writeDocumentImmediate(documentId, content);
		}

		// Queue for batch writing. Invalidate the parsed-content cache now, not at
		// flush time, so a read that arrives before the flush sees "not cached"
		// (falls through to disk) rather than the stale pre-write content.
		this.pendingWrites.set(documentId, {
			content,
			timestamp: Date.now(),
		});
		this.documentCache.delete(`doc:${documentId}`);

		// Flush if queue is full
		if (this.pendingWrites.size >= this.batchSize) {
			await this.flushPendingWrites();
		}
	}

	/**
	 * Write document immediately
	 */
	private async writeDocumentImmediate(
		documentId: string,
		content: string | RTFContent
	): Promise<void> {
		if (!isValidUUID(documentId)) {
			throw createError(
				ErrorCode.VALIDATION_ERROR,
				{ documentId },
				`Invalid document ID format: ${truncate(documentId, 50)}`
			);
		}
		return this.dedupedOperation(`write:${documentId}`, async () => {
			const filePath = getDocumentPath(this.projectPath, documentId);
			logger.debug(`Writing document to ${filePath}`);

			// Ensure the directory exists
			const dir = path.dirname(filePath);
			await ensureDir(dir);

			// Convert to RTF if needed
			let rtfContent: RTFContent;
			if (typeof content === 'string') {
				rtfContent = {
					plainText: content,
					formattedText: [],
					metadata: {},
				};
			} else {
				rtfContent = content;
			}

			// Backup existing content before overwrite. If the document already
			// exists but cannot be backed up, fail closed rather than risk an
			// unrecoverable overwrite of the writer's manuscript.
			const backupDir = path.join(this.projectPath, '.scrivener-mcp-backup');
			try {
				await ensureDir(backupDir);
				await fs.promises.copyFile(filePath, path.join(backupDir, `${documentId}.rtf`));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw createError(
						ErrorCode.FILE_WRITE_ERROR,
						{ documentId, error: (err as Error).message },
						`Refusing to overwrite document ${documentId}: could not back up existing content first`
					);
				}
				// ENOENT: no existing file to back up (first write) — safe to proceed.
			}

			await this.rtfHandler.writeRTF(filePath, rtfContent);

			// Update cache
			const cacheKey = `doc:${documentId}`;
			this.documentCache.set(cacheKey, rtfContent);
			await this.syncDocsChecksum(documentId);
		});
	}

	/**
	 * Write raw RTF bytes to a document's content.rtf, backing up the prior version
	 * first (fail-closed like writeDocumentImmediate). Used by the fidelity-preserving
	 * write path, which produces the exact bytes to store and must not have them
	 * re-serialized by the RTF writer. Invalidates the parsed cache.
	 */
	async writeRawContent(documentId: string, rawRtf: string): Promise<void> {
		if (!isValidUUID(documentId)) {
			throw createError(
				ErrorCode.VALIDATION_ERROR,
				{ documentId },
				`Invalid document ID format: ${truncate(documentId, 50)}`
			);
		}
		return this.dedupedOperation(`write:${documentId}`, async () => {
			const filePath = getDocumentPath(this.projectPath, documentId);
			await ensureDir(path.dirname(filePath));

			const backupDir = path.join(this.projectPath, '.scrivener-mcp-backup');
			try {
				await ensureDir(backupDir);
				await fs.promises.copyFile(filePath, path.join(backupDir, `${documentId}.rtf`));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw createError(
						ErrorCode.FILE_WRITE_ERROR,
						{ documentId, error: (err as Error).message },
						`Refusing to overwrite document ${documentId}: could not back up existing content first`
					);
				}
			}

			await fs.promises.writeFile(filePath, rawRtf, 'utf-8');
			this.documentCache.delete(`doc:${documentId}`);
			await this.syncDocsChecksum(documentId);
		});
	}

	/**
	 * Keep Scrivener's `Files/Data/docs.checksum` in sync after a write so Scrivener
	 * does not flag the document as "modified externally". Each line is
	 * `<UUID>/content.rtf=<sha1>` (verified against real projects). Only updates an
	 * existing checksum file — never creates one a project didn't already use — and
	 * serializes updates so concurrent writes can't corrupt the shared file. Best
	 * effort: a failure here never fails the write.
	 */
	private checksumLock: Promise<void> = Promise.resolve();
	private async syncDocsChecksum(documentId: string): Promise<void> {
		this.checksumLock = this.checksumLock.then(async () => {
			const checksumPath = path.join(this.projectPath, 'Files', 'Data', 'docs.checksum');
			try {
				let existing: string;
				try {
					existing = await fs.promises.readFile(checksumPath, 'utf-8');
				} catch {
					return; // no checksum file: this project doesn't use them, leave it that way
				}
				const bytes = await fs.promises.readFile(
					getDocumentPath(this.projectPath, documentId)
				);
				const hash = crypto.createHash('sha1').update(bytes).digest('hex');
				const key = `${documentId}/content.rtf`;
				const lines = existing.split('\n').filter((l) => l.length > 0);
				const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
				if (idx >= 0) lines[idx] = `${key}=${hash}`;
				else lines.push(`${key}=${hash}`);
				await safeWriteFile(checksumPath, `${lines.join('\n')}\n`);
			} catch (error) {
				logger.warn('Failed to update docs.checksum', {
					documentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		return this.checksumLock;
	}

	/**
	 * Flush pending writes in batches
	 * Takes a snapshot of pending writes and clears the map before processing,
	 * so new writes during processing go into the fresh map.
	 */
	private async flushPendingWrites(): Promise<void> {
		if (this.pendingWrites.size === 0) return;

		// Snapshot current pending writes, then clear so new writes
		// arriving during processing accumulate in the fresh map
		const snapshot = new Map(this.pendingWrites);
		this.pendingWrites.clear();

		const writes = Array.from(snapshot.entries());

		// Process in parallel batches
		const batches = [];
		for (let i = 0; i < writes.length; i += this.batchSize) {
			batches.push(writes.slice(i, i + this.batchSize));
		}

		for (const batch of batches) {
			await Promise.all(
				batch.map(([documentId, { content }]) =>
					this.writeDocumentImmediate(documentId, content)
				)
			);
		}
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
		} else {
			this.documentCache.clear();
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
	}
}
