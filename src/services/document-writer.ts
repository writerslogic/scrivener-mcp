import type { LRUCache } from '../core/cache.js';
import { randomUUID } from 'node:crypto';
import type { RTFContent, RTFHandler } from './parsers/rtf-handler.js';
import {
	MutationCoordinator,
	type CommitOptions,
	type MutationRecord,
} from './editorial/mutation-coordinator.js';

interface PendingWrite {
	raw: string;
	options: CommitOptions;
	expectedRevision: Promise<string>;
	explicitRevision: boolean;
	revisionReadFailed: boolean;
	rebase?: { beforeRevision: string; afterRevision: string };
	receipt?: MutationRecord;
}

export class DocumentWriter {
	private readonly batchSize = 10;
	private readonly pendingWrites = new Map<string, PendingWrite>();
	private readonly activeWrites = new Set<Promise<unknown>>();
	private readonly immediateWrites = new Map<string, Promise<MutationRecord>>();
	private flushPromise?: Promise<void>;
	private closing = false;
	private closePromise?: Promise<void>;
	readonly coordinator: MutationCoordinator;

	constructor(
		projectPath: string,
		private readonly rtfHandler: RTFHandler,
		private readonly documentCache: LRUCache<RTFContent>,
		private readonly observedRevision?: (documentId: string) => string | undefined,
		private readonly onCommitted?: (documentId: string, revision: string) => void,
		readOnly = false
	) {
		this.coordinator = new MutationCoordinator(projectPath, undefined, readOnly);
	}

	async writeDocument(
		documentId: string,
		content: string | RTFContent,
		immediate = false,
		options: CommitOptions = {}
	): Promise<void> {
		if (this.closing) throw new Error('Document writer is closing');
		this.coordinator.assertWritable();
		const raw = this.rtfHandler.convertToRTF(content);
		const captured = { ...options };
		await this.trackWrite(
			immediate
				? this.scheduleImmediate(documentId, raw, captured)
				: this.afterImmediate(documentId, () =>
						this.queueDocument(documentId, raw, false, captured)
					)
		);
	}

	private afterImmediate<T>(documentId: string, work: () => Promise<T>): Promise<T> {
		const prior = this.immediateWrites.get(documentId);
		return prior ? prior.then(work, work) : work();
	}

	private scheduleImmediate(
		documentId: string,
		raw: string,
		options: CommitOptions
	): Promise<MutationRecord> {
		const write = this.afterImmediate(documentId, async () => {
			const receipt = await this.queueDocument(documentId, raw, true, options);
			if (!receipt) throw new Error('Immediate manuscript write has no committed receipt');
			return receipt;
		});
		this.immediateWrites.set(documentId, write);
		const settled = () => {
			if (this.immediateWrites.get(documentId) === write)
				this.immediateWrites.delete(documentId);
		};
		void write.then(settled, settled);
		return write;
	}

	private trackWrite<T>(write: Promise<T>): Promise<T> {
		const tracked = write.finally(() => this.activeWrites.delete(tracked));
		this.activeWrites.add(tracked);
		return tracked;
	}

	private async queueDocument(
		documentId: string,
		raw: string,
		immediate = false,
		options: CommitOptions = {}
	): Promise<MutationRecord | undefined> {
		const replay =
			immediate && options.operationId && options.expectedRevision === undefined
				? this.coordinator.get(options.operationId)
				: undefined;
		const expectedRevision =
			options.expectedRevision ??
			replay?.beforeRevision ??
			this.observedRevision?.(documentId);
		const pending: PendingWrite = {
			raw,
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
		if (immediate) {
			try {
				await this.flushPendingWrites();
			} catch (error) {
				if (this.pendingWrites.get(documentId) === pending)
					this.pendingWrites.delete(documentId);
				if (!pending.receipt) throw error;
			}
			return pending.receipt;
		}
		if (this.pendingWrites.size >= this.batchSize) await this.flushPendingWrites();
		return undefined;
	}

	async writeRawContent(
		documentId: string,
		rawRtf: string,
		options: CommitOptions = {}
	): Promise<MutationRecord> {
		if (this.closing) throw new Error('Document writer is closing');
		this.coordinator.assertWritable();
		return this.trackWrite(this.scheduleImmediate(documentId, rawRtf, { ...options }));
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
					const committed = await this.commitRawContent(documentId, pending.raw, {
						...pending.options,
						expectedRevision,
					});
					pending.receipt = committed;
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
