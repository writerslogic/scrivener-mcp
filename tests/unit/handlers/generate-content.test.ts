import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { generateContentHandler } from '../../../src/handlers/analysis-handlers/document-analysis.js';
import type { HandlerContext, HandlerResult } from '../../../src/handlers/types.js';
import type { ScrivenerProject } from '../../../src/scrivener-project.js';
import { registerSamplingServer } from '../../../src/services/ai/sampling-bridge.js';

const environmentKeys = [
	'AI_PROVIDER',
	'SCRIVENER_LOCAL_ONLY',
	'ANTHROPIC_API_KEY',
	'OPENAI_API_KEY',
	'OPENROUTER_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_BASE_URL',
	'OPENAI_BASE_URL',
	'ANTHROPIC_MODEL',
	'OPENAI_MODEL',
	'OPENROUTER_MODEL',
	'OPENAI_ORG_ID',
	'OPENAI_PROJECT_ID',
	'ANTHROPIC_LOG',
	'OPENAI_LOG',
	'ANTHROPIC_CUSTOM_HEADERS',
] as const;
const originalFetch = globalThis.fetch;
const prompt = 'Private fixture prompt that must not appear in an error';
let environment: Map<string, string | undefined>;
let requests: Request[];
let respond: (request: Request) => Promise<Response>;
let manuscriptAccesses: PropertyKey[];

function response(content: string): Response {
	return new Response(
		JSON.stringify({
			id: 'chatcmpl-fixture',
			object: 'chat.completion',
			created: 1,
			model: 'fixture-model',
			choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
		}),
		{ headers: { 'content-type': 'application/json' } }
	);
}

function context(): HandlerContext {
	const deny = (_target: object, key: PropertyKey): never => {
		manuscriptAccesses.push(key);
		throw new Error('Generation must not access or modify the manuscript');
	};
	const project = new Proxy({} as ScrivenerProject, {
		get: deny,
		set: deny,
		deleteProperty: deny,
	});
	return {
		project,
		memoryManager: null,
		contentAnalyzer: {} as HandlerContext['contentAnalyzer'],
		contentEnhancer: {} as HandlerContext['contentEnhancer'],
	};
}

function text(result: HandlerResult): string {
	return result.content.map((item) => item.text ?? '').join('\n');
}

function generate(): Promise<HandlerResult> {
	return generateContentHandler.handler(
		{
			prompt,
			length: 900,
			context: { documentId: '11111111-1111-4111-8111-111111111111', style: 'concise' },
		},
		context()
	);
}

beforeEach(() => {
	environment = new Map(environmentKeys.map((key) => [key, process.env[key]] as const));
	for (const key of environmentKeys) delete process.env[key];
	registerSamplingServer(null);
	requests = [];
	manuscriptAccesses = [];
	respond = async () => {
		throw new Error('Unexpected offline provider request');
	};
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		return respond(request);
	};
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	registerSamplingServer(null);
	for (const [key, value] of environment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	expect(manuscriptAccesses).toEqual([]);
});

test('an absent provider reports an actionable error without invented prose or word counts', async () => {
	const result = await generate();
	expect(result.isError).toBe(true);
	expect(text(result)).toMatch(/configure.*API_KEY.*sampling/i);
	expect(text(result)).not.toContain(prompt);
	expect(text(result)).not.toMatch(/placeholder|wordCount|900/);
	expect(requests).toEqual([]);
});

test('local-only privacy blocks configured providers and a sampling-capable client', async () => {
	process.env.SCRIVENER_LOCAL_ONLY = 'true';
	process.env.OPENAI_API_KEY = 'fixture-openai-key';
	let samplingCalls = 0;
	registerSamplingServer({
		getClientCapabilities: () => ({ sampling: {} }),
		createMessage: async () => {
			samplingCalls++;
			throw new Error('Local-only mode must not reach sampling');
		},
	} as unknown as Server);
	const result = await generate();
	expect(result.isError).toBe(true);
	expect(text(result)).toMatch(/disabled in local-only mode/i);
	expect(requests).toEqual([]);
	expect(samplingCalls).toBe(0);
});

test('provider failures return errors without echoing credentials, source prompts or fabricated output', async () => {
	process.env.OPENAI_API_KEY = 'fixture-openai-key';
	respond = async () => {
		throw new Error('Bearer fixture-private-provider-error');
	};
	const result = await generate();
	expect(result.isError).toBe(true);
	expect(text(result)).toMatch(/generation failed.*provider.*quota.*connection/i);
	expect(text(result)).not.toMatch(/Bearer|fixture-private|fixture-openai|placeholder|wordCount|900/);
	expect(text(result)).not.toContain(prompt);
	expect(requests).toHaveLength(1);
});

test.each(['', ' \n\t'])(
	'an empty provider response %j cannot become successful generated prose',
	async (content) => {
		process.env.OPENAI_API_KEY = 'fixture-openai-key';
		respond = async () => response(content);
		const result = await generate();
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/returned no prose.*model settings/i);
		expect(text(result)).not.toMatch(/placeholder|wordCount|900/);
		expect(requests).toHaveLength(1);
	}
);

test('successful generation keeps the selected provider and counts the actual prose with shared metrics', async () => {
	process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key';
	process.env.OPENAI_API_KEY = 'fixture-openai-key';
	process.env.AI_PROVIDER = 'openai';
	respond = async () => response('One—two three.');
	const result = await generate();
	expect(result.isError).not.toBe(true);
	expect(JSON.parse(text(result))).toMatchObject({
		content: 'One—two three.',
		wordCount: 3,
		type: 'creative',
	});
	expect(requests.map((request) => request.url)).toEqual([
		'https://api.openai.com/v1/chat/completions',
	]);
});

test('client-side sampling can generate prose without configuring provider keys', async () => {
	process.env.AI_PROVIDER = 'sampling';
	registerSamplingServer({
		getClientCapabilities: () => ({ sampling: {} }),
		createMessage: async () => ({
			role: 'assistant',
			content: { type: 'text', text: 'A sampled sentence.' },
			model: 'fixture-client-model',
		}),
	} as unknown as Server);
	const result = await generate();
	expect(result.isError).not.toBe(true);
	expect(JSON.parse(text(result))).toMatchObject({ content: 'A sampled sentence.', wordCount: 3 });
	expect(requests).toEqual([]);
});
