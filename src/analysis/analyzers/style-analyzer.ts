import { splitIntoSentences } from '../../utils/text-metrics.js';
import { generateHash } from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';
import type { PredictiveCacheFactory } from '../../utils/predictive-cache.js';

export interface StyleAnalysis {
	sentenceVariety: 'low' | 'medium' | 'high';
	vocabularyComplexity: 'simple' | 'moderate' | 'complex' | 'advanced';
	adverbUsage: 'minimal' | 'moderate' | 'heavy';
	passiveVoicePercentage: number;
	dialoguePercentage: number;
	descriptionPercentage: number;
	mostFrequentWords: { word: string; count: number }[];
	styleConsistency: number; // 0-100
}

const logger = getLogger('style-analyzer');

export class StyleAnalyzer {
	private commonWords = new Set([
		'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'as',
		'by', 'that', 'this', 'it', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have',
		'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
	]);

	constructor(
		private predictiveStyleCache: ReturnType<typeof PredictiveCacheFactory.createMetadataCache>,
		private countSyllables: (words: string[]) => number
	) {}

	async analyzeStyle(content: string): Promise<StyleAnalysis> {
		const contentHash = generateHash(content.substring(0, 500));
		const cacheKey = `style:${contentHash}`;
		const context = ['style', 'text-analysis', contentHash.substring(0, 8)];

		// Try predictive cache first
		const cachedStyle = await this.predictiveStyleCache.get(cacheKey, context, 'style-session');
		if (cachedStyle) {
			return cachedStyle as StyleAnalysis;
		}

		try {
			if (!content || content.trim().length === 0) {
				return this.getDefaultStyleAnalysis();
			}

			const sentences = splitIntoSentences(content);
			const words = content
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 0);

			// Early exit for small content
			if (words.length < 10) {
				return this.getDefaultStyleAnalysis();
			}

			// Sentence variety
			const sentenceLengths = sentences.map((s: string) => s.split(/\s+/).length);
			const lengthVariance = this.calculateVariance(sentenceLengths);
			const sentenceVariety: 'low' | 'medium' | 'high' =
				lengthVariance > 50 ? 'high' : lengthVariance > 20 ? 'medium' : 'low';

			// Vocabulary complexity
			const complexWords = words.filter((w) => this.countSyllables([w]) > 2).length;
			const vocabularyComplexity: 'simple' | 'moderate' | 'complex' | 'advanced' =
				complexWords / words.length > 0.3
					? 'advanced'
					: complexWords / words.length > 0.2
						? 'complex'
						: complexWords / words.length > 0.1
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

			// Passive voice - detect using pattern-based auxiliary verb detection
			const passiveCount = words.filter((w) => this.isPassiveIndicator(w)).length;
			const passiveVoicePercentage = (passiveCount / sentences.length) * 100;

			// Dialogue vs description
			const dialogueLines = content
				.split('\n')
				.filter((line) => line.includes('"') || line.includes("'"));
			const dialoguePercentage = (dialogueLines.length / content.split('\n').length) * 100;
			const descriptionPercentage = 100 - dialoguePercentage;

			// Most frequent words (excluding common words)
			const wordFrequency = new Map<string, number>();
			words.forEach((word) => {
				if (!this.commonWords.has(word) && word.length > 3) {
					wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
				}
			});
			const mostFrequentWords = Array.from(wordFrequency.entries())
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([word, count]) => ({ word, count }));

			const result = {
				sentenceVariety,
				vocabularyComplexity,
				adverbUsage,
				passiveVoicePercentage: Math.min(Math.max(passiveVoicePercentage, 0), 100),
				dialoguePercentage: Math.min(Math.max(dialoguePercentage, 0), 100),
				descriptionPercentage: Math.min(Math.max(descriptionPercentage, 0), 100),
				mostFrequentWords,
				styleConsistency: 85, // TODO: Simplified for now
			};

			// Store in predictive cache
			await this.predictiveStyleCache.set(cacheKey, result, context, 'style-session');

			return result;
		} catch (error) {
			logger.warn('Style analysis failed, using default', { error });
			return this.getDefaultStyleAnalysis();
		}
	}

	private calculateVariance(numbers: number[]): number {
		const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
		const squaredDifferences = numbers.map((n) => Math.pow(n - mean, 2));
		return squaredDifferences.reduce((a, b) => a + b, 0) / numbers.length;
	}

	private isPassiveIndicator(word: string): boolean {
		const auxiliaryVerbs = ['was', 'were', 'been', 'being', 'be', 'is', 'are', 'am'];
		return auxiliaryVerbs.includes(word.toLowerCase());
	}

	private getDefaultStyleAnalysis(): StyleAnalysis {
		return {
			sentenceVariety: 'medium',
			vocabularyComplexity: 'moderate',
			adverbUsage: 'moderate',
			passiveVoicePercentage: 15,
			dialoguePercentage: 20,
			descriptionPercentage: 80,
			mostFrequentWords: [],
			styleConsistency: 75,
		};
	}
}