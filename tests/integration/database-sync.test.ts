import { SQLQueryBuilder } from '../../src/handlers/database/query-builder.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/handlers/database/database-sync.js';
import { CachedSQLiteManager, KeyDBCache } from '../../src/handlers/database/keydb-cache.js';
import type { Neo4jManager } from '../../src/handlers/database/neo4j-manager.js';
import { SQLiteManager } from '../../src/handlers/database/sqlite-manager.js';
import { TransactionCoordinator } from '../../src/handlers/database/transaction-coordinator.js';
import { JobQueueService, JobType } from '../../src/services/queue/job-queue.js';

const IDS = [
	'11111111-1111-4111-8111-111111111111',
	'22222222-2222-4222-8222-222222222222',
	'33333333-3333-4333-8333-333333333333',
];

function document(id: string, title = 'Original') {
	return { id, title, type: 'Text', path: `/Files/Data/${id}/content.rtf` };
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe('database synchronization with real SQLite', () => {
	let root: string;
	let sqlite: SQLiteManager;
	let sync: DatabaseSync;
	let transactions: TransactionCoordinator;
	let graph:
		| (Pick<Neo4jManager, 'isAvailable' | 'upsertDocument'> &
				Partial<Pick<Neo4jManager, 'upsertCharacter' | 'createRelationship'>>)
		| null;
	let queue: JobQueueService | undefined;

	beforeEach(async () => {
		jest.spyOn(CachedSQLiteManager.prototype, 'initialize').mockResolvedValue(undefined);
		root = await mkdtemp(join(tmpdir(), 'scrivener-db-sync-'));
		sqlite = new SQLiteManager(join(root, 'database.sqlite'));
		await sqlite.initialize();
		sqlite.getDatabase().pragma('foreign_keys = ON');
		sqlite.execute(`CREATE TABLE sync_markers (
			document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
			marker TEXT NOT NULL
		)`);
		transactions = new TransactionCoordinator(() => sqlite);
		graph = null;
		sync = new DatabaseSync(
			() => sqlite,
			() => graph as Neo4jManager | null
		);
	});

	afterEach(async () => {
		await queue?.shutdown();
		queue = undefined;
		await sqlite.close();
		await rm(root, { recursive: true, force: true });
		jest.restoreAllMocks();
	});

	it('uses SQLite when the configured graph is unavailable for characters and relationships', async () => {
		const upsertCharacter = jest.fn().mockRejectedValue(new Error('Disconnected graph'));
		const createRelationship = jest.fn().mockRejectedValue(new Error('Disconnected graph'));
		graph = {
			isAvailable: () => false,
			upsertDocument: jest.fn(),
			upsertCharacter,
			createRelationship,
		};
		await sync.syncCharacterData({ id: 'mara', name: 'Mara' });
		await sync.syncDocumentData(document(IDS[0]));
		await sync.syncDocumentData(document(IDS[1]));
		await sync.createRelationship(IDS[0], 'document', IDS[1], 'document', 'follows');
		expect(sqlite.queryOne('SELECT name FROM characters WHERE id = ?', ['mara'])).toEqual({
			name: 'Mara',
		});
		expect(sqlite.query('SELECT * FROM document_relationships')).toHaveLength(1);
		expect(upsertCharacter).not.toHaveBeenCalled();
		expect(createRelationship).not.toHaveBeenCalled();
	});

	it.each([0, 1, 2])(
		'restricts IN lists containing %i IDs, including alongside OR expressions',
		async (count) => {
			for (const id of IDS) await sync.syncDocumentData(document(id));
			const { sql, params } = new SQLQueryBuilder()
				.from('documents')
				.where('title = ? OR title IS NULL', 'Original')
				.whereIn('id', IDS.slice(0, count))
				.build();
			expect(sqlite.query(sql, params)).toHaveLength(count);
		}
	);

	function cachedQueries() {
		const entries = new Map<string, unknown>();
		jest.spyOn(KeyDBCache.prototype, 'isAvailable').mockReturnValue(true);
		jest.spyOn(KeyDBCache.prototype, 'get').mockImplementation(
			async (key) => entries.get(key) ?? null
		);
		jest.spyOn(KeyDBCache.prototype, 'set').mockImplementation(async (key, value) => {
			entries.set(key, value);
			return true;
		});
		return new CachedSQLiteManager(sqlite);
	}

	it('separates known 32-bit collision parameters and query result shapes', async () => {
		const cached = cachedQueries();
		for (const value of ['Aa', 'BB']) {
			expect(await cached.query('SELECT ? AS value', [value])).toEqual([{ value }]);
			expect(await cached.queryOne('SELECT ? AS value', [value])).toEqual({ value });
		}
	});

	it('observes wrapper writes, direct writes, transactions and commits from another connection', async () => {
		const cached = cachedQueries();
		await sync.syncDocumentData(document(IDS[0]));
		const sql = 'SELECT title FROM documents WHERE id = ?';
		expect(await cached.queryOne(sql, [IDS[0]])).toEqual({ title: 'Original' });
		await cached.execute('UPDATE documents SET title = ?', ['Wrapper']);
		expect(await cached.queryOne(sql, [IDS[0]])).toEqual({ title: 'Wrapper' });
		await cached.transaction(() =>
			sqlite.execute('UPDATE documents SET title = ?', ['Transaction'])
		);
		expect(await cached.queryOne(sql, [IDS[0]])).toEqual({ title: 'Transaction' });
		sqlite.execute('UPDATE documents SET title = ?', ['Direct']);
		expect(await cached.queryOne(sql, [IDS[0]])).toEqual({ title: 'Direct' });
		const other = new SQLiteManager(join(root, 'database.sqlite'));
		await other.initialize();
		try {
			other.execute('UPDATE documents SET title = ?', ['Other connection']);
			expect(await cached.queryOne(sql, [IDS[0]])).toEqual({ title: 'Other connection' });
		} finally {
			await other.close();
		}
	});

	it('does not resurrect an old query when a cache fill finishes after a write', async () => {
		const cached = cachedQueries();
		await sync.syncDocumentData(document(IDS[0]));
		const entered = deferred(),
			release = deferred();
		const set = KeyDBCache.prototype.set;
		jest.spyOn(KeyDBCache.prototype, 'set').mockImplementationOnce(async function (
			this: KeyDBCache,
			key,
			value,
			ttl
		) {
			entered.resolve();
			await release.promise;
			return set.call(this, key, value, ttl);
		});
		const sql = 'SELECT title FROM documents WHERE id = ?';
		const pending = cached.queryOne(sql, [IDS[0]]);
		await entered.promise;
		try {
			await cached.execute('UPDATE documents SET title = ?', ['Current']);
			expect(await cached.queryOne(sql, [IDS[0]])).toEqual({ title: 'Current' });
		} finally {
			release.resolve();
			await pending;
		}
		expect(await cached.queryOne(sql, [IDS[0]])).toEqual({ title: 'Current' });
	});

	it('updates documents without deleting dependent rows or resetting unrelated fields', async () => {
		await sync.syncDocumentData(document(IDS[0]));
		sqlite.execute('UPDATE documents SET created_at = ?, include_in_compile = 0 WHERE id = ?', [
			'2000-01-01',
			IDS[0],
		]);
		sqlite.execute('INSERT INTO sync_markers VALUES (?, ?)', [IDS[0], 'keep']);
		const original = sqlite.queryOne('SELECT rowid FROM documents WHERE id = ?', [IDS[0]]) as {
			rowid: number;
		};

		await sync.syncDocumentData({ ...document(IDS[0], 'Updated'), wordCount: 12 });

		expect(
			sqlite.queryOne(
				'SELECT rowid, title, word_count, created_at, include_in_compile FROM documents WHERE id = ?',
				[IDS[0]]
			)
		).toEqual({
			rowid: original.rowid,
			title: 'Updated',
			word_count: 12,
			created_at: '2000-01-01',
			include_in_compile: 0,
		});
		expect(sqlite.query('SELECT * FROM sync_markers')).toEqual([
			{ document_id: IDS[0], marker: 'keep' },
		]);
	});

	it('preserves character arcs and appearances during a profile sync', async () => {
		await sync.syncCharacterData({ id: 'mara', name: 'Mara', role: 'Captain' });
		sqlite.execute(
			'UPDATE characters SET character_arc = ?, appearances = ?, created_at = ? WHERE id = ?',
			['Learns to trust', '["scene"]', '2000-01-01', 'mara']
		);
		await sync.syncCharacterData({ id: 'mara', name: 'Mara', role: 'Explorer' });
		expect(
			sqlite.queryOne(
				'SELECT role, character_arc, appearances, created_at FROM characters WHERE id = ?',
				['mara']
			)
		).toEqual({
			role: 'Explorer',
			character_arc: 'Learns to trust',
			appearances: '["scene"]',
			created_at: '2000-01-01',
		});
	});

	it('rejects a character name collision without deleting either identity', async () => {
		await sync.syncCharacterData({ id: 'mara', name: 'Mara' });
		await sync.syncCharacterData({ id: 'elin', name: 'Elin' });
		await expect(sync.syncCharacterData({ id: 'elin', name: 'Mara' })).rejects.toMatchObject({
			errcode: 2067,
		});
		expect(sqlite.query('SELECT id, name FROM characters ORDER BY id')).toEqual([
			{ id: 'elin', name: 'Elin' },
			{ id: 'mara', name: 'Mara' },
		]);
	});

	it('keeps graph waits outside SQLite transactions and isolates concurrent failures', async () => {
		const entered = deferred();
		const release = deferred();
		graph = {
			isAvailable: () => true,
			upsertDocument: async (doc) => {
				if (doc.id === IDS[0]) {
					entered.resolve();
					await release.promise;
				}
			},
		};
		const failed = sync.syncDocumentData(document(IDS[0]));
		const rejection = expect(failed).rejects.toThrow('Graph failed');
		await entered.promise;
		try {
			expect(sqlite.getDatabase().isTransaction).toBe(false);
			await sync.syncDocumentData(document(IDS[1], 'Successful'));
		} finally {
			release.reject(new Error('Graph failed'));
			await rejection;
		}
		expect(sqlite.query('SELECT id, title FROM documents')).toEqual([
			{ id: IDS[1], title: 'Successful' },
		]);
		expect(sqlite.getDatabase().isTransaction).toBe(false);
	});

	it('leaves existing local data unchanged if the optional graph rejects an update', async () => {
		await sync.syncDocumentData(document(IDS[0]));
		graph = {
			isAvailable: () => true,
			upsertDocument: async () => {
				throw new Error('Graph failed');
			},
		};
		await expect(sync.syncDocumentData(document(IDS[0], 'Rejected'))).rejects.toThrow(
			'Graph failed'
		);
		expect(sqlite.queryOne('SELECT title FROM documents WHERE id = ?', [IDS[0]])).toEqual({
			title: 'Original',
		});
	});

	it('fails if the captured SQLite owner closes during graph I/O instead of reporting a skipped write as success', async () => {
		const entered = deferred();
		const release = deferred();
		let current: SQLiteManager | null = sqlite;
		graph = {
			isAvailable: () => true,
			upsertDocument: async () => {
				entered.resolve();
				await release.promise;
			},
		};
		const ownedSync = new DatabaseSync(
			() => current,
			() => graph as Neo4jManager
		);
		const pending = ownedSync.syncDocumentData(document(IDS[0]));
		const rejection = expect(pending).rejects.toThrow('Database not initialized');
		await entered.promise;
		try {
			await sqlite.close();
			current = null;
		} finally {
			release.resolve();
		}
		await rejection;
	});

	it('reports queued partial successes only for rows that remain committed', async () => {
		graph = {
			isAvailable: () => true,
			upsertDocument: async (doc) => {
				if (doc.id === IDS[1]) throw new Error('Graph failed');
			},
		};
		queue = new JobQueueService(root);
		await queue.initialize({ sqliteOnly: true, redisUrl: 'redis://127.0.0.1:1' });
		const initializedDatabase = (
			queue as unknown as { databaseService: { close(): Promise<void> } }
		).databaseService;
		await initializedDatabase.close();
		Object.assign(queue, {
			databaseService: {
				syncDocumentData: sync.syncDocumentData.bind(sync),
				beginTransaction: transactions.begin.bind(transactions),
				prepareTransaction: transactions.prepare.bind(transactions),
				commitTransaction: transactions.commit.bind(transactions),
				rollbackTransaction: transactions.rollback.bind(transactions),
				close: async () => {},
			},
		});
		const id = await queue.addJob(JobType.SYNC_DATABASE, {
			documents: IDS.map((id) => ({ id, content: 'Scene content.' })),
		});
		const status = await queue.waitForJob(JobType.SYNC_DATABASE, id);
		expect(status).toMatchObject({
			state: 'completed',
			result: {
				synced: 2,
				total: 3,
				failed: 1,
				errors: [{ documentId: IDS[1], error: 'Graph failed' }],
			},
		});
		expect(sqlite.query('SELECT id FROM documents ORDER BY id')).toEqual([
			{ id: IDS[0] },
			{ id: IDS[2] },
		]);
		expect(sqlite.getDatabase().isTransaction).toBe(false);
	});
});
