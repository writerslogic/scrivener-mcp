import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { MemoryManager } from '../../src/memory-manager.js';
import {
	updateMemoryHandler as remember,
	getMemoryHandler as recall,
} from '../../src/handlers/analysis-handlers/memory.js';
import { generateContentHandler } from '../../src/handlers/analysis-handlers/content-generation.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { AIClient } from '../../src/services/ai/ai-client.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { ProjectSource } from '../../src/services/editorial/project-source.js';
import { SeriesBible } from '../../src/services/editorial/series-bible.js';
import { disposeSpool, readResult } from '../../src/core/response-formatter.js';
import { safeWriteFile } from '../../src/utils/common.js';

jest.mock('../../src/utils/common.js', () => {
	const actual = jest.requireActual('../../src/utils/common.js');
	return { ...actual, safeWriteFile: jest.fn(actual.safeWriteFile) };
});

const validator = new AjvJsonSchemaValidator();
const input = validator.getValidator(remember.inputSchema as JsonSchemaType);
const written = validator.getValidator(remember.outputSchema as JsonSchemaType);
const recalled = validator.getValidator(recall.outputSchema as JsonSchemaType);
const write = safeWriteFile as jest.MockedFunction<typeof safeWriteFile>;
const realWrite = jest.requireActual<typeof import('../../src/utils/common.js')>(
	'../../src/utils/common.js'
).safeWriteFile;
let root: string;
let file: string;
let memory: MemoryManager;
let context: HandlerContext;
let store: PersistentStore;
let source: ProjectSource;
let release: (() => void) | undefined;

async function put(memoryType: string, data: Record<string, unknown>) {
	const args = { memoryType, data };
	expect(input(args).valid).toBe(true);
	const result = await remember.handler(args, context);
	expect(written(result.structuredContent).valid).toBe(true);
	expect(JSON.parse(result.content[0].text!)).toEqual(result.structuredContent);
	return result.structuredContent as { id: string | null; revision: string; persisted: true };
}

async function get(memoryType?: string) {
	const result = await recall.handler(memoryType === undefined ? {} : { memoryType }, context);
	expect(recalled(result.structuredContent).valid).toBe(true);
	let data = result.structuredContent!;
	if (typeof data._ref === 'string') {
		let offset: number | null = 0,
			json = '';
		do {
			const page = readResult(data._ref, offset, 1024);
			expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1024);
			json += page.text;
			offset = page.nextOffset;
		} while (offset !== null);
		data = JSON.parse(json);
		expect(recalled(data).valid).toBe(true);
	}
	return JSON.parse(JSON.stringify(data));
}

async function blockWrite() {
	let enter!: () => void;
	const started = new Promise<void>((notify) => {
		enter = notify;
	});
	const blocked = new Promise<void>((notify) => {
		release = notify;
	});
	write.mockImplementationOnce(async (...args) => {
		enter();
		await blocked;
		return realWrite(...args);
	});
	return { started };
}

beforeEach(async () => {
	write.mockImplementation(realWrite);
	write.mockClear();
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-memory-contract-')));
	file = join(root, '.ai-memory', 'project-memory.json');
	memory = new MemoryManager(root);
	await memory.initialize();
	store = new PersistentStore(join(root, 'editorial.sqlite'));
	source = new ProjectSource(
		root,
		store,
		async () => [],
		async () => {
			throw new Error('Unexpected manuscript read');
		}
	);
	context = {
		memoryManager: memory,
		project: { getEditorialServices: () => ({ source }) },
	} as unknown as HandlerContext;
});

afterEach(async () => {
	release?.();
	release = undefined;
	write.mockImplementation(realWrite);
	jest.restoreAllMocks();
	await memory.stopAutoSave();
	store.close();
	await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
	disposeSpool();
});

test.each([
	['characters', { name: 'Mara' }],
	['worldBuilding', { name: 'Moon Harbor', type: 'location', description: 'A tidal port.' }],
	['plotThreads', { name: 'The voyage' }],
] as const)(
	'durably creates, reads, updates and reloads %s without inventing missing facts',
	async (kind, data) => {
		const created = await put(kind, data);
		expect(created.id).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(await readFile(file, 'utf8'))[kind]).toEqual([
			{ ...data, id: created.id },
		]);
		expect((await get(kind)).memory).toEqual([{ ...data, id: created.id }]);
		const updated = await put(kind, { id: created.id, description: 'An authored revision.' });
		expect(updated.revision).not.toBe(created.revision);
		await memory.stopAutoSave();
		memory = new MemoryManager(root);
		await memory.initialize();
		context.memoryManager = memory;
		expect((await get(kind)).memory).toEqual([
			{ ...data, id: created.id, description: 'An authored revision.' },
		]);
	}
);

test('identical creates and updates are retry-safe and preserve a later amendment', async () => {
	const first = await put('characters', { name: 'Mara' });
	const again = await put('characters', { name: 'Mara' });
	expect(again).toEqual(first);
	const changed = await put('characters', { id: first.id, notes: 'Afraid of open water.' });
	expect(await put('characters', { id: first.id, notes: 'Afraid of open water.' })).toEqual(
		changed
	);
	expect((await put('characters', { name: 'Mara' })).id).toBe(first.id);
	expect((await get('characters')).memory).toEqual([
		{ id: first.id, name: 'Mara', notes: 'Afraid of open water.' },
	]);
});

test('new style memory is empty until explicitly authored, and partial updates preserve prior preferences', async () => {
	expect((await get('styleGuide')).memory).toEqual({});
	await put('styleGuide', { voice: 'Restrained' });
	await put('styleGuide', { tense: 'present' });
	expect((await get('styleGuide')).memory).toEqual({ voice: 'Restrained', tense: 'present' });
});

test('custom context preserves literal JSON tags, shared references and prototype-shaped keys through restart', async () => {
	const shared = { __type: 'Map', value: [['ordinary', 'JSON data']] };
	const data = { a: shared, b: shared, ...JSON.parse('{"__proto__":{"authored":true}}') };
	await put('all', data);
	await memory.stopAutoSave();
	memory = new MemoryManager(root);
	await memory.initialize();
	context.memoryManager = memory;
	const recalled = (await get()).memory.customContext;
	expect(recalled).toEqual(data);
	expect(Object.getPrototypeOf(recalled)).toBe(Object.prototype);
	expect(memory.getCustomContext('toString')).toBeUndefined();
	expect(await readFile(file, 'utf8')).not.toContain('[Circular]');
});

test('failed persistence cannot publish an uncommitted fact or acknowledge success', async () => {
	const before = await readFile(file, 'utf8');
	write.mockRejectedValueOnce(new Error('Synthetic write failure'));
	await expect(put('characters', { name: 'Mara' })).rejects.toThrow('Synthetic write failure');
	expect((await get('characters')).memory).toEqual([]);
	expect(await readFile(file, 'utf8')).toBe(before);
	await put('characters', { name: 'Mara' });
	expect((await get('characters')).memory).toHaveLength(1);
});

test('recognizes an already committed file when write cleanup reports failure', async () => {
	write.mockImplementationOnce(async (...args) => {
		await realWrite(...args);
		throw new Error('Synthetic post-commit cleanup failure');
	});
	const result = await put('characters', { name: 'Mara' });
	expect(JSON.parse(await readFile(file, 'utf8')).characters[0].id).toBe(result.id);
	expect((await get('characters')).memory[0].id).toBe(result.id);
});

test('readers see committed state while writes are serialized and caller inputs are snapshotted', async () => {
	const { started } = await blockWrite();
	const data = { name: 'Mara', traits: ['patient'] };
	const first = put('characters', data);
	await started;
	data.name = 'Changed after admission';
	data.traits.push('unexpected');
	const second = put('worldBuilding', { name: 'Moon Harbor', type: 'location' });
	expect((await get('characters')).memory).toEqual([]);
	expect((await get('worldBuilding')).memory).toEqual([]);
	release!();
	await Promise.all([first, second]);
	expect((await get('characters')).memory).toEqual([
		expect.objectContaining({ name: 'Mara', traits: ['patient'] }),
	]);
	expect(JSON.parse(await readFile(file, 'utf8')).worldBuilding).toHaveLength(1);
});

test.each([31, 32, 33])(
	'bounds pending writes at %i admissions without starting extra work',
	async (count) => {
		const { started } = await blockWrite();
		const first = memory.remember({ memoryType: 'characters', data: { name: 'First' } });
		await started;
		const admitted = [first];
		for (let index = 1; index < Math.min(count, 32); index++)
			admitted.push(
				memory.remember({ memoryType: 'characters', data: { name: `Person ${index}` } })
			);
		if (count > 32)
			await expect(
				memory.remember({ memoryType: 'characters', data: { name: 'Overflow' } })
			).rejects.toThrow('queue is full');
		release!();
		await Promise.all(admitted);
		expect((await get('characters')).memory).toHaveLength(Math.min(count, 32));
	}
);

test('shutdown drains admitted writes and rejects new ones', async () => {
	const { started } = await blockWrite();
	const accepted = put('characters', { name: 'Mara' });
	await started;
	const closing = memory.stopAutoSave();
	await expect(put('characters', { name: 'Late' })).rejects.toThrow('not open for updates');
	release!();
	await Promise.all([accepted, closing]);
	expect(JSON.parse(await readFile(file, 'utf8')).characters).toEqual([
		expect.objectContaining({ name: 'Mara' }),
	]);
});

test('serializes simultaneous initialization and excludes a second memory owner until close', async () => {
	const peer = new MemoryManager(root);
	await expect(peer.initialize()).rejects.toThrow('already owned');
	await peer.stopAutoSave();
	await memory.stopAutoSave();
	memory = new MemoryManager(root);
	await Promise.all([memory.initialize(), memory.initialize()]);
	context.memoryManager = memory;
	await put('characters', { name: 'Mara' });
	expect((await get('characters')).memory).toHaveLength(1);
});

test.each(['create', 'retry'])(
	'rejects a stale %s after an external edit and permits closing and reopening without overwriting it',
	async (operation) => {
		if (operation === 'retry') await put('characters', { name: 'Mara' });
		const external = JSON.parse(await readFile(file, 'utf8'));
		external.customContext.external = 'Preserve this edit';
		const saved = JSON.stringify(external);
		await writeFile(file, saved);
		await expect(put('characters', { name: 'Mara' })).rejects.toThrow(
			'changed outside this server'
		);
		await memory.stopAutoSave();
		expect(await readFile(file, 'utf8')).toBe(saved);
		memory = new MemoryManager(root);
		await memory.initialize();
		context.memoryManager = memory;
		await put('characters', { name: 'Mara' });
		expect((await get()).memory.customContext.external).toBe('Preserve this edit');
		expect((await get('characters')).memory).toHaveLength(1);
	}
);

test('large Unicode recalls spool and reconstruct all stored data at one revision', async () => {
	const data = { text: '🌊港\n'.repeat(7000) };
	const saved = await put('all', data);
	const response = await recall.handler({}, context);
	expect(typeof response.structuredContent?._ref).toBe('string');
	expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);

	const result = await get();
	expect(result.memory.customContext).toEqual(data);
	expect(result.revision).toBe(saved.revision);
	expect(result.memory.writingStats).toEqual({});
});

test.each([
	{ memoryType: 'unknown', data: {} },
	{ memoryType: 'characters', data: {} },
	{ memoryType: 'characters', data: { name: 'Mara', role: 'unknown' } },
	{ memoryType: 'characters', data: { name: 'Mara', traits: [3] } },
	{ memoryType: 'characters', data: { name: 'Mara', relationships: [{ characterId: 'x' }] } },
	{ memoryType: 'worldBuilding', data: { name: 'Port', appearances: [{ documentId: 'x' }] } },
	{ memoryType: 'plotThreads', data: { name: 'Voyage', documents: 'x' } },
	{ memoryType: 'styleGuide', data: { tense: 'unknown' } },
	{ memoryType: 'all', data: null },
	{ memoryType: 'all', data: {}, extra: true },
])('rejects invalid nested memory input %j without changing storage', async (args) => {
	expect(input(args).valid).toBe(false);
	const before = await readFile(file, 'utf8');
	await expect(remember.handler(args, context)).rejects.toThrow();
	expect(await readFile(file, 'utf8')).toBe(before);
});

test.each(['characters', 'worldBuilding', 'plotThreads'])(
	'rejects missing %s update IDs without silently adding records',
	async (kind) => {
		const before = await readFile(file, 'utf8');
		await expect(put(kind, { id: 'missing', name: 'Unknown' })).rejects.toThrow(
			'No matching memory entry'
		);
		expect(await readFile(file, 'utf8')).toBe(before);
	}
);

test.each([-1, 0, 1])('enforces the complete 64 KiB input budget at offset %i', async (delta) => {
	const data = { notes: Array.from({ length: 5 }, () => '') };
	const overhead = Buffer.byteLength(JSON.stringify({ memoryType: 'all', data }));
	let remaining = 65536 - overhead + delta;
	data.notes = data.notes.map(() => {
		const amount = Math.min(16000, remaining);
		remaining -= amount;
		return 'x'.repeat(amount);
	});
	if (delta <= 0) expect((await put('all', data)).persisted).toBe(true);
	else await expect(put('all', data)).rejects.toThrow('64 KiB');
});

test('newly remembered records feed generation and series import after restart', async () => {
	const character = await put('characters', {
		name: 'Mara',
		description: 'A watchmaker.',
		notes: 'Afraid of open water.',
	});
	await put('worldBuilding', {
		name: 'Moon Harbor',
		type: 'location',
		description: 'A tidal port.',
	});
	await put('plotThreads', { name: 'The voyage' });
	await memory.stopAutoSave();
	memory = new MemoryManager(root);
	await memory.initialize();
	context.memoryManager = memory;
	jest.spyOn(AIClient.prototype, 'isAvailable', 'get').mockReturnValue(true);
	const chat = jest
		.spyOn(AIClient.prototype, 'chat')
		.mockResolvedValue('Mara watched the harbor.');
	const generated = await generateContentHandler.handler(
		{ prompt: 'Write a scene.', context: { characterIds: [character.id] } },
		context
	);
	expect(generated.isError).not.toBe(true);
	expect(chat.mock.calls[0][0]).toContain('Afraid of open water.');
	const bible = new SeriesBible(source, store);
	const facts = await bible.importMemory(memory);
	expect(facts.map((fact) => fact.kind).sort()).toEqual(['character', 'chronology', 'location']);
	expect(facts.find((fact) => fact.kind === 'location')).toMatchObject({
		subject: 'Moon Harbor',
		value: 'A tidal port.',
		confidence: 'inferred',
		sources: [],
	});
	expect(await bible.importMemory(memory)).toEqual([]);
});

test.each([-1, 0, 1])(
	'imports memory atomically at the story-fact subject boundary plus %i',
	async (delta) => {
		await put('characters', { name: 'Mara' });
		await put('worldBuilding', { name: 'x'.repeat(200 + delta) });
		const bible = new SeriesBible(source, store);
		if (delta <= 0) expect(await bible.importMemory(memory)).toHaveLength(2);
		else {
			await expect(bible.importMemory(memory)).rejects.toThrow('Fact subject');
			expect(store.count('story:facts')).toBe(0);
		}
	}
);

test.each([-1, 0, 1])(
	'imports complete descriptions at the story-fact value boundary plus %i',
	async (delta) => {
		await put('characters', { name: 'Mara' });
		await put('worldBuilding', { name: 'Port', description: 'x'.repeat(2000 + delta) });
		const bible = new SeriesBible(source, store);
		if (delta <= 0) expect(await bible.importMemory(memory)).toHaveLength(2);
		else {
			await expect(bible.importMemory(memory)).rejects.toThrow('Fact value');
			expect(store.count('story:facts')).toBe(0);
		}
	}
);

test('rejects changed memory and rolls back storage failure without leaving a partial import', async () => {
	await put('characters', { name: 'Mara' });
	await put('worldBuilding', { name: 'Port' });
	const bible = new SeriesBible(source, store);
	const pending = bible.importMemory(memory);
	memory.setCustomContext('changed', true);
	await expect(pending).rejects.toThrow('changed during import');
	expect(store.count('story:facts')).toBe(0);
	const persist = store.put.bind(store);
	jest.spyOn(store, 'put')
		.mockImplementationOnce(persist)
		.mockImplementationOnce(() => {
			throw new Error('Synthetic import failure');
		});
	await expect(bible.importMemory(memory)).rejects.toThrow('Synthetic import failure');
	expect(store.count('story:facts')).toBe(0);
	jest.restoreAllMocks();
	expect(await bible.importMemory(memory)).toHaveLength(2);
});

test('deduplicates equivalent canonical and legacy locations but rejects conflicting legacy identities', async () => {
	await put('worldBuilding', { name: 'Port', type: 'location', description: 'A tidal port.' });
	await put('all', {
		worldBuilding: { locations: [{ name: 'Port', description: 'A tidal port.' }] },
	});
	const bible = new SeriesBible(source, store);
	expect(await bible.importMemory(memory)).toHaveLength(1);
	await put('all', {
		worldBuilding: {
			locations: [
				{ name: 'Elsewhere', description: 'First' },
				{ name: 'Elsewhere', description: 'Conflicting' },
			],
		},
	});
	await expect(bible.importMemory(memory)).rejects.toThrow('conflicting facts');
	expect(store.count('story:facts')).toBe(1);
});

test('preserves and imports top-level location lists written by the former worldBuilding handler', async () => {
	const locations = [{ name: 'Port', description: 'A tidal port.' }];
	await put('all', { locations });
	expect((await get()).memory.customContext.locations).toEqual(locations);
	const facts = await new SeriesBible(source, store).importMemory(memory);
	expect(facts).toEqual([
		expect.objectContaining({
			kind: 'location',
			subject: 'Port',
			value: 'A tidal port.',
			confidence: 'inferred',
			sources: [],
		}),
	]);
});
