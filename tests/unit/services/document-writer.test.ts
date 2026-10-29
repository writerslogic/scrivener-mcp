import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { LRUCache } from '../../../src/core/cache.js';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { DocumentWriter } from '../../../src/services/document-writer.js';
import { documentRevision } from '../../../src/services/editorial/mutation-coordinator.js';
import { RTFHandler, type RTFContent } from '../../../src/services/parsers/rtf-handler.js';
import { listDocumentSnapshots } from '../../../src/services/snapshots.js';

const DOC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const rtf = new RTFHandler();

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function pauseNextCommit(writer: DocumentWriter) {
	const entered = deferred();
	const release = deferred();
	const completed = deferred();
	const commit = writer.coordinator.commit.bind(writer.coordinator);
	const spy = jest.spyOn(writer.coordinator, 'commit').mockImplementationOnce(async (...args) => {
		entered.resolve();
		await release.promise;
		const result = await commit(...args);
		completed.resolve();
		return result;
	});
	return { entered, release, completed, spy };
}

describe('DocumentWriter', () => {
	let root: string;
	let writer: DocumentWriter;
	const file = (id = DOC) => path.join(root, 'Files', 'Data', id, 'content.rtf');
	const text = async (id = DOC) =>
		(await rtf.parseRTF(await fs.readFile(file(id), 'utf8'))).plainText;
	const createWriter = (observed?: (id: string) => string | undefined) =>
		new DocumentWriter(
			root,
			rtf,
			new LRUCache<RTFContent>(),
			async (_key, operation) => operation(),
			observed
		);

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-buffered-writes-'));
		for (const id of [DOC, OTHER]) {
			await fs.mkdir(path.dirname(file(id)), { recursive: true });
			await fs.writeFile(file(id), rtf.convertToRTF('Original.'));
		}
		writer = createWriter();
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		await writer.close();
		await fs.rm(root, { recursive: true, force: true });
	});

	it('retains operation identity, undo linkage, and snapshot title', async () => {
		await writer.writeDocument(DOC, 'Replacement.', false, {
			operationId: 'buffered-operation',
			undoes: 'original-operation',
			snapshotTitle: 'Before correction',
		});
		await writer.flushPendingWrites();
		const record = writer.coordinator.get('buffered-operation');
		expect(record?.state).toBe('committed');
		expect(record?.undoes).toBe('original-operation');
		expect(record?.snapshot?.title).toBe('Before correction');
		expect(await text()).toBe('Replacement.');
	});

	it('joins overlapping flushes and drains a newer implicit write to the same document', async () => {
		await writer.writeDocument(DOC, 'First.');
		const gate = pauseNextCommit(writer);
		const firstFlush = writer.flushPendingWrites();
		await gate.entered.promise;
		await writer.writeDocument(DOC, 'Latest.');
		const joinedFlush = writer.flushPendingWrites();
		gate.release.resolve();
		await Promise.all([firstFlush, joinedFlush]);
		expect(await text()).toBe('Latest.');
		expect(gate.spy).toHaveBeenCalledTimes(2);
		const firstId = gate.spy.mock.calls[0][2]!.operationId!;
		expect(gate.spy.mock.calls[1][2]?.expectedRevision).toBe(
			writer.coordinator.get(firstId)?.afterRevision
		);
	});

	it('preserves explicit stale expectations instead of rebasing them', async () => {
		const revision = (await writer.coordinator.readRaw(DOC)).revision;
		await writer.writeDocument(DOC, 'First.');
		const gate = pauseNextCommit(writer);
		const flushing = writer.flushPendingWrites();
		await gate.entered.promise;
		await writer.writeDocument(DOC, 'Explicit stale replacement.', false, {
			expectedRevision: revision,
		});
		const rejected = expect(flushing).rejects.toThrow('Stale document revision');
		gate.release.resolve();
		await rejected;
		expect(await text()).toBe('First.');
		await writer.writeDocument(DOC, 'Reviewed replacement.', false, {
			expectedRevision: (await writer.coordinator.readRaw(DOC)).revision,
		});
		await writer.flushPendingWrites();
		expect(await text()).toBe('Reviewed replacement.');
	});

	it('does not rebase an implicit expectation from an unrelated stale revision', async () => {
		await writer.close();
		writer = createWriter(() => documentRevision('Unrelated older content.'));
		const revision = (await writer.coordinator.readRaw(DOC)).revision;
		await writer.writeDocument(DOC, 'First.', false, { expectedRevision: revision });
		const gate = pauseNextCommit(writer);
		const flushing = writer.flushPendingWrites();
		await gate.entered.promise;
		await writer.writeDocument(DOC, 'Stale implicit replacement.');
		const rejected = expect(flushing).rejects.toThrow('Stale document revision');
		gate.release.resolve();
		await rejected;
		expect(await text()).toBe('First.');
		await writer.writeDocument(DOC, 'Reviewed replacement.', false, {
			expectedRevision: (await writer.coordinator.readRaw(DOC)).revision,
		});
	});

	it('handles a captured revision read that finishes after the previous commit', async () => {
		await writer.writeDocument(DOC, 'First.');
		const gate = pauseNextCommit(writer);
		const flushing = writer.flushPendingWrites();
		await gate.entered.promise;
		const captured = deferred();
		const releaseRead = deferred();
		const read = writer.coordinator.readRaw.bind(writer.coordinator);
		jest.spyOn(writer.coordinator, 'readRaw').mockImplementationOnce(async (id) => {
			const saved = await read(id);
			captured.resolve();
			await releaseRead.promise;
			return saved;
		});
		const queued = writer.writeDocument(DOC, 'Latest.');
		await captured.promise;
		gate.release.resolve();
		await gate.completed.promise;
		releaseRead.resolve();
		await queued;
		await flushing;
		await writer.flushPendingWrites();
		expect(await text()).toBe('Latest.');
	});

	it('keeps the newest payload when an older enqueue finishes its revision read later', async () => {
		const captured = deferred();
		const release = deferred();
		const read = writer.coordinator.readRaw.bind(writer.coordinator);
		jest.spyOn(writer.coordinator, 'readRaw').mockImplementationOnce(async (id) => {
			const saved = await read(id);
			captured.resolve();
			await release.promise;
			return saved;
		});
		const older = writer.writeDocument(DOC, 'Older.');
		await captured.promise;
		await writer.writeDocument(DOC, 'Latest.');
		release.resolve();
		await older;
		await writer.flushPendingWrites();
		expect(await text()).toBe('Latest.');
	});

	it.each(['Replacement.', 'Conflicting replacement.'])(
		'preserves same-operation retry identity after committing (%s)',
		async (content) => {
			const options = { operationId: 'same-operation' };
			await writer.writeDocument(DOC, 'Replacement.', false, options);
			const gate = pauseNextCommit(writer);
			const flushing = writer.flushPendingWrites();
			const completed =
				content === 'Replacement.'
					? flushing
					: expect(flushing).rejects.toThrow(
							'Operation ID was already used for different content'
						);
			await gate.entered.promise;
			const started = deferred();
			const releaseRead = deferred();
			const read = writer.coordinator.readRaw.bind(writer.coordinator);
			jest.spyOn(writer.coordinator, 'readRaw').mockImplementationOnce(async (id) => {
				started.resolve();
				await releaseRead.promise;
				return read(id);
			});
			const retry = writer.writeDocument(DOC, content, false, options);
			await started.promise;
			gate.release.resolve();
			await gate.completed.promise;
			releaseRead.resolve();
			await retry;
			await completed;
			expect(await text()).toBe('Replacement.');
			expect(await listDocumentSnapshots(root, DOC)).toHaveLength(1);
			expect(gate.spy.mock.calls[1][2]?.expectedRevision).toBe(
				writer.coordinator.get(options.operationId)?.beforeRevision
			);
			if (content !== 'Replacement.') {
				await writer.writeDocument(DOC, 'Replacement.', false, {
					...options,
					expectedRevision: writer.coordinator.get(options.operationId)!.beforeRevision,
				});
			}
		}
	);

	it('retains failed and unprocessed writes with stable IDs after a committed acknowledgment is lost', async () => {
		const commit = writer.coordinator.commit.bind(writer.coordinator);
		const spy = jest
			.spyOn(writer.coordinator, 'commit')
			.mockImplementationOnce(async (...args) => {
				await commit(...args);
				throw new Error('Acknowledgment lost');
			});
		await writer.writeDocument(DOC, 'First replacement.');
		await writer.writeDocument(OTHER, 'Second replacement.');
		await expect(writer.flushPendingWrites()).rejects.toThrow('Acknowledgment lost');
		await writer.flushPendingWrites();
		expect(await text()).toBe('First replacement.');
		expect(await text(OTHER)).toBe('Second replacement.');
		expect(spy.mock.calls[1][2]?.operationId).toBe(spy.mock.calls[0][2]?.operationId);
		expect(await listDocumentSnapshots(root, DOC)).toHaveLength(1);
	});

	it('retains the newest queued payload when an older in-flight write fails', async () => {
		await writer.writeDocument(DOC, 'Older.');
		await writer.writeDocument(OTHER, 'Unprocessed.');
		const entered = deferred();
		const release = deferred();
		jest.spyOn(writer.coordinator, 'commit').mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error('Retryable failure');
		});
		const flushing = writer.flushPendingWrites();
		await entered.promise;
		await writer.writeDocument(DOC, 'Latest.');
		const rejected = expect(flushing).rejects.toThrow('Retryable failure');
		release.resolve();
		await rejected;
		await writer.flushPendingWrites();
		expect(await text()).toBe('Latest.');
		expect(await text(OTHER)).toBe('Unprocessed.');
	});

	it('drops a failed initial revision read without retaining an unwriteable entry', async () => {
		jest.spyOn(writer.coordinator, 'readRaw').mockRejectedValueOnce(new Error('Read failed'));
		const queued = writer.writeDocument(DOC, 'Unread replacement.');
		const flushing = writer.flushPendingWrites();
		await expect(queued).rejects.toThrow('Read failed');
		await expect(flushing).rejects.toThrow('Read failed');
		await writer.flushPendingWrites();
		expect(await text()).toBe('Original.');
	});

	it('makes a follower close join a successor drain started by another flush caller', async () => {
		const manager = new DocumentManager(root);
		const managedWriter = (manager as unknown as { writer: DocumentWriter }).writer;
		const gate = pauseNextCommit(managedWriter);
		const close = jest.spyOn(managedWriter.coordinator, 'close');
		const emptyFlush = managedWriter.flushPendingWrites();
		const queued = manager.writeDocument(DOC, 'Replacement.');
		const closing = manager.close();
		await gate.entered.promise;
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(close).not.toHaveBeenCalled();
		} finally {
			gate.release.resolve();
			await Promise.all([emptyFlush, queued, closing]);
		}
		expect(await text()).toBe('Replacement.');
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('makes DocumentManager.close wait for an active flush and its queued arrivals', async () => {
		const manager = new DocumentManager(root);
		const managedWriter = (manager as unknown as { writer: DocumentWriter }).writer;
		await manager.writeDocument(DOC, 'First.');
		const gate = pauseNextCommit(managedWriter);
		const close = jest.spyOn(managedWriter.coordinator, 'close');
		const flushing = managedWriter.flushPendingWrites();
		await gate.entered.promise;
		await manager.writeDocument(OTHER, 'Queued during flush.');
		const closing = manager.close();
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(close).not.toHaveBeenCalled();
		} finally {
			gate.release.resolve();
			await Promise.all([flushing, closing]);
		}
		expect(await text()).toBe('First.');
		expect(await text(OTHER)).toBe('Queued during flush.');
		expect(close).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		'drains an admitted write paused at its revision read (immediate=%s)',
		async (immediate) => {
			const entered = deferred();
			const release = deferred();
			const read = writer.coordinator.readRaw.bind(writer.coordinator);
			jest.spyOn(writer.coordinator, 'readRaw').mockImplementationOnce(async (id) => {
				entered.resolve();
				await release.promise;
				return read(id);
			});
			const close = jest.spyOn(writer.coordinator, 'close');
			const writing = writer.writeDocument(DOC, 'Admitted replacement.', immediate);
			await entered.promise;
			const closing = writer.close();
			try {
				await expect(writer.writeDocument(OTHER, 'Too late.')).rejects.toThrow('closing');
				await expect(writer.writeRawContent(OTHER, 'Too late.')).rejects.toThrow('closing');
				expect(close).not.toHaveBeenCalled();
			} finally {
				release.resolve();
				await Promise.all([writing, closing]);
			}
			expect(await text()).toBe('Admitted replacement.');
			expect(close).toHaveBeenCalledTimes(1);
		}
	);

	it('joins manager shutdowns while an admitted raw write is paused', async () => {
		const manager = new DocumentManager(root);
		const managedWriter = (manager as unknown as { writer: DocumentWriter }).writer;
		const gate = pauseNextCommit(managedWriter);
		const close = jest.spyOn(managedWriter.coordinator, 'close');
		const writing = manager.writeRawContent(DOC, rtf.convertToRTF('Raw replacement.'));
		await gate.entered.promise;
		const closing = manager.close();
		const joined = manager.close();
		try {
			await expect(manager.createDocument('Too late.')).rejects.toThrow('closing');
			await expect(manager.renameDocument(DOC, 'Too late.')).rejects.toThrow('closing');
			expect(() => manager.getMutationCoordinator()).toThrow('closing');
			expect(close).not.toHaveBeenCalled();
		} finally {
			gate.release.resolve();
			await Promise.all([writing, closing, joined]);
		}
		expect(await text()).toBe('Raw replacement.');
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('retains failed buffered writes and operation IDs for a shutdown retry', async () => {
		await writer.writeDocument(DOC, 'First replacement.');
		await writer.writeDocument(OTHER, 'Second replacement.');
		const commit = jest
			.spyOn(writer.coordinator, 'commit')
			.mockRejectedValueOnce(new Error('Retryable write failure'));
		const close = jest.spyOn(writer.coordinator, 'close');
		await expect(writer.close()).rejects.toThrow('Retryable write failure');
		expect(close).not.toHaveBeenCalled();
		await expect(writer.writeDocument(DOC, 'Too late.')).rejects.toThrow('closing');
		await writer.close();
		expect(await text()).toBe('First replacement.');
		expect(await text(OTHER)).toBe('Second replacement.');
		expect(commit.mock.calls[1][2]?.operationId).toBe(commit.mock.calls[0][2]?.operationId);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('waits for every admitted write when another write fails during shutdown', async () => {
		const gate = pauseNextCommit(writer);
		const close = jest.spyOn(writer.coordinator, 'close');
		const writing = writer.writeRawContent(OTHER, rtf.convertToRTF('Completed replacement.'));
		await gate.entered.promise;
		jest.spyOn(writer.coordinator, 'readRaw').mockRejectedValueOnce(new Error('Read failed'));
		const failed = expect(
			writer.writeDocument(DOC, 'Unread replacement.', true)
		).rejects.toThrow('Read failed');
		const closing = expect(writer.close()).rejects.toThrow('Read failed');
		try {
			await failed;
			expect(close).not.toHaveBeenCalled();
		} finally {
			gate.release.resolve();
			await Promise.all([writing, closing]);
		}
		expect(await text(OTHER)).toBe('Completed replacement.');
		await writer.close();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it.each(['document', 'binder', 'snapshot'] as const)(
		'keeps the coordinator journal open while an admitted %s mutation reads saved content',
		async (kind) => {
			const coordinator = writer.coordinator;
			const binderPath = path.join(root, 'Project.scrivx');
			const binderBefore = '<?xml version="1.0"?><ScrivenerProject />';
			const binderAfter = '<?xml version="1.0"?><ScrivenerProject Version="2" />';
			if (kind === 'binder') await fs.writeFile(binderPath, binderBefore);
			const entered = deferred();
			const release = deferred();
			const open = fs.open;
			jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
				const handle = await open(...args);
				entered.resolve();
				await release.promise;
				return handle;
			});
			const writing =
				kind === 'document'
					? coordinator.commit(DOC, rtf.convertToRTF('Direct replacement.'), {
							operationId: 'direct-document',
						})
					: kind === 'binder'
						? coordinator.commitProjectFile(binderPath, binderAfter, {
								operationId: 'direct-binder',
								expectedRevision: documentRevision(binderBefore),
							})
						: coordinator.snapshot(DOC, 'Admitted snapshot', new Date('2026-01-01'));
			await entered.promise;
			let closed = false;
			const closing = coordinator.close().then(() => {
				closed = true;
			});
			const joined = coordinator.close();
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(closed).toBe(false);
			} finally {
				release.resolve();
				await Promise.all([writing, closing, joined]);
			}
			if (kind === 'snapshot') {
				expect(await listDocumentSnapshots(root, DOC)).toHaveLength(1);
				expect(await text()).toBe('Original.');
			} else {
				expect(coordinator.get(`direct-${kind}`)?.state).toBe('committed');
				if (kind === 'binder')
					expect(await fs.readFile(binderPath, 'utf8')).toBe(binderAfter);
				else expect(await text()).toBe('Direct replacement.');
			}
			await expect(coordinator.recover()).resolves.toEqual([]);
		}
	);

	it('joins a reopened mutation when another shutdown finishes in the same microtask turn', async () => {
		const coordinator = writer.coordinator;
		const firstEntered = deferred();
		const firstRelease = deferred();
		const secondEntered = deferred();
		const secondRelease = deferred();
		const read = coordinator.readRaw.bind(coordinator);
		jest.spyOn(coordinator, 'readRaw')
			.mockImplementationOnce(async (id) => {
				firstEntered.resolve();
				await firstRelease.promise;
				return read(id);
			})
			.mockImplementationOnce(async (id) => {
				secondEntered.resolve();
				await secondRelease.promise;
				return read(id);
			});
		const lifecycle = coordinator as unknown as { closeStore(): void };
		const closeStore = lifecycle.closeStore.bind(coordinator);
		let nextMutation: Promise<unknown> | undefined;
		let nextClose: Promise<void> | undefined;
		let nextClosed = false;
		jest.spyOn(lifecycle, 'closeStore').mockImplementationOnce(() => {
			closeStore();
			queueMicrotask(() => {
				nextMutation = coordinator.snapshot(DOC, 'Reopened', new Date('2026-01-02'));
				nextClose = coordinator.close().then(() => {
					nextClosed = true;
				});
			});
		});
		const first = coordinator.snapshot(DOC, 'First', new Date('2026-01-01'));
		await firstEntered.promise;
		const closing = coordinator.close();
		firstRelease.resolve();
		await Promise.all([first, closing, secondEntered.promise]);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(nextClosed).toBe(false);
		} finally {
			secondRelease.resolve();
			await Promise.all([nextMutation, nextClose]);
		}
		expect(await listDocumentSnapshots(root, DOC)).toHaveLength(2);
	});

	it('releases the coordinator journal after an admitted mutation fails during shutdown', async () => {
		const coordinator = writer.coordinator;
		const entered = deferred();
		const release = deferred();
		jest.spyOn(fs, 'open').mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error('Saved read failed');
		});
		const writing = expect(
			coordinator.commit(DOC, rtf.convertToRTF('Unread replacement.'))
		).rejects.toThrow('Saved read failed');
		await entered.promise;
		const closing = expect(coordinator.close()).rejects.toThrow('Saved read failed');
		release.resolve();
		await Promise.all([writing, closing]);
		await coordinator.close();
		await coordinator.commit(DOC, rtf.convertToRTF('Reviewed replacement.'));
		expect(await text()).toBe('Reviewed replacement.');
	});
});
