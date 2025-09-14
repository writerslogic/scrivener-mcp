import { getLogger } from '../../core/logger.js';
import { splitIntoSentences } from '../../utils/text-metrics.js';
import type { MLWordClassifierPro } from '../ml-word-classifier-pro.js';

export interface QualityIndicators {
	repetitiveness: number; // 0-100, lower is better
	cliches: string[];
	filterWords: string[];
	tellingVsShowing: number; // ratio
	sensoryDetails: 'lacking' | 'adequate' | 'rich';
	whiteSpace: 'cramped' | 'balanced' | 'excessive';
}

const logger = getLogger('quality-analyzer');

export class QualityAnalyzer {
	private clichePhrases = [
		'dark and stormy night',
		'in the nick of time',
		'avoid like the plague',
		'dead as a doornail',
		'fit as a fiddle',
		'time will tell',
		'only time will tell',
		'lost track of time',
		'all walks of life',
		'calm before the storm',
		'cry over spilled milk',
		'every cloud has a silver lining',
	];

	constructor(private classifier: MLWordClassifierPro) {}

	async assessQuality(content: string): Promise<QualityIndicators> {
		try {
			if (!content || content.trim().length === 0) {
				return this.getDefaultQualityIndicators();
			}

			const lowerContent = content.toLowerCase();
			const words = lowerContent.split(/\s+/).filter((w) => w.length > 0);
			const sentences = splitIntoSentences(content);

			// Early exit for very small content
			if (words.length < 5) {
				return this.getDefaultQualityIndicators();
			}

			// Optimized repetitiveness calculation with limited scope
			let repetitiveness = 0;
			if (words.length > 20) {
				const wordPairs = new Map<string, number>();
				const maxPairsToCheck = Math.min(words.length - 1, 1000); // Limit for performance

				for (let i = 0; i < maxPairsToCheck; i++) {
					if (i + 1 < words.length) {
						const pair = `${words[i]} ${words[i + 1]}`;
						wordPairs.set(pair, (wordPairs.get(pair) || 0) + 1);
					}
				}

				const repetitivePairs = Array.from(wordPairs.values()).filter(
					(count) => count > 2
				).length;
				repetitiveness = Math.min((repetitivePairs / wordPairs.size) * 100, 100);
			}

			// Optimized cliché detection
			const foundClichés = this.clichePhrases.filter((cliché) =>
				lowerContent.includes(cliché)
			);

			// Optimized filter word detection with batching
			const foundFilterWords: string[] = [];
			const uniqueWords = [...new Set(words)].slice(0, 100); // Limit unique words processed

			for (const word of uniqueWords) {
				if (word.length > 2) {
					const wordIndex = lowerContent.indexOf(word);
					if (wordIndex !== -1) {
						try {
							const classification = this.classifier.classify(
								word,
								content,
								wordIndex
							);
							if (classification.isFilterWord && classification.confidence > 0.6) {
								foundFilterWords.push(word);
							}
						} catch {
							// Skip problematic classifications
							continue;
						}
					}
				}
			}

			// Optimized telling vs showing calculation
			const tellingWords = words.filter((w) => this.isCognitiveVerb(w));
			const actionWords = words.filter((w) => w.endsWith('ed') || w.endsWith('ing'));
			const tellingVsShowing = tellingWords.length / Math.max(actionWords.length, 1);

			// Optimized sensory details calculation
			const sensoryPatterns =
				/\b(saw|heard|smell|taste|touch|felt|bright|dark|loud|quiet|soft|hard|sweet|bitter)\w*/g;
			const sensoryMatches = (lowerContent.match(sensoryPatterns) || []).length;
			const sensoryDetails =
				sensoryMatches / sentences.length > 1
					? 'rich'
					: sensoryMatches / sentences.length > 0.5
						? 'adequate'
						: 'lacking';

			// Optimized white space calculation
			const paragraphs = content.split(/\n\n+/);
			const avgParagraphLength = Math.max(content.length / paragraphs.length, 1);
			const whiteSpace =
				avgParagraphLength < 300
					? 'balanced'
					: avgParagraphLength < 800
						? 'balanced'
						: 'cramped';

			return {
				repetitiveness: Math.min(Math.max(repetitiveness, 0), 100),
				cliches: foundClichés.slice(0, 10), // Limit for memory
				filterWords: foundFilterWords.slice(0, 20), // Limit for memory
				tellingVsShowing: Math.min(Math.max(tellingVsShowing, 0), 10),
				sensoryDetails,
				whiteSpace,
			};
		} catch (error) {
			logger.warn('Quality assessment failed, using default', { error });
			return this.getDefaultQualityIndicators();
		}
	}

	private isCognitiveVerb(word: string): boolean {
		// Pattern-based detection of cognitive/mental state verbs
		const cognitivePatterns = [
			'felt',
			'thought',
			'knew',
			'realized',
			'understood',
			'believed',
			'remembered',
			'considered',
			'pondered',
			'reflected',
		];
		return (
			cognitivePatterns.includes(word.toLowerCase()) ||
			word.endsWith('ized') ||
			word.endsWith('ought') ||
			word.includes('think')
		);
	}

	private getDefaultQualityIndicators(): QualityIndicators {
		return {
			repetitiveness: 15,
			cliches: [],
			filterWords: [],
			tellingVsShowing: 0.3,
			sensoryDetails: 'adequate',
			whiteSpace: 'balanced',
		};
	}
}