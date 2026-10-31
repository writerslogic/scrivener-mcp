import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from '../../../src/memory-manager.js';
import { safeWriteFile } from '../../../src/utils/common.js';

jest.mock('../../../src/utils/common.js', () => {
	const actual = jest.requireActual<typeof import('../../../src/utils/common.js')>(
		'../../../src/utils/common.js'
	);
	return {
		...actual,
		safeWriteFile: jest.fn(actual.safeWriteFile),
	};
});

describe('serialized memory persistence', () => {
	const persist = jest.requireActual<typeof import('../../../src/utils/common.js')>(
		'../../../src/utils/common.js'
	).safeWriteFile;
	const write = safeWriteFile as jest.MockedFunction<typeof safeWriteFile>;
	let root: string;
	let memory: MemoryManager;
	let release: (() => void) | undefined;

	beforeEach(async () => {
		write.mockImplementation(persist);
		root = await mkdtemp(join(tmpdir(), 'scrivener-memory-save-'));
		memory = new MemoryManager(root);
		await memory.initialize();
	});

	afterEach(async () => {
		release?.();
		release = undefined;
		await memory.stopAutoSave();
		await rm(root, { recursive: true, force: true });
	});

	it('drains an older delayed save before final persistence so it cannot overwrite newer memory', async () => {
		let entered!: () => void;
		const started = new Promise<void>((notify) => {
			entered = notify;
		});
		const blocked = new Promise<void>((notify) => {
			release = notify;
		});
		let delayed = false;
		write.mockImplementation(async (file, data, options) => {
			if (file.endsWith('project-memory.json') && !delayed) {
				delayed = true;
				entered();
				await blocked;
			}
			return persist(file, data, options);
		});
		memory.setCustomContext('revision', 'older');
		const oldSave = memory.saveMemory();
		await started;
		memory.setCustomContext('revision', 'newest');
		let stopped = false;
		const stop = memory.stopAutoSave().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release!();
		await Promise.all([oldSave, stop]);
		expect(
			JSON.parse(await readFile(join(root, '.ai-memory', 'project-memory.json'), 'utf8'))
				.customContext.revision
		).toBe('newest');
	});

	it('reports a failed save to its caller and still permits a later successful explicit save', async () => {
		const primary = new Error('Synthetic primary persistence failure');
		write.mockRejectedValueOnce(primary);
		await expect(memory.saveMemory()).rejects.toBe(primary);
		memory.setCustomContext('recovered', true);
		await memory.saveMemory();
		expect(
			JSON.parse(await readFile(join(root, '.ai-memory', 'project-memory.json'), 'utf8'))
				.customContext.recovered
		).toBe(true);
	});

	it('writes the same snapshot to the primary file and backup when memory changes during I/O', async () => {
		let entered!: () => void;
		const started = new Promise<void>((notify) => {
			entered = notify;
		});
		const blocked = new Promise<void>((notify) => {
			release = notify;
		});
		write.mockImplementationOnce(async (file, data, options) => {
			entered();
			await blocked;
			return persist(file, data, options);
		});
		memory.setCustomContext('revision', 'saved');
		const pending = memory.saveMemory();
		await started;
		memory.setCustomContext('revision', 'later');
		release!();
		await pending;
		const primary = await readFile(join(root, '.ai-memory', 'project-memory.json'), 'utf8');
		const day = JSON.parse(primary).lastUpdated.split('T')[0];
		expect(await readFile(join(root, '.ai-memory', `backup-${day}.json`), 'utf8')).toBe(
			primary
		);
		expect(JSON.parse(primary).customContext.revision).toBe('saved');
	});

	it('keeps the last valid file when a value cannot be serialized', async () => {
		const file = join(root, '.ai-memory', 'project-memory.json');
		const saved = await readFile(file, 'utf8');
		memory.setCustomContext('unsupported', BigInt(1));
		await expect(memory.saveMemory()).rejects.toThrow('could not be serialized');
		expect(await readFile(file, 'utf8')).toBe(saved);
		delete memory.getFullMemory().customContext.unsupported;
	});

	it.each(['cycle', 'map'])(
		'rejects unsupported %s values without rewriting saved JSON',
		async (kind) => {
			const value: Record<string, unknown> = {};
			if (kind === 'cycle') value.self = value;
			else value.map = new Map([['key', 'value']]);
			const file = join(root, '.ai-memory', 'project-memory.json');
			const saved = await readFile(file, 'utf8');
			memory.setCustomContext('unsupported', value);
			await expect(memory.saveMemory()).rejects.toThrow('could not be serialized');
			expect(await readFile(file, 'utf8')).toBe(saved);
			delete memory.getFullMemory().customContext.unsupported;
		}
	);

	it('keeps the old snapshot when import persistence fails, then retries the same import', async () => {
		const before = memory.getMemorySnapshot();
		const imported = memory.getMemorySnapshot();
		imported.customContext = { imported: true };
		write.mockRejectedValueOnce(new Error('Synthetic import failure'));
		await expect(memory.importMemory(imported)).rejects.toThrow('Synthetic import failure');
		expect(memory.getMemorySnapshot()).toEqual(before);
		await memory.importMemory(imported);
		expect(memory.getCustomContext('imported')).toBe(true);
	});

	it('retains seven daily backups without deleting similarly named user files', async () => {
		const directory = join(root, '.ai-memory');
		for (let day = 1; day <= 8; day++)
			await writeFile(join(directory, `backup-2000-01-0${day}.json`), '{}');
		await writeFile(join(directory, 'backup-notes.txt'), 'Keep this note');
		await memory.saveMemory();
		expect(
			(await readdir(directory)).filter((file) =>
				/^backup-\d{4}-\d{2}-\d{2}\.json$/.test(file)
			)
		).toHaveLength(7);
		expect(await readFile(join(directory, 'backup-notes.txt'), 'utf8')).toBe('Keep this note');
	});

	it.each([-1, 0, 1])('caps complete persisted JSON at 16 MiB plus %i bytes', async (delta) => {
		const file = join(root, '.ai-memory', 'project-memory.json');
		const previous = await readFile(file, 'utf8');
		memory.setCustomContext('payload', '');
		const snapshot = memory.getFullMemory();
		const overhead = Buffer.byteLength(JSON.stringify({ ...snapshot, documentContexts: [] }));
		memory.setCustomContext('payload', 'x'.repeat(16 * 1024 * 1024 - overhead + delta));
		if (delta <= 0) {
			await memory.saveMemory();
			expect((await readFile(file)).length).toBe(16 * 1024 * 1024 + delta);
		} else {
			await expect(memory.saveMemory()).rejects.toThrow('16 MiB');
			expect(await readFile(file, 'utf8')).toBe(previous);
		}
		delete memory.getFullMemory().customContext.payload;
	});
});

describe('project memory loading', () => {
	const actual = jest.requireActual<typeof import('../../../src/utils/common.js')>(
		'../../../src/utils/common.js'
	);
	const write = safeWriteFile as jest.MockedFunction<typeof safeWriteFile>;
	let root: string;
	let file: string;
	let memory: MemoryManager;
	let initialized: boolean;

	beforeEach(async () => {
		write.mockImplementation(actual.safeWriteFile);
		write.mockClear();
		root = await mkdtemp(join(tmpdir(), 'scrivener-memory-load-'));
		await mkdir(join(root, '.ai-memory'));
		file = join(root, '.ai-memory', 'project-memory.json');
		memory = new MemoryManager(root);
		initialized = false;
	});

	afterEach(async () => {
		write.mockImplementation(actual.safeWriteFile);
		if (initialized) await memory.stopAutoSave();
		jest.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});

	it.each([
		'{unfinished',
		'null',
		'[]',
		'{"characters":{}}',
		'{"styleGuide":null}',
		'{"characters":[null]}',
		'{"characters":[{"id":"x","name":"Mara","traits":"invalid"}]}',
		'{"characters":[{"id":"x","name":"Mara"},{"id":"x","name":"Other"}]}',
		'{"documentContexts":{}}',
		'{"documentContexts":[["short"]]}',
		'{"documentContexts":[["long",{},"extra"]]}',
	])(
		'rejects invalid memory without replacing existing state or starting auto-save: %s',
		async (saved) => {
			await writeFile(file, saved);
			memory.setCustomContext('retained', true);
			const timers = jest.spyOn(global, 'setInterval');
			await expect(memory.initialize()).rejects.toThrow('Invalid project memory');
			await memory.stopAutoSave();
			expect(memory.getCustomContext('retained')).toBe(true);
			expect(await readFile(file, 'utf8')).toBe(saved);
			expect(write).not.toHaveBeenCalled();
			expect(timers).not.toHaveBeenCalled();
		}
	);

	it('propagates read errors instead of treating inaccessible memory as absent', async () => {
		await writeFile(file, '{"customContext":{"retained":true}}');
		const failure = Object.assign(new Error('Synthetic read failure'), { code: 'EACCES' });
		jest.spyOn(
			jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'),
			'open'
		).mockRejectedValueOnce(failure);
		await expect(memory.initialize()).rejects.toBe(failure);
		await memory.stopAutoSave();
		expect(write).not.toHaveBeenCalled();
		expect(JSON.parse(await readFile(file, 'utf8')).customContext.retained).toBe(true);
	});

	it('does not silently reset a missing primary when a backup survives', async () => {
		const backup = join(root, '.ai-memory', 'backup-2026-01-01.json');
		const saved = '{"customContext":{"retained":true}}';
		await writeFile(backup, saved);
		await expect(memory.initialize()).rejects.toThrow('restore a verified backup');
		await memory.stopAutoSave();
		expect(await readFile(backup, 'utf8')).toBe(saved);
		await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(write).not.toHaveBeenCalled();
	});

	it.each(['directory', 'file'])(
		'rejects a symlinked memory %s without changing its target',
		async (kind) => {
			const outside = join(root, 'outside');
			await mkdir(outside);
			const target = join(outside, 'project-memory.json');
			const saved = '{"customContext":{"retained":true}}';
			await writeFile(target, saved);
			if (kind === 'directory') {
				await rm(join(root, '.ai-memory'), { recursive: true });
				await symlink(outside, join(root, '.ai-memory'));
			} else await symlink(target, file);
			await expect(memory.initialize()).rejects.toThrow(/symbolic link|symlinks/);
			await memory.stopAutoSave();
			expect(await readFile(target, 'utf8')).toBe(saved);
			expect(write).not.toHaveBeenCalled();
		}
	);

	it.each([-1, 0, 1])('bounds memory-file reads at 16 MiB plus %i bytes', async (delta) => {
		const saved = '{}' + ' '.repeat(16 * 1024 * 1024 + delta - 2);
		await writeFile(file, saved);
		if (delta <= 0) {
			await memory.initialize();
			initialized = true;
			expect(memory.getWritingStats()).toEqual({});
		} else await expect(memory.initialize()).rejects.toThrow('16 MiB');
		await memory.stopAutoSave();
		expect(await readFile(file, 'utf8')).toBe(saved);
		expect(write).not.toHaveBeenCalled();
	});

	it('rejects malformed UTF-8 instead of replacing authored characters', async () => {
		const saved = Buffer.concat([
			Buffer.from('{"customContext":{"name":"'),
			Buffer.from([0xff]),
			Buffer.from('"}}'),
		]);
		await writeFile(file, saved);
		await expect(memory.initialize()).rejects.toThrow();
		await memory.stopAutoSave();
		expect(await readFile(file)).toEqual(saved);
	});

	it.each([
		{ documentContexts: [['doc', { documentId: 'doc', summary: 'retained' }]] },
		{
			documentContexts: {
				__type: 'Map',
				value: [['doc', { documentId: 'doc', summary: 'retained' }]],
			},
		},
	])(
		'loads partial legacy memory and persisted document contexts',
		async ({ documentContexts }) => {
			await writeFile(
				file,
				JSON.stringify({ customContext: { retained: true }, documentContexts })
			);
			await memory.initialize();
			initialized = true;
			expect(memory.getCustomContext('retained')).toBe(true);
			expect(memory.getDocumentContext('doc')?.summary).toBe('retained');
			expect(memory.getAllCharacters()).toEqual([]);
		}
	);
});
