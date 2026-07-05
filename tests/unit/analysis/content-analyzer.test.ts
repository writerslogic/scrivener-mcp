/**
 * ContentAnalyzer (base-analyzer) output tests. The analysis path previously had
 * no assertions on what it returns -- only that it ran. These lock the shape and
 * key numeric/semantic properties of analyzeContentDirect so the "wasm/SIMD"
 * acceleration layer can be refactored or removed without silent regressions.
 */

import { ContentAnalyzer } from '../../../src/analysis/base-analyzer.js';

const analyzer = new ContentAnalyzer();

const SIMPLE = 'The cat sat on the mat. The dog ran fast. We all had a lot of fun today.';
const COMPLEX =
	'The utilization of multifaceted epistemological methodologies necessitates ' +
	'comprehensive interdisciplinary consideration whenever theoretical frameworks ' +
	'are operationalized within institutional paradigms of governance.';

describe('ContentAnalyzer.analyzeContentDirect', () => {
	it('returns a fully-populated ContentAnalysis for valid content', async () => {
		const result = await analyzer.analyzeContentDirect(SIMPLE, 'doc-simple');
		expect(result.documentId).toBe('doc-simple');
		expect(typeof result.timestamp).toBe('string');
		expect(result.metrics).toBeTruthy();
		expect(result.structure).toBeTruthy();
		expect(result.style).toBeTruthy();
		expect(result.quality).toBeTruthy();
		expect(result.emotions).toBeTruthy();
		expect(result.pacing).toBeTruthy();
		expect(Array.isArray(result.suggestions)).toBe(true);
	});

	it('reports a positive word count for real content', async () => {
		const result = await analyzer.analyzeContentDirect(SIMPLE, 'doc-words');
		expect(result.metrics.wordCount).toBeGreaterThan(0);
		expect(result.metrics.sentenceCount).toBeGreaterThan(0);
	});

	it('scores simple prose as easier to read than dense prose', async () => {
		const simple = await analyzer.analyzeContentDirect(SIMPLE, 'doc-a');
		const complex = await analyzer.analyzeContentDirect(COMPLEX, 'doc-b');
		expect(simple.metrics.fleschReadingEase).toBeGreaterThan(complex.metrics.fleschReadingEase);
	});

	it('rejects content below the minimum length', async () => {
		await expect(analyzer.analyzeContentDirect('short', 'doc-x')).rejects.toThrow(
			/analyzeContent failed/
		);
	});

	it('preserves the document id across distinct documents', async () => {
		const a = await analyzer.analyzeContentDirect(SIMPLE, 'first');
		const b = await analyzer.analyzeContentDirect(COMPLEX, 'second');
		expect(a.documentId).toBe('first');
		expect(b.documentId).toBe('second');
	});
});
