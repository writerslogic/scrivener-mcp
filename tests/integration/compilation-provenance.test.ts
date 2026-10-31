import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { AIClient } from '../../src/services/ai/ai-client.js';
import { ProjectSource, savedRevision } from '../../src/services/editorial/project-source.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { DocumentManager } from '../../src/services/document-manager.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';
import {
	compileDocumentsHandler as compile,
	generateMarketingMaterialsHandler as marketing,
} from '../../src/handlers/compilation-handlers.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { readResult } from '../../src/core/response-formatter.js';

const ROOT = '10000000-0000-4000-8000-000000000000';
const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const RESEARCH = '10000000-0000-4000-8000-000000000003';
type Item = { UUID: string; Type: string; Title: string };
const validator = new AjvJsonSchemaValidator();
const validateCompile = validator.getValidator(compile.outputSchema as JsonSchemaType);
const validateMarketing = validator.getValidator(marketing.outputSchema as JsonSchemaType);
const rtf = new RTFHandler();
const spools = new Set<string>();
let root: string;
let store: PersistentStore;
let manager: DocumentManager;
let source: ProjectSource;
let context: HandlerContext;
let children: Item[];
let chat: jest.SpiedFunction<AIClient['chat']>;

async function save(text: string, id = FIRST): Promise<string> {
	const file = join(root, 'Files', 'Data', id, 'content.rtf');
	await mkdir(dirname(file), { recursive: true });
	const raw = rtf.convertToRTF(text);
	await writeFile(file, raw);
	return savedRevision(raw);
}

function retrieved(value: Record<string, unknown>): Record<string, unknown> {
	const id = (value._ref ?? value.resultId) as string;
	if (!id) return value;
	spools.add(dirname((value._file ?? value.file) as string));
	let offset: number | null = 0;
	let text = '';
	do {
		const page = readResult(id, offset, 1024);
		text += page.text;
		offset = page.nextOffset;
	} while (offset !== null);
	return JSON.parse(text);
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-compilation-')));
	store = new PersistentStore(join(root, '.scrivener-mcp', 'editorial.sqlite'));
	manager = new DocumentManager(root);
	children = [{ UUID: FIRST, Type: 'Text', Title: 'Opening' }];
	manager.setProjectStructure({
		ScrivenerProject: {
			Binder: {
				BinderItem: [
					{
						UUID: ROOT,
						Type: 'DraftFolder',
						Title: 'Draft',
						Children: { BinderItem: children },
					},
					{ UUID: RESEARCH, Type: 'Text', Title: 'Research' },
				],
			},
		},
	});
	source = new ProjectSource(
		root,
		store,
		() => manager.getDocumentsUnderFolder(ROOT),
		(id) => manager.readDocumentRaw(id),
		() => manager.getAllDocuments()
	);
	context = {
		project: {
			getAllDocuments: () => manager.getAllDocuments(),
			getDocumentsUnderFolder: (id: string) => manager.getDocumentsUnderFolder(id),
			readDocumentFormattedVersion: (id: string) => manager.readDocumentFormattedVersion(id),
			getEditorialServices: () => ({ source }),
		},
		personalization: { buildDirective: async () => '' },
	} as unknown as HandlerContext;
	chat = jest
		.spyOn(AIClient.prototype, 'chat')
		.mockImplementation(async (prompt) =>
			prompt.startsWith('Assess the quality')
				? '{"score":null,"suggestions":["Keep the ending",null],"issues":[]}'
				: 'Generated prose with <angle> & symbols.'
		);
	await save('Saved opening: Café — 東京 🌙.');
	await save('Research material outside the manuscript.', RESEARCH);
});

afterEach(async () => {
	try {
		await manager.close();
	} finally {
		store.close();
		jest.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	}
});

afterAll(async () => {
	for (const directory of spools) await rm(directory, { recursive: true, force: true });
});

test('preserves a complete oversized compilation and exposes warnings, availability and saved revisions', async () => {
	const body = 'x'.repeat(12000) + '東京 🌙 END';
	const revision = await save(body);
	const result = await compile.handler({ mode: 'intelligent', documentIds: [FIRST] }, context);
	expect(result.isError).not.toBe(true);
	expect(validateCompile(result.structuredContent).valid).toBe(true);
	expect(retrieved(result.structuredContent!).compiledText).toBe(body);
	const ai = retrieved(result.structuredContent!.ai as Record<string, unknown>);
	expect(ai).toMatchObject({
		metadata: { optimizations: [], warnings: [expect.stringContaining('12000')] },
		quality: {
			score: null,
			suggestions: ['Keep the ending'],
			availability: 'partial',
			partialFields: ['suggestions'],
			coverage: { end: 4000, sourceCharacters: body.length, truncated: true },
		},
		envelope: {
			sourceRevisions: [{ documentId: FIRST, revision }],
			sourceFormat: 'saved-rtf',
			policy: { mode: 'provider', revisionChecked: true },
		},
	});
	expect(chat).toHaveBeenCalledTimes(1);
	expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12000);
});

test.each(['text', 'markdown', 'html'])(
	'renders provider plain text as requested %s output',
	async (format) => {
		const result = await compile.handler(
			{ mode: 'intelligent', documentIds: [FIRST], format },
			context
		);
		expect(validateCompile(result.structuredContent).valid).toBe(true);
		const text = result.structuredContent!.text as string;
		expect(text).toContain(
			format === 'html' ? '&lt;angle&gt; &amp; symbols.' : '<angle> & symbols.'
		);
		if (format === 'html') expect(text).toContain('<h1>Opening</h1>');
		expect(chat.mock.calls[0][0]).toContain('Saved opening: Café — 東京 🌙.');
		expect(chat.mock.calls[0][0]).not.toContain('<h1>');
	}
);

test('preserves every quality finding when analysis is separately spooled', async () => {
	const suggestions = Array.from(
		{ length: 160 },
		(_, i) => `Finding ${i}: ${'東京 '.repeat(20)}`
	);
	chat.mockImplementation(async (prompt) =>
		prompt.startsWith('Assess the quality')
			? JSON.stringify({ score: 0, suggestions, issues: [] })
			: 'Revised source.'
	);
	const result = await compile.handler({ mode: 'intelligent', documentIds: [FIRST] }, context);
	expect(validateCompile(result.structuredContent).valid).toBe(true);
	const ai = result.structuredContent!.ai as Record<string, unknown>;
	expect(ai._ref).toEqual(expect.any(String));
	expect(retrieved(ai)).toMatchObject({
		quality: { score: 0, suggestions, availability: 'available' },
	});
});

test.each([compile, marketing])(
	'%s rejects a saved revision changed during generation',
	async (tool) => {
		chat.mockImplementation(async () => {
			await save('Changed during generation.');
			return 'Stale generated prose.';
		});
		const result = await tool.handler(
			{
				...(tool === compile ? { mode: 'intelligent' } : { materialType: 'synopsis' }),
				documentIds: [FIRST],
			},
			context
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain('Stale generated prose.');
	}
);

test.each(['title', 'addition', 'order'])(
	'compilation rejects changed binder %s',
	async (change) => {
		children.push({ UUID: SECOND, Type: 'Text', Title: 'Ending' });
		await save('The complete ending.', SECOND);
		chat.mockImplementation(async () => {
			if (change === 'title') children[0].Title = 'Changed title';
			if (change === 'addition' && children.length === 2)
				children.push({ UUID: RESEARCH, Type: 'Text', Title: 'New scene' });
			if (change === 'order') children.sort((a, b) => b.UUID.localeCompare(a.UUID));
			return '{}';
		});
		const result = await compile.handler({ mode: 'intelligent', rootFolderId: ROOT }, context);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
	}
);

test('marketing reads saved Draft text despite unhydrated binder metadata and returns source provenance', async () => {
	expect((await manager.getAllDocuments()).find((d) => d.id === FIRST)?.content).toBeUndefined();
	const result = await marketing.handler({ materialType: 'synopsis', length: 'long' }, context);
	expect(result.isError).not.toBe(true);
	expect(validateMarketing(result.structuredContent).valid).toBe(true);
	const data = retrieved(result.structuredContent!);
	expect(data).toMatchObject({
		content: 'Generated prose with <angle> & symbols.',
		coverage: { sourceCharacters: 'Saved opening: Café — 東京 🌙.'.length, truncated: false },
		envelope: {
			sourceRevisions: [
				{
					documentId: FIRST,
					revision: savedRevision(
						await readFile(join(root, 'Files', 'Data', FIRST, 'content.rtf'), 'utf8')
					),
				},
			],
			policy: { mode: 'provider', revisionChecked: true },
		},
	});
	expect(chat.mock.calls[0][0]).toContain('Saved opening: Café — 東京 🌙.');
	expect(chat.mock.calls[0][0]).not.toContain('Research material');
	expect(chat.mock.calls[0][1]?.maxTokens).toBeGreaterThan(2000);
	expect(JSON.parse(result.content[0].text!)).toEqual(result.structuredContent);
});

test('marketing accepts an explicit saved supplemental scope', async () => {
	const result = await marketing.handler(
		{ materialType: 'book_blurb', documentIds: [RESEARCH] },
		context
	);
	expect(result.isError).not.toBe(true);
	expect(chat.mock.calls[0][0]).toContain('Research material outside the manuscript.');
	expect(chat.mock.calls[0][0]).not.toContain('Saved opening');
});

test.each([11999, 12000, 12001])(
	'marketing checks complete source size at %i characters',
	async (length) => {
		const body = 'a'.repeat(length - 4) + 'TAIL';
		await save(body);
		const request = marketing.handler({ materialType: 'synopsis' }, context);
		if (length > 12000) {
			await expect(request).rejects.toThrow(/12000/);
			expect(chat).not.toHaveBeenCalled();
		} else {
			expect((await request).isError).not.toBe(true);
			expect(chat.mock.calls[0][0]).toContain(body);
		}
	}
);

test('marketing rechecks default manuscript membership, not only existing revisions', async () => {
	chat.mockImplementation(async () => {
		children.push({ UUID: SECOND, Type: 'Text', Title: 'New ending' });
		await save('Added after admission.', SECOND);
		return 'Stale synopsis.';
	});
	expect((await marketing.handler({ materialType: 'synopsis' }, context)).isError).toBe(true);
});

test.each([
	{ documentIds: [] },
	{ documentIds: [FIRST, FIRST] },
	{ documentIds: [null] },
	{ documentIds: ['x'.repeat(129)] },
	{ documentIds: [SECOND] },
	{ materialType: 'unknown' },
	{ length: 'huge' },
	{ targetAudience: 12 },
	{ targetAudience: 'a'.repeat(2001) },
	{ documentIds: FIRST },
	{ unexpected: true },
])('rejects malformed marketing scope/options before generation: %j', async (invalid) => {
	await expect(
		marketing.handler({ materialType: 'synopsis', ...invalid }, context)
	).rejects.toThrow();
	expect(chat).not.toHaveBeenCalled();
});

test('marketing errors never expose provider text or masquerade as generated materials', async () => {
	chat.mockRejectedValue(new Error('PRIVATE provider payload'));
	const result = await marketing.handler({ materialType: 'query_letter' }, context);
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toBeUndefined();
	expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

test('large marketing output is retrieved losslessly in bounded UTF-8 chunks', async () => {
	const body = '東京 café 🌙 '.repeat(1200);
	chat.mockResolvedValue(body);
	const result = await marketing.handler({ materialType: 'pitch_packet' }, context);
	expect(validateMarketing(result.structuredContent).valid).toBe(true);
	expect(result.structuredContent!._ref).toEqual(expect.any(String));
	expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4000);
	const full = retrieved(result.structuredContent!);
	expect(full.content).toBe(body);
	expect(validateMarketing(full).valid).toBe(true);
});
