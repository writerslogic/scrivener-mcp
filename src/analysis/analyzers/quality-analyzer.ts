import { collectProseExamples } from 'narrative-lens';
import { getLogger } from '../../core/logger.js';
import { splitIntoSentences } from '../../utils/text-metrics.js';
import type { MLWordClassifierPro } from '../ml-word-classifier-pro.js';

export interface QualityIndicators {
	repetitiveness: number | null; // 0-100, lower is better
	cliches: string[];
	filterWords: string[];
	tellingVsShowing: number | null; // ratio
	sensoryDetails: 'lacking' | 'adequate' | 'rich' | 'unavailable';
	whiteSpace: 'cramped' | 'balanced' | 'excessive' | 'unavailable';
}

const logger = getLogger('quality-analyzer');

export class QualityAnalyzer {
	constructor(private classifier: MLWordClassifierPro) {}

	async assessQuality(
		content: string,
		sharedProseFindings?: ReturnType<typeof collectProseExamples>
	): Promise<QualityIndicators> {
		try {
			if (!content || content.trim().length === 0) {
				return this.getDefaultQualityIndicators();
			}

			const lowerContent = content.toLowerCase();
			const words = lowerContent.split(/\s+/).filter((w) => w.length > 0);
			const sentences = splitIntoSentences(content);

			// Optimized repetitiveness calculation with limited scope
			let repetitiveness: number | null = null;
			if (words.length > 1) {
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

			const foundClichés = (sharedProseFindings ?? collectProseExamples([content]))
				.filter((example) => example.issueType === 'cliche')
				.map((example) => example.snippet);

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
			const tellingVsShowing = actionWords.length
				? tellingWords.length / actionWords.length
				: null;

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
				repetitiveness,
				cliches: foundClichés.slice(0, 10), // Limit for memory
				filterWords: foundFilterWords.slice(0, 20), // Limit for memory
				tellingVsShowing,
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

	getDefaultQualityIndicators(): QualityIndicators {
		return {
			repetitiveness: null,
			cliches: [],
			filterWords: [],
			tellingVsShowing: null,
			sensoryDetails: 'unavailable',
			whiteSpace: 'unavailable',
		};
	}
}
