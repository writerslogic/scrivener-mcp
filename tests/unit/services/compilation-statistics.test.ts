/**
 * Locks CompilationService.getStatistics: word/status/label aggregation across a
 * nested binder, and the longest/shortest-document selection (previously declared
 * but never populated) that get_manuscript_briefing surfaces.
 */

import { CompilationService } from '../../../src/services/compilation-service.js';
import type { ScrivenerDocument } from '../../../src/types/index.js';

const docs: ScrivenerDocument[] = [
	{
		id: 'f1',
		title: 'Part One',
		type: 'Folder',
		path: '/Part One',
		children: [
			{
				id: 'd1',
				title: 'Short scene',
				type: 'Text',
				path: '/Part One/Short scene',
				content: 'one two three',
				wordCount: 3,
				status: 'Done',
				label: 'POV: Ana',
			},
			{
				id: 'd2',
				title: 'Long scene',
				type: 'Text',
				path: '/Part One/Long scene',
				content: 'a b c d e f g h i j',
				wordCount: 10,
				status: 'To Do',
				label: 'POV: Ana',
			},
		],
	},
	{
		id: 'd3',
		title: 'Middle scene',
		type: 'Text',
		path: '/Middle scene',
		content: 'x y z q r',
		wordCount: 5,
		status: 'Done',
	},
];

describe('CompilationService.getStatistics', () => {
	const stats = new CompilationService().getStatistics(docs);

	it('aggregates words, documents, and folders', () => {
		expect(stats.totalWords).toBe(18);
		expect(stats.totalFolders).toBe(1);
		expect(stats.totalDocuments).toBe(4);
		expect(stats.averageDocumentLength).toBe(6); // 18 words / 3 text docs
	});

	it('breaks down by status and label', () => {
		expect(stats.documentsByStatus).toEqual({ Done: 2, 'To Do': 1 });
		expect(stats.documentsByLabel).toEqual({ 'POV: Ana': 2 });
	});

	it('selects the longest and shortest text documents', () => {
		expect(stats.longestDocument).toMatchObject({ id: 'd2', wordCount: 10 });
		expect(stats.shortestDocument).toMatchObject({ id: 'd1', wordCount: 3 });
	});
});

describe('CompilationService.compileStructured', () => {
	const svc = new CompilationService();
	const entries = [
		{ title: 'Part One', content: '', depth: 1, isFolder: true },
		{ title: 'Chapter 1', content: 'The scene opens.', depth: 2, isFolder: false },
		{ title: 'Chapter 2', content: 'It continues.', depth: 2, isFolder: false },
	];

	it('renders markdown headings by binder depth', () => {
		const out = svc.compileStructured(entries, { outputFormat: 'markdown' });
		expect(out).toContain('# Part One');
		expect(out).toContain('## Chapter 1');
		expect(out).toContain('The scene opens.');
	});

	it('inserts the scene separator only between sibling documents', () => {
		const out = svc.compileStructured(entries, {
			outputFormat: 'markdown',
			sceneSeparator: '* * *',
		});
		expect(out.match(/\* \* \*/g)).toHaveLength(1); // one gap: Ch1 -> Ch2
	});

	it('can omit document titles', () => {
		const out = svc.compileStructured(entries, {
			outputFormat: 'markdown',
			includeTitles: false,
		});
		expect(out).not.toContain('## Chapter 1');
		expect(out).toContain('The scene opens.');
	});

	it('escapes HTML in titles', () => {
		const out = svc.compileStructured(
			[{ title: 'A & B', content: 'x', depth: 1, isFolder: false }],
			{
				outputFormat: 'html',
			}
		);
		expect(out).toContain('A &amp; B');
	});
});
