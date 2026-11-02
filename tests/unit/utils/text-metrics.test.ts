import { getAccurateWordCount, getWritingTextMetrics } from '../../../src/utils/text-metrics.js';

test.each([
	['U.S.A.', 1],
	['F.B.I. U.S.A.', 2],
	['The U.S.A. is a place.', 5],
	['U.S.A. U.S.A.', 2],
	['Élodie’s café—it isn’t empty.', 5],
	['Ｆ．Ｂ．Ｉ．', 1],
])('counts tokenizer words in %j without subtracting acronym punctuation', (text, expected) => {
	expect(getAccurateWordCount(text as string)).toBe(expected);
});

test.each(['', ' ', '\n\t ', '\u200B\uFEFF\u2060'])(
	'reports absent text units and unavailable averages for %j',
	(text) => {
		expect(getWritingTextMetrics(text)).toEqual({
			wordCount: 0,
			sentenceCount: 0,
			paragraphCount: 0,
			averageWordsPerSentence: null,
			averageWordsPerParagraph: null,
			readingTimeMinutes: 0,
		});
	}
);

test('counts acronym-only paragraphs instead of discarding them as empty', () => {
	expect(getWritingTextMetrics('U.S.A.\n\nF.B.I.')).toMatchObject({
		wordCount: 2,
		paragraphCount: 2,
		averageWordsPerParagraph: 1,
	});
});

test.each([
	['猫です。', 2],
	['中国人民。', 2],
	['مرحبا بالعالم.', 2],
	['The harbor 与海。', 4],
])('counts Unicode word segments in %j', (text, expected) => {
	expect(getAccurateWordCount(text as string)).toBe(expected);
	expect(getWritingTextMetrics(text as string).sentenceCount).toBe(1);
});
