/**
 * AICollaboration tests. Empty-input and no-key behavior are deterministic; a
 * key-gated live test exercises a real multi-perspective Claude critique.
 */

import { AICollaboration } from '../../../../src/services/agents/ai-collaboration.js';
import { AIClient } from '../../../../src/services/ai/ai-client.js';

describe('AICollaboration', () => {
	it('returns an empty result for empty content without calling the model', async () => {
		const collab = new AICollaboration(new AIClient({ anthropicApiKey: '', openaiApiKey: '' }));
		const result = await collab.collaborateOnDocument({ content: '   ' });
		expect(result.perspectives).toEqual([]);
		expect(result.synthesis).toBe('');
	});

	it('propagates a clear error when no provider is configured', async () => {
		const collab = new AICollaboration(new AIClient({ anthropicApiKey: '', openaiApiKey: '' }));
		await expect(collab.collaborateOnDocument({ content: 'The cat sat.' })).rejects.toThrow(
			/No AI provider configured/
		);
	});

	const liveAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
	liveAnthropic('live Claude collaboration', () => {
		it('returns perspectives and a synthesis for a passage', async () => {
			const collab = new AICollaboration();
			const result = await collab.collaborateOnDocument(
				{
					content:
						'The man walked into the room. It was very dark. He was scared. He heard a noise.',
					title: 'Test',
				},
				{ enabledAgents: ['Editor', 'Critic'] }
			);
			expect(Array.isArray(result.perspectives)).toBe(true);
			expect(result.perspectives.length).toBeGreaterThan(0);
			expect(typeof result.synthesis).toBe('string');
		}, 30000);
	});
});
