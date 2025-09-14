/**
 * Unified text metrics utilities for accurate word, sentence, and paragraph counting
 * Handles Unicode, contractions, acronyms, and special characters properly
 */

import nlp from 'compromise';

/**
 * Normalize text for consistent processing
 */
function normalizeText(content: string): string {
	return content
		.normalize('NFKC') // normalize Unicode characters
		.replace(/\u200B|\uFEFF|\u2060/g, '') // strip zero-width chars
		.replace(/[""«»„]/g, '"') // normalize quotes
		.replace(/[''‚‛]/g, "'")
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

	// Get all abbreviations from the text
	const abbreviations = doc.abbreviations().out('array');

	// Also protect common titles and honorifics that NLP might miss
	const additionalAbbreviations = doc.match('#Honorific').out('array');
	const allAbbreviations = [...new Set([...abbreviations, ...additionalAbbreviations])];

	// Replace abbreviation periods with placeholders
	let protectedText = text;
	allAbbreviations.forEach((abbr) => {
		// Remove the period for the placeholder
		const pattern = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
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

/**
 * Restore protected periods
 */
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

	// Use NLP for more accurate word counting
	const text = normalizeText(content);
	const doc = nlp(text);

	// Get word count from NLP (handles contractions, possessives, etc. properly)
	let wordCount = doc.wordCount();

	// Adjust for acronyms that NLP might split
	const acronyms = doc.acronyms().out('array');
	wordCount =
		wordCount -
		acronyms.reduce((count: number, acronym: string) => {
			// If NLP counted an acronym as multiple words (e.g., "U.S.A." as 3), adjust
			const dots = (acronym.match(/\./g) || []).length;
			return count + Math.max(0, dots - 1);
		}, 0);

	return wordCount;
}

/**
 * Count sentences accurately
 * Handles abbreviations, decimals, and dialogue
 */
export function getAccurateSentenceCount(content: string): number {
	if (!content) return 0;

	// Use NLP for sentence detection
	const text = normalizeText(content);
	const protectedText = protectAbbreviations(text);

	// Use Compromise's sentence detection
	const doc = nlp(protectedText);
	let sentenceCount = doc.sentences().length;

	// For texts without proper punctuation, also consider paragraph breaks
	if (sentenceCount === 0) {
		const lines = text.split('\n').filter((line) => line.trim().length > 0);
		sentenceCount = lines.filter((line) => getAccurateWordCount(line) > 0).length;
	}

	return Math.max(1, sentenceCount); // At least 1 sentence if there's content
}

/**
 * Count paragraphs accurately
 * A paragraph is text separated by blank lines or indentation
 */
export function getAccurateParagraphCount(content: string): number {
	if (!content) return 0;

	// Split on multiple newlines or tab-indented lines
	const paragraphs = content.split(/\n\s*\n|\n\t+/).filter((p) => {
		// A valid paragraph has at least one word
		const trimmed = p.trim();
		return trimmed.length > 0 && getAccurateWordCount(trimmed) > 0;
	});

	return paragraphs.length || 1; // At least 1 paragraph if there's content
}

/**
 * Split text into sentences (returns array of sentences)
 */
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

/**
 * Get comprehensive text metrics
 */
export interface TextMetrics {
	wordCount: number;
	sentenceCount: number;
	paragraphCount: number;
	averageWordsPerSentence: number;
	averageWordsPerParagraph: number;
	readingTimeMinutes: number;
}

export function getTextMetrics(content: string): TextMetrics {
	const wordCount = getAccurateWordCount(content);
	const sentenceCount = getAccurateSentenceCount(content);
	const paragraphCount = getAccurateParagraphCount(content);

	return {
		wordCount,
		sentenceCount,
		paragraphCount,
		averageWordsPerSentence: sentenceCount > 0 ? wordCount / sentenceCount : 0,
		averageWordsPerParagraph: paragraphCount > 0 ? wordCount / paragraphCount : 0,
		readingTimeMinutes: Math.ceil(wordCount / 250), // Average adult reading speed
	};
}

/**
 * Calculate character count (with and without spaces)
 */
export function getCharacterCount(content: string, includeSpaces: boolean = true): number {
	if (!content) return 0;

	const normalized = content.normalize('NFKC').replace(/\u200B|\uFEFF|\u2060/g, '');

	if (includeSpaces) {
		return normalized.length;
	} else {
		return normalized.replace(/\s/g, '').length;
	}
}

/**
 * Get word frequency map
 * Uses NLP to identify stop words and common words
 */
export function getWordFrequency(
	content: string,
	ignoreCommonWords: boolean = true
): Map<string, number> {
	if (!content) return new Map();

	const text = normalizeText(content);
	const doc = nlp(text);

	const frequency = new Map<string, number>();

	// Get all terms from the document
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
				// Check if it's a very common word based on frequency
				['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'it'].includes(word)
			) {
				return;
			}
		}

		frequency.set(word, (frequency.get(word) || 0) + 1);
	});

	// Sort by frequency
	return new Map([...frequency.entries()].sort((a, b) => b[1] - a[1]));
}

/**
 * Split text into words
 */
export function splitIntoWords(text: string): string[] {
	if (!text) return [];

	const normalized = normalizeText(text);
	const doc = nlp(normalized);

	// Get words as array from NLP
	return doc.terms().out('array');
}

/**
 * Get word pairs (bigrams) from text or word array
 */
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
