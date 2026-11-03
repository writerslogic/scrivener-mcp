import { ContentAnalyzer } from '../../../src/analysis/base-analyzer.js';
import { analyzeDocumentHandler } from '../../../src/handlers/analysis-handlers/document-analysis.js';
import type { HandlerContext, HandlerResult } from '../../../src/handlers/types.js';
import { MetricsAnalyzer } from '../../../src/analysis/analyzers/metrics-analyzer.js';
import { disposeSpool, readResult } from '../../../src/core/response-formatter.js';

function data(result: HandlerResult): Record<string, unknown> {
	const value = result.structuredContent!;
	if (typeof value._ref !== 'string') return value;

	let offset: number | null = 0,
		json = '';
	do {
		const page = readResult(value._ref, offset, 1024);
		json += page.text;
		offset = page.nextOffset;
	} while (offset !== null);
	return JSON.parse(json);
}
afterAll(async () => {
	disposeSpool();
});

jest.mock('../../../src/analysis/ai-document-analyzer.js', () => ({
	...jest.requireActual('../../../src/analysis/ai-document-analyzer.js'),
	AIDocumentAnalyzer: class {
		async analyzeDocument() {
			throw new Error('provider unavailable fixture');
		}
	},
}));

describe('public document fallback with real local analysis', () => {
	let analyzer: ContentAnalyzer;
	let document: { projectId: string; documentId: string; revision: string; text: string };
	let context: HandlerContext;
	beforeEach(() => {
		analyzer = new ContentAnalyzer();
		document = {
			projectId: 'fallback',
			documentId: 'scene',
			revision: 'original',
			text: 'It was a dark and stormy night. "Leave now," Mira said. She was was afraid.',
		};
		context = {
			project: {
				getEditorialServices: () => ({
					source: { projectId: 'fallback', read: async () => document },
				}),
			},
			contentAnalyzer: analyzer,
		} as unknown as HandlerContext;
	});
	afterEach(() => {
		analyzer.dispose();
		jest.restoreAllMocks();
	});
	it('retains repetition, dialogue, prose evidence and explicit provider unavailability', async () => {
		const result = await analyzeDocumentHandler.handler({ documentId: 'scene' }, context);
		const report = data(result);
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ description: expect.stringMatching(/Repeated word/) }),
				expect.objectContaining({ description: expect.stringMatching(/cliche/) }),
			])
		);
		expect(report.local).toMatchObject({
			style: { dialoguePercentage: expect.any(Number), passiveVoicePercentage: null },
		});
		expect(report.availability).toMatchObject({ provider: 'unavailable' });
		expect(report.envelope).toMatchObject({
			sourceRevisions: [{ documentId: 'scene', revision: 'original' }],
			policy: { mode: 'raw', revisionChecked: true },
		});
		expect(result.content[0].text).not.toMatch(/\?|\[object Object\]|deep_analyze_content/);
	});
	it('reports missing metrics as unavailable while retaining real findings', async () => {
		jest.spyOn(MetricsAnalyzer.prototype, 'calculateMetrics').mockRejectedValue(
			new Error('metrics fixture')
		);
		const result = await analyzeDocumentHandler.handler({ documentId: 'scene' }, context);
		expect(data(result)).toMatchObject({
			readability: 'unavailable',
			nativeFindings: [expect.objectContaining({ kind: 'repetition' })],
		});
	});
	it('handles empty saved text without inventing readability or pacing', async () => {
		document.text = '';
		const result = await analyzeDocumentHandler.handler({ documentId: 'scene' }, context);
		expect(data(result)).toMatchObject({
			readability: 'unavailable',
			pacing: 'unavailable',
			issues: [],
		});
	});
	it('rejects a source change after provider failure instead of returning stale local evidence', async () => {
		const analyze = analyzer.analyzeContent.bind(analyzer);
		jest.spyOn(analyzer, 'analyzeContent').mockImplementation(async (...args) => {
			const result = await analyze(...args);
			document = { ...document, revision: 'external-edit' };
			return result;
		});
		await expect(
			analyzeDocumentHandler.handler({ documentId: 'scene' }, context)
		).rejects.toThrow(/source changed/);
	});
});
