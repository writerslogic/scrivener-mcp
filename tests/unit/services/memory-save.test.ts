import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from '../../../src/memory-manager.js';
import { AppError, ErrorCode, safeReadFile, safeWriteFile } from '../../../src/utils/common.js';

jest.mock('../../../src/utils/common.js', () => {
	const actual = jest.requireActual<typeof import('../../../src/utils/common.js')>(
		'../../../src/utils/common.js'
	);
	return {
		...actual,
		safeReadFile: jest.fn(actual.safeReadFile),
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
});

describe('project memory loading', () => {
	const actual = jest.requireActual<typeof import('../../../src/utils/common.js')>(
		'../../../src/utils/common.js'
	);
	const read = safeReadFile as jest.MockedFunction<typeof safeReadFile>;
	const write = safeWriteFile as jest.MockedFunction<typeof safeWriteFile>;
	let root: string;
	let file: string;
	let memory: MemoryManager;
	let initialized: boolean;

	beforeEach(async () => {
		read.mockImplementation(actual.safeReadFile);
		write.mockImplementation(actual.safeWriteFile);
		write.mockClear();
		root = await mkdtemp(join(tmpdir(), 'scrivener-memory-load-'));
		await mkdir(join(root, '.ai-memory'));
		file = join(root, '.ai-memory', 'project-memory.json');
		memory = new MemoryManager(root);
		initialized = false;
	});

	afterEach(async () => {
		read.mockImplementation(actual.safeReadFile);
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
			expect(memory.getCustomContext('retained')).toBe(true);
			expect(await readFile(file, 'utf8')).toBe(saved);
			expect(write).not.toHaveBeenCalled();
			expect(timers).not.toHaveBeenCalled();
		}
	);

	it('propagates read errors instead of treating inaccessible memory as absent', async () => {
		await writeFile(file, '{"customContext":{"retained":true}}');
		const failure = new AppError('Synthetic read failure', ErrorCode.PERMISSION_DENIED);
		read.mockRejectedValueOnce(failure);
		await expect(memory.initialize()).rejects.toBe(failure);
		expect(write).not.toHaveBeenCalled();
		expect(JSON.parse(await readFile(file, 'utf8')).customContext.retained).toBe(true);
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
