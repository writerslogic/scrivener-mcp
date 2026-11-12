import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	MutationCoordinator,
	documentRevision,
	type MutationRecord,
} from '../../../src/services/editorial/mutation-coordinator.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import { mutationRetentionLimits } from '../../../src/services/editorial/mutation-retention.js';
import { listDocumentSnapshots } from '../../../src/services/snapshots.js';

const DOCUMENT = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const BEFORE = '{\\rtf1 Original text.}';
const AFTER = '{\\rtf1 Reviewed text.}';
let root: string;
let store: PersistentStore;
let coordinator: MutationCoordinator;
const content = (id = DOCUMENT) => join(root, 'Files', 'Data', id, 'content.rtf');
const usage = () =>
	store.get<{ bytes: number; records: number; entries: number }>(
		'mutation-meta',
		'retention-usage-v1'
	)!;

async function open(maxRecords = 2, maxBytes = 1024 * 1024): Promise<void> {
	root = await mkdtemp(join(tmpdir(), 'mutation-retention-'));
	for (const id of [DOCUMENT, OTHER]) {
		await mkdir(dirname(content(id)), { recursive: true });
		await writeFile(content(id), BEFORE);
	}
	store = new PersistentStore(join(root, '.scrivener-mcp', 'editorial.sqlite'));
	coordinator = new MutationCoordinator(root, store, false, { maxRecords, maxBytes });
}
async function cleanup(): Promise<void> {
	await coordinator.close();
	store.close();
	await rm(root, { recursive: true, force: true });
}
const apply = (id = 'reviewed') =>
	coordinator.commit(DOCUMENT, AFTER, {
		operationId: id,
		expectedRevision: documentRevision(BEFORE),
	});
const undo = () =>
	coordinator.commit(DOCUMENT, BEFORE, {
		operationId: 'inverse',
		undoes: 'reviewed',
		expectedRevision: documentRevision(AFTER),
		snapshotTitle: 'Before undo of reviewed edit',
	});

beforeEach(async () => {
	await open();
});
afterEach(async () => {
	jest.restoreAllMocks();
	await cleanup();
});

test.each([1, 2, 3])(
	'reserves both receipt slots at a %i record limit before staging manuscript data',
	async (maxRecords) => {
		await coordinator.close();
		coordinator = new MutationCoordinator(root, store, false, {
			maxRecords,
			maxBytes: 1024 * 1024,
		});
		if (maxRecords === 1) {
			await expect(apply()).rejects.toThrow('Mutation history capacity reached');
			expect(store.count('mutations')).toBe(0);
			expect(store.count('mutation-pending')).toBe(0);
			expect(store.count('mutation-claims')).toBe(0);
			expect(await readFile(content(), 'utf8')).toBe(BEFORE);
			expect(await listDocumentSnapshots(root, DOCUMENT)).toHaveLength(0);
		} else {
			await apply();
			expect(usage().records).toBe(2);
			await expect(
				coordinator.commit(DOCUMENT, BEFORE, { operationId: 'unrelated' })
			).rejects.toThrow('capacity');
			expect(await readFile(content(), 'utf8')).toBe(AFTER);
			expect(store.count('mutations')).toBe(1);
		}
	}
);

test('checks exact reserved-byte boundaries without staging rejected receipts', async () => {
	await apply();
	const requiredBytes = usage().bytes;
	for (const delta of [-1, 0, 1]) {
		await cleanup();
		await open(2, requiredBytes + delta);
		if (delta < 0) {
			await expect(apply()).rejects.toThrow('capacity');
			expect(usage()).toEqual({ bytes: 0, records: 0, entries: 0 });
			expect(await readFile(content(), 'utf8')).toBe(BEFORE);
			expect(await listDocumentSnapshots(root, DOCUMENT)).toHaveLength(0);
		} else {
			await apply();
			expect(usage().bytes).toBe(requiredBytes);
		}
	}
});

test('preserves replay and one inverse undo after restart below the existing reservation budget', async () => {
	await apply();
	const originalUsage = usage();
	await coordinator.close();
	store.close();
	store = new PersistentStore(join(root, '.scrivener-mcp', 'editorial.sqlite'));
	coordinator = new MutationCoordinator(root, store, false, { maxRecords: 1, maxBytes: 1 });
	await expect(apply()).resolves.toMatchObject({ id: 'reviewed', state: 'committed' });
	await expect(undo()).resolves.toMatchObject({ id: 'inverse', state: 'committed' });
	await expect(undo()).resolves.toMatchObject({ id: 'inverse', state: 'committed' });
	expect(await readFile(content(), 'utf8')).toBe(BEFORE);
	expect(usage()).toEqual({ ...originalUsage, entries: 2 });
	expect(await listDocumentSnapshots(root, DOCUMENT)).toHaveLength(2);
	await expect(
		coordinator.commit(DOCUMENT, AFTER, { operationId: 'redo', undoes: 'inverse' })
	).rejects.toThrow('capacity');
	await coordinator.close();
	coordinator = new MutationCoordinator(root, store, false, { maxRecords: 1, maxBytes: 1 });
	await expect(undo()).resolves.toMatchObject({ state: 'committed' });
	expect(usage()).toEqual({ ...originalUsage, entries: 2 });
});

test('cannot use undo metadata to spend another document or different content reservation', async () => {
	await apply();
	await expect(
		coordinator.commit(DOCUMENT, '{\\rtf1 Different}', {
			operationId: 'wrong-text',
			undoes: 'reviewed',
		})
	).rejects.toThrow('capacity');
	await writeFile(content(OTHER), AFTER);
	await expect(
		coordinator.commit(OTHER, BEFORE, { operationId: 'wrong-document', undoes: 'reviewed' })
	).rejects.toThrow('capacity');
	await undo();
	expect(store.count('mutations')).toBe(2);
});

test('reserved undo accommodates the longest operation identity and escaped snapshot metadata', async () => {
	await apply('a');
	await coordinator.close();
	coordinator = new MutationCoordinator(root, store, false, { maxRecords: 1, maxBytes: 1 });
	await coordinator.commit(DOCUMENT, BEFORE, {
		operationId: 'x'.repeat(128),
		undoes: 'a',
		snapshotTitle: '"'.repeat(512),
	});
	expect(await readFile(content(), 'utf8')).toBe(BEFORE);
	expect(usage().records).toBe(2);
});

test('an interrupted legacy reservation migration rolls back and can resume without altering receipts', async () => {
	await apply();
	const record = store.get('mutations', 'reviewed');
	store.delete('mutation-reservations', 'reviewed');
	await coordinator.close();
	coordinator = new MutationCoordinator(root, store, false, { maxRecords: 1, maxBytes: 1 });
	const put = store.put.bind(store);
	const fault = jest.spyOn(store, 'put').mockImplementation((namespace, id, value) => {
		if (namespace === 'mutation-meta' && id === 'retention-usage-v1')
			throw new Error('Synthetic migration interruption');
		put(namespace, id, value);
	});
	expect(() => coordinator.get('reviewed')).toThrow('Synthetic migration interruption');
	fault.mockRestore();
	expect(store.count('mutation-reservations')).toBe(0);
	expect(store.get('mutations', 'reviewed')).toEqual(record);
	await undo();
	expect(store.count('mutations')).toBe(2);
	expect(usage().records).toBe(2);
});

test('rolls back reservation and receipt together on initial database failure', async () => {
	const put = store.put.bind(store);
	const fault = jest.spyOn(store, 'put').mockImplementation((namespace, id, value) => {
		if (namespace === 'mutations') throw new Error('Synthetic disk full');
		put(namespace, id, value);
	});
	await expect(apply()).rejects.toThrow('Synthetic disk full');
	fault.mockRestore();
	expect(usage()).toEqual({ bytes: 0, records: 0, entries: 0 });
	expect(store.count('mutation-reservations')).toBe(0);
	expect(store.count('mutation-pending')).toBe(0);
	expect(await readFile(content(), 'utf8')).toBe(BEFORE);
	await apply();
	await undo();
	expect(usage().records).toBe(2);
});

test('recovers a published edit whose final receipt failed without charging admission again', async () => {
	const put = store.put.bind(store);
	const fault = jest.spyOn(store, 'put').mockImplementation((namespace, id, value) => {
		if (namespace === 'mutations' && (value as MutationRecord).state === 'committed')
			throw new Error('Synthetic commit failure');
		put(namespace, id, value);
	});
	await expect(apply()).rejects.toThrow('Synthetic commit failure');
	fault.mockRestore();
	const reserved = usage();
	expect(await readFile(content(), 'utf8')).toBe(AFTER);
	await coordinator.close();
	coordinator = new MutationCoordinator(root, store, false, { maxRecords: 1, maxBytes: 1 });
	await expect(coordinator.recover()).resolves.toEqual([
		expect.objectContaining({ state: 'committed' }),
	]);
	await apply();
	expect(usage()).toEqual(reserved);
	await undo();
	expect(usage()).toEqual({ ...reserved, entries: 2 });
});

test('recovers a failed inverse publication without allocating another undo reservation', async () => {
	await apply();
	const reserved = usage();
	const put = store.put.bind(store);
	const fault = jest.spyOn(store, 'put').mockImplementation((namespace, id, value) => {
		if (
			namespace === 'mutations' &&
			id === 'inverse' &&
			(value as MutationRecord).state === 'committed'
		)
			throw new Error('Synthetic inverse receipt failure');
		put(namespace, id, value);
	});
	await expect(undo()).rejects.toThrow('Synthetic inverse receipt failure');
	fault.mockRestore();
	await coordinator.close();
	coordinator = new MutationCoordinator(root, store, false, { maxRecords: 1, maxBytes: 1 });
	await coordinator.recover();
	await undo();
	expect(usage()).toEqual({ ...reserved, entries: 2 });
	expect(await readFile(content(), 'utf8')).toBe(BEFORE);
});

test('entry pages expose storage identities and exact UTF-8 bytes without materializing payloads', () => {
	store.put('entries', 'first', { id: 'misleading', text: '🌙'.repeat(1000) });
	store.put('entries', 'second', { id: 'also-misleading', text: 'é' });
	const page = store.pageEntries('entries', { limit: 1 });
	expect(page).toEqual({
		items: [
			{
				id: 'first',
				bytes: Buffer.byteLength(
					JSON.stringify({ id: 'misleading', text: '🌙'.repeat(1000) })
				),
			},
		],
		nextCursor: 'first',
	});
	expect(store.pageEntries('entries', { after: page.nextCursor!, limit: 1 })).toEqual({
		items: [
			{
				id: 'second',
				bytes: Buffer.byteLength(JSON.stringify({ id: 'also-misleading', text: 'é' })),
			},
		],
		nextCursor: null,
	});
	for (const limit of [0, 101])
		expect(() => store.pageEntries('entries', { limit })).toThrow('1–100');
	expect(store.pageEntries('entries', { limit: 100 }).items).toHaveLength(2);
	store.put('entries', '', { text: 'empty key' });
	expect(store.pageEntries('entries', { limit: 1 }).nextCursor).toBe('');
	expect(store.pageEntries('entries', { after: '', limit: 1 }).items[0].id).toBe('first');
});

test('does not silently skip an invalid empty mutation identity during migration', () => {
	store.put('mutations', '', { id: '', state: 'committed' });
	expect(() => coordinator.get('missing')).toThrow('Malformed mutation journal');
	expect(store.count('mutations')).toBe(1);
	expect(store.count('mutation-reservations')).toBe(0);
});

test('refuses export capacity before preparing an artifact and releases aborted export admission', async () => {
	const request = {
		operationId: 'export',
		requestHash: documentRevision('request'),
		outputPath: join(root, '.scrivener-mcp', 'exports', 'result.pdf'),
	};
	const prepare = jest.fn(async () => ({
		buffer: Buffer.from('result'),
		result: { format: 'text' },
	}));
	await expect(coordinator.publishExport(request, prepare)).rejects.toThrow('capacity');
	expect(prepare).not.toHaveBeenCalled();
	expect(store.count('mutations')).toBe(0);
	await coordinator.close();
	coordinator = new MutationCoordinator(root, store, false, {
		maxRecords: 1,
		maxBytes: 100 * 1024 * 1024,
	});
	await expect(
		coordinator.publishExport(request, async () => {
			throw new Error('Synthetic preparation failure');
		})
	).rejects.toThrow('Synthetic preparation failure');
	expect(usage()).toEqual({ bytes: 0, records: 0, entries: 0 });
	expect(store.count('mutation-reservations')).toBe(0);
	await coordinator.publishExport(request, prepare);
	await coordinator.publishExport(request, prepare);
	expect(prepare).toHaveBeenCalledTimes(1);
	expect(await readFile(request.outputPath, 'utf8')).toBe('result');
	expect(usage().records).toBe(1);
});

test('migrates legacy history through bounded metadata pages and retains every receipt above a new cap', async () => {
	for (let index = 0; index < 250; index++) {
		const id = `legacy-${String(index).padStart(3, '0')}`;
		store.put('mutations', id, {
			id,
			documentId: DOCUMENT,
			beforeRaw: BEFORE,
			afterRaw: AFTER,
			beforeRevision: documentRevision(BEFORE),
			afterRevision: documentRevision(AFTER),
			beforeExists: true,
			state: 'committed',
			createdAt: new Date().toISOString(),
		});
	}
	const unbounded = jest.spyOn(store, 'list').mockImplementation(() => {
		throw new Error('Unbounded history read');
	});
	expect(coordinator.get('legacy-249')?.afterRaw).toBe(AFTER);
	expect(unbounded).not.toHaveBeenCalled();
	unbounded.mockRestore();
	expect(usage().records).toBe(500);
	expect(store.count('mutations')).toBe(250);
	await expect(apply()).rejects.toThrow('capacity');
	await writeFile(content(), AFTER);
	await coordinator.commit(DOCUMENT, BEFORE, {
		operationId: 'legacy-undo',
		undoes: 'legacy-249',
	});
	expect(store.count('mutations')).toBe(251);
	expect(usage().records).toBe(500);
});

test.each(['0', '-1', '1.5', '1e3', 'NaN', '9007199254740992'])(
	'rejects unsafe retention configuration %s',
	(value) => {
		const prior = process.env.SCRIVENER_MUTATION_MAX_BYTES;
		try {
			process.env.SCRIVENER_MUTATION_MAX_BYTES = value;
			expect(mutationRetentionLimits).toThrow('positive safe integer');
		} finally {
			if (prior === undefined) delete process.env.SCRIVENER_MUTATION_MAX_BYTES;
			else process.env.SCRIVENER_MUTATION_MAX_BYTES = prior;
		}
	}
);

test.each([511, 512, 513])(
	'validates snapshot titles of length %i before staging',
	async (length) => {
		const promise = coordinator.commit(DOCUMENT, AFTER, { snapshotTitle: 'x'.repeat(length) });
		if (length <= 512) await expect(promise).resolves.toMatchObject({ state: 'committed' });
		else {
			await expect(promise).rejects.toThrow('Snapshot title');
			expect(store.count('mutations')).toBe(0);
		}
	}
);
