/**
 * AIClient provider-selection tests (deterministic, no network) plus a
 * key-gated integration test that performs a real Claude round-trip when
 * ANTHROPIC_API_KEY is present in the environment.
 */

import { AIClient } from '../../../../src/services/ai/ai-client.js';

describe('AIClient provider selection', () => {
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

	it('is unavailable and throws on chat when no key is configured', async () => {
		const c = new AIClient({ anthropicApiKey: '', openaiApiKey: '' });
		expect(c.isAvailable).toBe(false);
		await expect(c.chat('hello')).rejects.toThrow(/No AI provider configured/);
	});

	it('rejects an empty prompt', async () => {
		const c = new AIClient({ anthropicApiKey: 'sk-ant-test' });
		await expect(c.chat('   ')).rejects.toThrow(/non-empty prompt/);
	});

	it('requires OpenAI for embeddings even when Claude handles chat', async () => {
		const c = new AIClient({ anthropicApiKey: 'sk-ant-test', openaiApiKey: '' });
		await expect(c.embed(['x'])).rejects.toThrow(/Embeddings require OPENAI_API_KEY/);
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
