/**
 * AdvancedReadabilityService tests. Pure, deterministic, dependency-free: exact
 * token/character counts, the Flesch formula as an internal-consistency
 * invariant, and semantic monotonicity (simple prose must score easier than
 * dense prose) -- a real behavior gate, not a structure check.
 */

import { AdvancedReadabilityService } from '../../../src/analysis/advanced-readability.js';

const svc = new AdvancedReadabilityService();

const SIMPLE = 'The cat sat on the mat. The dog ran fast. We had a lot of fun.';
const COMPLEX =
	'The utilization of multifaceted epistemological methodologies necessitates ' +
	'comprehensive interdisciplinary consideration whenever theoretical frameworks ' +
	'are operationalized within institutional paradigms.';

describe('AdvancedReadabilityService.calculateMetrics', () => {
	it('returns zeroed metrics for empty text', () => {
		const m = svc.calculateMetrics('');
		expect(m.fleschReadingEase).toBe(0);
		expect(m.lexiconCount).toBe(0);
		expect(m.sentenceCount).toBe(0);
		expect(m.textStandard).toBe('N/A');
	});

	it('returns zeroed metrics for whitespace-only text', () => {
		expect(svc.calculateMetrics('   \n\t  ').lexiconCount).toBe(0);
	});

	it('counts words, non-space characters, and sentences exactly', () => {
		const m = svc.calculateMetrics('The cat sat on the mat.');
		expect(m.lexiconCount).toBe(6);
		expect(m.characterCount).toBe(18); // "Thecatsatonthemat." incl. period
		expect(m.sentenceCount).toBe(1);
	});

	it('derives averageSentenceLength as words / sentences', () => {
		const m = svc.calculateMetrics('The cat sat on the mat.');
		expect(m.averageSentenceLength).toBeCloseTo(6);
		expect(m.averageWordsPerSentence).toBe(m.averageSentenceLength);
	});

	it('computes reading time from a 200 wpm baseline', () => {
		// 6 words -> ceil(6 / 200) === 1 minute
		expect(svc.calculateMetrics('The cat sat on the mat.').readingTimeMinutes).toBe(1);
	});

	it('keeps Flesch Reading Ease consistent with its own sub-metrics', () => {
		const m = svc.calculateMetrics(SIMPLE);
		const expected =
			206.8348 - 1.015 * m.averageSentenceLength - 84.6 * m.averageSyllablesPerWord;
		expect(m.fleschReadingEase).toBeCloseTo(expected, 6);
	});

	it('scores simple prose as easier than dense prose (semantic gate)', () => {
		const simple = svc.calculateMetrics(SIMPLE);
		const complex = svc.calculateMetrics(COMPLEX);
		expect(simple.fleschReadingEase).toBeGreaterThan(complex.fleschReadingEase);
		// Grade level moves the other way: dense prose reads at a higher grade.
		expect(complex.fleschKincaidGrade).toBeGreaterThan(simple.fleschKincaidGrade);
	});

	it('assigns a valid comprehension-difficulty bucket', () => {
		const buckets = [
			'very_easy',
			'easy',
			'fairly_easy',
			'standard',
			'fairly_difficult',
			'difficult',
			'very_difficult',
		];
		expect(buckets).toContain(svc.calculateMetrics(SIMPLE).comprehensionDifficulty);
		expect(svc.calculateMetrics(SIMPLE).recommendations).toBeInstanceOf(Array);
	});
});

describe('AdvancedReadabilityService.compareReadability', () => {
	it('identifies the simpler of two texts', () => {
		const result = svc.compareReadability(SIMPLE, COMPLEX);
		expect(result.comparison.easier).toBe('text1');
	});

	it('reports two texts of equal readability as similar', () => {
		const result = svc.compareReadability(SIMPLE, SIMPLE);
		expect(result.comparison.easier).toBe('similar');
	});
});

describe('AdvancedReadabilityService.analyzeReadabilityTrends', () => {
	it('returns exactly the requested number of segments', () => {
		const trends = svc.analyzeReadabilityTrends(
			'One. Two. Three. Four. Five. Six. Seven. Eight.',
			4
		);
		expect(trends.segments).toHaveLength(4);
		for (const seg of trends.segments) {
			expect(typeof seg.fleschScore).toBe('number');
			expect(seg.position).toBeGreaterThan(0);
		}
	});
});

describe('AdvancedReadabilityService.calculateMetricsBatch', () => {
	it('returns one metrics object per input text', async () => {
		const out = await svc.calculateMetricsBatch([SIMPLE, COMPLEX]);
		expect(out).toHaveLength(2);
		expect(out[0].fleschReadingEase).toBeGreaterThan(out[1].fleschReadingEase);
	});
});
