/**
 * Verifies the paragraph-level LCS diff used by compare_snapshot: unchanged
 * paragraphs between edits are not reported as churn, and pure additions,
 * removals, and reorders resolve correctly.
 */

import { diffParagraphs, diffWordCounts, splitParagraphs } from '../../../src/utils/text-diff.js';

describe('splitParagraphs', () => {
	it('trims and drops blank paragraphs', () => {
		expect(splitParagraphs('  a \n\n b \n\n\n')).toEqual(['a', 'b']);
	});
});

describe('diffParagraphs', () => {
	it('reports no changes for identical text', () => {
		const d = diffParagraphs('one\n\ntwo', 'one\n\ntwo');
		expect(d).toEqual({ added: [], removed: [], unchanged: 2 });
	});

	it('detects an added paragraph without churning the unchanged ones', () => {
		const d = diffParagraphs('one\n\ntwo', 'one\n\nnew\n\ntwo');
		expect(d.added).toEqual(['new']);
		expect(d.removed).toEqual([]);
		expect(d.unchanged).toBe(2);
	});

	it('detects a removed paragraph', () => {
		const d = diffParagraphs('one\n\ntwo\n\nthree', 'one\n\nthree');
		expect(d.removed).toEqual(['two']);
		expect(d.added).toEqual([]);
		expect(d.unchanged).toBe(2);
	});

	it('reports a replaced paragraph as one removed and one added', () => {
		const d = diffParagraphs('one\n\ntwo', 'one\n\ndeux');
		expect(d.removed).toEqual(['two']);
		expect(d.added).toEqual(['deux']);
		expect(d.unchanged).toBe(1);
	});

	it('handles empty inputs', () => {
		expect(diffParagraphs('', '')).toEqual({ added: [], removed: [], unchanged: 0 });
		expect(diffParagraphs('', 'x')).toEqual({ added: ['x'], removed: [], unchanged: 0 });
		expect(diffParagraphs('x', '')).toEqual({ added: [], removed: ['x'], unchanged: 0 });
	});
});

describe('diffWordCounts', () => {
	it('counts a single in-paragraph word change as 1 added / 1 removed', () => {
		// A paragraph diff would flag the whole line; word-level isolates the edit.
		expect(diffWordCounts('the quick brown fox', 'the slow brown fox')).toEqual({
			added: 1,
			removed: 1,
		});
	});

	it('counts pure additions and removals', () => {
		expect(diffWordCounts('one two', 'one two three four')).toEqual({ added: 2, removed: 0 });
		expect(diffWordCounts('one two three', 'one')).toEqual({ added: 0, removed: 2 });
	});

	it('reports zero for identical text', () => {
		expect(diffWordCounts('same words here', 'same words here')).toEqual({
			added: 0,
			removed: 0,
		});
	});
});
