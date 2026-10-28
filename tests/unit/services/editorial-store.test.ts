import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';

it('migrates the empty schema, rolls back interrupted transitions and preserves committed state across restart', async () => {
	const root = await mkdtemp(join(tmpdir(), 'editorial-migration-'));
	const file = join(root, 'state.sqlite');
	try {
		const store = new PersistentStore(file);
		store.put('identity', 'project', 'stable-project');
		expect(() =>
			store.transaction(() => {
				store.put('review', 'operation', { state: 'committed' });
				store.put('identity', 'project', 'wrong-project');
				throw new Error('simulated interruption');
			})
		).toThrow('simulated interruption');
		store.close();
		const reopened = new PersistentStore(file);
		expect(reopened.get('identity', 'project')).toBe('stable-project');
		expect(reopened.list('review')).toEqual([]);
		expect(() => reopened.transaction(() => Promise.resolve())).toThrow('must be synchronous');
		reopened.close();
		const future = new Database(file);
		future.pragma('user_version = 2');
		future.close();
		expect(() => new PersistentStore(file)).toThrow('newer than this server');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
