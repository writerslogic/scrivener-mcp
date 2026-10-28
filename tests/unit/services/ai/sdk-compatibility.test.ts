import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AIClient, type AIProvider } from '../../../../src/services/ai/ai-client.js';
import { registerSamplingServer } from '../../../../src/services/ai/sampling-bridge.js';

const environmentKeys = [
	'AI_PROVIDER', 'SCRIVENER_LOCAL_ONLY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
	'OPENROUTER_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL',
	'ANTHROPIC_MODEL', 'OPENAI_MODEL', 'OPENROUTER_MODEL', 'OPENAI_EMBED_MODEL',
	'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'ANTHROPIC_LOG', 'OPENAI_LOG',
	'ANTHROPIC_CUSTOM_HEADERS',
] as const;
const credentials = {
	anthropicApiKey: 'fixture-anthropic-key',
	openaiApiKey: 'fixture-openai-key',
	openrouterApiKey: 'fixture-openrouter-key',
};
const originalFetch = globalThis.fetch;
let environment: Map<string, string | undefined>;
let requests: Request[];
let respond: (request: Request) => Promise<Response>;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json', 'request-id': 'fixture-request', 'x-request-id': 'fixture-request' },
});
const chatReply = (content = 'Provider reply'): Response => json({
	id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
	choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
	usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
});
const float32 = (values: number[]): string => {
	const buffer = Buffer.alloc(values.length * 4);
	values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
	return buffer.toString('base64');
};
const embeddingReply = (encoding: 'base64' | 'float'): Response => json({
	object: 'list', model: 'fixture-embedding',
	data: [[1, -2, 0.5], [-3, 0, 2]].map((embedding, index) => ({
		object: 'embedding', index, embedding: encoding === 'base64' ? float32(embedding) : embedding,
	})),
	usage: { prompt_tokens: 5, total_tokens: 5 },
});

beforeEach(() => {
	environment = new Map(environmentKeys.map((key) => [key, process.env[key]] as const));
	for (const key of environmentKeys) delete process.env[key];
	registerSamplingServer(null);
	requests = [];
	respond = async () => { throw new Error('Unexpected offline provider request'); };
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
});

it('sends Anthropic v1 requests without removed sampling parameters and returns only text blocks', async () => {
	process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token-must-not-win';
	respond = async () => json({
		id: 'msg-fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
		content: [
			{ type: 'text', text: 'First', citations: [] },
			{ type: 'thinking', thinking: 'Not user-visible', signature: 'fixture' },
			{ type: 'text', text: ' second', citations: [] },
		],
		stop_reason: 'end_turn', stop_sequence: null,
		usage: { input_tokens: 9, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
	});
	const client = new AIClient({ ...credentials, provider: 'anthropic' });
	await expect(client.chat('Fixture passage', {
		system: 'Return prose only', maxTokens: 73, temperature: 0.1,
	})).resolves.toBe('First second');
	expect(requests).toHaveLength(1);
	const request = requests[0];
	expect(request.url).toBe('https://api.anthropic.com/v1/messages');
	expect(request.headers.get('authorization')).toBe('Bearer fixture-anthropic-key');
	expect(request.headers.get('x-api-key')).toBeNull();
	expect(request.headers.get('anthropic-version')).toBe('2026-10-21');
	expect(request.headers.get('x-stainless-timeout')).toBe('60');
	expect(await request.json()).toEqual({
		model: 'claude-sonnet-4-6', max_tokens: 73, system: 'Return prose only',
		messages: [{ role: 'user', content: 'Fixture passage' }],
	});
});

it.each(['openai', 'openrouter'] as const)('preserves %s chat routing, options and text extraction', async (provider) => {
	respond = async () => chatReply();
	const client = new AIClient({ ...credentials, provider, timeoutMs: 120_000 });
	await expect(client.chat('Fixture passage', {
		model: 'fixture-chat', system: 'Return prose only', maxTokens: 27, temperature: 0.25,
	})).resolves.toBe('Provider reply');
	expect(requests).toHaveLength(1);
	const request = requests[0];
	expect(request.url).toBe(provider === 'openai'
		? 'https://api.openai.com/v1/chat/completions'
		: 'https://openrouter.ai/api/v1/chat/completions');
	expect(request.headers.get('authorization')).toBe(`Bearer fixture-${provider}-key`);
	expect(request.headers.get('x-stainless-timeout')).toBe('120');
	expect(request.headers.get('http-referer')).toBe(provider === 'openrouter'
		? 'https://github.com/writerslogic/scrivener-mcp' : null);
	expect(request.headers.get('x-title')).toBe(provider === 'openrouter' ? 'scrivener-mcp' : null);
	expect(await request.json()).toEqual({
		model: 'fixture-chat', max_tokens: 27, temperature: 0.25,
		messages: [{ role: 'system', content: 'Return prose only' }, { role: 'user', content: 'Fixture passage' }],
	});
});

it.each([
	['openai', 'base64'], ['openrouter', 'base64'], ['openrouter', 'float'],
] as const)('decodes %s %s embeddings through the installed SDK', async (provider, encoding) => {
	respond = async () => embeddingReply(encoding);
	const client = new AIClient({
		anthropicApiKey: '', openaiApiKey: provider === 'openai' ? credentials.openaiApiKey : '',
		openrouterApiKey: credentials.openrouterApiKey, timeoutMs: 119_999,
	});
	await expect(client.embed(['First passage', 'Second passage'])).resolves.toEqual([[1, -2, 0.5], [-3, 0, 2]]);
	expect(requests).toHaveLength(1);
	const request = requests[0];
	expect(request.url).toBe(provider === 'openai'
		? 'https://api.openai.com/v1/embeddings' : 'https://openrouter.ai/api/v1/embeddings');
	expect(request.headers.get('authorization')).toBe(`Bearer fixture-${provider}-key`);
	expect(request.headers.get('x-stainless-timeout')).toBe('119');
	expect(await request.json()).toEqual({
		model: provider === 'openai' ? 'text-embedding-3-small' : 'openai/text-embedding-3-small',
		input: ['First passage', 'Second passage'], encoding_format: 'base64',
	});
});

it('rejects malformed embedding vectors without fallback or replay', async () => {
	respond = async () => json({ data: [{ index: 0, embedding: Buffer.from([1, 2, 3]).toString('base64') }] });
	const client = new AIClient(credentials);
	await expect(client.embed(['Fixture passage'])).rejects.toThrow(/multiple of 4/i);
	expect(requests).toHaveLength(1);
});

it.each([
	[400, 'Your credit balance is too low', true],
	[400, 'Invalid request body', false],
	[401, 'Invalid API key', true],
	[429, 'Rate limited', true],
	[503, 'Provider unavailable', true],
] as const)('classifies a real SDK %s error (%s) without replay', async (status, message, fallback) => {
	respond = async (request) => new URL(request.url).hostname === 'api.anthropic.com'
		? json({ type: 'error', error: { type: 'invalid_request_error', message } }, status)
		: chatReply('Fallback reply');
	const client = new AIClient({ ...credentials, openaiApiKey: '' });
	if (fallback) await expect(client.chat('Fixture passage')).resolves.toBe('Fallback reply');
	else await expect(client.chat('Fixture passage')).rejects.toMatchObject({ status, message: expect.stringContaining(message) });
	expect(requests.map((request) => new URL(request.url).hostname)).toEqual(fallback
		? ['api.anthropic.com', 'openrouter.ai'] : ['api.anthropic.com']);
});

it('falls back once from OpenAI embeddings without SDK rate-limit retries', async () => {
	respond = async (request) => new URL(request.url).hostname === 'api.openai.com'
		? json({ error: { type: 'rate_limit_error', message: 'Fixture rate limit', code: 'rate_limit_exceeded' } }, 429)
		: embeddingReply('base64');
	const client = new AIClient(credentials);
	await expect(client.embed(['First passage', 'Second passage'])).resolves.toEqual([[1, -2, 0.5], [-3, 0, 2]]);
	expect(requests.map((request) => new URL(request.url).hostname)).toEqual(['api.openai.com', 'openrouter.ai']);
});

it.each(['anthropic', 'openai', 'openrouter'] as const)('does not replay or fall back after an ambiguous %s connection failure', async (provider: AIProvider) => {
	respond = async () => { throw new TypeError('Fixture connection interrupted'); };
	const client = new AIClient({ ...credentials, provider });
	await expect(client.chat('Fixture passage')).rejects.toBeInstanceOf(provider === 'anthropic'
		? Anthropic.APIConnectionError : OpenAI.APIConnectionError);
	expect(requests).toHaveLength(1);
});

it.each([
	['anthropic', 'chat'], ['openai', 'chat'], ['openrouter', 'embed'],
] as const)('aborts a stalled %s %s HTTP 200 body without replay or fallback', async (provider, operation) => {
	let activeBodies = 0;
	let aborted = false;
	let cleanup = (): void => {};
	respond = async (request) => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				activeBodies++;
				controller.enqueue(new TextEncoder().encode('{'));
				let ended = false;
				const end = (reason: unknown): void => {
					if (ended) return;
					ended = true;
					request.signal.removeEventListener('abort', abort);
					activeBodies--;
					controller.error(reason);
				};
				const abort = (): void => {
					aborted = true;
					end(request.signal.reason);
				};
				cleanup = (): void => end(new Error('Fixture cleanup'));
				request.signal.addEventListener('abort', abort, { once: true });
			},
		});
		return new Response(body, { headers: { 'content-type': 'application/json' } });
	};
	const client = new AIClient({
		...credentials, provider, timeoutMs: 250,
		openaiApiKey: provider === 'openrouter' ? '' : credentials.openaiApiKey,
	});
	const cleanupTimer = setTimeout(() => cleanup(), 2000);
	try {
		const pending = operation === 'chat' ? client.chat('Fixture passage') : client.embed(['Fixture passage']);
		await expect(pending).rejects.toThrow(/abort|timeout|timed out/i);
		expect(requests).toHaveLength(1);
		expect(aborted).toBe(true);
		expect(activeBodies).toBe(0);
	} finally {
		clearTimeout(cleanupTimer);
		cleanup();
	}
});

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 120_001, null, '60000'])(
	'rejects invalid timeoutMs %s before any request', (timeout) => {
		expect(() => new AIClient({ ...credentials, timeoutMs: timeout as number })).toThrow(RangeError);
		expect(requests).toHaveLength(0);
	}
);

it.each([1, 119_999, 120_000])('accepts timeoutMs boundary %s', (timeoutMs) => {
	expect(() => new AIClient({ ...credentials, timeoutMs })).not.toThrow();
	expect(requests).toHaveLength(0);
});
