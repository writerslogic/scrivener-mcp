import { computeReadability } from 'narrative-lens';
import { AdvancedReadabilityService } from '../../../src/analysis/advanced-readability.js';
import { ContentAnalyzer } from '../../../src/analysis/base-analyzer.js';

jest.mock('narrative-lens', () => {
	const actual = jest.requireActual('narrative-lens');
	return { __esModule: true, ...actual, computeReadability: jest.fn(actual.computeReadability) };
});

const svc = new AdvancedReadabilityService();

const SIMPLE = 'The cat sat on the mat. The dog ran fast. We had a lot of fun.';
const COMPLEX =
	'The utilization of multifaceted epistemological methodologies necessitates ' +
	'comprehensive interdisciplinary consideration whenever theoretical frameworks ' +
	'are operationalized within institutional paradigms.';

describe('AdvancedReadabilityService.calculateMetrics', () => {
	it.each(['', '   \n\t  ', '... — !'])(
		'marks unavailable scores without inventing a reading level: %j',
		(text) => {
			const metrics = svc.calculateMetrics(text);
			expect(metrics).toMatchObject({
				availability: 'unavailable',
				fleschReadingEase: null,
				fleschKincaidGrade: null,
				smogIndex: null,
				linsearWriteFormula: null,
				lexiconCount: 0,
				readingLevel: null,
				comprehensionDifficulty: 'unavailable',
				textStandard: 'unavailable',
				recommendations: [],
			});
		}
	);

	it('retains honest availability through the legacy ContentAnalyzer entry point on native failure', async () => {
		jest.mocked(computeReadability).mockImplementationOnce(() => {
			throw new Error('native fixture failure');
		});
		const analyzer = new ContentAnalyzer();
		try {
			expect(await analyzer.getAdvancedReadabilityAnalysis(SIMPLE)).toMatchObject({
				availability: 'unavailable',
				reason: 'analysis_failed',
				fleschReadingEase: null,
				lexiconCount: null,
				sentenceCount: null,
				recommendations: [],
			});
		} finally {
			analyzer.dispose();
		}
	});

	it('counts words, non-space characters, and sentences exactly', () => {
		const m = svc.calculateMetrics('The cat sat on the mat.');
		expect(m.lexiconCount).toBe(6);
		expect(m.characterCount).toBe(18); // "Thecatsatonthemat." incl. period
		expect(m.sentenceCount).toBe(1);
	});
	it.each([29, 30, 31])('exposes SMOG availability at %i complete sentences', (count) => {
		const result = svc.calculateMetrics(
			'Unusual discoveries encouraged the researchers. '.repeat(count)
		);
		expect(result.smogAvailable).toBe(count >= 30);
		if (count < 30) expect(result.smogIndex).toBeNull();
		else expect(result.smogIndex).toBeGreaterThan(0);
	});
	it('rejects invalid input types rather than reporting an empty measurement', () => {
		expect(() => svc.calculateMetrics(null as never)).toThrow(/text must be a string/);
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

	it.each([SIMPLE, COMPLEX, 'Dr. Jones waited. “Really?” she asked.'])(
		'uses Narrative Lens for supported scores and counts: %s',
		(text) => {
			const actual = svc.calculateMetrics(text);
			const expected = computeReadability(text);
			expect(actual).toMatchObject({
				availability: 'available',
				fleschReadingEase: expected.fleschEase,
				fleschKincaidGrade: expected.fkgl,
				smogIndex: expected.smogAvailable ? expected.smog : null,
				linsearWriteFormula: null,
				smogAvailable: expected.smogAvailable,
				colemanLiauIndex: expected.colemanLiau,
				automatedReadabilityIndex: expected.ari,
				gunningFogIndex: expected.gunningFog,
				daleChallReadabilityScore: expected.daleChall,
				syllableCount: expected.syllableCount,
				lexiconCount: expected.wordCount,
				sentenceCount: expected.sentenceCount,
				difficultWords: expected.polysyllableCount,
			});
			for (const value of Object.values(actual)) {
				if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
			}
		}
	);

	it('scores simple prose as easier than dense prose (semantic gate)', () => {
		const simple = svc.calculateMetrics(SIMPLE);
		const complex = svc.calculateMetrics(COMPLEX);
		if (simple.availability !== 'available' || complex.availability !== 'available')
			throw new Error('Expected readability measurements for prose fixtures');
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
	it('does not rank or recommend changes from unavailable inputs', () => {
		expect(svc.compareReadability('', SIMPLE).comparison).toEqual({
			easier: 'unavailable',
			keyDifferences: [],
			recommendations: [],
		});
		expect(svc.getAudienceSpecificRecommendations('', 'general_public')).toEqual([]);
		expect(svc.getContextualReadability('', 'business')).toEqual({
			score: null,
			contextAppropriateness: 'unavailable',
			suggestions: [],
		});
	});
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
	it('does not pad short passages with fabricated segments or a stable trend', () => {
		const trends = svc.analyzeReadabilityTrends('Mira rested. The moon rose.', 10);
		expect(trends.segments).toHaveLength(2);
		expect(trends.segments.map((segment) => segment.position)).toEqual([50, 100]);
		expect(trends.overallTrend).toBe('unavailable');
		expect(svc.analyzeReadabilityTrends('')).toEqual({
			segments: [],
			overallTrend: 'unavailable',
			problematicSections: [],
		});
	});
	it.each([0, 1, 2, 999, 1000, 1001, 1.5, Infinity])(
		'bounds segment allocation at %s',
		(count) => {
			const analyze = () => svc.analyzeReadabilityTrends(SIMPLE, count);
			if (Number.isInteger(count) && count >= 1 && count <= 1000)
				expect(analyze).not.toThrow();
			else expect(analyze).toThrow(/segmentCount/);
		}
	);
	it('reports an unavailable trend while retaining unaffected segment measurements', () => {
		jest.mocked(computeReadability).mockImplementationOnce(() => {
			throw new Error('native fixture failure');
		});
		const trends = svc.analyzeReadabilityTrends(SIMPLE, 3);
		expect(trends.overallTrend).toBe('unavailable');
		expect(trends.segments[0].fleschScore).toBeNull();
		expect(
			trends.segments.slice(1).every((segment) => typeof segment.fleschScore === 'number')
		).toBe(true);
	});
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
	it('surfaces malformed batches instead of silently dropping every entry', async () => {
		await expect(svc.calculateMetricsBatch([])).rejects.toThrow();
		await expect(svc.calculateMetricsBatch([SIMPLE, null as never])).rejects.toThrow(
			/text must be a string/
		);
	});
	it('preserves each input position when one native calculation fails', async () => {
		jest.mocked(computeReadability).mockImplementationOnce(() => {
			throw new Error('native fixture failure');
		});
		const out = await svc.calculateMetricsBatch([SIMPLE, COMPLEX, '']);
		expect(out.map((metrics) => metrics.availability)).toEqual([
			'unavailable',
			'available',
			'unavailable',
		]);
		expect(out[0].lexiconCount).toBeNull();
		expect(out[1].fleschReadingEase).toBe(computeReadability(COMPLEX).fleschEase);
		expect(out[2].lexiconCount).toBe(0);
	});
	it('returns one metrics object per input text', async () => {
		const out = await svc.calculateMetricsBatch([SIMPLE, COMPLEX]);
		expect(out).toHaveLength(2);
		if (out[0].availability !== 'available' || out[1].availability !== 'available')
			throw new Error('Expected readability measurements for both batch entries');
		expect(out[0].fleschReadingEase).toBeGreaterThan(out[1].fleschReadingEase);
	});
});
