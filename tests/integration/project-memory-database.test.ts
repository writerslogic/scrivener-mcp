import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from '../../src/memory-manager.js';
import type { DatabaseService } from '../../src/handlers/database/database-service.js';
import { SQLiteManager } from '../../src/handlers/database/sqlite-manager.js';
import { CachedSQLiteManager } from '../../src/handlers/database/keydb-cache.js';
import { MigrationManager } from '../../src/handlers/database/migrations.js';
import { readMemoryDatabase } from '../../src/services/memory/project-memory-database.js';

let root: string;
let file: string;
let sqlite: SQLiteManager;
let database: DatabaseService;
let memory: MemoryManager;

beforeEach(async () => {
	jest.spyOn(CachedSQLiteManager.prototype, 'initialize').mockResolvedValue(undefined);
	root = await mkdtemp(join(tmpdir(), 'scrivener-memory-database-'));
	file = join(root, '.ai-memory', 'project-memory.json');
	sqlite = new SQLiteManager(join(root, 'legacy.sqlite'));
	await sqlite.initialize();
	await new MigrationManager(sqlite, null).migrate();
	database = {
		isInitialized: () => true,
		getSQLite: () => sqlite,
		getNeo4j: () => null,
	} as unknown as DatabaseService;
	memory = new MemoryManager(root, database);
});

afterEach(async () => {
	await memory.stopAutoSave();
	await sqlite.close();
	jest.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

test('imports actual SQLite columns and missing facts without inventing profile or progress values', async () => {
	sqlite.execute(
		'INSERT INTO characters (id, name, character_arc, appearances) VALUES (?, ?, ?, ?)',
		['mara', 'Mara', 'Learns to trust', JSON.stringify(['scene-one'])]
	);
	sqlite.execute('INSERT INTO plot_threads (id, name, status, documents) VALUES (?, ?, ?, ?)', [
		'voyage',
		'Voyage',
		null,
		JSON.stringify(['scene-one']),
	]);
	sqlite.execute('INSERT INTO locations (id, name, type, significance) VALUES (?, ?, ?, ?)', [
		'port',
		'Port',
		null,
		null,
	]);
	sqlite.execute('INSERT INTO project_metadata (key, value) VALUES (?, ?)', [
		'custom_literal',
		JSON.stringify({ __type: 'Map', value: [['x', 'ordinary JSON']] }),
	]);
	await memory.initialize();
	expect(memory.getAllCharacters()).toEqual([
		{ id: 'mara', name: 'Mara', arc: 'Learns to trust', appearances: ['scene-one'] },
	]);
	expect(memory.getPlotThreads()).toEqual([
		{ id: 'voyage', name: 'Voyage', documents: ['scene-one'] },
	]);
	expect(memory.getWorldElements()).toEqual([{ id: 'port', name: 'Port', type: 'location' }]);
	expect(memory.getWritingStats()).toEqual({});
	expect(memory.getStyleGuide()).toEqual({});
	expect(memory.getCustomContext('literal')).toEqual({
		__type: 'Map',
		value: [['x', 'ordinary JSON']],
	});
});

test.each([
	['characters', "INSERT INTO characters (id, name, traits) VALUES ('bad', 'Mara', '{invalid')"],
	['metadata', "INSERT INTO project_metadata (key, value) VALUES ('style_guide', '{invalid')"],
	['snapshot', "INSERT INTO project_metadata (key, value) VALUES ('project_memory', '{invalid')"],
])('rejects corrupt %s JSON without creating an empty primary file', async (_kind, sql) => {
	sqlite.execute(sql);
	await expect(memory.initialize()).rejects.toThrow('Invalid project-memory database JSON');
	await memory.stopAutoSave();
	await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('uses the JSON primary when a stale database mirror is corrupt', async () => {
	await memory.initialize();
	await memory.remember({ memoryType: 'characters', data: { name: 'Mara' } });
	await memory.stopAutoSave();
	sqlite.execute('UPDATE project_metadata SET value = ? WHERE key = ?', [
		'{invalid',
		'project_memory',
	]);
	memory = new MemoryManager(root, database);
	await memory.initialize();
	expect(memory.getAllCharacters()).toEqual([expect.objectContaining({ name: 'Mara' })]);
});

test('mirrors supplied fields without replacing rows or dependent data, and restores the complete saved snapshot', async () => {
	sqlite.execute(
		'INSERT INTO characters (id, name, character_arc, created_at) VALUES (?, ?, ?, ?)',
		['mara', 'Mara', 'Learns to trust', '2000-01-01']
	);
	await memory.initialize();
	sqlite.execute('PRAGMA foreign_keys = ON');
	sqlite.execute(
		'CREATE TABLE memory_links (character_id TEXT REFERENCES characters(id) ON DELETE CASCADE)'
	);
	sqlite.execute('INSERT INTO memory_links VALUES (?)', ['mara']);
	await memory.remember({
		memoryType: 'characters',
		data: { id: 'mara', notes: 'A watchmaker.' },
	});
	await memory.remember({
		memoryType: 'worldBuilding',
		data: { name: 'The compass', type: 'object' },
	});
	await memory.remember({
		memoryType: 'plotThreads',
		data: {
			name: 'Voyage',
			documents: ['scene-one'],
			keyEvents: [{ documentId: 'scene-one', event: 'Departure' }],
		},
	});
	expect(
		sqlite.queryOne('SELECT character_arc, notes, created_at FROM characters WHERE id = ?', [
			'mara',
		])
	).toEqual({
		character_arc: 'Learns to trust',
		notes: 'A watchmaker.',
		created_at: '2000-01-01',
	});
	expect(sqlite.queryOne('SELECT * FROM memory_links')).toEqual({ character_id: 'mara' });
	expect(sqlite.queryOne('SELECT status, documents FROM plot_threads')).toEqual({
		status: null,
		documents: JSON.stringify(['scene-one']),
	});
	const saved = JSON.parse(await readFile(file, 'utf8'));
	await memory.stopAutoSave();
	await rm(join(root, '.ai-memory'), { recursive: true });
	memory = new MemoryManager(root, database);
	await memory.initialize();
	const restored = JSON.parse(await readFile(file, 'utf8'));
	expect({ ...restored, lastUpdated: saved.lastUpdated }).toEqual(saved);
});

test('rolls back a failed secondary mirror while preserving the acknowledged primary snapshot', async () => {
	await memory.initialize();
	sqlite.execute(
		"CREATE TRIGGER fail_memory_mirror BEFORE UPDATE ON project_metadata BEGIN SELECT RAISE(ABORT, 'Synthetic mirror failure'); END"
	);
	const result = await memory.remember({ memoryType: 'characters', data: { name: 'Mara' } });
	expect(result.persisted).toBe(true);
	expect(JSON.parse(await readFile(file, 'utf8')).characters).toEqual([
		{ id: result.id, name: 'Mara' },
	]);
	expect(sqlite.queryOne('SELECT COUNT(*) AS count FROM characters')).toEqual({ count: 0 });
	await memory.stopAutoSave();
	memory = new MemoryManager(root, database);
	await memory.initialize();
	expect(memory.getCharacter(result.id!)?.name).toBe('Mara');
});

test.each([-1, 0, 1])(
	'bounds a database snapshot at 16 MiB plus %i bytes before copying it into memory',
	async (delta) => {
		const value = '{}' + ' '.repeat(16 * 1024 * 1024 + delta - 2);
		sqlite.execute('INSERT INTO project_metadata (key, value) VALUES (?, ?)', [
			'project_memory',
			value,
		]);
		if (delta <= 0) {
			await memory.initialize();
			expect(memory.getAllCharacters()).toEqual([]);
		} else {
			await expect(memory.initialize()).rejects.toThrow('exceeds 16 MiB');
			await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		}
	}
);

test.each([9999, 10000, 10001])('bounds legacy row imports at %i records', (count) => {
	const db = sqlite.getDatabase();
	const insert = db.prepare('INSERT INTO characters (id, name) VALUES (?, ?)');
	db.transaction(() => {
		for (let index = 0; index < count; index++) insert.run(`id-${index}`, `Person ${index}`);
	})();
	if (count <= 10000) expect(readMemoryDatabase(db).characters).toHaveLength(count);
	else expect(() => readMemoryDatabase(db)).toThrow('10000-row import budget');
});
