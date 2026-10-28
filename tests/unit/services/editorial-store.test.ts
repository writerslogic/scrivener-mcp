import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';

let root: string;
let file: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'editorial-migration-'));
	file = join(root, 'state.sqlite');
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it('migrates the empty schema, rolls back interrupted transitions and preserves committed state across restart', () => {
	const store = new PersistentStore(file);
	try {
		store.put('identity', 'project', 'stable-project');
		expect(() => store.transaction(() => {
			store.put('review', 'operation', { state: 'committed' });
			store.put('identity', 'project', 'wrong-project');
			throw new Error('simulated interruption');
		})).toThrow('simulated interruption');
	} finally {
		store.close();
	}
	const reopened = new PersistentStore(file);
	try {
		expect(reopened.get('identity', 'project')).toBe('stable-project');
		expect(reopened.list('review')).toEqual([]);
		expect(() => reopened.transaction(() => {
			reopened.put('review', 'escaped', { state: 'unexpected' });
			return Promise.resolve();
		})).toThrow('must be synchronous');
		expect(reopened.list('review')).toEqual([]);
	} finally {
		reopened.close();
		reopened.close();
	}
	const future = new Database(file);
	try {
		future.pragma('journal_mode = DELETE');
		future.pragma('user_version = 2');
	} finally {
		future.close();
	}
	expect(() => new PersistentStore(file)).toThrow('newer than this server');
	const inspected = new Database(file);
	try {
		expect(inspected.pragma('user_version', { simple: true })).toBe(2);
		expect(inspected.pragma('journal_mode', { simple: true })).toBe('delete');
	} finally {
		inspected.close();
	}
});

it('rejects native async transactions before their writes can escape a rollback', async () => {
	const store = new PersistentStore(file);
	try {
		expect(() => store.transaction(async () => {
			store.put('review', 'before-await', { state: 'unexpected' });
			await Promise.resolve();
			store.put('review', 'after-await', { state: 'unexpected' });
		})).toThrow('must be synchronous');
		await Promise.resolve();
		expect(store.list('review')).toEqual([]);
	} finally {
		store.close();
	}
});

it('fails initialization on an incompatible state table and releases the failed connection', () => {
	const invalid = new Database(file);
	try {
		invalid.exec('CREATE TABLE editorial_state (obsolete TEXT)');
		invalid.pragma('user_version = 1');
	} finally {
		invalid.close();
	}
	expect(() => new PersistentStore(file)).toThrow(/column/i);
	const repaired = new Database(file);
	try {
		repaired.exec('DROP TABLE editorial_state');
		repaired.pragma('user_version = 0');
	} finally {
		repaired.close();
	}
	const reopened = new PersistentStore(file);
	try {
		reopened.put('identity', 'project', 'recovered-project');
		expect(reopened.get('identity', 'project')).toBe('recovered-project');
	} finally {
		reopened.close();
	}
});
