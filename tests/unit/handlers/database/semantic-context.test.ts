/**
 * Behavior tests for the retrieved-context formatter that grounds the semantic
 * layer's generation prompts. Pure and deterministic — no vector store needed.
 */

import {
	formatRetrievedContext,
	type RetrievedDoc,
} from '../../../../src/handlers/database/retrieved-context.js';

const hit = (pageContent: string, title?: string): [RetrievedDoc, number] => [
	{ pageContent, metadata: title ? { title } : {} },
	0.9,
];

describe('formatRetrievedContext', () => {
	it('labels passages by title and joins them with separators', () => {
		const out = formatRetrievedContext([hit('alpha', 'Ch1'), hit('beta', 'Ch2')]);
		expect(out).toBe('[Ch1]: alpha\n\n---\n\n[Ch2]: beta');
	});

	it('defaults the label to Document when a hit has no title', () => {
		expect(formatRetrievedContext([hit('x')])).toBe('[Document]: x');
	});

	it('caps each passage to perDocChars', () => {
		const out = formatRetrievedContext([hit('y'.repeat(100), 'T')], 10);
		expect(out).toBe(`[T]: ${'y'.repeat(10)}`);
	});

	it('drops empty-content hits and returns empty for no hits', () => {
		expect(formatRetrievedContext([hit('', 'T')])).toBe('');
		expect(formatRetrievedContext([])).toBe('');
	});
});
