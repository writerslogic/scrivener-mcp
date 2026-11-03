import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AIClient } from '../../src/services/ai/ai-client.js';
import { ProjectSource, savedRevision } from '../../src/services/editorial/project-source.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';
import { enhanceContentHandler as tool } from '../../src/handlers/analysis-handlers/document-analysis.js';
import { ENHANCEMENT_INSTRUCTIONS } from '../../src/services/enhancements/ai-content-enhancer.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { disposeSpool, readResult } from '../../src/core/response-formatter.js';

const DOCUMENT = '10000000-0000-4000-8000-000000000001';
const validator = new AjvJsonSchemaValidator();
const input = validator.getValidator(tool.inputSchema as JsonSchemaType);
const output = validator.getValidator(tool.outputSchema as JsonSchemaType);
const rtf = new RTFHandler();
let root: string;
let store: PersistentStore;
let source: ProjectSource;
let context: HandlerContext;
let chat: jest.SpiedFunction<AIClient['chat']>;
const args = { documentId: DOCUMENT, enhancementType: 'style' };

async function save(text: string) {
	const raw = rtf.convertToRTF(text);
	await writeFile(join(root, 'content.rtf'), raw);
	return savedRevision(raw);
}

async function call(extra: Record<string, unknown> = {}, failed = false) {
	const request = { ...args, ...extra };
	expect(input(request).valid).toBe(true);
	const response = await tool.handler(request, context);
	expect(Boolean(response.isError)).toBe(failed);
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
	return data;
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-enhancement-')));
	store = new PersistentStore(join(root, 'editorial.sqlite'));
	source = new ProjectSource(
		root,
		store,
		async () => [{ id: DOCUMENT, type: 'Text', title: 'Scene', path: 'Draft/Scene' }],
		async () => readFile(join(root, 'content.rtf'), 'utf8')
	);
	context = {
		project: { getEditorialServices: () => ({ source }) },
		personalization: {
			buildDirective: jest.fn().mockResolvedValue('Keep the restrained voice.'),
		},
	} as unknown as HandlerContext;
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

test('returns the proposed text, saved-source envelope and full coverage without changing the source', async () => {
	const before = await readFile(join(root, 'content.rtf'), 'utf8');
	const saved = await source.read(DOCUMENT);
	const result = await call();
	expect(result).toMatchObject({
		original: saved.text,
		enhanced: 'Mara watched the harbor. 🌙',
		changed: true,
		qualityValidation: null,
	});
	expect(result.coverage).toEqual({
		start: 0,
		end: saved.text.length,
		sourceCharacters: saved.text.length,
		sourceRevision: createHash('sha256').update(saved.text).digest('hex'),
		truncated: false,
	});
	expect(result.envelope).toMatchObject({
		sourceFormat: 'saved-rtf',
		sourceRevisions: [{ documentId: DOCUMENT, revision: saved.revision }],
		policy: { mode: 'provider', revisionChecked: true },
	});
	expect(chat.mock.calls[0][0]).toContain(saved.text);
	expect(chat.mock.calls[0][1]?.system).toContain('Keep the restrained voice.');
	expect(await readFile(join(root, 'content.rtf'), 'utf8')).toBe(before);
});

test.each(Object.entries(ENHANCEMENT_INSTRUCTIONS))(
	'uses the declared instruction for %s',
	async (enhancementType, instruction) => {
		await call({ enhancementType });
		expect(chat.mock.calls[0][0]).toContain(instruction);
	}
);

test('keeps unchanged provider output as a structured result with provenance', async () => {
	const original = (await source.read(DOCUMENT)).text;
	chat.mockResolvedValue(original);
	expect(await call()).toMatchObject({ original, enhanced: original, changed: false });
});

test('snapshots explicit options, applies them in the prompt, and identifies changed instructions', async () => {
	const options = {
		tone: 'darker',
		length: 100,
		complexity: 'simplify',
		perspective: 'first',
		tense: 'past',
		preserveDialogue: true,
		preserveNames: true,
		aggressiveness: 'light',
		context: 'A moonlit harbor.',
	};
	const pending = call({ options });
	options.tone = 'lighter';
	const result = await pending;
	expect(chat.mock.calls[0][0]).toContain('"tone":"darker"');
	expect(chat.mock.calls[0][0]).toContain('"length":100');
	expect(chat.mock.calls[0][0]).toContain('A moonlit harbor.');
	expect((await call({ options })).envelope).not.toEqual(result.envelope);
});

test.each([11999, 12000, 12001])(
	'admits the whole source or rejects it at %i UTF-16 characters',
	async (length) => {
		const text = 'x'.repeat(length - 3) + '🌙.';
		await save(text);
		if (length > 12000) {
			await expect(call()).rejects.toThrow('1–12000 UTF-16');
			expect(chat).not.toHaveBeenCalled();
		} else {
			const result = await call();
			expect(result.coverage).toMatchObject({ end: length, truncated: false });
			expect(chat.mock.calls[0][0]).toContain(text);
		}
	}
);

test.each([63999, 64000, 64001])(
	'preserves complete Unicode output or rejects it at %i UTF-16 characters',
	async (length) => {
		const text = 'x'.repeat(length - 3) + '🌙.';
		chat.mockResolvedValue(text);
		const result = await call({}, length > 64000);
		expect(result.enhanced).toBe(length > 64000 ? null : text);
	}
);

test.each([1999, 2000, 2001])('bounds context at %i characters', async (length) => {
	const options = { context: 'x'.repeat(length) };
	expect(input({ ...args, options }).valid).toBe(length <= 2000);
	if (length > 2000) {
		await expect(tool.handler({ ...args, options }, context)).rejects.toThrow(
			'Invalid enhancement option'
		);
		expect(chat).not.toHaveBeenCalled();
	} else await call({ options });
});

test.each([0, 1, 2, 3999, 4000, 4001])(
	'validates target word count %i before provider use',
	async (length) => {
		const valid = length >= 1 && length <= 4000;
		expect(input({ ...args, options: { length } }).valid).toBe(valid);
		if (valid) await call({ options: { length } });
		else {
			await expect(tool.handler({ ...args, options: { length } }, context)).rejects.toThrow(
				'Invalid enhancement option'
			);
			expect(chat).not.toHaveBeenCalled();
		}
	}
);

test.each([
	null,
	[],
	{ tone: 'unknown' },
	{ preserveNames: 'true' },
	{ length: 1.5 },
	{ context: 7 },
	{ context: '\0' },
	{ arbitrary: true },
	JSON.parse('{"__proto__":"unsafe"}'),
])('rejects invalid options %j consistently with the schema', async (options) => {
	expect(input({ ...args, options }).valid).toBe(false);
	await expect(tool.handler({ ...args, options }, context)).rejects.toThrow();
	expect(chat).not.toHaveBeenCalled();
});

test.each([
	{},
	{ documentId: DOCUMENT },
	{ ...args, enhancementType: '__proto__' },
	{ ...args, documentId: '' },
	{ ...args, extra: true },
])('rejects invalid request %j before provider use', async (request) => {
	expect(input(request).valid).toBe(false);
	await expect(tool.handler(request, context)).rejects.toThrow();
	expect(chat).not.toHaveBeenCalled();
});

test.each(['', '   ', null, 5])(
	'reports malformed provider output %j as unavailable without falling back',
	async (text) => {
		chat.mockResolvedValue(text as string);
		expect(await call({}, true)).toMatchObject({
			enhanced: null,
			availability: { status: 'unavailable', reason: 'provider_failed' },
		});
	}
);

test('does not expose provider error bodies or manufacture a successful rewrite', async () => {
	chat.mockRejectedValue(new Error('private manuscript and fixture-secret-key'));
	const result = await call({}, true);
	expect(JSON.stringify(result)).not.toMatch(/private manuscript|fixture-secret-key/);
	expect(result.enhanced).toBeNull();
	expect(chat).toHaveBeenCalledTimes(1);
});

test.each([true, false])(
	'rejects changed saved source after provider success=%s',
	async (success) => {
		chat.mockImplementation(async () => {
			await save('An external revision.');
			if (!success) throw new Error('provider unavailable');
			return 'A proposed rewrite.';
		});
		await expect(call({}, !success)).rejects.toThrow('Saved source changed');
	}
);

test('propagates preference and source failures without mislabeling them as provider outages', async () => {
	jest.spyOn(context.personalization!, 'buildDirective').mockRejectedValueOnce(
		new Error('preferences unavailable')
	);
	await expect(call()).rejects.toThrow('preferences unavailable');
	await rm(join(root, 'content.rtf'));
	await expect(call()).rejects.toThrow();
	expect(chat).not.toHaveBeenCalled();
});
