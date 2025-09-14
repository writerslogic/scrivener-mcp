import nlp from 'compromise';
import type { StyleGuide } from '../../memory-manager.js';
import { MLWordClassifierPro } from '../../analysis/ml-word-classifier-pro.js';
import { AppError, ErrorCode } from '../../utils/common.js';
import { splitIntoSentences } from '../../utils/text-metrics.js';

// Import the new modular enhancers
import {
	StyleEnhancer,
	ClarityEnhancer,
	DescriptionEnhancer,
	DialogueEnhancer,
	EmotionEnhancer,
	PacingEnhancer,
} from './enhancers/index.js';

export type EnhancementType =
	| 'rewrite'
	| 'expand'
	| 'condense'
	| 'improve-flow'
	| 'enhance-descriptions'
	| 'strengthen-dialogue'
	| 'fix-pacing'
	| 'add-sensory-details'
	| 'show-dont-tell'
	| 'eliminate-filter-words'
	| 'vary-sentences'
	| 'strengthen-verbs'
	| 'fix-continuity'
	| 'match-style';

export interface EnhancementOptions {
	documentId?: string;
	context?: string;
	tone?: 'maintain' | 'lighter' | 'darker' | 'more-serious' | 'more-humorous';
	length?: 'maintain' | 'shorter' | 'longer' | number;
	complexity?: 'simplify' | 'maintain' | 'elevate';
	perspective?: 'maintain' | 'first' | 'second' | 'third-limited' | 'third-omniscient';
	tense?: 'maintain' | 'past' | 'present' | 'future';
	preserveDialogue?: boolean;
	preserveNames?: boolean;
	aggressiveness?: 'light' | 'moderate' | 'heavy';
}

export interface EnhancementRequest {
	content: string;
	type: EnhancementType;
	options?: EnhancementOptions;
	styleGuide?: StyleGuide;
	context?: string;
}

export interface EnhancementResult {
	original: string;
	enhanced: string;
	changes: Change[];
	metrics: {
		originalWordCount: number;
		enhancedWordCount: number;
		readabilityChange: number;
		changesApplied: number;
		processingTime?: number;
	};
	suggestions: string[];
	qualityValidation?: {
		coherence: number;
		consistency: number;
		improvement: number;
		overallScore: number;
	};
}

export interface Change {
	type: string;
	original: string;
	replacement: string;
	reason: string;
	location: { start: number; end: number };
}

export interface WritingPrompt {
	type: 'scene' | 'dialogue' | 'description' | 'action' | 'transition' | 'opening' | 'ending';
	context: string;
	constraints?: {
		wordCount?: { min?: number; max?: number };
		includeCharacters?: string[];
		setting?: string;
		mood?: string;
		conflict?: string;
		pointOfView?: string;
	};
	styleGuide?: StyleGuide;
}

export interface GeneratedContent {
	content: string;
	type: string;
	wordCount: number;
	suggestions: string[];
	alternativeVersions?: string[];
}

export class ContentEnhancer {
	private classifier: MLWordClassifierPro;

	// Enhancer instances
	private readonly styleEnhancer: StyleEnhancer;
	private readonly clarityEnhancer: ClarityEnhancer;
	private readonly descriptionEnhancer: DescriptionEnhancer;
	private readonly dialogueEnhancer: DialogueEnhancer;
	private readonly emotionEnhancer: EmotionEnhancer;
	private readonly pacingEnhancer: PacingEnhancer;

	constructor() {
		this.classifier = new MLWordClassifierPro();

		// Initialize enhancers with dependencies
		this.styleEnhancer = new StyleEnhancer(this.classifier);
		this.clarityEnhancer = new ClarityEnhancer(this.classifier);
		this.descriptionEnhancer = new DescriptionEnhancer(this.classifier);
		this.dialogueEnhancer = new DialogueEnhancer();
		this.emotionEnhancer = new EmotionEnhancer(this.classifier);
		this.pacingEnhancer = new PacingEnhancer();
	}

	async enhance(request: EnhancementRequest): Promise<EnhancementResult> {
		const startTime = performance.now();
		
		if (!request.content || request.content.trim().length === 0) {
			throw new AppError('Content cannot be empty', ErrorCode.VALIDATION_ERROR);
		}

		if (request.content.length > 100000) {
			throw new AppError('Content too large for enhancement', ErrorCode.VALIDATION_ERROR);
		}

		const originalWordCount = request.content.split(/\s+/).length;
		const changes: Change[] = [];
		let enhanced = request.content;

		try {
			// Apply enhancement based on type
			switch (request.type) {
				case 'eliminate-filter-words':
					enhanced = this.styleEnhancer.eliminateFilterWords(enhanced, changes);
					break;

				case 'strengthen-verbs':
					enhanced = this.styleEnhancer.strengthenVerbs(enhanced, changes);
					break;

				case 'vary-sentences':
					enhanced = this.styleEnhancer.varySentences(enhanced, changes);
					break;

				case 'add-sensory-details':
					enhanced = this.descriptionEnhancer.addSensoryDetails(enhanced, changes);
					break;

				case 'show-dont-tell':
					enhanced = this.emotionEnhancer.showDontTell(enhanced, changes);
					break;

				case 'improve-flow':
					enhanced = this.clarityEnhancer.improveFlow(enhanced, changes);
					break;

				case 'enhance-descriptions':
					enhanced = this.descriptionEnhancer.enhanceDescriptions(enhanced, changes);
					break;

				case 'strengthen-dialogue':
					enhanced = this.dialogueEnhancer.strengthenDialogue(enhanced, changes);
					break;

				case 'fix-pacing':
					enhanced = this.pacingEnhancer.fixPacing(enhanced, changes, request.options || {});
					break;

				case 'condense':
					enhanced = this.clarityEnhancer.condenseContent(
						enhanced,
						changes,
						request.options || {},
						typeof request.options?.length === 'number' ? request.options.length : undefined
					);
					break;

				case 'expand':
					enhanced = this.descriptionEnhancer.expandContent(
						enhanced,
						changes,
						typeof request.options?.length === 'number' ? request.options.length : undefined
					);
					break;

				case 'rewrite':
					enhanced = this.rewriteContent(enhanced, changes, request.options || {});
					break;

				case 'fix-continuity':
					enhanced = this.pacingEnhancer.fixContinuity(enhanced, changes, request.context);
					break;

				case 'match-style':
					enhanced = this.styleEnhancer.matchStyle(enhanced, changes, request.styleGuide);
					break;

				default:
					throw new AppError(`Unknown enhancement type: ${request.type}`, ErrorCode.VALIDATION_ERROR);
			}

			// Apply complexity adjustments if specified
			if (request.options?.complexity && request.options.complexity !== 'maintain') {
				enhanced = this.applyComplexityAdjustment(enhanced, changes, request.options.complexity);
			}

			// Apply tense conversion if specified
			if (request.options?.tense && request.options.tense !== 'maintain') {
				enhanced = this.clarityEnhancer.convertTense(enhanced, request.options.tense, changes);
			}

			const enhancedWordCount = enhanced.split(/\s+/).length;
			const readabilityChange = this.calculateReadabilityChange(request.content, enhanced);
			const processingTime = performance.now() - startTime;

			return {
				original: request.content,
				enhanced,
				changes,
				metrics: {
					originalWordCount,
					enhancedWordCount,
					readabilityChange,
					changesApplied: changes.length,
					processingTime,
				},
				suggestions: this.generateSuggestions(request.type, enhanced),
			};
		} catch (error) {
			throw new AppError(
				`Enhancement failed: ${(error as Error).message}`,
				ErrorCode.PROCESSING_ERROR
			);
		}
	}

	private rewriteContent(
		content: string,
		changes: Change[],
		options: EnhancementOptions
	): string {
		let result = content;

		// Apply multiple enhancement types for comprehensive rewrite
		result = this.styleEnhancer.eliminateFilterWords(result, changes);
		result = this.styleEnhancer.strengthenVerbs(result, changes);
		result = this.styleEnhancer.varySentences(result, changes);
		result = this.descriptionEnhancer.addSensoryDetails(result, changes);
		result = this.emotionEnhancer.showDontTell(result, changes);

		// Apply tone adjustments
		if (options.tone && options.tone !== 'maintain') {
			result = this.applyToneAdjustment(result, changes, options.tone);
		}

		return result;
	}

	private applyComplexityAdjustment(
		content: string,
		changes: Change[],
		complexity: 'simplify' | 'elevate'
	): string {
		if (complexity === 'simplify') {
			return this.clarityEnhancer.simplifySentences(content, changes);
		} else if (complexity === 'elevate') {
			return this.clarityEnhancer.complexifySentences(content, changes);
		}
		return content;
	}

	private applyToneAdjustment(
		content: string,
		changes: Change[],
		tone: 'lighter' | 'darker' | 'more-serious' | 'more-humorous'
	): string {
		// Simplified tone adjustment - would need more sophisticated implementation
		let result = content;

		const toneAdjustments: Record<string, Record<string, string>> = {
			'lighter': {
				'terrible': 'unpleasant',
				'horrible': 'difficult',
				'awful': 'challenging',
			},
			'darker': {
				'difficult': 'terrible',
				'challenging': 'grueling',
				'unpleasant': 'horrifying',
			},
			'more-serious': {
				'fun': 'engaging',
				'cool': 'impressive',
				'awesome': 'remarkable',
			},
			'more-humorous': {
				'serious': 'stuffy',
				'important': 'earth-shattering',
				'big': 'enormous',
			},
		};

		const adjustments = toneAdjustments[tone] || {};
		for (const [original, replacement] of Object.entries(adjustments)) {
			const regex = new RegExp(`\\b${original}\\b`, 'gi');
			if (regex.test(result)) {
				changes.push({
					type: 'tone-adjustment',
					original,
					replacement,
					reason: `Adjusted tone to be ${tone.replace('-', ' ')}`,
					location: { start: 0, end: original.length },
				});
				result = result.replace(regex, replacement);
			}
		}

		return result;
	}

	private calculateReadabilityChange(original: string, enhanced: string): number {
		const originalMetrics = this.calculateTextMetrics(original);
		const enhancedMetrics = this.calculateTextMetrics(enhanced);

		// Simple readability comparison based on average sentence length and syllable count
		const originalScore = originalMetrics.avgSentenceLength + originalMetrics.avgSyllablesPerWord;
		const enhancedScore = enhancedMetrics.avgSentenceLength + enhancedMetrics.avgSyllablesPerWord;

		return enhancedScore - originalScore; // Positive means more complex, negative means simpler
	}

	private calculateTextMetrics(text: string): {
		wordCount: number;
		sentenceCount: number;
		avgSentenceLength: number;
		avgSyllablesPerWord: number;
	} {
		const words = text.split(/\s+/).filter(w => w.length > 0);
		const sentences = splitIntoSentences(text);
		
		const wordCount = words.length;
		const sentenceCount = sentences.length;
		const avgSentenceLength = wordCount / Math.max(sentenceCount, 1);
		
		// Calculate average syllables per word
		const totalSyllables = words.reduce((total, word) => {
			return total + this.countSyllablesAdvanced(word);
		}, 0);
		const avgSyllablesPerWord = totalSyllables / Math.max(wordCount, 1);

		return {
			wordCount,
			sentenceCount,
			avgSentenceLength,
			avgSyllablesPerWord,
		};
	}

	private countSyllablesAdvanced(word: string): number {
		// More accurate syllable counting
		word = word.toLowerCase().replace(/[^a-z]/g, '');
		if (word.length === 0) return 0;

		// Count vowel groups
		let syllables = 0;
		let previousWasVowel = false;
		const vowels = 'aeiouy';

		for (let i = 0; i < word.length; i++) {
			const isVowel = vowels.includes(word[i]);
			if (isVowel && !previousWasVowel) {
				syllables++;
			}
			previousWasVowel = isVowel;
		}

		// Apply common rules
		if (word.endsWith('e') && syllables > 1) syllables--;
		if (word.endsWith('le') && word.length > 2 && !vowels.includes(word[word.length - 3])) syllables++;
		if (word.endsWith('ed') && syllables > 1 && !vowels.includes(word[word.length - 3])) syllables--;

		// Ensure at least 1 syllable
		return Math.max(syllables, 1);
	}

	private generateSuggestions(_type: EnhancementType, _content: string): string[] {
		// Generate contextual suggestions based on the enhancement type and results
		return [
			'Consider reading the enhanced text aloud to check for flow',
			'Review the changes to ensure they maintain your intended voice',
			'Check that character names and details remain consistent',
		];
	}
}