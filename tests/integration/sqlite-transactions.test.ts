import Database from 'better-sqlite3';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteManager } from '../../src/handlers/database/sqlite-manager.js';
import { CachedSQLiteManager } from '../../src/handlers/database/keydb-cache.js';
import { TransactionCoordinator } from '../../src/handlers/database/transaction-coordinator.js';
import { DatabaseService } from '../../src/handlers/database/database-service.js';
import { DatabaseSetup } from '../../src/handlers/database/database-setup.js';
import { Neo4jManager } from '../../src/handlers/database/neo4j-manager.js';
import { MigrationManager } from '../../src/handlers/database/migrations.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((notify) => {
		resolve = notify;
	});
	return { promise, resolve };
}

describe('SQLite transaction ownership and durability', () => {
	let root: string;
	let file: string;
	let sqlite: SQLiteManager;
	let coordinator: TransactionCoordinator;
	let connections: Database.Database[];
	let services: DatabaseService[];
	const insert = (value: string) => sqlite.execute('INSERT INTO tx_rows VALUES (?)', [value]);
	const rows = () => sqlite.query('SELECT value FROM tx_rows ORDER BY value');
	const finish = async (id: string) => {
		await coordinator.prepare(id);
		await coordinator.commit(id);
	};

	beforeEach(async () => {
		jest.spyOn(CachedSQLiteManager.prototype, 'initialize').mockResolvedValue(undefined);
		root = await mkdtemp(join(tmpdir(), 'scrivener-sqlite-transactions-'));
		file = join(root, 'project.sqlite');
		sqlite = new SQLiteManager(file);
		await sqlite.initialize();
		sqlite.getDatabase().exec('CREATE TABLE tx_rows(value TEXT PRIMARY KEY)');
		sqlite.getDatabase().pragma('busy_timeout = 0');
		coordinator = new TransactionCoordinator(() => sqlite);
		connections = [];
		services = [];
	});

	afterEach(async () => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		for (const service of services) await service.close();
		for (const db of connections) if (db.open) db.close();
		await sqlite.close();
		await rm(root, { recursive: true, force: true });
	});

	function connect(): Database.Database {
		const db = new Database(file);
		db.pragma('busy_timeout = 0');
		connections.push(db);
		return db;
	}

	function createService(): DatabaseService {
		jest.spyOn(DatabaseSetup, 'getCredentials').mockRejectedValue(
			new Error('SQLite-only initialization must not discover ambient credentials')
		);
		jest.spyOn(DatabaseSetup, 'checkNeo4jAvailability').mockRejectedValue(
			new Error('SQLite-only initialization must not probe graph services')
		);
		const service = new DatabaseService(root, {
			neo4j: { uri: 'bolt://127.0.0.1:7687', user: '', password: '', enabled: false },
		});
		services.push(service);
		return service;
	}

	it('rolls back a failed callback and keeps subsequent explicit commits usable', async () => {
		await expect(
			sqlite.transaction(() => {
				insert('lost');
				throw new Error('Abort');
			})
		).rejects.toThrow('Abort');
		expect(rows()).toEqual([]);
		sqlite.beginTransaction();
		insert('kept');
		sqlite.commit();
		expect(rows()).toEqual([{ value: 'kept' }]);
		expect(sqlite.getDatabase().inTransaction).toBe(false);
	});

	it('rejects an async callback before any writes can escape its transaction', async () => {
		await expect(
			sqlite.transaction(async () => {
				insert('before');
				await Promise.resolve();
				insert('after');
			})
		).rejects.toThrow('must be synchronous');
		await Promise.resolve();
		expect(rows()).toEqual([]);
		await expect(
			sqlite.transaction(() => {
				insert('promise');
				return Promise.resolve();
			})
		).rejects.toThrow(/promise/i);
		expect(rows()).toEqual([]);
	});

	it('supports balanced nested explicit scopes inside a synchronous callback', async () => {
		await expect(
			sqlite.transaction(() => {
				sqlite.beginTransaction();
				insert('nested');
				sqlite.commit();
				return 42;
			})
		).resolves.toBe(42);
		expect(rows()).toEqual([{ value: 'nested' }]);
		expect(sqlite.getDatabase().inTransaction).toBe(false);
	});

	it.each(['commit', 'begin', 'rollback'] as const)(
		'rejects a callback that changes its own %s scope',
		async (operation) => {
			await expect(
				sqlite.transaction(() => {
					insert('lost');
					if (operation === 'begin') sqlite.beginTransaction();
					else sqlite[operation]();
				})
			).rejects.toThrow(/transaction/i);
			expect(rows()).toEqual([]);
			await sqlite.transaction(() => insert('kept'));
			expect(rows()).toEqual([{ value: 'kept' }]);
		}
	);

	it('keeps a failed deferred commit retryable without losing its nesting depth', () => {
		const db = sqlite.getDatabase();
		db.pragma('foreign_keys = ON');
		db.exec(
			'CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)'
		);
		sqlite.beginTransaction();
		sqlite.execute('INSERT INTO children VALUES (7)');
		expect(() => sqlite.commit()).toThrow(/FOREIGN KEY/i);
		expect(db.inTransaction).toBe(true);
		sqlite.execute('INSERT INTO parents VALUES (7)');
		sqlite.commit();
		expect(db.inTransaction).toBe(false);
		expect(sqlite.query('SELECT parent FROM children')).toEqual([{ parent: 7 }]);
	});

	it.each(['manager', 'native'] as const)(
		'prevents writes from escaping after %s rollback inside a callback',
		async (method) => {
			await expect(
				sqlite.transaction(() => {
					insert('before');
					if (method === 'manager') sqlite.rollback();
					else sqlite.getDatabase().exec('ROLLBACK');
					insert('escaped');
				})
			).rejects.toThrow(/rolled back/);
			expect(rows()).toEqual([]);
			await sqlite.transaction(() => insert('kept'));
			expect(rows()).toEqual([{ value: 'kept' }]);
		}
	);

	it('recovers its scope after a transaction is rolled back through the native connection', () => {
		sqlite.beginTransaction();
		insert('lost');
		sqlite.getDatabase().exec('ROLLBACK');
		expect(() => sqlite.commit()).toThrow('no longer active');
		sqlite.beginTransaction();
		insert('kept');
		sqlite.commit();
		expect(rows()).toEqual([{ value: 'kept' }]);
	});

	it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid retry count %s before invoking a callback',
		async (retries) => {
			let invoked = false;
			await expect(
				sqlite.transaction(() => {
					invoked = true;
				}, retries)
			).rejects.toThrow('positive safe integer');
			expect(invoked).toBe(false);
		}
	);

	it('retries a genuine busy error without keeping a transaction open during backoff', async () => {
		jest.useFakeTimers();
		const competing = connect();
		competing.exec('BEGIN IMMEDIATE');
		let attempts = 0;
		const pending = sqlite.transaction(() => {
			attempts++;
			insert('kept');
		}, 2);
		expect(attempts).toBe(1);
		expect(sqlite.getDatabase().inTransaction).toBe(false);
		competing.exec('ROLLBACK');
		await jest.advanceTimersByTimeAsync(100);
		await pending;
		expect(attempts).toBe(2);
		expect(rows()).toEqual([{ value: 'kept' }]);
	});

	it('does not join another transaction that begins during retry backoff', async () => {
		jest.useFakeTimers();
		const competing = connect();
		competing.exec('BEGIN IMMEDIATE');
		const pending = sqlite.transaction(() => insert('retry'), 2);
		const rejected = expect(pending).rejects.toThrow('Another transaction started');
		sqlite.beginTransaction();
		competing.exec('ROLLBACK');
		insert('owner');
		await jest.advanceTimersByTimeAsync(100);
		await rejected;
		expect(sqlite.getDatabase().inTransaction).toBe(true);
		sqlite.commit();
		expect(rows()).toEqual([{ value: 'owner' }]);
	});

	it('does not let stale transaction tickets affect a newer transaction', async () => {
		const committed = await coordinator.begin();
		insert('committed');
		await finish(committed);
		const aborted = await coordinator.begin();
		insert('aborted');
		await coordinator.rollback(aborted);
		const current = await coordinator.begin();
		insert('current');
		await coordinator.commit(committed);
		await expect(coordinator.rollback(committed)).rejects.toThrow('Committed transaction');
		await coordinator.rollback(aborted);
		await expect(coordinator.prepare(aborted)).rejects.toThrow('was rolled back');
		expect(sqlite.getDatabase().inTransaction).toBe(true);
		expect(connect().prepare('SELECT value FROM tx_rows ORDER BY value').all()).toEqual([
			{ value: 'committed' },
		]);
		await finish(current);
		expect(rows()).toEqual([{ value: 'committed' }, { value: 'current' }]);
	});

	it('requires nested commit order and reflects a root rollback in every child ticket', async () => {
		const rootId = await coordinator.begin();
		insert('root');
		const child = await coordinator.begin();
		insert('child');
		await coordinator.prepare(rootId);
		await expect(coordinator.commit(rootId)).rejects.toThrow('reverse begin order');
		await finish(child);
		const sibling = await coordinator.begin();
		insert('sibling');
		await finish(sibling);
		await coordinator.rollback(rootId);
		expect(rows()).toEqual([]);
		for (const id of [rootId, child, sibling])
			expect(coordinator.get(id)?.status).toBe('rolled_back');
		const next = await coordinator.begin();
		insert('next');
		await finish(next);
		expect(rows()).toEqual([{ value: 'next' }]);
	});

	it('does not publish a ticket if opening the native transaction fails', async () => {
		sqlite.getDatabase().exec('BEGIN');
		await expect(coordinator.begin()).rejects.toMatchObject({
			code: 'SQLITE_ERROR',
			message: expect.stringMatching(/transaction/i),
		});
		expect((coordinator as unknown as { log: Map<string, unknown> }).log.size).toBe(0);
		sqlite.getDatabase().exec('ROLLBACK');
		const id = await coordinator.begin();
		insert('kept');
		await finish(id);
		expect(rows()).toEqual([{ value: 'kept' }]);
	});

	it('invalidates old tickets after close and reopen without rolling back the new connection', async () => {
		const old = await coordinator.begin();
		insert('lost');
		await sqlite.close();
		await sqlite.initialize();
		await expect(coordinator.prepare(old)).rejects.toThrow('closed before completion');
		expect(coordinator.get(old)?.status).toBe('rolled_back');
		const current = await coordinator.begin();
		insert('kept');
		await coordinator.rollback(old);
		await finish(current);
		expect(rows()).toEqual([{ value: 'kept' }]);
	});

	it('coalesces initialization and makes a concurrent close join it', async () => {
		await sqlite.close();
		const entered = deferred(),
			release = deferred();
		jest.spyOn(CachedSQLiteManager.prototype, 'initialize').mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const first = sqlite.initialize();
		await entered.promise;
		const db = sqlite.getDatabase();
		const second = sqlite.initialize();
		const closing = sqlite.close();
		try {
			await Promise.resolve();
			expect(db.open).toBe(true);
		} finally {
			release.resolve();
			await Promise.all([first, second, closing]);
		}
		expect(db.open).toBe(false);
	});

	it('waits for an in-flight close before opening a new connection', async () => {
		const old = sqlite.getDatabase();
		const entered = deferred(),
			release = deferred();
		jest.spyOn(CachedSQLiteManager.prototype, 'close').mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const closing = sqlite.close();
		await entered.promise;
		const opening = sqlite.initialize();
		try {
			await Promise.resolve();
			expect(old.open).toBe(true);
		} finally {
			release.resolve();
			await Promise.all([closing, opening]);
		}
		expect(old.open).toBe(false);
		expect(sqlite.getDatabase()).not.toBe(old);
		await sqlite.transaction(() => insert('kept'));
		expect(rows()).toEqual([{ value: 'kept' }]);
	});

	it('honors a final close after an initialize request queued during a previous close', async () => {
		const entered = deferred();
		const release = deferred();
		jest.spyOn(CachedSQLiteManager.prototype, 'close').mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const firstClose = sqlite.close();
		await entered.promise;
		const opening = sqlite.initialize();
		const finalClose = sqlite.close();
		release.resolve();
		await Promise.all([firstClose, opening, finalClose]);
		expect(() => sqlite.getDatabase()).toThrow('not initialized');
		await sqlite.initialize();
		await sqlite.transaction(() => insert('kept'));
		expect(rows()).toEqual([{ value: 'kept' }]);
	});

	it('releases a failed initialization before a repaired schema is reopened', async () => {
		await sqlite.close();
		const invalid = connect();
		invalid.exec('DROP TABLE documents; CREATE TABLE documents(id TEXT PRIMARY KEY)');
		invalid.close();
		await expect(sqlite.initialize()).rejects.toMatchObject({
			code: 'SQLITE_ERROR',
			message: expect.stringMatching(/column/i),
		});
		expect(() => sqlite.getDatabase()).toThrow('not initialized');
		const repaired = connect();
		repaired.exec('DROP TABLE documents');
		repaired.close();
		await sqlite.initialize();
		await sqlite.transaction(() => insert('kept'));
		expect(rows()).toEqual([{ value: 'kept' }]);
	});

	it('closes SQLite despite optional cache teardown failure and permits a later reopen', async () => {
		const old = sqlite.getDatabase();
		jest.spyOn(CachedSQLiteManager.prototype, 'close').mockRejectedValueOnce(
			new Error('Cache close failed')
		);
		await expect(sqlite.close()).rejects.toThrow('Cache close failed');
		expect(old.open).toBe(false);
		await sqlite.initialize();
		expect(sqlite.getDatabase()).not.toBe(old);
	});

	it('returns a completed readable backup and accurate scalar page statistics', async () => {
		insert('backed up');
		const backup = join(root, 'backup.sqlite');
		await sqlite.backup(backup);
		const copy = new Database(backup, { readonly: true });
		connections.push(copy);
		expect(copy.prepare('SELECT value FROM tx_rows').all()).toEqual([{ value: 'backed up' }]);
		const stats = sqlite.getDatabaseStats();
		expect(stats.pageCount).toBeGreaterThan(0);
		expect(stats.pageSize).toBeGreaterThan(0);
		expect((await stat(backup)).size).toBe(stats.pageCount * stats.pageSize);
		await expect(
			sqlite.backup(join(root, 'missing-directory', 'backup.sqlite'))
		).rejects.toThrow();
	});

	it('makes DatabaseService backup wait for the SQLite copy rather than reporting early success', async () => {
		insert('backed up');
		const service = new DatabaseService(root);
		Object.assign(service, { sqliteManager: sqlite });
		const entered = deferred(),
			release = deferred();
		const db = sqlite.getDatabase();
		const backup = db.backup.bind(db);
		jest.spyOn(db, 'backup').mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return backup(...args);
		});
		let settled = false;
		const folder = join(root, 'service-backup');
		const pending = service.backup(folder).then(() => {
			settled = true;
		});
		await entered.promise;
		let closed = false;
		const closing = service.close().then(() => {
			closed = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			expect(closed).toBe(false);
		} finally {
			release.resolve();
			await Promise.all([pending, closing]);
		}
		expect(db.open).toBe(false);
		const files = await readdir(folder);
		expect(files).toHaveLength(1);
		const copy = new Database(join(folder, files[0]), { readonly: true });
		connections.push(copy);
		expect(copy.prepare('SELECT value FROM tx_rows').all()).toEqual([{ value: 'backed up' }]);
	});

	it('makes close drain an admitted backup before closing its source connection', async () => {
		insert('backed up');
		const entered = deferred();
		const release = deferred();
		const db = sqlite.getDatabase();
		const original = db.backup.bind(db);
		jest.spyOn(db, 'backup').mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		});
		const target = join(root, 'drained-backup.sqlite');
		const backup = sqlite.backup(target);
		await entered.promise;
		const closing = sqlite.close();
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(db.open).toBe(true);
		} finally {
			release.resolve();
			await Promise.all([backup, closing]);
		}
		expect(db.open).toBe(false);
		const copy = new Database(target, { readonly: true });
		connections.push(copy);
		expect(copy.prepare('SELECT value FROM tx_rows').all()).toEqual([{ value: 'backed up' }]);
	});

	it('serializes DatabaseService initialization and waits for storage to close before reopening', async () => {
		const service = createService();
		await Promise.all([service.initialize(), service.initialize()]);
		const storage = service.getSQLite();
		const old = storage.getDatabase();
		await service.syncDocumentData({
			id: 'persisted',
			title: 'Persisted',
			type: 'Text',
			path: '/persisted',
		});
		const entered = deferred();
		const release = deferred();
		const close = storage.close.bind(storage);
		jest.spyOn(storage, 'close').mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return close();
		});
		let closed = false;
		const closing = service.close().then(() => {
			closed = true;
		});
		await entered.promise;
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			expect(service.isInitialized()).toBe(false);
		} finally {
			release.resolve();
			await closing;
		}
		expect(old.open).toBe(false);
		await service.initialize();
		expect(service.isInitialized()).toBe(true);
		expect(
			service.getSQLite().queryOne('SELECT title FROM documents WHERE id = ?', ['persisted'])
		).toEqual({ title: 'Persisted' });
	});

	it.each([false, true])(
		'attempts every DatabaseService teardown and keeps failed owners retryable (both fail: %s)',
		async (bothFail) => {
			const service = createService();
			await service.initialize();
			const old = service.getSQLite().getDatabase();
			const graph = new Neo4jManager('bolt://127.0.0.1:7687', '', '');
			Object.assign(service, { neo4jManager: graph });
			const close = jest.spyOn(graph, 'close');
			if (bothFail) close.mockRejectedValueOnce(new Error('Graph close failed'));
			jest.spyOn(CachedSQLiteManager.prototype, 'close').mockRejectedValueOnce(
				new Error('Cache close failed')
			);
			await expect(service.close()).rejects.toThrow(
				bothFail ? 'Multiple database resources' : 'Cache close failed'
			);
			expect(close).toHaveBeenCalledTimes(1);
			expect(old.open).toBe(false);
			expect(service.isInitialized()).toBe(false);
			await service.close();
			expect(() => service.getSQLite()).toThrow('not initialized');
		}
	);

	it('releases DatabaseService storage after failed migrations and permits initialization retry', async () => {
		const service = createService();
		let failed: Database.Database | undefined;
		jest.spyOn(MigrationManager.prototype, 'migrate').mockImplementationOnce(async () => {
			failed = service.getSQLite().getDatabase();
			throw new Error('Migration failed');
		});
		await expect(service.initialize()).rejects.toThrow('Migration failed');
		expect(failed?.open).toBe(false);
		expect(service.isInitialized()).toBe(false);
		await service.initialize();
		expect(service.isInitialized()).toBe(true);
		await service.syncDocumentData({
			id: 'after-retry',
			title: 'After retry',
			type: 'Text',
			path: '/retry',
		});
		expect(
			service
				.getSQLite()
				.queryOne('SELECT title FROM documents WHERE id = ?', ['after-retry'])
		).toEqual({ title: 'After retry' });
	});
});
