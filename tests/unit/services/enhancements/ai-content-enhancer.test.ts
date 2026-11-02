/**
 * AIContentEnhancer tests. Result-shape and no-key behavior are deterministic;
 * an explicitly opted-in live test exercises a real Claude enhancement round-trip.
 */

import { describeLiveAnthropic as liveAnthropic } from '../../../helpers/live-provider.js';
import { AIContentEnhancer } from '../../../../src/services/enhancements/ai-content-enhancer.js';
import { AIClient } from '../../../../src/services/ai/ai-client.js';
import * as lens from 'narrative-lens';

jest.mock('narrative-lens', () => {
	const native = jest.requireActual<typeof import('narrative-lens')>('narrative-lens');
	return { ...native, computeReadability: jest.fn(native.computeReadability) };
});

describe('AIContentEnhancer', () => {
	it('reports provider absence without manufacturing a rewrite', async () => {
		const enhancer = new AIContentEnhancer(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' })
		);
		await expect(enhancer.enhance({ content: 'Some prose.', type: 'style' })).rejects.toThrow(
			/AI enhancement unavailable/
		);
	});

	it('preserves exact input/output whitespace and measured metrics, with no invented edit list or quality score', async () => {
		const original = '  The U.S.A. is a place.\n';
		const enhanced = '\nThe U.S.A. is a country.  ';
		const chat = jest.fn().mockResolvedValue(enhanced);
		const enhancer = new AIContentEnhancer({ chat } as unknown as AIClient);
		const result = await enhancer.enhance({ content: original, type: 'clarity' });
		expect(chat.mock.calls[0][0]).toContain(original);
		expect(result).toMatchObject({
			original,
			enhanced,
			changed: true,
			changes: null,
			suggestions: null,
			qualityValidation: null,
		});
		expect(result.metrics).toEqual({
			originalWordCount: 5,
			enhancedWordCount: 5,
			readabilityChange:
				lens.computeReadability(enhanced).fleschEase -
				lens.computeReadability(original).fleschEase,
			changesApplied: null,
		});
	});

	it('retains the complete rewrite and successful sibling metrics when native measurement fails', async () => {
		const measure = jest.mocked(lens.computeReadability).mockImplementationOnce(() => {
			throw new Error('native fixture');
		});
		try {
			const enhancer = new AIContentEnhancer({
				chat: jest.fn().mockResolvedValue('A revised passage.'),
			} as unknown as AIClient);
			const result = await enhancer.enhance({
				content: 'The original passage.',
				type: 'style',
			});
			expect(result.enhanced).toBe('A revised passage.');
			expect(result.metrics).toMatchObject({
				originalWordCount: null,
				enhancedWordCount: 3,
				readabilityChange: null,
			});
			expect(result.availability.unavailableFields).toEqual(
				expect.arrayContaining(['metrics.originalWordCount', 'metrics.readabilityChange'])
			);
		} finally {
			measure.mockImplementation(
				jest.requireActual<typeof import('narrative-lens')>('narrative-lens')
					.computeReadability
			);
		}
	});

	liveAnthropic('live Claude enhancement', () => {
		it('returns a conforming, non-empty enhancement of the passage', async () => {
			const enhancer = new AIContentEnhancer();
			const original = 'The man walked into the room. It was very dark. He was scared.';
			const result = await enhancer.enhance({
				content: original,
				type: 'style',
			});

			expect(typeof result.enhanced).toBe('string');
			expect(result.enhanced.length).toBeGreaterThan(0);
			expect(result.original).toBe(original);
			expect(result.metrics.originalWordCount).toBeGreaterThan(0);
			expect(result.changes).toBeNull();
		}, 30000);
	});
});
