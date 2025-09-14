/**
 * Advanced NLP-based sentiment analyzer using Compromise.js
 * Fixes context issues like "unhappy" triggering as joy and "enjoying misery" double-counting
 */

import nlp from 'compromise';
// Note: compromise-sentiment doesn't exist as a separate package
// Using compromise's built-in features instead
import { getLogger } from '../../core/logger.js';

const _logger = getLogger('nlp-sentiment-analyzer');

export interface SentimentResult {
	score: number; // -1 to 1
	comparative: number; // normalized score
	emotion: string;
	confidence: number;
	tokens: TokenAnalysis[];
	negations: NegationContext[];
	context: string;
}

export interface TokenAnalysis {
	word: string;
	pos: string; // part of speech
	sentiment: number;
	negated: boolean;
	intensifier?: string;
}

export interface NegationContext {
	negator: string;
	scope: string[];
	originalSentiment: string;
	invertedSentiment: string;
}

export interface EmotionVector {
	joy: number;
	sadness: number;
	anger: number;
	fear: number;
	surprise: number;
	disgust: number;
	trust: number;
	anticipation: number;
}

export class NLPSentimentAnalyzer {
	private readonly negationWords = new Set([
		'not',
		'no',
		'never',
		'neither',
		'nor',
		'none',
		'nobody',
		'nothing',
		'nowhere',
		'hardly',
		'scarcely',
		'barely',
		'rarely',
		'seldom',
		"doesn't",
		"don't",
		"didn't",
		"won't",
		"wouldn't",
		"shouldn't",
		"couldn't",
		"can't",
		'cannot',
		"isn't",
		"aren't",
		"wasn't",
		"weren't",
		"hasn't",
		"haven't",
		"hadn't",
		'without',
		'lacking',
		'absent',
	]);

	private readonly intensifiers = {
		amplifiers: new Set([
			'very',
			'extremely',
			'absolutely',
			'completely',
			'totally',
			'utterly',
			'quite',
			'really',
			'so',
			'too',
			'exceptionally',
			'remarkably',
		]),
		diminishers: new Set([
			'slightly',
			'somewhat',
			'rather',
			'fairly',
			'a bit',
			'a little',
			'moderately',
			'mildly',
			'hardly',
			'barely',
			'scarcely',
		]),
	};

	// Emotion lexicons with context-aware patterns
	private readonly emotionLexicon: Record<string, EmotionVector> = {
		// Joy (positive valence, high arousal)
		happy: {
			joy: 0.9,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0.1,
			disgust: 0,
			trust: 0.3,
			anticipation: 0.2,
		},
		unhappy: {
			joy: 0,
			sadness: 0.8,
			anger: 0.2,
			fear: 0,
			surprise: 0,
			disgust: 0,
			trust: -0.2,
			anticipation: -0.1,
		},
		joy: {
			joy: 1.0,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0.2,
			disgust: 0,
			trust: 0.4,
			anticipation: 0.3,
		},
		joyful: {
			joy: 0.95,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0.15,
			disgust: 0,
			trust: 0.35,
			anticipation: 0.25,
		},
		enjoying: {
			joy: 0.7,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0,
			disgust: 0,
			trust: 0.3,
			anticipation: 0.4,
		},
		delighted: {
			joy: 0.85,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0.3,
			disgust: 0,
			trust: 0.25,
			anticipation: 0.2,
		},
		pleased: {
			joy: 0.6,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0,
			disgust: 0,
			trust: 0.4,
			anticipation: 0.1,
		},
		cheerful: {
			joy: 0.75,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0,
			disgust: 0,
			trust: 0.35,
			anticipation: 0.15,
		},
		ecstatic: {
			joy: 1.0,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0.4,
			disgust: 0,
			trust: 0.2,
			anticipation: 0.1,
		},

		// Sadness (negative valence, low arousal)
		sad: {
			joy: 0,
			sadness: 0.9,
			anger: 0,
			fear: 0.1,
			surprise: 0,
			disgust: 0,
			trust: -0.1,
			anticipation: -0.2,
		},
		misery: {
			joy: 0,
			sadness: 1.0,
			anger: 0.2,
			fear: 0.3,
			surprise: 0,
			disgust: 0.1,
			trust: -0.4,
			anticipation: -0.3,
		},
		miserable: {
			joy: 0,
			sadness: 0.95,
			anger: 0.15,
			fear: 0.25,
			surprise: 0,
			disgust: 0.05,
			trust: -0.35,
			anticipation: -0.25,
		},
		depressed: {
			joy: 0,
			sadness: 0.9,
			anger: 0.1,
			fear: 0.2,
			surprise: 0,
			disgust: 0,
			trust: -0.3,
			anticipation: -0.4,
		},
		grief: {
			joy: 0,
			sadness: 1.0,
			anger: 0.1,
			fear: 0.1,
			surprise: 0,
			disgust: 0,
			trust: -0.2,
			anticipation: -0.3,
		},
		sorrow: {
			joy: 0,
			sadness: 0.85,
			anger: 0,
			fear: 0.05,
			surprise: 0,
			disgust: 0,
			trust: -0.15,
			anticipation: -0.2,
		},
		melancholy: {
			joy: 0,
			sadness: 0.7,
			anger: 0,
			fear: 0,
			surprise: 0,
			disgust: 0,
			trust: -0.1,
			anticipation: -0.15,
		},

		// Anger (negative valence, high arousal)
		angry: {
			joy: 0,
			sadness: 0.1,
			anger: 0.9,
			fear: 0,
			surprise: 0.1,
			disgust: 0.2,
			trust: -0.5,
			anticipation: 0.1,
		},
		furious: {
			joy: 0,
			sadness: 0,
			anger: 1.0,
			fear: 0,
			surprise: 0.2,
			disgust: 0.3,
			trust: -0.6,
			anticipation: 0,
		},
		rage: {
			joy: 0,
			sadness: 0,
			anger: 1.0,
			fear: 0.1,
			surprise: 0.1,
			disgust: 0.2,
			trust: -0.7,
			anticipation: 0,
		},
		irritated: {
			joy: 0,
			sadness: 0,
			anger: 0.5,
			fear: 0,
			surprise: 0,
			disgust: 0.2,
			trust: -0.3,
			anticipation: 0,
		},
		annoyed: {
			joy: 0,
			sadness: 0,
			anger: 0.4,
			fear: 0,
			surprise: 0,
			disgust: 0.15,
			trust: -0.25,
			anticipation: 0,
		},

		// Fear (negative valence, variable arousal)
		afraid: {
			joy: 0,
			sadness: 0.2,
			anger: 0,
			fear: 0.9,
			surprise: 0.3,
			disgust: 0,
			trust: -0.4,
			anticipation: 0.5,
		},
		scared: {
			joy: 0,
			sadness: 0.15,
			anger: 0,
			fear: 0.85,
			surprise: 0.35,
			disgust: 0,
			trust: -0.35,
			anticipation: 0.4,
		},
		terrified: {
			joy: 0,
			sadness: 0.1,
			anger: 0,
			fear: 1.0,
			surprise: 0.4,
			disgust: 0.1,
			trust: -0.5,
			anticipation: 0.3,
		},
		anxious: {
			joy: 0,
			sadness: 0.3,
			anger: 0.1,
			fear: 0.7,
			surprise: 0,
			disgust: 0,
			trust: -0.3,
			anticipation: 0.6,
		},
		worried: {
			joy: 0,
			sadness: 0.4,
			anger: 0,
			fear: 0.6,
			surprise: 0,
			disgust: 0,
			trust: -0.2,
			anticipation: 0.5,
		},
	};

	/**
	 * Analyzes sentiment with full context awareness
	 */
	analyzeSentiment(text: string): SentimentResult {
		const doc = nlp(text);
		const sentences = doc.sentences().out('array');

		let totalScore = 0;
		let tokenCount = 0;
		const tokens: TokenAnalysis[] = [];
		const negations: NegationContext[] = [];
		const emotionTotals: EmotionVector = {
			joy: 0,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0,
			disgust: 0,
			trust: 0,
			anticipation: 0,
		};

		// Process each sentence for context
		sentences.forEach((sentence: string) => {
			const sentenceDoc = nlp(sentence);
			const sentenceTokens = this.analyzeSentenceWithContext(sentenceDoc as any);

			sentenceTokens.forEach((token) => {
				tokens.push(token);
				totalScore += token.sentiment;
				tokenCount++;

				// Update emotion vectors
				const emotionVec = this.getEmotionVector(token.word, token.negated);
				Object.keys(emotionTotals).forEach((emotion) => {
					emotionTotals[emotion as keyof EmotionVector] +=
						emotionVec[emotion as keyof EmotionVector];
				});
			});

			// Detect negation contexts
			const negationContexts = this.detectNegationContexts(sentenceDoc as any);
			negations.push(...negationContexts);
		});

		const comparative = tokenCount > 0 ? totalScore / tokenCount : 0;
		const dominantEmotion = this.getDominantEmotion(emotionTotals);
		const confidence = this.calculateConfidence(tokens, negations);

		return {
			score: totalScore,
			comparative,
			emotion: dominantEmotion,
			confidence,
			tokens,
			negations,
			context: this.determineContext(text, emotionTotals),
		};
	}

	/**
	 * Analyzes a sentence with full grammatical context
	 */
	private analyzeSentenceWithContext(doc: { 
		terms: () => { out: (format: string) => string[] };
		words?: () => { text: () => string; has: (tag: string) => boolean }[];
	}): TokenAnalysis[] {
		const tokens: TokenAnalysis[] = [];
		const terms = doc.terms().out('array');
		const posTags = doc.terms().out('tags');

		for (let i = 0; i < terms.length; i++) {
			const word = terms[i].toLowerCase();
			const tagData = posTags[i];
			const pos = typeof tagData === 'string' ? tagData : this.extractPOSTag(Array.isArray(tagData) ? tagData : []);

			// Check for negation scope
			const negated = doc.words ? this.isInNegationScope(doc as any, i) : false;

			// Check for intensifiers
			const intensifierType = doc.words ? this.getIntensifier(doc as any, i) : undefined;

			// Calculate sentiment
			let sentiment = this.getWordSentiment(word, pos, negated);

			// Apply intensifier
			if (intensifierType) {
				sentiment = this.applyIntensifier(sentiment, intensifierType);
			}

			tokens.push({
				word,
				pos,
				sentiment,
				negated,
				intensifier: intensifierType || undefined,
			});
		}

		return tokens;
	}

	/**
	 * Detects if a word is within negation scope
	 */
	private isInNegationScope(
		doc: { words(): { text(): string; has(tag: string): boolean }[] },
		wordIndex: number
	): boolean {
		const terms = (doc as any).terms().out('array');
		const windowSize = 3; // Look back 3 words for negation

		for (let i = Math.max(0, wordIndex - windowSize); i < wordIndex; i++) {
			if (this.negationWords.has(terms[i].toLowerCase())) {
				// Check if there's a clause boundary between negation and target
				const between = terms.slice(i + 1, wordIndex).join(' ');
				if (!between.match(/[,;.!?]|but|however|although/)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Gets intensifier for a word
	 */
	private getIntensifier(
		doc: { words(): { text(): string; has(tag: string): boolean }[] },
		wordIndex: number
	): string | undefined {
		const terms = (doc as any).terms().out('array');

		if (wordIndex > 0) {
			const prevWord = terms[wordIndex - 1].toLowerCase();
			if (this.intensifiers.amplifiers.has(prevWord)) {
				return 'amplifier';
			}
			if (this.intensifiers.diminishers.has(prevWord)) {
				return 'diminisher';
			}
		}

		return undefined;
	}

	/**
	 * Applies intensifier effect to sentiment
	 */
	private applyIntensifier(sentiment: number, intensifier: string): number {
		if (intensifier === 'amplifier') {
			return sentiment * 1.5;
		} else if (intensifier === 'diminisher') {
			return sentiment * 0.5;
		}
		return sentiment;
	}

	/**
	 * Gets sentiment score for a word considering POS and negation
	 */
	private getWordSentiment(word: string, pos: string, negated: boolean): number {
		const emotionVec = this.emotionLexicon[word];
		if (!emotionVec) return 0;

		// Adjust sentiment based on part-of-speech
		let posMultiplier = 1.0;
		if (pos.startsWith('JJ')) posMultiplier = 1.2; // Adjectives are more emotionally charged
		else if (pos.startsWith('RB')) posMultiplier = 1.1; // Adverbs modify intensity
		else if (pos.startsWith('VB')) posMultiplier = 0.9; // Verbs are less emotionally direct
		else if (pos.startsWith('NN')) posMultiplier = 0.8; // Nouns are typically neutral

		// Calculate valence from emotion vector
		const positiveEmotions = emotionVec.joy + emotionVec.trust + emotionVec.anticipation;
		const negativeEmotions =
			emotionVec.sadness + emotionVec.anger + emotionVec.fear + emotionVec.disgust;

		let sentiment = (positiveEmotions - negativeEmotions) * posMultiplier;

		// Apply negation
		if (negated) {
			sentiment = -sentiment * 0.8; // Slightly reduce magnitude for negated sentiments
		}

		return sentiment;
	}

	/**
	 * Gets emotion vector for a word
	 */
	private getEmotionVector(word: string, negated: boolean): EmotionVector {
		let vec = this.emotionLexicon[word] || {
			joy: 0,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0,
			disgust: 0,
			trust: 0,
			anticipation: 0,
		};

		if (negated) {
			// Invert emotions for negated context
			vec = {
				joy: vec.sadness * 0.8,
				sadness: vec.joy * 0.8,
				anger: vec.anger * 0.5, // Anger doesn't fully invert
				fear: vec.fear * 0.7,
				surprise: vec.surprise * 1.2, // Negation can increase surprise
				disgust: vec.disgust * 0.6,
				trust: -vec.trust,
				anticipation: -vec.anticipation,
			};
		}

		return vec;
	}

	/**
	 * Detects negation contexts in a sentence
	 */
	private detectNegationContexts(doc: { match: (pattern: string) => { out: (format: string) => Array<{ text: string; offset: { start: number } }> } }): NegationContext[] {
		const contexts: NegationContext[] = [];
		const terms = (doc as any).terms().out('array');

		for (let i = 0; i < terms.length; i++) {
			const word = terms[i].toLowerCase();
			if (this.negationWords.has(word)) {
				const scope = this.getNegationScope(terms, i);
				const originalSentiment = this.getScopeEmotion(scope, false);
				const invertedSentiment = this.getScopeEmotion(scope, true);

				contexts.push({
					negator: word,
					scope,
					originalSentiment,
					invertedSentiment,
				});
			}
		}

		return contexts;
	}

	/**
	 * Gets the scope of a negation word
	 */
	private getNegationScope(terms: string[], negationIndex: number): string[] {
		const scope: string[] = [];
		const maxScope = 4; // Maximum words affected by negation

		for (
			let i = negationIndex + 1;
			i < Math.min(terms.length, negationIndex + maxScope + 1);
			i++
		) {
			const word = terms[i];
			// Stop at clause boundaries
			if (word.match(/[,;.!?]|but|however|although/)) {
				break;
			}
			scope.push(word);
		}

		return scope;
	}

	/**
	 * Gets emotion for a scope of words
	 */
	private getScopeEmotion(scope: string[], negated: boolean): string {
		const emotionTotals: EmotionVector = {
			joy: 0,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0,
			disgust: 0,
			trust: 0,
			anticipation: 0,
		};

		scope.forEach((word) => {
			const vec = this.getEmotionVector(word.toLowerCase(), negated);
			Object.keys(emotionTotals).forEach((emotion) => {
				emotionTotals[emotion as keyof EmotionVector] +=
					vec[emotion as keyof EmotionVector];
			});
		});

		return this.getDominantEmotion(emotionTotals);
	}

	/**
	 * Gets dominant emotion from emotion vector
	 */
	private getDominantEmotion(emotions: EmotionVector): string {
		let maxEmotion = 'neutral';
		let maxValue = 0;

		Object.entries(emotions).forEach(([emotion, value]) => {
			if (Math.abs(value) > Math.abs(maxValue)) {
				maxValue = value;
				maxEmotion = emotion;
			}
		});

		// If all emotions are low, return neutral
		if (Math.abs(maxValue) < 0.1) {
			return 'neutral';
		}

		return maxEmotion;
	}

	/**
	 * Calculates confidence in sentiment analysis
	 */
	private calculateConfidence(tokens: TokenAnalysis[], negations: NegationContext[]): number {
		// Base confidence on number of recognized emotion words
		const emotionWords = tokens.filter((t) => Math.abs(t.sentiment) > 0).length;
		const totalWords = tokens.length;

		let confidence = Math.min(1.0, emotionWords / (totalWords * 0.1));

		// Reduce confidence for complex negation contexts
		confidence -= negations.length * 0.05;

		// Reduce confidence for mixed sentiments
		const posTokens = tokens.filter((t) => t.sentiment > 0).length;
		const negTokens = tokens.filter((t) => t.sentiment < 0).length;
		if (posTokens > 0 && negTokens > 0) {
			const balance = Math.min(posTokens, negTokens) / Math.max(posTokens, negTokens);
			confidence *= 1 - balance * 0.3;
		}

		return Math.max(0.1, Math.min(1.0, confidence));
	}

	/**
	 * Determines overall context of the text
	 */
	private determineContext(text: string, emotions: EmotionVector): string {
		const doc = nlp(text);

		// Check for specific contexts
		if (doc.has('#Question')) return 'interrogative';
		if (doc.has('#Imperative')) return 'imperative';
		if (doc.has('#Conditional')) return 'conditional';

		// Check emotional context
		const dominantEmotion = this.getDominantEmotion(emotions);
		const totalEmotionStrength = Object.values(emotions).reduce(
			(a, b) => Math.abs(a) + Math.abs(b),
			0
		);

		if (totalEmotionStrength < 0.5) return 'neutral';
		if (dominantEmotion === 'joy' || dominantEmotion === 'trust') return 'positive';
		if (dominantEmotion === 'sadness' || dominantEmotion === 'fear') return 'negative';
		if (dominantEmotion === 'anger' || dominantEmotion === 'disgust') return 'hostile';

		return 'mixed';
	}

	/**
	 * Extracts POS tag from Compromise tags
	 */
	private extractPOSTag(tags: string[] | Record<string, boolean>): string {
		if (!tags) return 'Unknown';

		// Convert Compromise tags to standard POS tags
		if ((tags as any).Noun) return 'Noun';
		if ((tags as any).Verb) return 'Verb';
		if ((tags as any).Adjective) return 'Adjective';
		if ((tags as any).Adverb) return 'Adverb';
		if ((tags as any).Pronoun) return 'Pronoun';
		if ((tags as any).Preposition) return 'Preposition';
		if ((tags as any).Conjunction) return 'Conjunction';
		if ((tags as any).Determiner) return 'Determiner';

		return 'Other';
	}

	/**
	 * Analyzes emotional arc with proper context
	 */
	analyzeEmotionalArc(
		text: string,
		segments: number = 10
	): Array<{
		position: number;
		emotion: string;
		intensity: number;
		sentiment: number;
		confidence: number;
	}> {
		const segmentSize = Math.ceil(text.length / segments);
		const arc = [];

		for (let i = 0; i < segments; i++) {
			const start = i * segmentSize;
			const end = Math.min(start + segmentSize, text.length);
			const segment = text.substring(start, end);

			if (segment.trim()) {
				const analysis = this.analyzeSentiment(segment);
				arc.push({
					position: (i + 1) / segments,
					emotion: analysis.emotion,
					intensity: Math.abs(analysis.score) * 100,
					sentiment: analysis.comparative,
					confidence: analysis.confidence,
				});
			}
		}

		return arc;
	}

	/**
	 * Detects pacing through linguistic analysis
	 */
	analyzePacing(text: string): {
		overall: 'slow' | 'moderate' | 'fast' | 'variable';
		sentenceComplexity: number;
		actionDensity: number;
		dialogueRatio: number;
	} {
		const doc = nlp(text);

		// Analyze sentence complexity
		const sentences = doc.sentences();
		const avgWords =
			sentences
				.out('array')
				.reduce((acc: number, s: string) => acc + s.split(/\s+/).length, 0) /
			sentences.length;

		// Count action verbs vs state verbs
		const actionVerbs = doc
			.match('#Verb')
			.filter(
				(v: { has(tag: string): boolean }) =>
					!v.has('#Copula') && !v.has('#Modal') && !v.has('#Auxiliary')
			).length;
		const totalVerbs = doc.verbs().length;
		const actionDensity = totalVerbs > 0 ? actionVerbs / totalVerbs : 0;

		// Detect dialogue
		const dialogueMatches = text.match(/["'].*?["']/g) || [];
		const dialogueWords = dialogueMatches.join(' ').split(/\s+/).length;
		const totalWords = text.split(/\s+/).length;
		const dialogueRatio = dialogueWords / totalWords;

		// Determine overall pacing
		let overall: 'slow' | 'moderate' | 'fast' | 'variable';
		const sentenceComplexity = avgWords / 20; // Normalize to 0-1 scale

		if (actionDensity > 0.6 && sentenceComplexity < 0.7) {
			overall = 'fast';
		} else if (actionDensity < 0.3 && sentenceComplexity > 0.8) {
			overall = 'slow';
		} else if (Math.abs(actionDensity - 0.5) < 0.2) {
			overall = 'moderate';
		} else {
			overall = 'variable';
		}

		return {
			overall,
			sentenceComplexity,
			actionDensity,
			dialogueRatio,
		};
	}
}

// Export singleton instance
export const nlpAnalyzer = new NLPSentimentAnalyzer();
