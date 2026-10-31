import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { AIClient } from '../../src/services/ai/ai-client.js';
import {
	COLLABORATION_ROLES,
	type CollaborationResult,
} from '../../src/services/agents/ai-collaboration.js';
import { ProjectSource, savedRevision } from '../../src/services/editorial/project-source.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import type { AnalysisEnvelope } from '../../src/services/editorial/analysis-envelope.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';
import { multiAgentAnalysisHandler as tool } from '../../src/handlers/analysis-handlers/advanced.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { readResult } from '../../src/core/response-formatter.js';

const DOCUMENT = '10000000-0000-4000-8000-000000000001';
const validator = new AjvJsonSchemaValidator();
const validateInput = validator.getValidator(tool.inputSchema as JsonSchemaType);
const validateOutput = validator.getValidator(tool.outputSchema as JsonSchemaType);
const rtf = new RTFHandler();
const spools = new Set<string>();
let root: string;
let store: PersistentStore;
let source: ProjectSource;
let context: HandlerContext;
let chat: jest.SpiedFunction<AIClient['chat']>;
const feedback = {
	perspectives: COLLABORATION_ROLES.map((role) => ({ role, feedback: `Evidence for ${role}.` })),
	synthesis: 'Preserve the ending.',
	consensus: 'Clarify the opening.',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function save(text: string): Promise<string> {
	const raw = rtf.convertToRTF(text);
	await writeFile(join(root, 'content.rtf'), raw);
	return savedRevision(raw);
}

async function analyze(
	args: Record<string, unknown> = {}
): Promise<CollaborationResult & { envelope: AnalysisEnvelope }> {
	const response = await tool.handler({ documentId: DOCUMENT, ...args }, context);
	expect(response.isError).not.toBe(true);
	expect(JSON.parse(response.content[0].text!)).toEqual(response.structuredContent);
	expect(validateOutput(response.structuredContent).valid).toBe(true);
	let data = response.structuredContent!;
	if (typeof data._ref === 'string') {
		expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);
		spools.add(dirname(data._file as string));
		let offset: number | null = 0;
		let json = '';
		do {
			const page = readResult(data._ref, offset, 1024);
			expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1024);
			json += page.text;
			offset = page.nextOffset;
		} while (offset !== null);
		data = JSON.parse(json);
		expect(validateOutput(data).valid).toBe(true);
	}
	return data as unknown as CollaborationResult & { envelope: AnalysisEnvelope };
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-critique-')));
	store = new PersistentStore(join(root, 'editorial.sqlite'));
	source = new ProjectSource(
		root,
		store,
		async () => [{ id: DOCUMENT, type: 'Text', title: 'Opening', path: 'Draft/Opening' }],
		async () => readFile(join(root, 'content.rtf'), 'utf8')
	);
	context = {
		project: { getEditorialServices: () => ({ source }) },
	} as unknown as HandlerContext;
	chat = jest.spyOn(AIClient.prototype, 'chat').mockResolvedValue(JSON.stringify(feedback));
	await save('Mara waited at the harbor. 🌙');
});

afterEach(async () => {
	jest.restoreAllMocks();
	store.close();
	await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
	for (const directory of spools) await rm(directory, { recursive: true, force: true });
});

test('binds one provider response to saved RTF and decoded text revisions', async () => {
	const saved = await source.read(DOCUMENT);
	const result = await analyze();
	expect(result.method).toBe('single-provider-perspectives');
	expect(result.agents).toEqual(COLLABORATION_ROLES);
	expect(result.perspectives).toEqual(feedback.perspectives);
	expect(result.availability).toEqual({
		status: 'available',
		unavailableFields: [],
		unavailableRoles: [],
		partialFields: [],
	});
	expect(result.coverage).toEqual({
		start: 0,
		end: saved.text.length,
		sourceCharacters: saved.text.length,
		sourceRevision: hash(saved.text),
		truncated: false,
	});
	expect(result.envelope).toMatchObject({
		projectId: source.projectId,
		sourceFormat: 'saved-rtf',
		scope: { kind: 'document', documentIds: [DOCUMENT] },
		sourceRevisions: [{ documentId: DOCUMENT, revision: saved.revision }],
		policy: { mode: 'provider', revisionChecked: true, usesSavedProjectControls: false },
	});
	expect(chat).toHaveBeenCalledTimes(1);
	expect(chat.mock.calls[0][0]).toContain(saved.text);
	expect(chat.mock.calls[0][0]).toContain('BEGIN UNTRUSTED INPUT');
});

test('default and explicit all perspectives use the same request identity', async () => {
	expect((await analyze({ agents: ['all'] })).envelope.requestId).toBe(
		(await analyze()).envelope.requestId
	);
});

test.each([
	['collaborative', 'Compare where the perspectives agree or conflict'],
	['workshop', 'propose a concrete revision exercise'],
	['review', 'without rewriting the passage'],
])('applies %s mode to the provider request', async (collaborationMode, instruction) => {
	chat.mockResolvedValue(
		JSON.stringify({ ...feedback, perspectives: feedback.perspectives.slice(0, 1) })
	);
	const result = await analyze({ agents: ['editor'], collaborationMode });
	expect(result.collaborationMode).toBe(collaborationMode);
	expect(result.agents).toEqual(['editor']);
	expect(result.availability.status).toBe('available');
	expect(chat.mock.calls[0][0]).toContain(instruction);
});

test('different perspectives and modes have distinct request identities', async () => {
	const results = await Promise.all([
		analyze({ agents: ['editor'] }),
		analyze({ agents: ['critic'] }),
		analyze({ agents: ['editor'], collaborationMode: 'review' }),
	]);
	expect(new Set(results.map((result) => result.envelope.requestId)).size).toBe(3);
});

test('preserves usable feedback, duplicates and literal code fences while exposing missing fields and roles', async () => {
	const entries = [
		{ role: ' Editor ', feedback: 'Keep ```json and [brackets] intact.' },
		{ role: 'editor', feedback: 'Keep this second finding too.' },
		null,
		{ role: 'coordinator', feedback: 'Unsupported role' },
		{ role: 'critic', feedback: '' },
	];
	chat.mockResolvedValue(
		`\x60\x60\x60json\n${JSON.stringify({ perspectives: entries, synthesis: 80, consensus: 'Keep the evidence.' })}\n\x60\x60\x60`
	);
	const result = await analyze({ agents: ['editor', 'critic'] });
	expect(result.perspectives).toEqual(
		entries.slice(0, 2).map((entry) => ({ ...entry, role: 'editor' }))
	);
	expect(result.synthesis).toBeNull();
	expect(result.consensus).toBe('Keep the evidence.');
	expect(result.availability).toEqual({
		status: 'partial',
		unavailableFields: ['synthesis'],
		unavailableRoles: ['critic'],
		partialFields: ['perspectives'],
	});
});

test('missing fields remain explicitly unavailable without invented scores or prose', async () => {
	chat.mockResolvedValue('{}');
	const result = await analyze({ agents: ['editor'] });
	expect(result.perspectives).toEqual([]);
	expect(result.synthesis).toBeNull();
	expect(result.consensus).toBeNull();
	expect(result.availability).toEqual({
		status: 'unavailable',
		unavailableFields: ['perspectives', 'synthesis', 'consensus'],
		unavailableRoles: ['editor'],
		partialFields: [],
		reason: 'invalid_response',
	});
});

test('an empty saved document retains provenance without invoking a provider', async () => {
	const revision = await save('');
	const result = await analyze();
	expect(result.availability.reason).toBe('no_text');
	expect(result.coverage).toMatchObject({ end: 0, sourceCharacters: 0, truncated: false });
	expect(result.envelope.sourceRevisions).toEqual([{ documentId: DOCUMENT, revision }]);
	expect(chat).not.toHaveBeenCalled();
});

test.each([11999, 12000, 12001])(
	'reports exact saved source coverage at %i characters',
	async (length) => {
		const text = 'x'.repeat(length);
		await save(text);
		const result = await analyze();
		expect(result.coverage).toEqual({
			start: 0,
			end: Math.min(12000, length),
			sourceCharacters: length,
			sourceRevision: hash(text),
			truncated: length > 12000,
		});
		expect(chat.mock.calls[0][0]).toContain(text.slice(0, 12000));
		if (length > 12000) expect(chat.mock.calls[0][0]).not.toContain(text);
	}
);

test('avoids splitting a saved-text surrogate pair at the context boundary', async () => {
	const text = 'x'.repeat(11999) + '🌙tail';
	await save(text);
	const result = await analyze();
	expect(result.coverage).toMatchObject({
		start: 0,
		end: 11999,
		sourceCharacters: text.length,
		truncated: true,
	});
	expect(chat.mock.calls[0][0]).toContain(text.slice(0, 11999));
	expect(chat.mock.calls[0][0]).not.toContain('\ud83c');
});

test.each(['Not JSON', '[]', '{broken'])(
	'flags malformed provider results as MCP tool errors: %j',
	async (reply) => {
		chat.mockResolvedValue(reply);
		const result = await tool.handler({ documentId: DOCUMENT }, context);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(chat).toHaveBeenCalledTimes(1);
	}
);

test('does not expose provider error bodies or silently retry', async () => {
	chat.mockRejectedValue(new Error('Provider body contains fixture-secret-token'));
	const result = await tool.handler({ documentId: DOCUMENT }, context);
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).not.toContain('fixture-secret-token');
	expect(chat).toHaveBeenCalledTimes(1);
});

test('rejects an externally edited source after provider completion', async () => {
	chat.mockImplementation(async () => {
		await save('Revised while the provider worked.');
		return JSON.stringify(feedback);
	});
	const result = await tool.handler({ documentId: DOCUMENT }, context);
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toBeUndefined();
});

test('retrieves every large Unicode finding once with no changed text', async () => {
	const perspectives = Array.from({ length: 40 }, (_, index) => ({
		role: 'editor',
		feedback: `${index}: ` + '🌙[evidence]```'.repeat(100),
	}));
	chat.mockResolvedValue(JSON.stringify({ ...feedback, perspectives }));
	const result = await analyze({ agents: ['editor'] });
	expect(result.perspectives).toEqual(perspectives);
	expect(result.synthesis).toBe(feedback.synthesis);
});

test.each([
	{ agents: [] },
	{ agents: ['editor', 'editor'] },
	{ agents: ['all', 'critic'] },
	{ agents: ['Editor'] },
	{ agents: ['writer'] },
	{ agents: null },
	{ agents: 'editor' },
	{ agents: [...COLLABORATION_ROLES, 'critic'] },
	{ collaborationMode: null },
	{ collaborationMode: 'unknown' },
	{ documentId: '' },
	{ documentId: ' ' },
	{ documentId: 'x'.repeat(129) },
	{ enhanced: true },
])('rejects invalid public inputs before provider work: %j', async (args) => {
	const input = { documentId: DOCUMENT, ...args };
	expect(validateInput(input).valid).toBe(false);
	await expect(tool.handler(input, context)).rejects.toThrow();
	expect(chat).not.toHaveBeenCalled();
});

test.each([1, 4, 5])(
	'accepts %i distinct supported perspectives through schema and runtime',
	async (count) => {
		const agents = COLLABORATION_ROLES.slice(0, count);
		const input = { documentId: DOCUMENT, agents };
		expect(validateInput(input).valid).toBe(true);
		expect((await analyze({ agents })).agents).toEqual(agents);
	}
);
