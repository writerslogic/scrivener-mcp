/**
 * Tests for the word classifier: confirms it is functional (the contextual POS
 * path was silently throwing and returning all-false) and that the named-entity
 * guard exempts proper nouns from filler/weak/common/cliche classification.
 */

import { MLWordClassifierPro } from '../../../src/analysis/ml-word-classifier-pro.js';

describe('MLWordClassifierPro', () => {
	const classifier = new MLWordClassifierPro();

	it('keeps equal-length contexts and repeated word positions equivalent to fresh analysis', () => {
		const instance = new MLWordClassifierPro();
		const first = 'we think outside box';
		const second = 'we think outside hut';
		expect(instance.classify('outside', first, 9).isCliche).toBe(true);
		expect(instance.classify('outside', second, 9)).toEqual(
			new MLWordClassifierPro().classify('outside', second, 9)
		);
		expect(instance.classify('outside', second, 9).isCliche).toBe(false);
		const repeated = `${first} and ${second}`;
		for (const position of [9, repeated.lastIndexOf('outside')]) {
			expect(instance.classify('outside', repeated, position)).toEqual(
				new MLWordClassifierPro().classify('outside', repeated, position)
			);
		}
	});

	it('includes the complete analyzed context beyond old cache prefixes', () => {
		const prefix = 'Quiet footsteps crossed the empty room. '.repeat(29);
		const first = `${prefix}we think outside box`;
		const second = `${prefix}we think outside hut`;
		const position = first.indexOf('outside');
		const instance = new MLWordClassifierPro();
		instance.classify('outside', first, position);
		expect(instance.classify('outside', second, position)).toEqual(
			new MLWordClassifierPro().classify('outside', second, position)
		);
	});

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
