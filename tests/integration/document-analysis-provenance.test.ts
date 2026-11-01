import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { AIClient } from '../../src/services/ai/ai-client.js';
import { ContentAnalyzer } from '../../src/analysis/base-analyzer.js';
import { ProjectSource } from '../../src/services/editorial/project-source.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';
import { analyzeDocumentHandler as tool } from '../../src/handlers/analysis-handlers/document-analysis.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { readResult } from '../../src/core/response-formatter.js';
import { checkGrammar } from 'narrative-lens';

jest.mock('narrative-lens', () => {
	const actual = jest.requireActual('narrative-lens');
	return { ...actual, checkGrammar: jest.fn(actual.checkGrammar) };
});

const DOCUMENT = '10000000-0000-4000-8000-000000000001';
const validator = new AjvJsonSchemaValidator();
const input = validator.getValidator(tool.inputSchema as JsonSchemaType);
const output = validator.getValidator(tool.outputSchema as JsonSchemaType);
const rtf = new RTFHandler();
const spools = new Set<string>();
const valid = {
	readability: 'Clear.',
	pacing: 'Steady.',
	issues: [{ description: 'A repeated opener.', severity: 'low' }],
};
const text = 'It was a dark and stormy night. "Leave now," Mira said. She was was afraid.';
let root: string;
let store: PersistentStore;
let source: ProjectSource;
let context: HandlerContext;
let chat: jest.SpiedFunction<AIClient['chat']>;
let local: ContentAnalyzer;

async function save(text: string) {
	await writeFile(join(root, 'content.rtf'), rtf.convertToRTF(text));
}

async function call(extra: Record<string, unknown> = {}) {
	const request = { documentId: DOCUMENT, ...extra };
	expect(input(request).valid).toBe(true);
	const response = await tool.handler(request, context);
	expect(response.isError).not.toBe(true);
	expect(output(response.structuredContent).valid).toBe(true);
	let data = response.structuredContent!;
	if (typeof data._ref === 'string') {
		expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);
		spools.add(dirname(data._file as string));
		let offset: number | null = 0,
			json = '';
		do {
			const page = readResult(data._ref, offset, 1024);
			expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1024);
			json += page.text;
			offset = page.nextOffset;
		} while (offset !== null);
		data = JSON.parse(json);
		expect(output(data).valid).toBe(true);
	}
	return JSON.parse(JSON.stringify(data));
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-document-analysis-')));
	store = new PersistentStore(join(root, 'editorial.sqlite'));
	source = new ProjectSource(
		root,
		store,
		async () => [{ id: DOCUMENT, type: 'Text', title: 'Scene', path: 'Draft/Scene' }],
		async () => readFile(join(root, 'content.rtf'), 'utf8')
	);
	local = new ContentAnalyzer();
	context = {
		project: { getEditorialServices: () => ({ source }) },
		contentAnalyzer: local,
	} as unknown as HandlerContext;
	chat = jest.spyOn(AIClient.prototype, 'chat').mockResolvedValue(JSON.stringify(valid));
	(checkGrammar as jest.Mock)
		.mockReset()
		.mockImplementation(jest.requireActual('narrative-lens').checkGrammar);
	await save(text);
});

afterEach(async () => {
	jest.restoreAllMocks();
	local.dispose();
	store.close();
	await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
	for (const path of spools) await rm(path, { recursive: true, force: true });
});

test('sends the complete saved source and selected focus, with stable semantic request identity', async () => {
	const document = await source.read(DOCUMENT);
	const before = await readFile(join(root, 'content.rtf'), 'utf8');
	const types = ['style', 'characters'];
	const pending = call({ analysisTypes: types });
	types.splice(0, 2, 'pacing');
	const result = await pending;
	expect(chat.mock.calls[0][0]).toContain(document.text);
	expect(chat.mock.calls[0][0]).toContain('requested areas: characters, style');
	expect(result).toMatchObject({
		...valid,
		focus: { requested: ['characters', 'style'], scope: 'provider-instructions' },
		coverage: {
			start: 0,
			end: document.text.length,
			sourceCharacters: document.text.length,
			truncated: false,
		},
		availability: {
			provider: 'available',
			providerReason: null,
			local: 'not_requested',
			grammar: 'not_requested',
			unavailable: [],
		},
		envelope: {
			sourceFormat: 'saved-rtf',
			sourceRevisions: [{ documentId: DOCUMENT, revision: document.revision }],
			policy: { mode: 'provider', revisionChecked: true },
		},
	});
	expect((await call({ analysisTypes: ['characters', 'style'] })).envelope.requestId).toBe(
		result.envelope.requestId
	);
	expect((await call({ analysisTypes: types })).envelope.requestId).not.toBe(
		result.envelope.requestId
	);
	expect((await call()).envelope.requestId).toBe(
		(await call({ analysisTypes: ['all'] })).envelope.requestId
	);
	expect(await readFile(join(root, 'content.rtf'), 'utf8')).toBe(before);
});

test('malformed provider output yields real native findings and explicit broad fallback scope', async () => {
	chat.mockResolvedValue('{"issues":[]}');
	const result = await call({ analysisTypes: ['characters'] });
	expect(result).toMatchObject({
		focus: { requested: ['characters'], scope: 'broad-local' },
		availability: {
			provider: 'unavailable',
			providerReason: 'provider_failed',
			local: 'available',
			grammar: 'available',
		},
		envelope: { policy: { mode: 'raw', usesSavedProjectControls: false } },
	});
	expect(result.issues).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ description: expect.stringMatching(/Repeated word/) }),
			expect.objectContaining({ description: expect.stringMatching(/cliche/) }),
		])
	);
	expect(JSON.stringify(result)).not.toMatch(/unknown|\[object Object\]/);
});

test('native grammar findings survive failure of the entire local analyzer', async () => {
	chat.mockRejectedValue(new Error('private provider fixture'));
	jest.spyOn(local, 'analyzeContent').mockRejectedValue(new Error('private local fixture'));
	const result = await call();
	expect(result).toMatchObject({
		readability: 'unavailable',
		pacing: 'unavailable',
		availability: { local: 'unavailable', grammar: 'available' },
	});
	expect(result.nativeFindings).toEqual(
		expect.arrayContaining([expect.objectContaining({ kind: 'repetition' })])
	);
	expect(result.issues).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ description: expect.stringMatching(/Repeated word/) }),
		])
	);
	expect(JSON.stringify(result)).not.toContain('private');
});

test('local prose findings survive an independent native grammar failure', async () => {
	chat.mockRejectedValue(new Error('provider fixture'));
	(checkGrammar as jest.Mock).mockImplementation(() => {
		throw new Error('grammar fixture');
	});
	const result = await call();
	expect(result.availability).toMatchObject({
		provider: 'unavailable',
		local: 'available',
		grammar: 'unavailable',
	});
	expect(result.issues).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ description: expect.stringMatching(/cliche/) }),
		])
	);
});

test('simultaneous failures cannot masquerade as measured prose quality', async () => {
	chat.mockRejectedValue(new Error('provider fixture'));
	jest.spyOn(local, 'analyzeContent').mockRejectedValue(new Error('local fixture'));
	(checkGrammar as jest.Mock).mockImplementation(() => {
		throw new Error('grammar fixture');
	});
	expect(await call()).toMatchObject({
		readability: 'unavailable',
		pacing: 'unavailable',
		issues: [],
		availability: {
			provider: 'unavailable',
			local: 'unavailable',
			grammar: 'unavailable',
			unavailable: ['provider', 'local', 'grammar', 'readability', 'pacing'],
		},
	});
});

test.each([11999, 12000, 12001])(
	'reports complete input coverage at %i UTF-16 characters, without a clipped provider critique',
	async (length) => {
		await save('x'.repeat(length - 3) + '🌙.');
		const result = await call();
		expect(result.coverage).toEqual({
			start: 0,
			end: length,
			sourceCharacters: length,
			truncated: false,
		});
		if (length <= 12000) {
			expect(chat).toHaveBeenCalledTimes(1);
			expect(result.availability.provider).toBe('available');
		} else {
			expect(chat).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				availability: { providerReason: 'source_limit' },
				focus: { scope: 'broad-local' },
				envelope: { policy: { providerAccess: false } },
			});
		}
	}
);

test('empty saved text reports absence instead of claiming a provider analyzed it', async () => {
	await save('');
	expect(await call()).toMatchObject({
		readability: 'unavailable',
		pacing: 'unavailable',
		issues: [],
		availability: { provider: 'unavailable', providerReason: 'empty_source' },
		envelope: { policy: { mode: 'raw', providerAccess: false } },
	});
	expect(chat).not.toHaveBeenCalled();
});

test('spools large Unicode provider findings without omissions or duplicate entries', async () => {
	const issues = Array.from({ length: 20 }, (_, index) => ({
		description: `${index}: ${'🌙'.repeat(250)}`,
	}));
	chat.mockResolvedValue(JSON.stringify({ ...valid, issues }));
	expect((await call()).issues).toEqual(issues);
});

test.each([
	{ analysisTypes: [] },
	{ analysisTypes: ['style', 'style'] },
	{ analysisTypes: ['unknown'] },
	{ analysisTypes: 'style' },
	{ analysisTypes: [3] },
	{ analysisTypes: null },
	{ documentId: '' },
	{ documentId: '\0' },
	{ extra: true },
])('rejects invalid request %j before source or provider use', async (extra) => {
	const request = { documentId: DOCUMENT, ...extra };
	expect(input(request).valid).toBe(false);
	const read = jest.spyOn(source, 'read');
	await expect(tool.handler(request, context)).rejects.toThrow();
	expect(read).not.toHaveBeenCalled();
	expect(chat).not.toHaveBeenCalled();
});

test.each([true, false])(
	'rejects changed saved input after provider success=%s',
	async (success) => {
		chat.mockImplementation(async () => {
			await save('An external change.');
			if (!success) throw new Error('provider fixture');
			return JSON.stringify(valid);
		});
		await expect(call()).rejects.toThrow('Saved source changed');
	}
);

test('checks project ownership after the final asynchronous source read', async () => {
	const read = source.read.bind(source);
	let reads = 0;
	jest.spyOn(source, 'read').mockImplementation(async (id) => {
		const document = await read(id);
		if (++reads === 2) context.project = null;
		return document;
	});
	await expect(call()).rejects.toThrow('Selected project changed');
});

test('does not send source data after a project switch during the initial read', async () => {
	const read = source.read.bind(source);
	jest.spyOn(source, 'read').mockImplementation(async (id) => {
		const document = await read(id);
		context.project = null;
		return document;
	});
	await expect(call()).rejects.toThrow('Selected project changed');
	expect(chat).not.toHaveBeenCalled();
});
