/**
 * Unified text metrics utilities for accurate word, sentence, and paragraph counting
 * Handles Unicode, contractions, acronyms, and special characters properly
 */

import nlp from 'compromise';
import { escapeRegExp } from './regex.js';

const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

function hasNonLatinLetters(text: string): boolean {
	return /[^\p{Script=Latin}\P{Letter}]/u.test(text);
}

export function hasEnglishReadabilityEvidence(text: string): boolean {
	return (
		!hasNonLatinLetters(text) &&
		/\b(?:the|and|is|are|was|were|with|this|that|these|those|she|he|they|we|you|his|her|their|our|your|but|from|have|has|had|it|its|my|would|could|should|will|there)\b/iu.test(
			text
		)
	);
}

/**
 * Normalize text for consistent processing
 */
function normalizeText(content: string): string {
	return content
		.normalize('NFKC') // normalize Unicode characters
		.replace(/\u200B|\uFEFF|\u2060/g, '') // strip zero-width chars
		.replace(/["“”«»„]/g, '"') // normalize quotes
		.replace(/['‘’‚‛]/g, "'")
		.replace(/—|–|‒/g, ' ') // replace dashes with spaces
		.replace(/…/g, '...') // normalize ellipsis
		.replace(/\s+/g, ' '); // collapse whitespace
}

/**
 * Protect abbreviations and decimals from sentence splitting
 * Uses NLP to detect abbreviations instead of hardcoded list
 */
function protectAbbreviations(text: string): string {
	const doc = nlp(text);

	const abbreviations = doc.abbreviations().out('array');

	// Also protect common titles and honorifics that NLP might miss
	const additionalAbbreviations = doc.match('#Honorific').out('array');
	const allAbbreviations = [...new Set([...abbreviations, ...additionalAbbreviations])];

	// Replace abbreviation periods with placeholders
	let protectedText = text;
	allAbbreviations.forEach((abbr) => {
		const pattern = new RegExp(`\\b${escapeRegExp(abbr)}`, 'gi');
		protectedText = protectedText.replace(pattern, abbr.replace(/\./g, '@@@'));
	});

	// Protect decimal numbers
	protectedText = protectedText.replace(/(\d)\.(\d)/g, '$1@@@$2');

	// Protect time formats (e.g., 3:30 p.m.)
	protectedText = protectedText.replace(
		/\b([0-9]{1,2}:[0-9]{2})\s*([ap])\.m\./gi,
		'$1 $2@@@m@@@'
	);

	return protectedText;
}

function restoreProtectedPeriods(text: string): string {
	return text.replace(/@@@/g, '.');
}

/**
 * Accurate word counting that handles:
 * - Numbers with commas/decimals (count as 1 word)
 * - Hyphenated words (split unless dictionary word)
 * - Smart quotes and dashes
 */
export function getAccurateWordCount(content: string): number {
	if (!content) return 0;
	const normalized = normalizeText(content);
	if (hasNonLatinLetters(normalized)) {
		let count = 0;
		for (const segment of wordSegmenter.segment(normalized)) if (segment.isWordLike) count++;
		return count;
	}
	return nlp(normalized).wordCount();
}

export function getAccurateSentenceCount(content: string): number {
	if (!content) return 0;

	const text = normalizeText(content);
	if (hasNonLatinLetters(text))
		return [...sentenceSegmenter.segment(text)].filter(
			({ segment }) => getAccurateWordCount(segment) > 0
		).length;
	const protectedText = protectAbbreviations(text);

	// Use Compromise's sentence detection
	const doc = nlp(protectedText);
	let sentenceCount = doc.sentences().length;

	// For texts without proper punctuation, also consider paragraph breaks
	if (sentenceCount === 0) {
		const lines = text.split('\n').filter((line) => line.trim().length > 0);
		sentenceCount = lines.filter((line) => getAccurateWordCount(line) > 0).length;
	}

	return sentenceCount;
}

export function getAccurateParagraphCount(content: string): number {
	if (!content) return 0;

	const paragraphs = content.split(/\n\s*\n|\n\t+/).filter((p) => {
		// A valid paragraph has at least one word
		const trimmed = p.trim();
		return trimmed.length > 0 && getAccurateWordCount(trimmed) > 0;
	});

	return paragraphs.length;
}

export function splitIntoSentences(content: string): string[] {
	if (!content) return [];

	// Use NLP for sentence splitting
	const text = normalizeText(content);
	const protectedText = protectAbbreviations(text);

	const doc = nlp(protectedText);
	const sentences = doc.sentences().out('array');

	// Restore protected periods in each sentence
	return sentences
		.map((s: string) => restoreProtectedPeriods(s).trim())
		.filter((s: string) => s.length > 0);
}

export interface WritingTextMetrics {
	wordCount: number;
	sentenceCount: number;
	paragraphCount: number;
	averageWordsPerSentence: number | null;
	averageWordsPerParagraph: number | null;
	readingTimeMinutes: number;
}

export function getWritingTextMetrics(content: string): WritingTextMetrics {
	const wordCount = getAccurateWordCount(content);
	const sentenceCount = getAccurateSentenceCount(content);
	const paragraphCount = getAccurateParagraphCount(content);

	return {
		wordCount,
		sentenceCount,
		paragraphCount,
		averageWordsPerSentence: sentenceCount > 0 ? wordCount / sentenceCount : null,
		averageWordsPerParagraph: paragraphCount > 0 ? wordCount / paragraphCount : null,
		readingTimeMinutes: Math.ceil(wordCount / 250), // Average adult reading speed
	};
}

export function getCharacterCount(content: string, includeSpaces: boolean = true): number {
	if (!content) return 0;

	const normalized = content.normalize('NFKC').replace(/\u200B|\uFEFF|\u2060/g, '');

	if (includeSpaces) {
		return normalized.length;
	} else {
		return normalized.replace(/\s/g, '').length;
	}
}

export function getWordFrequency(
	content: string,
	ignoreCommonWords: boolean = true
): Map<string, number> {
	if (!content) return new Map();

	const text = normalizeText(content);
	const doc = nlp(text);

	const frequency = new Map<string, number>();

	const terms = doc.terms().json();

	terms.forEach((term: { text: string; [key: string]: unknown }) => {
		const word = term.text.toLowerCase();

		// Skip if it's a common word and we're ignoring them
		if (ignoreCommonWords) {
			// Use NLP's built-in detection of stop words and common terms
			const termDoc = nlp(term.text);
			if (
				termDoc.has('#Determiner') ||
				termDoc.has('#Preposition') ||
				termDoc.has('#Conjunction') ||
				termDoc.has('#Pronoun') ||
				termDoc.has('#Auxiliary') ||
				['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'it'].includes(word)
			) {
				return;
			}
		}

		frequency.set(word, (frequency.get(word) || 0) + 1);
	});

	return new Map([...frequency.entries()].sort((a, b) => b[1] - a[1]));
}

export function splitIntoWords(text: string): string[] {
	if (!text) return [];

	const normalized = normalizeText(text);
	const doc = nlp(normalized);

	return doc.terms().out('array');
}

export function getWordPairs(input: string | string[]): Array<[string, string]> {
	const words = typeof input === 'string' ? splitIntoWords(input) : input;
	const pairs: Array<[string, string]> = [];

	for (let i = 0; i < words.length - 1; i++) {
		pairs.push([words[i], words[i + 1]]);
	}

	return pairs;
}

/**
 * Export a function that matches the old signature for backward compatibility
 */
export function countWords(text: string): number {
	return getAccurateWordCount(text);
}
