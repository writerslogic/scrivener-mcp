import type { LRUCache } from '../core/cache.js';
import { randomUUID } from 'node:crypto';
import type { RTFContent, RTFHandler } from './parsers/rtf-handler.js';
import {
	MutationCoordinator,
	type CommitOptions,
	type MutationRecord,
} from './editorial/mutation-coordinator.js';

interface PendingWrite {
	content: RTFContent | string;
	options: CommitOptions;
	expectedRevision: Promise<string>;
	explicitRevision: boolean;
	revisionReadFailed: boolean;
	rebase?: { beforeRevision: string; afterRevision: string };
}

export class DocumentWriter {
	private readonly batchSize = 10;
	private readonly pendingWrites = new Map<string, PendingWrite>();
	private readonly activeWrites = new Set<Promise<unknown>>();
	private flushPromise?: Promise<void>;
	private closing = false;
	private closePromise?: Promise<void>;
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
		if (this.closing) throw new Error('Document writer is closing');
		return this.trackWrite(this.queueDocument(documentId, content, immediate, options));
	}

	private trackWrite<T>(write: Promise<T>): Promise<T> {
		const tracked = write.finally(() => this.activeWrites.delete(tracked));
		this.activeWrites.add(tracked);
		return tracked;
	}

	private async queueDocument(
		documentId: string,
		content: string | RTFContent,
		immediate = false,
		options: CommitOptions = {}
	): Promise<void> {
		const expectedRevision = options.expectedRevision ?? this.observedRevision?.(documentId);
		if (immediate) {
			await this.writeDocumentImmediate(documentId, content, {
				...options,
				expectedRevision:
					expectedRevision ?? (await this.coordinator.readRaw(documentId)).revision,
			});
			return;
		}
		const pending: PendingWrite = {
			content,
			options: { ...options, operationId: options.operationId ?? randomUUID() },
			expectedRevision:
				expectedRevision === undefined
					? this.coordinator.readRaw(documentId).then((saved) => saved.revision)
					: Promise.resolve(expectedRevision),
			explicitRevision: options.expectedRevision !== undefined,
			revisionReadFailed: false,
		};
		this.pendingWrites.set(documentId, pending);
		this.documentCache.delete(`doc:${documentId}`);
		try {
			await pending.expectedRevision;
		} catch (error) {
			pending.revisionReadFailed = true;
			if (this.pendingWrites.get(documentId) === pending)
				this.pendingWrites.delete(documentId);
			throw error;
		}
		if (this.pendingWrites.size >= this.batchSize) await this.flushPendingWrites();
	}

	private async writeDocumentImmediate(
		documentId: string,
		content: string | RTFContent,
		options: CommitOptions
	): Promise<MutationRecord> {
		const raw = this.rtfHandler.convertToRTF(content);
		return this.commitRawContent(documentId, raw, options);
	}

	async writeRawContent(
		documentId: string,
		rawRtf: string,
		options: CommitOptions = {}
	): Promise<MutationRecord> {
		if (this.closing) throw new Error('Document writer is closing');
		return this.trackWrite(this.commitRawContent(documentId, rawRtf, options));
	}

	private async commitRawContent(
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
		do {
			this.flushPromise ??= this.drainPendingWrites().finally(() => {
				this.flushPromise = undefined;
			});
			await this.flushPromise;
		} while (this.pendingWrites.size || this.flushPromise);
	}

	private async drainPendingWrites(): Promise<void> {
		while (this.pendingWrites.size) {
			const writes = [...this.pendingWrites];
			this.pendingWrites.clear();
			for (let index = 0; index < writes.length; index++) {
				const [documentId, pending] = writes[index];
				try {
					const capturedRevision = await pending.expectedRevision;
					const expectedRevision =
						pending.rebase?.beforeRevision === capturedRevision
							? pending.rebase.afterRevision
							: capturedRevision;
					const committed = await this.writeDocumentImmediate(
						documentId,
						pending.content,
						{
							...pending.options,
							expectedRevision,
						}
					);
					const next = this.pendingWrites.get(documentId);
					if (next && !next.explicitRevision) {
						const retry = next.options.operationId === committed.id;
						next.rebase = {
							beforeRevision: retry
								? committed.afterRevision
								: committed.beforeRevision,
							afterRevision: retry
								? committed.beforeRevision
								: committed.afterRevision,
						};
					}
				} catch (error) {
					for (const [id, value] of writes.slice(index)) {
						if (!value.revisionReadFailed && !this.pendingWrites.has(id))
							this.pendingWrites.set(id, value);
					}
					throw error;
				}
			}
		}
	}

	close(): Promise<void> {
		this.closing = true;
		this.closePromise ??= this.drainAndClose().catch((error) => {
			this.closePromise = undefined;
			throw error;
		});
		return this.closePromise;
	}

	private async drainAndClose(): Promise<void> {
		const results = await Promise.allSettled(this.activeWrites);
		const errors = results
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map((result) => result.reason);
		try {
			await this.flushPendingWrites();
		} catch (error) {
			if (!errors.includes(error)) errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1)
			throw new AggregateError(errors, 'Manuscript writes failed during shutdown');
		await this.coordinator.close();
	}
}
