/**
 * AICollaboration tests. Empty-input and no-key behavior are deterministic; a
 * explicitly opted-in live test exercises a real multi-perspective Claude critique.
 */

import { describeLiveAnthropic as liveAnthropic } from '../../../helpers/live-provider.js';
import { AICollaboration } from '../../../../src/services/agents/ai-collaboration.js';
import { AIClient } from '../../../../src/services/ai/ai-client.js';
import { createHash } from 'node:crypto';

describe('AICollaboration', () => {
	it('reports unavailable feedback for empty content without calling the model', async () => {
		const collab = new AICollaboration(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' })
		);
		const result = await collab.collaborateOnDocument({ content: '   ' });
		expect(result.perspectives).toEqual([]);
		expect(result.synthesis).toBeNull();
		expect(result.consensus).toBeNull();
		expect(result.availability).toMatchObject({
			status: 'unavailable',
			reason: 'no_text',
			unavailableFields: ['perspectives', 'synthesis', 'consensus'],
		});
		expect(result.coverage).toMatchObject({ start: 0, end: 0, sourceCharacters: 3 });
	});

	it.each([4_999_999, 5_000_000, 5_000_001])(
		'bounds source admission at %i characters',
		async (length) => {
			const chat = jest.fn().mockResolvedValue('{}');
			const collab = new AICollaboration({ chat } as unknown as AIClient);
			const pending = collab.collaborateOnDocument({ content: 'x'.repeat(length) });
			if (length > 5_000_000) {
				await expect(pending).rejects.toThrow('at most 5000000');
				expect(chat).not.toHaveBeenCalled();
			} else {
				const result = await pending;
				expect(result.coverage).toMatchObject({
					end: 12000,
					sourceCharacters: length,
					truncated: true,
				});
				expect(chat).toHaveBeenCalledTimes(1);
			}
		}
	);

	it('snapshots the requested perspectives before awaiting the provider', async () => {
		const roles = ['editor'];
		const chat = jest.fn().mockImplementation(async () => {
			roles.push('critic');
			return '{"perspectives":[{"role":"editor","feedback":"Keep the ending."}],"synthesis":"Retain the ending.","consensus":"Keep it."}';
		});
		const result = await new AICollaboration({
			chat,
		} as unknown as AIClient).collaborateOnDocument(
			{ content: 'The light went out.' },
			{ enabledAgents: roles }
		);
		expect(result.agents).toEqual(['editor']);
		expect(result.availability.status).toBe('available');
	});

	it('keeps untrimmed input offsets and complete text identity at a Unicode context boundary', async () => {
		const content = '  ' + 'x'.repeat(11997) + '🌙tail';
		const chat = jest.fn().mockResolvedValue('{}');
		const result = await new AICollaboration({
			chat,
		} as unknown as AIClient).collaborateOnDocument({ content });
		expect(result.coverage).toEqual({
			start: 0,
			end: 11999,
			sourceCharacters: content.length,
			sourceRevision: createHash('sha256').update(content).digest('hex'),
			truncated: true,
		});
		expect(chat.mock.calls[0][0]).toContain(content.slice(0, 11999));
		expect(chat.mock.calls[0][0]).not.toContain('\ud83c');
	});

	it('propagates a clear error when no provider is configured', async () => {
		const collab = new AICollaboration(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' })
		);
		await expect(collab.collaborateOnDocument({ content: 'The cat sat.' })).rejects.toThrow(
			/No AI provider configured/
		);
	});

	liveAnthropic('live Claude collaboration', () => {
		it('returns perspectives and a synthesis for a passage', async () => {
			const collab = new AICollaboration();
			const result = await collab.collaborateOnDocument(
				{
					content:
						'The man walked into the room. It was very dark. He was scared. He heard a noise.',
					title: 'Test',
				},
				{ enabledAgents: ['editor', 'critic'] }
			);
			expect(Array.isArray(result.perspectives)).toBe(true);
			expect(result.perspectives.length).toBeGreaterThan(0);
			expect(typeof result.synthesis).toBe('string');
		}, 30000);
	});
});
