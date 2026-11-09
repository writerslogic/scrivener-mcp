import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSqliteBusy, openSqliteDatabase } from '../../../src/utils/sqlite.js';

test('bundles SQLite 3.54.1 or newer', () => {
	const db = openSqliteDatabase(':memory:');
	try {
		const { version } = db.prepare('SELECT sqlite_version() AS version').get() as {
			version: string;
		};
		const [major, minor, patch] = version.split('.').map(Number);
		expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(3_054_001);
	} finally {
		db.close();
	}
});

test('rejects values the driver would otherwise store as NULL or coerce', () => {
	const db = openSqliteDatabase(':memory:');
	try {
		db.exec('CREATE TABLE t(a)');
		const insert = db.prepare('INSERT INTO t(a) VALUES (?)');
		const named = db.prepare('INSERT INTO t(a) VALUES (@a)');
		for (const value of [new Date(0), true, [1], new Map(), () => 1, Symbol('s')]) {
			expect(() => insert.run(value)).toThrow(TypeError);
			expect(() => named.run({ a: value })).toThrow(TypeError);
		}
		expect(() => named.run({ a: { nested: 1 } })).toThrow(TypeError);
		for (const value of [null, undefined, 1, 1.5, 2n, 'text', new Uint8Array([1])])
			insert.run(value);
		named.run({ a: 'named' });
		expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 8 });
		expect(db.prepare('SELECT count(*) AS n FROM t WHERE a = ?').get(2)).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});

test('identifies SQLITE_BUSY from a competing connection but not other failures', async () => {
	const root = await mkdtemp(join(tmpdir(), 'scrivener-sqlite-'));
	const file = join(root, 'busy.sqlite');
	const owner = openSqliteDatabase(file);
	const competitor = openSqliteDatabase(file, { timeout: 0 });
	try {
		owner.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
		owner.exec('BEGIN IMMEDIATE');
		let busy: unknown;
		try {
			competitor.exec('BEGIN IMMEDIATE');
		} catch (error) {
			busy = error;
		}
		expect(isSqliteBusy(busy)).toBe(true);
		owner.exec('ROLLBACK');

		owner.exec('INSERT INTO t(id) VALUES (1)');
		expect(() => owner.exec('INSERT INTO t(id) VALUES (1)')).toThrow(/UNIQUE/);
		let constraint: unknown;
		try {
			owner.exec('INSERT INTO t(id) VALUES (1)');
		} catch (error) {
			constraint = error;
		}
		expect(isSqliteBusy(constraint)).toBe(false);
		expect(isSqliteBusy(new Error('database is locked'))).toBe(false);
	} finally {
		competitor.close();
		owner.close();
		await rm(root, { recursive: true, force: true });
	}
});
