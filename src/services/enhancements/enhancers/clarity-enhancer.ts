import nlp from 'compromise';
import { MLWordClassifierPro } from '../../../analysis/ml-word-classifier-pro.js';
import { splitIntoSentences } from '../../../utils/text-metrics.js';
import type { Change, EnhancementOptions } from '../content-enhancer.js';

const FLOW_TRANSITIONS = [
	'However',
	'Meanwhile',
	'Furthermore',
	'Nevertheless',
	'Additionally',
] as const;

const REDUNDANT_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
	{ pattern: /\bin order to\b/g, replacement: 'to' },
	{ pattern: /\bdue to the fact that\b/g, replacement: 'because' },
	{ pattern: /\bat this point in time\b/g, replacement: 'now' },
	{ pattern: /\bfor the purpose of\b/g, replacement: 'to' },
	{ pattern: /\bin the event that\b/g, replacement: 'if' },
];

const SENTENCE_BREAK_POINTS = [' and ', ' but ', ' or ', ' so ', '; '] as const;

const COMBINATION_CONJUNCTIONS = ['and', 'but', 'while', 'as'] as const;

const SUBORDINATE_CONJUNCTIONS = [
	'although',
	'because',
	'since',
	'while',
	'whereas',
	'even though',
] as const;

const QUALIFIERS = ['very', 'quite', 'rather', 'somewhat', 'fairly', 'pretty', 'really'] as const;

const COMPLEX_TO_SIMPLE: Readonly<Record<string, string>> = {
	utilize: 'use',
	facilitate: 'help',
	demonstrate: 'show',
	implement: 'do',
	terminate: 'end',
	acquire: 'get',
	commence: 'start',
};

const SIMPLE_TO_COMPLEX: Readonly<Record<string, string>> = {
	big: 'substantial',
	small: 'minute',
	good: 'exemplary',
	bad: 'deplorable',
	nice: 'pleasant',
	said: 'articulated',
	went: 'proceeded',
};

const LESS_ESSENTIAL_ADJECTIVES = [
	'nice',
	'good',
	'bad',
	'big',
	'small',
	'pretty',
	'ugly',
] as const;

const NOUN_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
	person: ['man', 'woman', 'person', 'child', 'boy', 'girl', 'friend', 'stranger'],
	place: ['house', 'building', 'room', 'street', 'park', 'store', 'city', 'town'],
	vehicle: ['car', 'truck', 'bus', 'bicycle', 'motorcycle', 'train', 'plane'],
	object: ['table', 'chair', 'book', 'phone', 'computer', 'pen'],
};

const SUBORDINATE_CLAUSES: Readonly<Record<string, readonly string[]>> = {
	person: ['who was standing nearby', 'who seemed familiar'],
	house: ['which stood on the corner', 'that had been empty for years'],
	car: ['which was parked outside', 'that belonged to his neighbor'],
	default: ['which caught his attention', 'that seemed important'],
};

const COMMON_VERBS = ['is', 'was', 'are', 'were', 'have', 'has', 'had', 'will', 'would'] as const;
const VERB_ENDINGS = ['ed', 'ing', 'es', 's'] as const;

export class ClarityEnhancer {
	private classifier: MLWordClassifierPro;

	constructor(classifier: MLWordClassifierPro) {
		this.classifier = classifier;
	}

	improveFlow(content: string, changes: Change[]): string {
		const sentences = splitIntoSentences(content);
		const processedSentences: string[] = [];

		for (let i = 0; i < sentences.length; i++) {
			const sentence = sentences[i].trim();
			if (!sentence) {
				processedSentences.push(sentence);
				continue;
			}

			let modifiedSentence = sentence;
			const nextSentence = i < sentences.length - 1 ? sentences[i + 1].trim() : '';

			// Add transitions where needed
			if (nextSentence && this.needsTransition(sentence, nextSentence)) {
				const transition = this.selectTransition(sentence, nextSentence);
				if (transition) {
					changes.push({
						type: 'flow-improvement',
						original: sentence,
						replacement: sentence + ' ' + transition,
						reason: `Added transition "${transition}" to improve flow`,
						location: { start: 0, end: sentence.length },
					});
					modifiedSentence = sentence + ' ' + transition;
				}
			}

			processedSentences.push(modifiedSentence);
		}

		return processedSentences.join(' ');
	}

	condenseContent(
		content: string,
		changes: Change[],
		options: EnhancementOptions,
		targetLength?: number
	): string {
		const sentences = splitIntoSentences(content);
		const originalWordCount = content.split(/\s+/).length;
		const target = targetLength || Math.floor(originalWordCount * 0.8);

		let result = content;
		let currentWordCount = originalWordCount;

		// Remove redundant phrases
		result = this.removeRedundancy(result, changes);
		currentWordCount = result.split(/\s+/).length;

		// Combine sentences if still too long
		if (currentWordCount > target) {
			result = this.combineSentences(result, changes);
			currentWordCount = result.split(/\s+/).length;
		}

		// Remove less essential adjectives and adverbs
		if (currentWordCount > target && options.aggressiveness !== 'light') {
			result = this.removeNonEssentialModifiers(result, changes);
		}

		return result;
	}

	fixPacing(content: string, changes: Change[], options: EnhancementOptions): string {
		const sentences = splitIntoSentences(content);
		const processedSentences: string[] = [];

		for (let i = 0; i < sentences.length; i++) {
			const sentence = sentences[i].trim();
			if (!sentence) {
				processedSentences.push(sentence);
				continue;
			}

			const wordCount = sentence.split(/\s+/).length;
			let modifiedSentence = sentence;

			// Handle overly long sentences (slow pacing)
			if (wordCount > 25) {
				const broken = this.breakLongSentence(sentence);
				if (broken !== sentence) {
					changes.push({
						type: 'pacing-fix',
						original: sentence,
						replacement: broken,
						reason: 'Broke long sentence to improve pacing',
						location: { start: 0, end: sentence.length },
					});
					modifiedSentence = broken;
				}
			}

			// Handle overly short sentences in sequence (choppy pacing)
			if (wordCount < 6 && i > 0) {
				const prevSentence = sentences[i - 1].trim();
				const prevWordCount = prevSentence.split(/\s+/).length;

				if (prevWordCount < 8 && this.canCombineSentences(prevSentence, sentence)) {
					// We'll handle this when processing the previous sentence
					continue;
				}
			}

			processedSentences.push(modifiedSentence);
		}

		return processedSentences.join(' ');
	}

	simplifySentences(content: string, changes: Change[]): string {
		const sentences = splitIntoSentences(content);
		const processedSentences: string[] = [];

		for (const sentence of sentences) {
			if (!sentence.trim()) {
				processedSentences.push(sentence);
				continue;
			}

			let simplified = sentence;

			// Break compound sentences
			simplified = this.breakCompoundSentences(simplified, changes);

			// Simplify vocabulary
			simplified = this.simplifyVocabulary(simplified, changes);

			// Remove unnecessary qualifiers
			simplified = this.removeQualifiers(simplified, changes);

			processedSentences.push(simplified);
		}

		return processedSentences.join(' ');
	}

	complexifySentences(content: string, changes: Change[]): string {
		const sentences = splitIntoSentences(content);
		const processedSentences: string[] = [];

		for (let i = 0; i < sentences.length; i++) {
			const sentence = sentences[i].trim();
			if (!sentence) {
				processedSentences.push(sentence);
				continue;
			}

			let complex = sentence;
			const nextSentence = i < sentences.length - 1 ? sentences[i + 1].trim() : '';

			// Combine related short sentences
			if (
				sentence.split(/\s+/).length < 12 &&
				nextSentence &&
				nextSentence.split(/\s+/).length < 12
			) {
				const combined = this.combineSentencesComplex(sentence, nextSentence);
				if (combined && combined !== sentence + ' ' + nextSentence) {
					changes.push({
						type: 'complexity-increase',
						original: sentence + ' ' + nextSentence,
						replacement: combined,
						reason: 'Combined sentences to increase complexity',
						location: { start: 0, end: (sentence + ' ' + nextSentence).length },
					});
					processedSentences.push(combined);
					i++; // Skip next sentence as it's been combined
					continue;
				}
			}

			// Add sophisticated vocabulary
			complex = this.enhanceVocabulary(complex, changes);

			// Add subordinate clauses
			complex = this.addSubordinateClauses(complex, changes);

			processedSentences.push(complex);
		}

		return processedSentences.join(' ');
	}

	convertTense(content: string, tense: string, changes: Change[]): string {
		const words = content.split(/\s+/);
		const processedWords: string[] = [];

		for (let i = 0; i < words.length; i++) {
			const word = words[i].toLowerCase().replace(/[^\w]/g, '');

			if (this.isVerbPattern(word, words, i)) {
				const converted = this.applyTenseConversion(word, tense);
				if (converted !== word) {
					const original = words[i];
					const replacement = original.replace(word, converted);
					changes.push({
						type: 'tense-conversion',
						original,
						replacement,
						reason: `Converted verb to ${tense} tense`,
						location: { start: i, end: i + 1 },
					});
					processedWords.push(replacement);
				} else {
					processedWords.push(words[i]);
				}
			} else {
				processedWords.push(words[i]);
			}
		}

		return processedWords.join(' ');
	}

	private needsTransition(sentence1: string, sentence2: string): boolean {
		const topicShift = this.detectTopicShift(sentence1, sentence2);
		return topicShift > 0.6;
	}

	private detectTopicShift(sentence1: string, sentence2: string): number {
		const words1 = new Set(
			sentence1
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 3)
		);
		const words2 = new Set(
			sentence2
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 3)
		);

		const intersection = new Set([...words1].filter((x) => words2.has(x)));
		const union = new Set([...words1, ...words2]);

		if (union.size === 0) return 1;
		return 1 - intersection.size / union.size;
	}

	private selectTransition(sentence1: string, sentence2: string): string {
		return FLOW_TRANSITIONS[Math.floor(Math.random() * FLOW_TRANSITIONS.length)];
	}

	private removeRedundancy(content: string, changes: Change[]): string {
		let result = content;
		for (const { pattern, replacement } of REDUNDANT_PATTERNS) {
			const matches = result.match(pattern);
			if (matches) {
				changes.push({
					type: 'redundancy-removal',
					original: matches[0],
					replacement,
					reason: `Simplified redundant phrase`,
					location: { start: 0, end: matches[0].length },
				});
				result = result.replace(pattern, replacement);
			}
		}

		return result;
	}

	private combineSentences(content: string, changes: Change[]): string {
		const sentences = splitIntoSentences(content);
		const result: string[] = [];

		for (let i = 0; i < sentences.length; i++) {
			const current = sentences[i].trim();
			const next = i < sentences.length - 1 ? sentences[i + 1].trim() : '';

			if (current && next && this.canCombineSentences(current, next)) {
				const combined = this.combineTwoSentences(current, next);
				changes.push({
					type: 'sentence-combination',
					original: current + ' ' + next,
					replacement: combined,
					reason: 'Combined related sentences',
					location: { start: 0, end: (current + ' ' + next).length },
				});
				result.push(combined);
				i++; // Skip next sentence
			} else if (current) {
				result.push(current);
			}
		}

		return result.join(' ');
	}

	private removeNonEssentialModifiers(content: string, changes: Change[]): string {
		const doc = nlp(content);
		let result = content;

		// Remove excessive adjectives (keep only the most important ones)
		const adjectives = doc.adjectives().json();
		const lessImportant = adjectives.filter((adj: any) =>
			this.isLessEssentialAdjective(adj.text)
		);

		for (const adj of lessImportant) {
			const regex = new RegExp(`\\b${adj.text}\\s+`, 'gi');
			if (regex.test(result)) {
				changes.push({
					type: 'modifier-removal',
					original: adj.text,
					replacement: '',
					reason: 'Removed non-essential adjective for brevity',
					location: { start: 0, end: adj.text.length },
				});
				result = result.replace(regex, '');
			}
		}

		return result;
	}

	private breakLongSentence(sentence: string): string {
		for (const breakPoint of SENTENCE_BREAK_POINTS) {
			const index = sentence.indexOf(breakPoint);
			if (index > 10 && index < sentence.length - 10) {
				const part1 = sentence.substring(0, index).trim();
				const part2 = sentence.substring(index + breakPoint.length).trim();

				if (part2) {
					return part1 + '. ' + part2.charAt(0).toUpperCase() + part2.slice(1);
				}
			}
		}

		return sentence;
	}

	private canCombineSentences(sentence1: string, sentence2: string): boolean {
		// Check if sentences are related and can be combined
		const words1 = new Set(
			sentence1
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 3)
		);
		const words2 = new Set(
			sentence2
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 3)
		);

		const intersection = new Set([...words1].filter((x) => words2.has(x)));
		const similarity = intersection.size / Math.max(words1.size, words2.size);

		return similarity > 0.3; // 30% word overlap suggests relation
	}

	private combineTwoSentences(sentence1: string, sentence2: string): string {
		const conjunction =
			COMBINATION_CONJUNCTIONS[Math.floor(Math.random() * COMBINATION_CONJUNCTIONS.length)];

		return sentence1.replace(/\.$/, '') + ' ' + conjunction + ' ' + sentence2.toLowerCase();
	}

	private breakCompoundSentences(sentence: string, changes: Change[]): string {
		// Similar to breakLongSentence but specifically for compound structures
		return this.breakLongSentence(sentence);
	}

	private simplifyVocabulary(sentence: string, changes: Change[]): string {
		let result = sentence;
		for (const [complex, simple] of Object.entries(COMPLEX_TO_SIMPLE)) {
			const regex = new RegExp(`\\b${complex}\\b`, 'gi');
			if (regex.test(result)) {
				changes.push({
					type: 'vocabulary-simplification',
					original: complex,
					replacement: simple,
					reason: `Simplified complex word "${complex}" to "${simple}"`,
					location: { start: 0, end: complex.length },
				});
				result = result.replace(regex, simple);
			}
		}

		return result;
	}

	private removeQualifiers(sentence: string, changes: Change[]): string {
		let result = sentence;

		for (const qualifier of QUALIFIERS) {
			const regex = new RegExp(`\\b${qualifier}\\s+`, 'gi');
			const matches = result.match(regex);
			if (matches) {
				changes.push({
					type: 'qualifier-removal',
					original: matches[0],
					replacement: '',
					reason: `Removed qualifier "${qualifier}" for directness`,
					location: { start: 0, end: matches[0].length },
				});
				result = result.replace(regex, '');
			}
		}

		return result;
	}

	private combineSentencesComplex(sentence1: string, sentence2: string): string | null {
		const conjunction =
			SUBORDINATE_CONJUNCTIONS[Math.floor(Math.random() * SUBORDINATE_CONJUNCTIONS.length)];
		return (
			conjunction.charAt(0).toUpperCase() +
			conjunction.slice(1) +
			' ' +
			sentence1.toLowerCase().replace(/\.$/, '') +
			', ' +
			sentence2.toLowerCase()
		);
	}

	private enhanceVocabulary(sentence: string, changes: Change[]): string {
		let result = sentence;
		for (const [simple, complex] of Object.entries(SIMPLE_TO_COMPLEX)) {
			const regex = new RegExp(`\\b${simple}\\b`, 'gi');
			if (regex.test(result)) {
				changes.push({
					type: 'vocabulary-enhancement',
					original: simple,
					replacement: complex,
					reason: `Enhanced vocabulary: "${simple}" to "${complex}"`,
					location: { start: 0, end: simple.length },
				});
				result = result.replace(regex, complex);
			}
		}

		return result;
	}

	private addSubordinateClauses(sentence: string, changes: Change[]): string {
		// Add descriptive subordinate clauses where appropriate
		const doc = nlp(sentence);
		const nouns = doc.nouns().json();

		if (nouns.length > 0 && sentence.split(/\s+/).length < 15) {
			const noun = nouns[0];
			const clause = this.generateSubordinateClause(noun.text);
			if (clause) {
				const enhanced = sentence.replace(noun.text, `${noun.text}, ${clause},`);
				changes.push({
					type: 'complexity-addition',
					original: sentence,
					replacement: enhanced,
					reason: 'Added subordinate clause for complexity',
					location: { start: 0, end: sentence.length },
				});
				return enhanced;
			}
		}

		return sentence;
	}

	private generateSubordinateClause(noun: string): string | null {
		const nounType = this.categorizeNoun(noun);
		const options = SUBORDINATE_CLAUSES[nounType] || SUBORDINATE_CLAUSES.default;
		return options[Math.floor(Math.random() * options.length)];
	}

	private categorizeNoun(noun: string): string {
		const doc = nlp(noun);
		if (doc.has('#Person')) return 'person';
		if (doc.has('#Place')) return 'place';
		if (doc.has('#Organization')) return 'organization';
		if (doc.has('#Date')) return 'time';

		for (const [category, words] of Object.entries(NOUN_CATEGORIES)) {
			if (words.includes(noun.toLowerCase())) {
				return category;
			}
		}
		return 'default';
	}

	private isLessEssentialAdjective(adjective: string): boolean {
		return (LESS_ESSENTIAL_ADJECTIVES as readonly string[]).includes(adjective.toLowerCase());
	}

	private isVerbPattern(word: string, words: string[], index: number): boolean {
		return (
			(COMMON_VERBS as readonly string[]).includes(word) ||
			VERB_ENDINGS.some((ending) => word.endsWith(ending))
		);
	}

	private applyTenseConversion(word: string, targetTense: string): string {
		const doc = nlp(word);
		const verb = doc.verbs();

		if (verb.found) {
			if (targetTense === 'past') {
				verb.toPastTense();
			} else if (targetTense === 'present') {
				verb.toPresentTense();
			} else if (targetTense === 'future') {
				verb.toFutureTense();
			}
			return verb.text();
		}

		return word;
	}
}
