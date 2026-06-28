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
