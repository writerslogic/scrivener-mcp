import Database from 'better-sqlite3';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

it('rejects directory state targets before opening SQLite', async () => {
	await mkdir(file);
	expect(() => new PersistentStore(file)).toThrow(/regular file/);
});

(process.platform === 'win32' ? it.skip : it)(
	'rejects symlink and FIFO state files without modifying their targets or blocking',
	async () => {
		const target = join(root, 'external');
		await writeFile(target, 'must remain unchanged');
		await symlink(target, file);
		expect(() => new PersistentStore(file)).toThrow(/symlink/);
		expect(await readFile(target, 'utf8')).toBe('must remain unchanged');
		await rm(file);
		execFileSync('mkfifo', [file]);
		const loader = createRequire(resolve('package.json')).resolve('tsx');
		const check =
			"const {pathToFileURL}=await import('node:url'); const {PersistentStore}=await import(pathToFileURL(process.argv[1]).href); try { new PersistentStore(process.argv[2]); process.exitCode=1; } catch(error) { process.stdout.write(error.message); }";
		const result = execFileSync(
			process.execPath,
			[
				'--import',
				loader,
				'--input-type=module',
				'-e',
				check,
				resolve('src/services/editorial/persistent-store.ts'),
				file,
			],
			{ timeout: 5000, maxBuffer: 4096, encoding: 'utf8' }
		);
		expect(result).toMatch(/regular file/);
	}
);

it('migrates the empty schema, rolls back interrupted transitions and preserves committed state across restart', () => {
	const store = new PersistentStore(file);
	try {
		store.put('identity', 'project', 'stable-project');
		expect(() =>
			store.transaction(() => {
				store.put('review', 'operation', { state: 'committed' });
				store.put('identity', 'project', 'wrong-project');
				throw new Error('simulated interruption');
			})
		).toThrow('simulated interruption');
	} finally {
		store.close();
	}
	const reopened = new PersistentStore(file);
	try {
		expect(reopened.get('identity', 'project')).toBe('stable-project');
		expect(reopened.list('review')).toEqual([]);
		expect(() =>
			reopened.transaction(() => {
				reopened.put('review', 'escaped', { state: 'unexpected' });
				return Promise.resolve();
			})
		).toThrow('must be synchronous');
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
		expect(() =>
			store.transaction(async () => {
				store.put('review', 'before-await', { state: 'unexpected' });
				await Promise.resolve();
				store.put('review', 'after-await', { state: 'unexpected' });
			})
		).toThrow('must be synchronous');
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

it('pages durable state with bounded SQL projections and stable cursors under insertions and deletions', () => {
	let store = new PersistentStore(file);
	try {
		for (const id of ['01', '02', '03'])
			store.put('history', id, {
				id,
				title: id,
				before: 'private manuscript'.repeat(1000),
				edits: [{ text: 'replacement' }],
			});
		store.put('unrelated', '04', { id: '04' });
		store.put('flags', 'one', {
			enabled: true,
			disabled: false,
			optional: undefined,
			detail: { empty: null, count: 0 },
		});
		expect(
			store.page('flags', {}, ['enabled', 'disabled', 'optional', 'detail']).items
		).toEqual([{ enabled: true, disabled: false, detail: { empty: null, count: 0 } }]);
		const page = store.page<{ id: string; title: string }>('history', { limit: 2 }, [
			'id',
			'title',
		]);
		expect(page).toEqual({
			items: [
				{ id: '01', title: '01' },
				{ id: '02', title: '02' },
			],
			nextCursor: '02',
		});
		store.delete('history', '01');
		store.put('history', '00', { id: '00', title: 'earlier' });
		store.close();
		store = new PersistentStore(file);
		expect(
			store.page('history', { after: page.nextCursor!, limit: 2 }, ['id', 'title'])
		).toEqual({ items: [{ id: '03', title: '03' }], nextCursor: null });
		expect(store.page('history', { after: "x' OR 1=1 --" })).toEqual({
			items: [],
			nextCursor: null,
		});
		for (const limit of [0, 101, 1.5])
			expect(() => store.page('history', { limit })).toThrow(/limit/);
		for (const limit of [1, 99, 100])
			expect(store.page('history', { limit }).items.length).toBeLessThanOrEqual(limit);
		expect(() => store.page('history', {}, ['id); DROP TABLE editorial_state;--'])).toThrow(
			/projection/
		);
	} finally {
		store.close();
	}
});
