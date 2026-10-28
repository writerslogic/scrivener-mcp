import type { LRUCache } from '../core/cache.js';
import type { RTFContent, RTFHandler } from './parsers/rtf-handler.js';
import {
	MutationCoordinator,
	type CommitOptions,
	type MutationRecord,
} from './editorial/mutation-coordinator.js';

export class DocumentWriter {
	private readonly batchSize = 10;
	private readonly pendingWrites = new Map<
		string,
		{ content: RTFContent | string; expectedRevision: string }
	>();
	readonly coordinator: MutationCoordinator;

	constructor(
		projectPath: string,
		private readonly rtfHandler: RTFHandler,
		private readonly documentCache: LRUCache<RTFContent>,
		_dedupedOperation: <T>(key: string, operation: () => Promise<T>) => Promise<T>,
		private readonly observedRevision?: (documentId: string) => string | undefined,
		private readonly onCommitted?: (documentId: string, revision: string) => void
	) {
		this.coordinator = new MutationCoordinator(projectPath);
	}

	async writeDocument(
		documentId: string,
		content: string | RTFContent,
		immediate = false,
		options: CommitOptions = {}
	): Promise<void> {
		const expectedRevision =
			options.expectedRevision ??
			this.observedRevision?.(documentId) ??
			(await this.coordinator.readRaw(documentId)).revision;
		if (immediate) {
			await this.writeDocumentImmediate(documentId, content, {
				...options,
				expectedRevision,
			});
			return;
		}
		this.pendingWrites.set(documentId, { content, expectedRevision });
		this.documentCache.delete(`doc:${documentId}`);
		if (this.pendingWrites.size >= this.batchSize) await this.flushPendingWrites();
	}

	private async writeDocumentImmediate(
		documentId: string,
		content: string | RTFContent,
		options: CommitOptions
	): Promise<void> {
		const raw = this.rtfHandler.convertToRTF(content);
		await this.writeRawContent(documentId, raw, options);
	}

	async writeRawContent(
		documentId: string,
		rawRtf: string,
		options: CommitOptions = {}
	): Promise<MutationRecord> {
		const expectedRevision = options.expectedRevision ?? this.observedRevision?.(documentId);
		const result = await this.coordinator.commit(documentId, rawRtf, {
			...options,
			expectedRevision,
		});
		this.documentCache.delete(`doc:${documentId}`);
		this.onCommitted?.(documentId, result.afterRevision);
		return result;
	}

	async flushPendingWrites(): Promise<void> {
		const writes = [...this.pendingWrites];
		this.pendingWrites.clear();
		for (let index = 0; index < writes.length; index++) {
			const [documentId, pending] = writes[index];
			try {
				await this.writeDocumentImmediate(documentId, pending.content, {
					expectedRevision: pending.expectedRevision,
				});
			} catch (error) {
				for (const [id, value] of writes.slice(index)) {
					if (!this.pendingWrites.has(id)) this.pendingWrites.set(id, value);
				}
				throw error;
			}
		}
	}

	close(): void {
		this.coordinator.close();
	}
}
