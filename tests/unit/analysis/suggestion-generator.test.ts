import { collectProseExamples } from 'narrative-lens';
import { SuggestionGenerator } from '../../../src/analysis/analyzers/suggestion-generator.js';
import type { StyleAnalysis } from '../../../src/analysis/analyzers/style-analyzer.js';
import type { QualityIndicators } from '../../../src/analysis/analyzers/quality-analyzer.js';

const generator = new SuggestionGenerator();
const style: StyleAnalysis = {
	sentenceVariety: 'low',
	vocabularyComplexity: 'simple',
	adverbUsage: 'heavy',
	passiveVoicePercentage: null,
	dialoguePercentage: 0,
	descriptionPercentage: 100,
	mostFrequentWords: [],
	styleConsistency: null,
};
const quality: QualityIndicators = {
	repetitiveness: 0,
	cliches: [],
	filterWords: [],
	tellingVsShowing: 0,
	sensoryDetails: 'adequate',
	whiteSpace: 'balanced',
};

it('preserves native prose advice and excerpts without fabricating source locations', async () => {
	const text = `${'She walked through the quiet garden and watched the distant trees '.repeat(10)}.`;
	const findings = collectProseExamples([text]);
	expect(findings.length).toBeGreaterThan(0);
	const suggestions = await generator.generateSuggestions(
		text,
		{ ...style, proseFindings: findings },
		quality
	);
	for (const finding of findings) {
		expect(suggestions).toContainEqual({
			type: 'style',
			severity: 'minor',
			issue: finding.issueType,
			suggestion: finding.suggestion,
			example: finding.snippet,
		});
	}
	expect(suggestions.every((suggestion) => suggestion.location === undefined)).toBe(true);
});

it('deduplicates shared findings and suppresses obsolete generic advice', async () => {
	const finding = {
		sceneId: 0,
		issueType: 'passive_voice',
		snippet: 'The door was opened.',
		suggestion: 'Consider naming the actor.',
	};
	const suggestions = await generator.generateSuggestions(finding.snippet, style, quality, [
		finding,
		finding,
	]);
	expect(suggestions).toHaveLength(1);
	expect(suggestions[0].suggestion).toBe(finding.suggestion);
	expect(await generator.generateSuggestions('', style, quality, [])).toEqual([]);
});

it('retains application-specific sensory and telling assessments', async () => {
	const suggestions = await generator.generateSuggestions(
		'The room was quiet.',
		style,
		{ ...quality, sensoryDetails: 'lacking', tellingVsShowing: 0.7 },
		[]
	);
	expect(suggestions.map(({ issue }) => issue)).toEqual([
		'High ratio of telling vs showing',
		'Lacking sensory details',
	]);
});
