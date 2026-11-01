import { ContentAnalyzer } from '../../../src/analysis/base-analyzer.js';

const analyzer = new ContentAnalyzer();
afterAll(() => analyzer.dispose());

const SIMPLE = 'The cat sat on the mat. The dog ran fast. We all had a lot of fun today.';
const COMPLEX =
	'The utilization of multifaceted epistemological methodologies necessitates ' +
	'comprehensive interdisciplinary consideration whenever theoretical frameworks ' +
	'are operationalized within institutional paradigms of governance.';

describe('ContentAnalyzer.analyzeContentDirect', () => {
	it('scores simple prose as easier to read than dense prose', async () => {
		const simple = await analyzer.analyzeContentDirect(SIMPLE, 'doc-a');
		const complex = await analyzer.analyzeContentDirect(COMPLEX, 'doc-b');
		expect(simple.documentId).toBe('doc-a');
		expect(complex.documentId).toBe('doc-b');
		expect(simple.metrics.wordCount).toBe(18);
		expect(simple.metrics.sentenceCount).toBe(3);
		const simpleEase = simple.metrics.fleschReadingEase;
		const complexEase = complex.metrics.fleschReadingEase;
		if (simpleEase === null || complexEase === null)
			throw new Error('Nonempty readability fixtures must produce available measurements');
		expect(Number.isFinite(simpleEase)).toBe(true);
		expect(Number.isFinite(complexEase)).toBe(true);
		expect(simpleEase).toBeGreaterThan(complexEase);
	});

	it('analyzes short text with measured dialogue and explicitly unavailable description coverage', async () => {
		const result = await analyzer.analyzeContentDirect('short', 'doc-x');
		expect(result.metrics.wordCount).toBe(1);
		expect(result.style).toMatchObject({
			dialoguePercentage: 0,
			descriptionPercentage: null,
		});
	});
});
