import { afterEach, beforeEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'sqlite12');
const BEFORE = { text: 'Café — 東京 😀', revision: 12 };
const stores = new Set<PersistentStore>();
let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'scrivener-sqlite-upgrade-'));
});

afterEach(async () => {
	try {
		for (const store of stores) store.close();
	} finally {
		stores.clear();
		await rm(directory, { recursive: true, force: true });
	}
});

function openStore(file: string): PersistentStore {
	const store = new PersistentStore(file);
	stores.add(store);
	return store;
}

async function copyFixture(name: 'baseline' | 'interrupted'): Promise<string> {
	const file = join(directory, `${name}.sqlite`);
	await copyFile(join(FIXTURES, `${name}.sqlite`), file);
	if (name === 'interrupted')
		await copyFile(join(FIXTURES, `${name}.sqlite-wal`), `${file}-wal`);
	return file;
}

it.each(['baseline', 'interrupted'] as const)(
	'reopens v12 %s state with the current driver and preserves subsequent commits',
	async (name) => {
		const file = await copyFixture(name);
		if (name === 'interrupted') {
			const withoutWal = join(directory, 'without-wal.sqlite');
			await copyFile(join(FIXTURES, 'interrupted.sqlite'), withoutWal);
			const checkpointOnly = openStore(withoutWal);
			expect(checkpointOnly.get('upgrade', 'before')).toEqual(BEFORE);
			expect(checkpointOnly.get('upgrade', 'committed')).toBeUndefined();
			checkpointOnly.close();
		}

		const store = openStore(file);
		expect(store.get('upgrade', 'before')).toEqual(BEFORE);
		expect(store.get('upgrade', 'committed')).toEqual(
			name === 'interrupted' ? { checkpoint: true } : undefined
		);
		store.transaction(() => store.put('upgrade', 'after', { revision: 13 }));
		store.close();

		const reopened = openStore(file);
		expect(reopened.get('upgrade', 'before')).toEqual(BEFORE);
		expect(reopened.get('upgrade', 'after')).toEqual({ revision: 13 });
		expect(reopened.get('upgrade', 'committed')).toEqual(
			name === 'interrupted' ? { checkpoint: true } : undefined
		);
		reopened.close();

		const inspected = new Database(file);
		try {
			expect(inspected.pragma('user_version', { simple: true })).toBe(1);
			expect(inspected.pragma('journal_mode', { simple: true })).toBe('wal');
			expect(inspected.pragma('integrity_check', { simple: true })).toBe('ok');
		} finally {
			inspected.close();
		}
	}
);

it('preserves savepoint and outer rollback boundaries after upgrading a v12 database', async () => {
	const file = await copyFixture('baseline');
	const store = openStore(file);
	store.transaction(() => {
		store.put('upgrade', 'outer', { committed: true });
		expect(() =>
			store.transaction(() => {
				store.delete('upgrade', 'before');
				store.put('upgrade', 'inner', { committed: false });
				throw new Error('rollback savepoint');
			})
		).toThrow('rollback savepoint');
		expect(store.get('upgrade', 'before')).toEqual(BEFORE);
	});
	expect(() =>
		store.transaction(() => {
			store.delete('upgrade', 'before');
			store.transaction(() => store.put('upgrade', 'nested', { committed: false }));
			throw new Error('rollback outer transaction');
		})
	).toThrow('rollback outer transaction');
	store.close();

	const reopened = openStore(file);
	expect(reopened.get('upgrade', 'before')).toEqual(BEFORE);
	expect(reopened.get('upgrade', 'outer')).toEqual({ committed: true });
	expect(reopened.get('upgrade', 'inner')).toBeUndefined();
	expect(reopened.get('upgrade', 'nested')).toBeUndefined();
});

it('serializes competing process claims and retains the winner after reopening an upgraded database', async () => {
	const file = await copyFixture('baseline');
	const store = openStore(file);
	const script = `
const Database = require('better-sqlite3');
const database = new Database(process.argv[1]);
database.pragma('busy_timeout = 5000');
process.once('message', () => {
	let winner;
	try {
		winner = database.transaction(() => {
			const row = database.prepare('SELECT value FROM editorial_state WHERE namespace = ? AND id = ?').get('upgrade', 'claim');
			if (row) return JSON.parse(row.value);
			const claim = { owner: 'child' };
			database.prepare('INSERT INTO editorial_state(namespace, id, value) VALUES (?, ?, ?)').run('upgrade', 'claim', JSON.stringify(claim));
			return claim;
		}).immediate();
	} finally {
		database.close();
	}
	process.send(winner, () => process.disconnect());
});
process.send('ready');
`;
	const child = spawn(process.execPath, ['-e', script, file], {
		cwd: process.cwd(),
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
	});
	const exited = once(child, 'exit');
	const nextMessage = (): Promise<unknown> =>
		Promise.race([
			once(child, 'message').then(([message]) => message),
			exited.then(([code, signal]) => {
				throw new Error(`Claim process exited before reporting: ${code ?? signal}`);
			}),
		]);
	let childClaim: Promise<unknown> | undefined;
	try {
		expect(await nextMessage()).toBe('ready');
		childClaim = nextMessage();
		child.send('claim');
		const winner = store.transaction(() => {
			const existing = store.get<{ owner: string }>('upgrade', 'claim');
			if (existing) return existing;
			const claim = { owner: 'parent' };
			store.put('upgrade', 'claim', claim);
			return claim;
		});
		expect(['parent', 'child']).toContain(winner.owner);
		expect(await childClaim).toEqual(winner);
		expect(await exited).toEqual([0, null]);
		store.close();
		const reopened = openStore(file);
		expect(reopened.get('upgrade', 'claim')).toEqual(winner);
		expect(reopened.get('upgrade', 'before')).toEqual(BEFORE);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await Promise.allSettled(childClaim ? [exited, childClaim] : [exited]);
	}
});
