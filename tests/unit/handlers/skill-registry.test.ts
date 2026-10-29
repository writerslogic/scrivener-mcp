import {
	initializeSkillRegistry,
	activateSkill,
	activateSkillForTool,
	getRegisteredTools,
	getToolCatalogRevision,
	executeRegisteredHandler,
	validateRegisteredArgs,
} from '../../../src/handlers/skill-registry.js';
import { HandlerError, type HandlerContext } from '../../../src/handlers/types.js';

const DOCUMENT = '11111111-1111-4111-8111-111111111111';
const eager = process.env.SCRIVENER_MCP_EAGER_TOOLS;
const toolNames = (): string[] => getRegisteredTools().map((tool) => tool.name);
const context = (project: HandlerContext['project'] = null): HandlerContext => ({
	project,
	memoryManager: null,
	contentAnalyzer: {} as HandlerContext['contentAnalyzer'],
	contentEnhancer: {} as HandlerContext['contentEnhancer'],
});

beforeEach(() => {
	delete process.env.SCRIVENER_MCP_EAGER_TOOLS;
	initializeSkillRegistry();
});

afterAll(() => {
	if (eager === undefined) delete process.env.SCRIVENER_MCP_EAGER_TOOLS;
	else process.env.SCRIVENER_MCP_EAGER_TOOLS = eager;
});

test('progressive activation changes the catalog once and keeps hidden tools unavailable', async () => {
	expect(toolNames()).toEqual(
		expect.arrayContaining(['list_skills', 'use_skill', 'read_result', 'open_project'])
	);
	expect(toolNames()).not.toContain('analyze_document');
	const before = getToolCatalogRevision();
	await expect(executeRegisteredHandler('analyze_document', {}, context())).rejects.toMatchObject({
		code: 'INVALID_ARGUMENT',
	});
	expect(toolNames()).toContain('analyze_document');
	expect(getToolCatalogRevision()).toBe(before + 1);
	expect(activateSkillForTool('analyze_document')).toBe(false);
	expect(activateSkillForTool('list_skills')).toBe(false);
	for (const name of ['find_analogies', 'build_vector_store', 'no_such_tool']) {
		await expect(executeRegisteredHandler(name, {}, context())).rejects.toMatchObject({
			code: 'UNKNOWN_TOOL',
		});
		expect(toolNames()).not.toContain(name);
	}
	expect(getToolCatalogRevision()).toBe(before + 1);
});

test('activation order and repeated initialization preserve the same eager source order', () => {
	process.env.SCRIVENER_MCP_EAGER_TOOLS = '1';
	initializeSkillRegistry();
	const eagerTools = toolNames();
	delete process.env.SCRIVENER_MCP_EAGER_TOOLS;
	initializeSkillRegistry();
	for (const skill of [
		'advanced',
		'relationships',
		'memory',
		'credentials',
		'compilation',
		'analysis',
		'search',
		'documents',
	])
		activateSkill(skill);
	expect(toolNames()).toEqual(eagerTools);
	expect(new Set(eagerTools).size).toBe(eagerTools.length);
	initializeSkillRegistry();
	expect(toolNames().filter((name) => name === 'use_skill')).toHaveLength(1);
	expect(toolNames()).not.toContain('analyze_document');
});

test('fallback discovery includes complete callable schemas on activation and repeat calls', async () => {
	const first = await executeRegisteredHandler('use_skill', { name: 'search' }, context());
	const second = await executeRegisteredHandler('use_skill', { name: 'search' }, context());
	expect(first.structuredContent?.activated).toBe(true);
	expect(second.structuredContent?.activated).toBe(false);
	expect(second.structuredContent?.tools).toEqual(first.structuredContent?.tools);
	const tools = first.structuredContent?.tools as ReturnType<typeof getRegisteredTools>;
	const search = tools.find((tool) => tool.name === 'search_passages');
	expect(search).toEqual(getRegisteredTools().find((tool) => tool.name === 'search_passages'));
	expect(search?.inputSchema).toMatchObject({
		type: 'object',
		required: ['query'],
		properties: {
			limit: { type: 'integer', minimum: 1, maximum: 50 },
			documentIds: { type: 'array', maxItems: 10000, items: { type: 'string', maxLength: 128 } },
		},
	});
	const text = first.content[0].text!;
	expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toEqual(tools);
	expect((await executeRegisteredHandler('use_skill', { name: 'unknown' }, context())).isError).toBe(
		true
	);
	const textOnly = await executeRegisteredHandler('use_skill', { name: 'project' }, context());
	const apps = await executeRegisteredHandler('use_skill', { name: 'project' }, {
		...context(),
		uiSupported: true,
	});
	const dashboard = (result: typeof apps) =>
		(result.structuredContent?.tools as ReturnType<typeof getRegisteredTools>).find(
			(tool) => tool.name === 'manuscript_dashboard'
		);
	expect(dashboard(textOnly)?._meta).toBeUndefined();
	expect(dashboard(apps)?._meta).toEqual(
		getRegisteredTools(true).find((tool) => tool.name === 'manuscript_dashboard')?._meta
	);
	expect(dashboard(apps)?._meta).toBeDefined();
});

test('direct dispatch rejects malformed inputs before metadata writes and preserves valid values', async () => {
	const saved: Record<string, Record<string, string>> = {};
	let writes = 0;
	const project = {
		ensureWritable: async () => undefined,
		updateDocumentMetadata: async (
			id: string,
			metadata: { customMetadata: Record<string, string> }
		) => {
			writes++;
			saved[id] = { ...metadata.customMetadata };
		},
	} as unknown as HandlerContext['project'];
	const active = context(project);
	for (const args of [
		{},
		{ documentId: 17, customMetadata: { label: 'Safe' } },
		{ documentId: DOCUMENT, force: 'false', customMetadata: { label: 'Safe' } },
		{ documentId: DOCUMENT, customMetadata: { label: 17 } },
		null,
		[],
	]) {
		await expect(
			executeRegisteredHandler('update_document', args as Record<string, unknown>, active)
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
	}
	expect(saved).toEqual({});
	expect(writes).toBe(0);
	const args = { documentId: DOCUMENT, force: false, customMetadata: { label: 'Café 🌙' } };
	const result = await executeRegisteredHandler('update_document', args, active);
	expect(result.isError).not.toBe(true);
	expect(saved).toEqual({ [DOCUMENT]: { label: 'Café 🌙' } });
	expect(writes).toBe(1);
	expect(args.customMetadata.label).toBe('Café 🌙');
});

test.each([
	{ action: 'erase' },
	{ action: 'propose', edits: [{ start: 0.5, end: 2, text: 'x' }] },
	{ action: 'propose', edits: [{ start: 0, end: 2 }] },
	{ action: 'propose', edits: [{ start: 0, end: 2, text: 17 }] },
])('enforces published nested edit types and operation enum: %j', async (args) => {
	await expect(executeRegisteredHandler('review_changes', args, context())).rejects.toMatchObject({
		code: 'INVALID_ARGUMENT',
	});
});

test.each([
	['limit', 0, false],
	['limit', 1, true],
	['limit', 2, true],
	['limit', 49, true],
	['limit', 50, true],
	['limit', 51, false],
	['contextChars', -1, false],
	['contextChars', 0, true],
	['contextChars', 1, true],
	['contextChars', 1999, true],
	['contextChars', 2000, true],
	['contextChars', 2001, false],
] as const)('enforces %s boundary %i without coercion', (field, value, valid) => {
	const validate = () => validateRegisteredArgs('search_passages', { query: 'loyalty', [field]: value });
	if (valid) expect(validate).not.toThrow();
	else expect(validate).toThrow(HandlerError);
});

test('enforces array item constraints, closed schemas, and declared string bounds', () => {
	for (const args of [
		{ query: '', documentIds: [DOCUMENT] },
		{ query: 'x'.repeat(2049) },
		{ query: 'loyalty', limit: '1' },
		{ query: 'loyalty', mode: 'approximate' },
		{ query: 'loyalty', documentIds: [17] },
		{ query: 'loyalty', documentIds: ['x'.repeat(129)] },
		{ query: 'loyalty', documentIds: Array.from({ length: 10001 }, () => DOCUMENT) },
	])
		expect(() => validateRegisteredArgs('search_passages', args)).toThrow(HandlerError);
	expect(() => validateRegisteredArgs('c2pa_capabilities', { extra: true })).toThrow(HandlerError);
	for (const query of ['x', 'x'.repeat(2047), 'x'.repeat(2048)])
		expect(() => validateRegisteredArgs('search_passages', { query })).not.toThrow();
	for (const count of [9999, 10000])
		expect(() =>
			validateRegisteredArgs('search_passages', {
				query: 'loyalty',
				documentIds: Array.from({ length: count }, () => DOCUMENT),
			})
		).not.toThrow();
});
