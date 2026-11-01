import { collectProseExamples, analyzeForeshadowing, ManuscriptContext } from 'narrative-lens';
import { MLWordClassifierPro } from '../../../src/analysis/ml-word-classifier-pro.js';
import { ContextAnalyzer } from '../../../src/analysis/context-analyzer.js';
import { extractContinuityCandidates } from '../../../src/services/editorial/continuity-service.js';

it('delegates the shared cliché while retaining the demonstrated business-phrase gap', () => {
	const classifier = new MLWordClassifierPro();
	const shared = 'The glass was crystal clear.';
	expect(collectProseExamples([shared])).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				issueType: 'cliche',
				snippet: expect.stringContaining('crystal clear'),
			}),
		])
	);
	expect(classifier.classify('clear', shared, shared.indexOf('clear')).isCliche).toBe(true);
	const gap = 'we think outside box';
	expect(collectProseExamples([gap]).filter((item) => item.issueType === 'cliche')).toEqual([]);
	expect(classifier.classify('outside', gap, gap.indexOf('outside')).isCliche).toBe(true);
});

it('retains prose cue excerpts that are not native setup/payoff pairs', () => {
	const text = 'Little did she know the door would close. She remembered the old wooden door.';
	const analyzer = new ContextAnalyzer({} as never, {} as never);
	expect(analyzer['extractForeshadowing'](text)).toEqual([
		'Little did she know the door would close.',
	]);
	expect(analyzer['extractCallbacks'](text)).toContain('remembered the old wooden door.');
	expect(analyzeForeshadowing([text.toLowerCase().split(/\s+/)], 1)).toEqual([]);
});

it('retains singleton canon candidates with exact source provenance absent from native conflict output', () => {
	const text = '🌙 Mira has blue eyes. Mira was born in 1984.';
	const document = {
		projectId: 'p',
		documentId: 's',
		title: 'Scene',
		path: 'Draft/Scene',
		revision: 'saved',
		order: 0,
		text,
		metadata: {},
	};
	const context = new ManuscriptContext(1024 * 1024);
	try {
		const report = context.analyze({
			documentId: 'p',
			scenes: [{ id: 's', text }],
			configuration: { rules: ['NL-CONTINUITY-ATTRIBUTE'] },
		});
		expect(report.findings).toEqual([]);
		const candidates = extractContinuityCandidates(document);
		expect(candidates.map((item) => item.predicate)).toEqual(['eye-color', 'birth-year']);
		for (const candidate of candidates) {
			const source = candidate.sources[0];
			expect(text.slice(source.start, source.end)).toBe(source.quote);
			expect(source.revision).toBe('saved');
			expect(candidate.confidence).toBe('inferred');
		}
	} finally {
		context.clear();
	}
});
