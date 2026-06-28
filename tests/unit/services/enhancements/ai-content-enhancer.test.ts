/**
 * AIContentEnhancer tests. Result-shape and no-key behavior are deterministic;
 * a key-gated live test exercises a real Claude enhancement round-trip.
 */

import { AIContentEnhancer } from '../../../../src/services/enhancements/ai-content-enhancer.js';
import { AIClient } from '../../../../src/services/ai/ai-client.js';
import type { EnhancementType } from '../../../../src/services/enhancements/content-enhancer.js';

describe('AIContentEnhancer', () => {
	it('propagates a clear error when no AI provider is configured', async () => {
		const enhancer = new AIContentEnhancer(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '' })
		);
		await expect(
			enhancer.enhance({ content: 'Some prose.', type: 'style' as EnhancementType })
		).rejects.toThrow(/No AI provider configured/);
	});

	const liveAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
	liveAnthropic('live Claude enhancement', () => {
		it('returns a conforming, non-empty enhancement of the passage', async () => {
			const enhancer = new AIContentEnhancer();
			const original = 'The man walked into the room. It was very dark. He was scared.';
			const result = await enhancer.enhance({
				content: original,
				type: 'style' as EnhancementType,
			});

			expect(typeof result.enhanced).toBe('string');
			expect(result.enhanced.length).toBeGreaterThan(0);
			expect(result.original).toBe(original);
			expect(result.metrics.originalWordCount).toBeGreaterThan(0);
			expect(result.metrics.processingTime).toBeGreaterThan(0);
			expect(Array.isArray(result.changes)).toBe(true);
		}, 30000);
	});
});
