import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LRUCache } from '../core/cache.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import { ensureDir, isValidUUID, safeWriteFile, truncate } from '../utils/common.js';
import { getDocumentPath } from '../utils/scrivener-utils.js';
import type { RTFContent } from './parsers/rtf-handler.js';
import type { RTFHandler } from './parsers/rtf-handler.js';

const logger = getLogger('document-manager');

/** Document writes: batched and immediate, with the docs.checksum update. */
export class DocumentWriter {
	private readonly batchSize = 10;
	private pendingWrites: Map<string, { content: RTFContent | string; timestamp: number }> =
		new Map();
	private checksumLock: Promise<void> = Promise.resolve();

	constructor(
		private readonly projectPath: string,
		private readonly rtfHandler: RTFHandler,
		private readonly documentCache: LRUCache<RTFContent>,
		private readonly dedupedOperation: <T>(
			key: string,
			operation: () => Promise<T>
		) => Promise<T>
	) {}

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
	async flushPendingWrites(): Promise<void> {
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
}
