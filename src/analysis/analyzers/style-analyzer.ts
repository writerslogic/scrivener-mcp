import {
	collectProseExamples,
	computeReadability,
	extractDialogue,
	wordFrequencies,
} from 'narrative-lens';
import { splitIntoSentences } from '../../utils/text-metrics.js';
import { generateHash } from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';
import type { PredictiveCacheFactory } from '../../utils/predictive-cache.js';

export interface StyleAnalysis {
	sentenceVariety: 'low' | 'medium' | 'high' | 'unavailable';
	vocabularyComplexity: 'simple' | 'moderate' | 'complex' | 'advanced' | 'unavailable';
	adverbUsage: 'minimal' | 'moderate' | 'heavy' | 'unavailable';
	passiveVoicePercentage: number | null;
	proseFindings?: ReturnType<typeof collectProseExamples>;
	dialoguePercentage: number | null;
	descriptionPercentage: number | null;
	mostFrequentWords: { word: string; count: number }[];
	styleConsistency: number | null; // 0-100
}

const logger = getLogger('style-analyzer');

export class StyleAnalyzer {
	private commonWords = new Set([
		'the',
		'a',
		'an',
		'and',
		'or',
		'but',
		'in',
		'on',
		'at',
		'to',
		'for',
		'of',
		'with',
		'as',
		'by',
		'that',
		'this',
		'it',
		'is',
		'was',
		'are',
		'were',
		'be',
		'been',
		'being',
		'have',
		'has',
		'had',
		'do',
		'does',
		'did',
		'will',
		'would',
		'could',
		'should',
	]);

	constructor(
		private predictiveStyleCache: ReturnType<typeof PredictiveCacheFactory.createMetadataCache>
	) {}

	async analyzeStyle(
		content: string,
		sharedProseFindings?: ReturnType<typeof collectProseExamples>
	): Promise<StyleAnalysis> {
		const contentHash = generateHash(content);
		const cacheKey = `style:lens-0.2:availability-v2:${contentHash}`;
		const context = ['style', 'text-analysis', contentHash.substring(0, 8)];

		// Try predictive cache first
		const cachedStyle = await this.predictiveStyleCache
			.get(cacheKey, context, 'style-session')
			.catch(() => {
				logger.warn('Style cache read failed');
				return undefined;
			});
		if (cachedStyle) {
			return cachedStyle as StyleAnalysis;
		}

		let proseFindings = sharedProseFindings;
		try {
			if (!content || content.trim().length === 0) {
				return this.getDefaultStyleAnalysis();
			}

			const sentences = splitIntoSentences(content);
			const words = content
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 0);

			// Sentence variety
			const sentenceLengths = sentences.map((s: string) => s.split(/\s+/).length);
			const lengthVariance = this.calculateVariance(sentenceLengths);
			const sentenceVariety: 'low' | 'medium' | 'high' =
				lengthVariance > 50 ? 'high' : lengthVariance > 20 ? 'medium' : 'low';

			// Vocabulary complexity
			const readability = computeReadability(content);
			if (readability.wordCount === 0) return this.getDefaultStyleAnalysis();
			const complexWords = readability.polysyllableCount;
			const vocabularyComplexity: 'simple' | 'moderate' | 'complex' | 'advanced' =
				complexWords / Math.max(readability.wordCount, 1) > 0.3
					? 'advanced'
					: complexWords / Math.max(readability.wordCount, 1) > 0.2
						? 'complex'
						: complexWords / Math.max(readability.wordCount, 1) > 0.1
							? 'moderate'
							: 'simple';

			// Adverb usage
			const adverbs = words.filter((w) => w.endsWith('ly')).length;
			const adverbUsage: 'minimal' | 'moderate' | 'heavy' =
				adverbs / words.length > 0.05
					? 'heavy'
					: adverbs / words.length > 0.02
						? 'moderate'
						: 'minimal';

			proseFindings ??= collectProseExamples([content]);

			const dialogueWords = extractDialogue(content, 0, []).reduce(
				(sum, line) => sum + computeReadability(line.quote).wordCount,
				0
			);
			const dialoguePercentage = Math.min(
				100,
				(dialogueWords / Math.max(readability.wordCount, 1)) * 100
			);

			const mostFrequentWords = wordFrequencies(content, readability.wordCount)
				.filter(({ word }) => !this.commonWords.has(word) && word.length > 3)
				.slice(0, 10);

			const result = {
				sentenceVariety,
				vocabularyComplexity,
				adverbUsage,
				passiveVoicePercentage: null,
				proseFindings,
				dialoguePercentage: Math.min(Math.max(dialoguePercentage, 0), 100),
				descriptionPercentage: null,
				mostFrequentWords,
				styleConsistency: null,
			};

			// Store in predictive cache
			await this.predictiveStyleCache
				.set(cacheKey, result, context, 'style-session')
				.catch(() => {
					logger.warn('Style cache write failed');
				});

			return result;
		} catch (error) {
			logger.warn('Style analysis failed; style percentages unavailable', { error });
			return { ...this.getDefaultStyleAnalysis(), proseFindings };
		}
	}

	private calculateVariance(numbers: number[]): number {
		const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
		const squaredDifferences = numbers.map((n) => Math.pow(n - mean, 2));
		return squaredDifferences.reduce((a, b) => a + b, 0) / numbers.length;
	}

	getDefaultStyleAnalysis(): StyleAnalysis {
		return {
			sentenceVariety: 'unavailable',
			vocabularyComplexity: 'unavailable',
			adverbUsage: 'unavailable',
			passiveVoicePercentage: null,
			dialoguePercentage: null,
			descriptionPercentage: null,
			mostFrequentWords: [],
			styleConsistency: null,
		};
	}
}
