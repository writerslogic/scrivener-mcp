/**
 * AIClient provider-selection tests (deterministic, no network) plus a
 * key-gated integration test that performs a real Claude round-trip when
 * ANTHROPIC_API_KEY is present in the environment.
 */

import { AIClient, isProviderUnavailable } from '../../../../src/services/ai/ai-client.js';
import { registerSamplingServer } from '../../../../src/services/ai/sampling-bridge.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

describe('AIClient provider selection', () => {
	const originalProvider = process.env.AI_PROVIDER;

	beforeEach(() => {
		delete process.env.AI_PROVIDER;
	});

	afterAll(() => {
		if (originalProvider === undefined) delete process.env.AI_PROVIDER;
		else process.env.AI_PROVIDER = originalProvider;
	});

	it('prefers Anthropic when both keys are present', () => {
		const c = new AIClient({ anthropicApiKey: 'sk-ant-test', openaiApiKey: 'sk-openai-test' });
		expect(c.provider).toBe('anthropic');
		expect(c.isAvailable).toBe(true);
		expect(c.chatModel).toMatch(/^claude/);
	});

	it('falls back to OpenAI when only the OpenAI key is present', () => {
		// Empty string explicitly disables Anthropic regardless of ambient env.
		const c = new AIClient({ anthropicApiKey: '', openaiApiKey: 'sk-openai-test' });
		expect(c.provider).toBe('openai');
		expect(c.chatModel).not.toMatch(/^claude/);
	});

	it('honors an explicit OpenAI provider override even with an Anthropic key', () => {
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: 'sk-openai-test',
			provider: 'openai',
		});
		expect(c.provider).toBe('openai');
	});

	it('honors AI_PROVIDER=openai from the environment when both keys are present', () => {
		process.env.AI_PROVIDER = 'openai';
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: 'sk-openai-test',
		});
		expect(c.provider).toBe('openai');
	});

	it('lets an explicit provider option override AI_PROVIDER', () => {
		process.env.AI_PROVIDER = 'openai';
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: 'sk-openai-test',
			provider: 'anthropic',
		});
		expect(c.provider).toBe('anthropic');
	});

	it('falls back to OpenRouter when it holds the only key', () => {
		const c = new AIClient({
			anthropicApiKey: '',
			openaiApiKey: '',
			openrouterApiKey: 'sk-or-test',
		});
		expect(c.provider).toBe('openrouter');
		expect(c.chatModel).toContain('/');
	});

	it('honors AI_PROVIDER=openrouter when its key is present', () => {
		process.env.AI_PROVIDER = 'openrouter';
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: 'sk-openai-test',
			openrouterApiKey: 'sk-or-test',
		});
		expect(c.provider).toBe('openrouter');
	});

	it('falls back to an available provider when the requested one has no key', () => {
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: '',
			openrouterApiKey: '',
			provider: 'openrouter',
		});
		expect(c.provider).toBe('anthropic');
	});

	it('is unavailable and throws on chat when no key is configured', async () => {
		const c = new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' });
		expect(c.isAvailable).toBe(false);
		await expect(c.chat('hello')).rejects.toThrow(/No AI provider configured/);
	});

	it('rejects an empty prompt', async () => {
		const c = new AIClient({ anthropicApiKey: 'sk-ant-test' });
		await expect(c.chat('   ')).rejects.toThrow(/non-empty prompt/);
	});

	it('requires OpenAI or OpenRouter for embeddings even when Claude handles chat', async () => {
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: '',
			openrouterApiKey: '',
		});
		await expect(c.embed(['x'])).rejects.toThrow(/Embeddings require OPENAI_API_KEY/);
	});
});

describe('AIClient provider fallback', () => {
	const accountError = (status: number, message: string) =>
		Object.assign(new Error(message), { status });

	const stubOpenRouterReply = (text: string) => ({
		chat: {
			completions: {
				create: jest.fn().mockResolvedValue({ choices: [{ message: { content: text } }] }),
			},
		},
	});

	it('retries on the next provider when the primary reports exhausted credit', async () => {
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: '',
			openrouterApiKey: 'sk-or-test',
		});
		const anthropicStub = {
			messages: {
				create: jest
					.fn()
					.mockRejectedValue(accountError(400, 'Your credit balance is too low')),
			},
		};
		const openrouterStub = stubOpenRouterReply('fallback-ok');
		Object.assign(c, { anthropic: anthropicStub, openrouter: openrouterStub });

		await expect(c.chat('hello')).resolves.toBe('fallback-ok');
		expect(anthropicStub.messages.create).toHaveBeenCalledTimes(1);
		expect(openrouterStub.chat.completions.create).toHaveBeenCalledTimes(1);
	});

	it('does not fall back on a request-level error', async () => {
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: '',
			openrouterApiKey: 'sk-or-test',
		});
		const anthropicStub = {
			messages: { create: jest.fn().mockRejectedValue(accountError(400, 'invalid request')) },
		};
		const openrouterStub = stubOpenRouterReply('should-not-run');
		Object.assign(c, { anthropic: anthropicStub, openrouter: openrouterStub });

		await expect(c.chat('hello')).rejects.toThrow('invalid request');
		expect(openrouterStub.chat.completions.create).not.toHaveBeenCalled();
	});

	it('rethrows when every configured provider is unavailable', async () => {
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: '',
			openrouterApiKey: 'sk-or-test',
		});
		const anthropicStub = {
			messages: {
				create: jest.fn().mockRejectedValue(accountError(402, 'payment required')),
			},
		};
		const openrouterStub = {
			chat: {
				completions: {
					create: jest.fn().mockRejectedValue(accountError(429, 'rate limited')),
				},
			},
		};
		Object.assign(c, { anthropic: anthropicStub, openrouter: openrouterStub });

		await expect(c.chat('hello')).rejects.toThrow('rate limited');
	});
});

describe('AIClient MCP sampling', () => {
	afterEach(() => registerSamplingServer(null));

	const fakeServer = (createMessage: jest.Mock, supportsSampling = true) =>
		({
			getClientCapabilities: () => (supportsSampling ? { sampling: {} } : {}),
			createMessage,
		}) as unknown as Server;

	it('serves chat through client sampling when no keys are configured', async () => {
		const createMessage = jest.fn().mockResolvedValue({
			model: 'client-model',
			role: 'assistant',
			content: { type: 'text', text: 'sampled' },
		});
		registerSamplingServer(fakeServer(createMessage));
		const c = new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' });
		expect(c.isAvailable).toBe(true);
		await expect(c.chat('hi')).resolves.toBe('sampled');
		expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 1024 }));
	});

	it('ignores sampling when the client does not advertise the capability', () => {
		registerSamplingServer(fakeServer(jest.fn(), false));
		const c = new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' });
		expect(c.isAvailable).toBe(false);
	});

	it('falls back from a dead key provider to client sampling', async () => {
		const createMessage = jest.fn().mockResolvedValue({
			model: 'client-model',
			role: 'assistant',
			content: { type: 'text', text: 'sampled-fallback' },
		});
		registerSamplingServer(fakeServer(createMessage));
		const c = new AIClient({
			anthropicApiKey: 'sk-ant-test',
			openaiApiKey: '',
			openrouterApiKey: '',
		});
		Object.assign(c, {
			anthropic: {
				messages: {
					create: jest
						.fn()
						.mockRejectedValue(
							Object.assign(new Error('payment required'), { status: 402 })
						),
				},
			},
		});
		await expect(c.chat('hi')).resolves.toBe('sampled-fallback');
	});
});

describe('AIClient embeddings', () => {
	const savedEmbedModel = process.env.OPENAI_EMBED_MODEL;

	beforeEach(() => {
		delete process.env.OPENAI_EMBED_MODEL;
	});

	afterAll(() => {
		if (savedEmbedModel === undefined) delete process.env.OPENAI_EMBED_MODEL;
		else process.env.OPENAI_EMBED_MODEL = savedEmbedModel;
	});

	it('embeds via OpenRouter with a vendor-prefixed model when it is the only provider', async () => {
		const c = new AIClient({
			anthropicApiKey: '',
			openaiApiKey: '',
			openrouterApiKey: 'sk-or-test',
		});
		const create = jest.fn().mockResolvedValue({ data: [{ embedding: [1, 2] }] });
		Object.assign(c, { openrouter: { embeddings: { create } } });
		await expect(c.embed(['x'])).resolves.toEqual([[1, 2]]);
		expect(create).toHaveBeenCalledWith({
			model: 'openai/text-embedding-3-small',
			input: ['x'],
		});
	});

	it('falls back from OpenAI to OpenRouter on an account-level error', async () => {
		const c = new AIClient({
			anthropicApiKey: '',
			openaiApiKey: 'sk-openai-test',
			openrouterApiKey: 'sk-or-test',
		});
		Object.assign(c, {
			openai: {
				embeddings: {
					create: jest
						.fn()
						.mockRejectedValue(Object.assign(new Error('quota'), { status: 429 })),
				},
			},
			openrouter: {
				embeddings: { create: jest.fn().mockResolvedValue({ data: [{ embedding: [3] }] }) },
			},
		});
		await expect(c.embed(['x'])).resolves.toEqual([[3]]);
	});
});

describe('isProviderUnavailable', () => {
	it.each([[401], [402], [403], [429], [500], [503]])('is true for status %d', (status) => {
		expect(isProviderUnavailable(Object.assign(new Error('x'), { status }))).toBe(true);
	});

	it('is true for a 400 that reports exhausted credit', () => {
		expect(
			isProviderUnavailable(
				Object.assign(new Error('Your credit balance is too low'), { status: 400 })
			)
		).toBe(true);
	});

	it('is false for a plain 400 and for errors without a status', () => {
		expect(
			isProviderUnavailable(Object.assign(new Error('bad request'), { status: 400 }))
		).toBe(false);
		expect(isProviderUnavailable(new Error('TypeError: x is not a function'))).toBe(false);
	});
});

const liveAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
liveAnthropic('AIClient live Claude round-trip', () => {
	it('returns the requested token from a real Claude call', async () => {
		const c = new AIClient();
		expect(c.provider).toBe('anthropic');
		const reply = await c.chat('Reply with exactly the word PONG and nothing else.', {
			maxTokens: 16,
			temperature: 0,
		});
		expect(reply.toUpperCase()).toContain('PONG');
	}, 30000);
});
