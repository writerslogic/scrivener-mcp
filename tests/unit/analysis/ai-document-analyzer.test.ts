/**
 * AIDocumentAnalyzer tests. Empty-input and no-key behavior are deterministic;
 * a key-gated live test exercises a real Claude analysis round-trip.
 */

import { AIDocumentAnalyzer } from '../../../src/analysis/ai-document-analyzer.js';
import { AIClient } from '../../../src/services/ai/ai-client.js';

describe('AIDocumentAnalyzer', () => {
	it('returns an n/a analysis for empty content without calling the model', async () => {
		const analyzer = new AIDocumentAnalyzer(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' })
		);
		const result = await analyzer.analyzeDocument('   ');
		expect(result.readability).toBe('n/a');
		expect(result.issues).toEqual([]);
	});

	it('propagates a clear error when no provider is configured and content is present', async () => {
		const analyzer = new AIDocumentAnalyzer(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' })
		);
		await expect(analyzer.analyzeDocument('The cat sat.')).rejects.toThrow(
			/No AI provider configured/
		);
	});

	const liveAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
	liveAnthropic('live Claude analysis', () => {
		it('returns a conforming analysis with string fields and an issues array', async () => {
			const analyzer = new AIDocumentAnalyzer();
			const result = await analyzer.analyzeDocument(
				'The man walked into the room. It was very dark. He was scared. Suddenly, ' +
					'something moved in the corner and he felt his heart race with fear.'
			);
			expect(typeof result.readability).toBe('string');
			expect(result.readability.length).toBeGreaterThan(0);
			expect(typeof result.pacing).toBe('string');
			expect(Array.isArray(result.issues)).toBe(true);
		}, 30000);
	});
});
