import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { AIClient } from '../../src/services/ai/ai-client.js';
import { ProjectSource } from '../../src/services/editorial/project-source.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import {
	analysisDigest,
	type AnalysisEnvelope,
} from '../../src/services/editorial/analysis-envelope.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';
import { MemoryManager, type CharacterProfile } from '../../src/memory-manager.js';
import { generateContentHandler as tool } from '../../src/handlers/analysis-handlers/document-analysis.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { disposeSpool, readResult } from '../../src/core/response-formatter.js';
import * as textMetrics from '../../src/utils/text-metrics.js';

const DOCUMENT = '10000000-0000-4000-8000-000000000001';
const validator = new AjvJsonSchemaValidator();
const input = validator.getValidator(tool.inputSchema as JsonSchemaType);
const output = validator.getValidator(tool.outputSchema as JsonSchemaType);
const rtf = new RTFHandler();
let root: string;
let store: PersistentStore;
let source: ProjectSource;
let memory: MemoryManager;
let character: CharacterProfile;
let context: HandlerContext;
let chat: jest.SpiedFunction<AIClient['chat']>;
const prompt = '  Continue the scene.\n';

async function save(text: string) {
	await writeFile(join(root, 'content.rtf'), rtf.convertToRTF(text));
}

function args() {
	return { prompt, context: { documentId: DOCUMENT, characterIds: [character.id] } };
}

async function call(request: Record<string, unknown> = args()) {
	expect(input(request).valid).toBe(true);
	const response = await tool.handler(request, context);
	expect(response.isError).not.toBe(true);
	expect(JSON.parse(response.content[0].text!)).toEqual(response.structuredContent);
	expect(output(response.structuredContent).valid).toBe(true);
	let data = response.structuredContent!;
	if (typeof data._ref === 'string') {
		expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);

		let offset: number | null = 0,
			json = '';
		do {
			const part = readResult(data._ref, offset, 1024);
			expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(1024);
			json += part.text;
			offset = part.nextOffset;
		} while (offset !== null);
		data = JSON.parse(json);
		expect(output(data).valid).toBe(true);
	}
	return data as {
		content: string;
		envelope: AnalysisEnvelope;
		context: {
			document: { end: number; sourceCharacters: number; truncated: boolean } | null;
			characters: { id: string; revision: string }[];
		};
	};
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-generation-')));
	store = new PersistentStore(join(root, 'editorial.sqlite'));
	source = new ProjectSource(
		root,
		store,
		async () => [{ id: DOCUMENT, type: 'Text', title: 'Scene', path: 'Draft/Scene' }],
		async () => readFile(join(root, 'content.rtf'), 'utf8')
	);
	memory = new MemoryManager(root);
	character = memory.addCharacter({
		name: 'Mara',
		role: 'protagonist',
		description: 'A watchmaker.',
		traits: ['patient'],
		arc: 'Learns to ask for help.',
		relationships: [],
		appearances: [{ documentId: DOCUMENT, context: 'Waiting by the harbor.' }],
		notes: 'Afraid of open water.',
	});
	context = {
		project: { getEditorialServices: () => ({ source }) },
		memoryManager: memory,
		personalization: {
			buildDirective: jest.fn().mockResolvedValue('Keep the restrained voice.'),
		},
	} as unknown as HandlerContext;
	jest.spyOn(AIClient.prototype, 'isAvailable', 'get').mockReturnValue(true);
	chat = jest.spyOn(AIClient.prototype, 'chat').mockResolvedValue('Mara watched the harbor. 🌙');
	await save('Mara waited at the harbor. 🌙');
});

afterEach(async () => {
	jest.restoreAllMocks();
	store.close();
	await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
	disposeSpool();
});

test('uses actual saved text and profile facts with exact revision coverage and no manuscript writes', async () => {
	const before = await readFile(join(root, 'content.rtf'), 'utf8');
	const document = await source.read(DOCUMENT);
	const result = await call();
	expect(chat.mock.calls[0][0]).toContain(document.text);
	expect(chat.mock.calls[0][0]).toContain('A watchmaker.');
	expect(chat.mock.calls[0][0]).toContain('Afraid of open water.');
	expect(chat.mock.calls[0][0]).toContain(prompt);
	expect(chat.mock.calls[0][1]?.system).toContain('Keep the restrained voice.');
	expect(result.context).toEqual({
		document: {
			documentId: DOCUMENT,
			start: 0,
			end: document.text.length,
			sourceCharacters: document.text.length,
			truncated: false,
		},
		characters: [{ id: character.id, revision: analysisDigest(character) }],
	});
	expect(result.envelope).toMatchObject({
		projectId: source.projectId,
		sourceFormat: 'saved-rtf',
		sourceRevisions: [{ documentId: DOCUMENT, revision: document.revision }],
		policy: { mode: 'provider', revisionChecked: true, mutatesManuscript: false },
	});
	expect(await readFile(join(root, 'content.rtf'), 'utf8')).toBe(before);
});

test('context-free generation needs no project and declares no invented project or revision', async () => {
	context.project = null;
	context.memoryManager = null;
	const read = jest.spyOn(source, 'read');
	const result = await call({ prompt });
	expect(read).not.toHaveBeenCalled();
	expect(chat.mock.calls[0][0]).toBe(prompt);
	expect(result.context).toEqual({ document: null, characters: [] });
	expect(result.envelope).toMatchObject({
		projectId: null,
		sourceFormat: 'supplied-text',
		sourceRevisions: [],
		policy: { revisionChecked: false },
	});
});

test('character-only context uses profiles without reading manuscript text', async () => {
	const read = jest.spyOn(source, 'read');
	const result = await call({ prompt, context: { characterIds: [character.id] } });
	expect(read).not.toHaveBeenCalled();
	expect(chat.mock.calls[0][0]).toContain('Afraid of open water.');
	expect(result.context.document).toBeNull();
	expect(result.envelope.policy.revisionChecked).toBe(true);
});

test.each([15999, 16000, 16001])(
	'discloses saved context coverage at %i UTF-16 characters',
	async (length) => {
		const text = 'x'.repeat(length - 3) + '🌙.';
		await save(text);
		const result = await call();
		const end = length > 16000 ? 16000 : length;
		expect(result.context.document).toMatchObject({
			end,
			sourceCharacters: length,
			truncated: length > 16000,
		});
		expect(chat.mock.calls[0][0]).toContain(text.slice(0, end));
	}
);

test('does not split a surrogate pair when limiting the saved excerpt', async () => {
	await save('x'.repeat(15999) + '🌙beyond the excerpt');
	const result = await call();
	expect(result.context.document).toMatchObject({ end: 15999, truncated: true });
	expect(chat.mock.calls[0][0]).not.toMatch(/🌙|beyond the excerpt|\uD83C/);
});

test.each([15999, 16000, 16001])(
	'bounds prompt size at %i characters before provider use',
	async (length) => {
		const request = { prompt: 'x'.repeat(length) };
		expect(input(request).valid).toBe(length <= 16000);
		if (length <= 16000) await call(request);
		else {
			await expect(tool.handler(request, context)).rejects.toThrow('1–16000');
			expect(chat).not.toHaveBeenCalled();
		}
	}
);

test.each([15999, 16000, 16001])(
	'matches JSON Schema character counting for %i astral prompt characters',
	async (length) => {
		const request = { prompt: '🌙'.repeat(length), context: { style: '🌙'.repeat(1000) } };
		expect(input(request).valid).toBe(length <= 16000);
		if (length <= 16000) await call(request);
		else {
			await expect(tool.handler(request, context)).rejects.toThrow('1–16000');
			expect(chat).not.toHaveBeenCalled();
		}
	}
);

test('retains generated prose when the local word count is unavailable', async () => {
	jest.spyOn(textMetrics, 'getAccurateWordCount').mockImplementation(() => {
		throw new Error('Tokenizer unavailable');
	});
	expect(await call()).toMatchObject({
		content: 'Mara watched the harbor. 🌙',
		wordCount: null,
		availability: { unavailableFields: ['wordCount'] },
	});
});

test.each([63999, 64000, 64001])(
	'preserves complete Unicode output or rejects it at %i UTF-16 characters',
	async (length) => {
		const text = 'x'.repeat(length - 3) + '🌙.';
		chat.mockResolvedValue(text);
		if (length <= 64000) expect((await call()).content).toBe(text);
		else {
			const result = await tool.handler(args(), context);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain('No prose was returned');
			expect(result.content[0].text).not.toContain(text);
		}
	}
);

test.each([0, 1, 2, 1999, 2000, 2001])(
	'validates target word count %i before provider use',
	async (length) => {
		const request = { ...args(), length };
		const valid = length >= 1 && length <= 2000;
		expect(input(request).valid).toBe(valid);
		if (valid) await call(request);
		else {
			await expect(tool.handler(request, context)).rejects.toThrow('integer from 1 to 2000');
			expect(chat).not.toHaveBeenCalled();
		}
	}
);

test.each([31, 32, 33])('bounds selected profiles at %i', async (count) => {
	const ids = [character.id];
	for (let index = 1; index < count; index++) {
		const { id: _id, ...profile } = character;
		ids.push(memory.addCharacter({ ...profile, name: `Person ${index}` }).id);
	}
	const request = { prompt, context: { characterIds: ids } };
	expect(input(request).valid).toBe(count <= 32);
	if (count <= 32) expect((await call(request)).context.characters).toHaveLength(count);
	else {
		await expect(tool.handler(request, context)).rejects.toThrow('at most 32');
		expect(chat).not.toHaveBeenCalled();
	}
});

test.each([-1, 0, 1])('bounds serialized profile context at 16 KiB%+i', async (delta) => {
	character.notes = '';
	const overhead = Buffer.byteLength(JSON.stringify([character]));
	character.notes = 'x'.repeat(16384 - overhead + delta);
	if (delta <= 0) await call();
	else {
		await expect(call()).rejects.toThrow('exceed 16 KiB');
		expect(chat).not.toHaveBeenCalled();
	}
});

test.each([
	{},
	{ prompt: '' },
	{ prompt: '   ' },
	{ prompt: 3 },
	{ prompt, extra: true },
	{ prompt, length: 1.5 },
	{ prompt, context: null },
	{ prompt, context: [] },
	{ prompt, context: { arbitrary: true } },
	{ prompt, context: { characterIds: 'mara' } },
	{ prompt, context: { characterIds: ['mara', 'mara'] } },
	{ prompt, context: { documentId: '\0' } },
	{ prompt, context: { style: '' } },
	{ prompt, context: { style: 'x'.repeat(1001) } },
])('rejects invalid nested generation arguments %j before dispatch', async (request) => {
	expect(input(request).valid).toBe(false);
	await expect(tool.handler(request, context)).rejects.toThrow();
	expect(chat).not.toHaveBeenCalled();
});

test.each(['project', 'memory', 'missing', 'invalid'] as const)(
	'rejects unavailable %s context without silently dropping it',
	async (missing) => {
		if (missing === 'project') context.project = null;
		if (missing === 'memory') context.memoryManager = null;
		if (missing === 'missing') memory.getAllCharacters().splice(0);
		if (missing === 'invalid') character.notes = Number.NaN as unknown as string;
		await expect(call()).rejects.toThrow();
		expect(chat).not.toHaveBeenCalled();
	}
);

test.each(['source', 'profile', 'project', 'memory'] as const)(
	'rejects changed %s after generation',
	async (changed) => {
		chat.mockImplementation(async () => {
			if (changed === 'source') await save('An external revision.');
			if (changed === 'profile') character.notes = 'Changed canon.';
			if (changed === 'project') context.project = null;
			if (changed === 'memory') context.memoryManager = new MemoryManager(root);
			return 'A new scene.';
		});
		await expect(call()).rejects.toThrow(/changed during generation/);
	}
);

test('checks project selection after the asynchronous final source read', async () => {
	const read = source.read.bind(source);
	let reads = 0;
	jest.spyOn(source, 'read').mockImplementation(async (id) => {
		const document = await read(id);
		if (++reads === 2) context.project = null;
		return document;
	});
	await expect(call()).rejects.toThrow('Selected project changed');
});

test('rejects a project switch while preparing preferences before sending manuscript data', async () => {
	jest.spyOn(context.personalization!, 'buildDirective').mockImplementation(async () => {
		context.project = null;
		return '';
	});
	await expect(call()).rejects.toThrow('Selected project changed');
	expect(chat).not.toHaveBeenCalled();
});

test('snapshots input options and binds options, preferences, source and profiles to request identity', async () => {
	const request = { ...args(), length: 100, context: { ...args().context, style: 'restrained' } };
	const pending = call(request);
	request.context.style = 'florid';
	request.context.characterIds.splice(0);
	const original = await pending;
	expect(chat.mock.calls[0][1]?.system).toContain('restrained');
	expect(original.context.characters).toHaveLength(1);
	const changed = await call(request);
	expect(changed.envelope.requestId).not.toBe(original.envelope.requestId);
	const ids = new Set([changed.envelope.requestId, original.envelope.requestId]);
	character.notes = 'New canon.';
	ids.add((await call()).envelope.requestId);
	await save('New source.');
	ids.add((await call()).envelope.requestId);
	jest.spyOn(context.personalization!, 'buildDirective').mockResolvedValue('New preferences.');
	ids.add((await call()).envelope.requestId);
	expect(ids.size).toBe(5);
});
