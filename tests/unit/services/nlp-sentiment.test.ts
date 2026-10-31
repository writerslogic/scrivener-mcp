import { NLPSentimentAnalyzer } from '../../../src/services/analysis/nlp-sentiment-analyzer.js';

const analyzer = new NLPSentimentAnalyzer();

test.each(['happy', 'happy.', '“Happy!”', 'Mira felt happy.'])(
	'retains positive sentiment with punctuation and case: %s',
	(text) => {
		const result = analyzer.analyzeSentiment(text);
		expect(result.score).toBeGreaterThan(0);
		expect(result.tokens).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ word: 'happy', sentiment: expect.any(Number) }),
			])
		);
	}
);

test.each(['sad', 'sad.', '“Sad!”', 'Mira felt sad.'])(
	'retains negative sentiment with punctuation and case: %s',
	(text) => {
		expect(analyzer.analyzeSentiment(text).score).toBeLessThan(0);
	}
);

test('uses actual POS tags and bounds negation at clause boundaries', () => {
	const result = analyzer.analyzeSentiment('Mira was not happy, but she was sad.');
	expect(result.tokens.find((token) => token.word === 'happy')).toMatchObject({
		pos: 'JJ',
		negated: true,
	});
	expect(result.tokens.find((token) => token.word === 'sad')).toMatchObject({
		pos: 'JJ',
		negated: false,
	});
	expect(result.negations[0].scope).toEqual(['happy']);
	expect(analyzer.analyzeSentiment('Mira was not happy.').score).toBeLessThan(0);
});

test.each([2, 3, 4])('bounds the lookback at a negation distance of %i tokens', (distance) => {
	const text = `Mira was not ${'truly '.repeat(distance - 1)}happy.`;
	const result = analyzer.analyzeSentiment(text);
	expect(result.tokens.find((token) => token.word === 'happy')?.negated).toBe(distance <= 3);
	expect(result.negations[0].scope.includes('happy')).toBe(distance <= 3);
});

test('applies intensifiers within a clause and keeps wordless input empty', () => {
	const plain = analyzer.analyzeSentiment('Mira was happy.');
	expect(analyzer.analyzeSentiment('Mira was very happy.').score).toBeGreaterThan(plain.score);
	expect(
		analyzer
			.analyzeSentiment('Mira said very, happy.')
			.tokens.find((token) => token.word === 'happy')?.intensifier
	).toBeUndefined();
	expect(analyzer.analyzeSentiment('').tokens).toEqual([]);
});
