import { StyleAnalyzer } from '../../../src/analysis/analyzers/style-analyzer.js';
import { StructureAnalyzer } from '../../../src/analysis/analyzers/structure-analyzer.js';
import { PacingAnalyzer } from '../../../src/analysis/analyzers/pacing-analyzer.js';
import { QualityAnalyzer } from '../../../src/analysis/analyzers/quality-analyzer.js';

function createStyleAnalyzer() {
	const entries = new Map<string, unknown>();
	const cache = {
		get: async (key: string) => entries.get(key),
		set: async (key: string, value: unknown) => {
			entries.set(key, value);
		},
	};
	return new StyleAnalyzer(cache as ConstructorParameters<typeof StyleAnalyzer>[0]);
}

describe('Narrative Lens analyzer integration', () => {
	it('does not classify apostrophes in contractions as quoted dialogue', async () => {
		const result = await createStyleAnalyzer().analyzeStyle(
			"I don't think we should leave. They aren't ready to go home yet."
		);
		expect(result.dialoguePercentage).toBe(0);
		expect(result.passiveVoicePercentage).toBeNull();
		expect(result.styleConsistency).toBeNull();
	});

	it('measures short unquoted passages instead of fabricating dialogue', async () => {
		const result = await createStyleAnalyzer().analyzeStyle('Plain words with no quotations.');
		expect(result.dialoguePercentage).toBe(0);
		expect(result.descriptionPercentage).toBeNull();
	});

	it('invalidates style cache when only text after the first 500 characters changes', async () => {
		const analyzer = createStyleAnalyzer();
		const prefix = 'The quiet garden waited beneath the stars. '.repeat(15);
		const narration = await analyzer.analyzeStyle(prefix + 'The gardener walked home.');
		const dialogue = await analyzer.analyzeStyle(
			prefix + '"We should leave the garden now," she said.'
		);
		expect(narration.dialoguePercentage).toBe(0);
		expect(dialogue.dialoguePercentage).toBeGreaterThan(0);
	});

	it('preserves native prose evidence without inventing passive prevalence', async () => {
		const result = await createStyleAnalyzer().analyzeStyle(
			'The door was opened by John. '.repeat(6)
		);
		expect(
			result.proseFindings?.some((finding) => finding.issueType === 'repetitive_opener')
		).toBe(true);
		expect(result.passiveVoicePercentage).toBeNull();
	});

	it('retains unassessed opening quality and source evidence', () => {
		const result = new StructureAnalyzer().analyzeStructure('She ran into the dark forest.');
		expect(result.openingStrength).toBe('unassessed');
		expect(result.openingEvidence?.qualityAssessed).toBe(false);
		expect(result.openingEvidence?.cues.length).toBeGreaterThan(0);
	});

	it('uses native cliché evidence instead of a second phrase catalog', async () => {
		const classifier = { classify: () => ({ isFilterWord: false, confidence: 0 }) };
		const analyzer = new QualityAnalyzer(
			classifier as unknown as ConstructorParameters<typeof QualityAnalyzer>[0]
		);
		const result = await analyzer.assessQuality(
			'It was a dark and stormy night. The door was locked.'
		);
		expect(result.cliches.some((snippet) => snippet.includes('dark and stormy night'))).toBe(
			true
		);
	});

	it('keeps sentence boundaries and covers the complete pacing range', async () => {
		const result = await new PacingAnalyzer().analyzePacing(
			'She ran. He followed. They escaped. '.repeat(6)
		);
		expect(result.overall).toBe('fast');
		expect(result.sections[0].start).toBe(0);
		expect(result.sections[result.sections.length - 1]?.end).toBe(100);
		expect(result.sections.every((section) => section.pace === 'fast')).toBe(true);
	});
});
