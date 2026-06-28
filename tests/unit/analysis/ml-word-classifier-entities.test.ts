/**
 * Tests for the word classifier: confirms it is functional (the contextual POS
 * path was silently throwing and returning all-false) and that the named-entity
 * guard exempts proper nouns from filler/weak/common/cliche classification.
 */

import { MLWordClassifierPro } from '../../../src/analysis/ml-word-classifier-pro.js';

describe('MLWordClassifierPro', () => {
	const classifier = new MLWordClassifierPro();

	it('detects an intensifier as a filler word (classifier is functional)', () => {
		expect(classifier.classify('very', 'It was very cold outside today.', 2).isFilterWord).toBe(
			true
		);
		expect(
			classifier.classify('really', 'That was really kind of you to help.', 2).isFilterWord
		).toBe(true);
	});

	it('detects expanded filler words from the curated list', () => {
		for (const w of ['simply', 'totally', 'absolutely', 'essentially']) {
			const result = classifier.classify(w, `The plan was ${w} ready for review.`, 3);
			expect(result.isFilterWord).toBe(true);
		}
	});

	it('does not flag strong, specific words as fillers or weak verbs (no false positives)', () => {
		const a = classifier.classify('sprinted', 'She sprinted across the muddy field.', 1);
		expect(a.isWeakVerb).toBe(false);
		expect(a.isFilterWord).toBe(false);
		const b = classifier.classify('mountain', 'The mountain loomed over the valley.', 1);
		expect(b.isFilterWord).toBe(false);
		expect(b.isCliche).toBe(false);
	});

	it('does NOT flag a proper-noun client name that collides with a buzzword (NER guard)', () => {
		const result = classifier.classify(
			'Robust',
			'The contract went to Robust, our biggest client.',
			4
		);
		expect(result.isCliche).toBe(false);
		expect(result.isFilterWord).toBe(false);
	});

	it('never classifies a person name as a weak/common/filler word', () => {
		const result = classifier.classify('Sarah', 'Sarah opened the door and stepped inside.', 0);
		expect(result.isFilterWord).toBe(false);
		expect(result.isWeakVerb).toBe(false);
		expect(result.isCliche).toBe(false);
	});
});
