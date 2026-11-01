import * as lens from 'narrative-lens';
import { ContentAnalyzer } from '../../../src/analysis/base-analyzer.js';
import { StyleAnalyzer } from '../../../src/analysis/analyzers/style-analyzer.js';
import { StructureAnalyzer } from '../../../src/analysis/analyzers/structure-analyzer.js';
import { QualityAnalyzer } from '../../../src/analysis/analyzers/quality-analyzer.js';
import { EmotionAnalyzer } from '../../../src/analysis/analyzers/emotion-analyzer.js';
import { PacingAnalyzer } from '../../../src/analysis/analyzers/pacing-analyzer.js';
import { SuggestionGenerator } from '../../../src/analysis/analyzers/suggestion-generator.js';

jest.mock('narrative-lens', () => {
	const actual = jest.requireActual('narrative-lens');
	return { __esModule: true, ...actual, extractDialogue: jest.fn(actual.extractDialogue) };
});

function style(cacheFailure = false) {
	return new StyleAnalyzer({
		get: async () => undefined,
		set: async () => {
			if (cacheFailure) throw new Error('cache unavailable');
		},
	} as never);
}
afterEach(() => jest.restoreAllMocks());

it('reports whitespace-only source counts as zero and its averages as unavailable', async () => {
	const analyzer = new ContentAnalyzer();
	try {
		const result = await analyzer.analyzeContent(' \n\t ', 'blank-metrics');
		expect(result.metrics).toMatchObject({
			wordCount: 0,
			sentenceCount: 0,
			paragraphCount: 0,
			averageSentenceLength: null,
			averageParagraphLength: null,
		});
	} finally {
		analyzer.dispose();
	}
});

it('weights streaming averages by source units and defers combined native scores until final analysis', async () => {
	const analyzer = new ContentAnalyzer();
	try {
		const stream = analyzer.analyzeContentStream(
			'One two three four five.\n\nA short sentence. Another short sentence. The final sentence.',
			'stream-metrics',
			25
		);
		await stream.next();
		const partial = await stream.next();
		expect(partial.done).toBe(false);
		expect(partial.value.metrics).toMatchObject({
			wordCount: 14,
			sentenceCount: 4,
			paragraphCount: 2,
			averageSentenceLength: 3.5,
			averageParagraphLength: 7,
			readingTime: 1,
			fleschReadingEase: null,
			fleschKincaidGrade: null,
		});
		const final = await stream.next();
		expect(final.done).toBe(true);
		expect(final.value.metrics?.fleschReadingEase).not.toBeNull();
	} finally {
		analyzer.dispose();
	}
});

it.each([9, 10, 11])('measures dialogue across the former %s-token cutoff', async (count) => {
	const words = Array.from({ length: count }, () => 'word').join(' ');
	expect((await style().analyzeStyle(words)).dialoguePercentage).toBe(0);
	expect((await style().analyzeStyle(`"${words}"`)).dialoguePercentage).toBeGreaterThan(0);
});

it('marks empty style and failed extraction unavailable without fabricated labels', async () => {
	const empty = await style().analyzeStyle('');
	expect(empty).toMatchObject({
		sentenceVariety: 'unavailable',
		vocabularyComplexity: 'unavailable',
		adverbUsage: 'unavailable',
		dialoguePercentage: null,
		descriptionPercentage: null,
	});
	const findings = lens.collectProseExamples(['It was a dark and stormy night.']);
	jest.mocked(lens.extractDialogue).mockImplementationOnce(() => {
		throw new Error('native fixture failure');
	});
	expect(await style().analyzeStyle('It was a dark and stormy night.', findings)).toMatchObject({
		...empty,
		proseFindings: findings,
	});
});

it('retains prose findings computed before a later native failure', async () => {
	jest.mocked(lens.extractDialogue).mockImplementationOnce(() => {
		throw new Error('dialogue fixture failure');
	});
	const result = await style().analyzeStyle('It was a dark and stormy night.');
	expect(result.dialoguePercentage).toBeNull();
	expect(result.proseFindings).toEqual(
		expect.arrayContaining([expect.objectContaining({ issueType: 'cliche' })])
	);
});

it('preserves measured style when only cache persistence fails', async () => {
	expect(
		(await style(true).analyzeStyle('Plain words with no quotations.')).dialoguePercentage
	).toBe(0);
});

it('preserves native evidence despite independent analyzer and suggestion failures', async () => {
	const analyzer = new ContentAnalyzer();
	try {
		jest.spyOn(StructureAnalyzer.prototype, 'analyzeStructure').mockImplementation(() => {
			throw new Error('structure unavailable');
		});
		jest.spyOn(StyleAnalyzer.prototype, 'analyzeStyle').mockRejectedValue(
			new Error('style unavailable')
		);
		jest.spyOn(QualityAnalyzer.prototype, 'assessQuality').mockRejectedValue(
			new Error('quality unavailable')
		);
		jest.spyOn(EmotionAnalyzer.prototype, 'analyzeEmotions').mockRejectedValue(
			new Error('emotions unavailable')
		);
		jest.spyOn(PacingAnalyzer.prototype, 'analyzePacing').mockRejectedValue(
			new Error('pacing unavailable')
		);
		jest.spyOn(SuggestionGenerator.prototype, 'generateSuggestions').mockRejectedValue(
			new Error('suggestions unavailable')
		);
		const result = await analyzer.analyzeContent(
			'It was a dark and stormy night.',
			'failure-fixture'
		);
		expect(result.metrics.wordCount).toBeGreaterThan(0);
		expect(result.suggestions).toEqual(
			expect.arrayContaining([expect.objectContaining({ issue: 'cliche' })])
		);
		expect(result.quality).toMatchObject({
			repetitiveness: null,
			tellingVsShowing: null,
			sensoryDetails: 'unavailable',
		});
		expect(result.emotions).toMatchObject({
			tensionLevel: null,
			moodConsistency: null,
			dominantEmotion: 'unavailable',
		});
		expect(result.pacing).toMatchObject({ overall: 'unavailable', actionVsReflection: null });
		expect(result.structure).toMatchObject({
			chapters: null,
			sceneBreaks: null,
			endingStrength: 'unavailable',
		});
	} finally {
		analyzer.dispose();
	}
});
