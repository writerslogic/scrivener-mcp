import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/handlers/database/database-sync.js';
import { CachedSQLiteManager } from '../../src/handlers/database/keydb-cache.js';
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
	let graph: Pick<Neo4jManager, 'isAvailable' | 'upsertDocument'> | null;
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
			() => graph as Neo4jManager | null,
			() => null,
			transactions
		);
	});

	afterEach(async () => {
		await queue?.shutdown();
		queue = undefined;
		await sqlite.close();
		await rm(root, { recursive: true, force: true });
		jest.restoreAllMocks();
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
			code: 'SQLITE_CONSTRAINT_UNIQUE',
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
			expect(sqlite.getDatabase().inTransaction).toBe(false);
			await sync.syncDocumentData(document(IDS[1], 'Successful'));
		} finally {
			release.reject(new Error('Graph failed'));
			await rejection;
		}
		expect(sqlite.query('SELECT id, title FROM documents')).toEqual([
			{ id: IDS[1], title: 'Successful' },
		]);
		expect(sqlite.getDatabase().inTransaction).toBe(false);
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
			() => graph as Neo4jManager,
			() => null
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
		Object.assign(queue, {
			isInitialized: true,
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
		expect(sqlite.getDatabase().inTransaction).toBe(false);
	});
});
