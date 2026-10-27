import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from '../../../src/memory-manager.js';
import { safeWriteFile } from '../../../src/utils/common.js';

jest.mock('../../../src/utils/common.js', () => {
	const actual = jest.requireActual<typeof import('../../../src/utils/common.js')>('../../../src/utils/common.js');
	return { ...actual, safeWriteFile: jest.fn(actual.safeWriteFile) };
});

describe('serialized memory persistence', () => {
	const persist = jest.requireActual<typeof import('../../../src/utils/common.js')>('../../../src/utils/common.js').safeWriteFile;
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
		release?.(); release = undefined;
		await memory.stopAutoSave();
		await rm(root, { recursive: true, force: true });
	});

	it('drains an older delayed save before final persistence so it cannot overwrite newer memory', async () => {
		let entered!: () => void;
		const started = new Promise<void>((notify) => { entered = notify; });
		const blocked = new Promise<void>((notify) => { release = notify; });
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
		const stop = memory.stopAutoSave().then(() => { stopped = true; });
		await Promise.resolve();
		expect(stopped).toBe(false);
		release!();
		await Promise.all([oldSave, stop]);
		expect(JSON.parse(await readFile(join(root, '.ai-memory', 'project-memory.json'), 'utf8')).customContext.revision).toBe('newest');
	});

	it('reports a failed save to its caller and still permits a later successful explicit save', async () => {
		const primary = new Error('Synthetic primary persistence failure');
		write.mockRejectedValueOnce(primary);
		await expect(memory.saveMemory()).rejects.toBe(primary);
		memory.setCustomContext('recovered', true);
		await memory.saveMemory();
		expect(JSON.parse(await readFile(join(root, '.ai-memory', 'project-memory.json'), 'utf8')).customContext.recovered).toBe(true);
	});
});
