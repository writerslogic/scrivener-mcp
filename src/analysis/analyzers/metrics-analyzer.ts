import {
	getWritingTextMetrics as getTextMetrics,
	hasEnglishReadabilityEvidence,
} from '../../utils/text-metrics.js';
import { getLogger } from '../../core/logger.js';
import { computeReadability } from 'narrative-lens';
import { generateHash } from '../../utils/common.js';
import type { PredictiveCacheFactory } from '../../utils/predictive-cache.js';

export interface WritingMetrics {
	wordCount: number;
	sentenceCount: number;
	paragraphCount: number;
	averageSentenceLength: number | null;
	averageParagraphLength: number | null;
	readingTime: number; // in minutes
	fleschReadingEase: number | null;
	fleschKincaidGrade: number | null;
}

export class MetricsAnalyzer {
	constructor(
		private predictiveMetricsCache: ReturnType<
			typeof PredictiveCacheFactory.createMetadataCache
		>,
		private memoizeAsync: <T>(key: string, calculator: () => Promise<T>) => Promise<T>
	) {}

	async calculateMetrics(
		content: string,
		textMetrics?: ReturnType<typeof getTextMetrics>
	): Promise<WritingMetrics> {
		const contentHash = generateHash(content);
		const cacheKey = `metrics:language-v1:${contentHash}`;
		const context = ['metrics', 'text-analysis', contentHash.substring(0, 8)];

		// Try predictive cache first
		const cachedMetrics = await this.predictiveMetricsCache
			.get(cacheKey, context, 'metrics-session')
			.catch(() => {
				getLogger('metrics-analyzer').warn('Metrics cache read failed');
				return undefined;
			});
		if (cachedMetrics) {
			return cachedMetrics as WritingMetrics;
		}

		const result = await this.memoizeAsync(cacheKey, async () => {
			// Use pre-calculated metrics if available, otherwise calculate
			const metrics = textMetrics || getTextMetrics(content);

			const readability = hasEnglishReadabilityEvidence(content)
				? computeReadability(content)
				: undefined;
			const fleschReadingEase = readability?.wordCount
				? Math.max(0, Math.min(100, readability.fleschEase))
				: null;
			const fleschKincaidGrade = readability?.wordCount
				? Math.max(0, readability.fkgl)
				: null;

			return {
				wordCount: metrics.wordCount,
				sentenceCount: metrics.sentenceCount,
				paragraphCount: metrics.paragraphCount,
				averageSentenceLength: metrics.averageWordsPerSentence,
				averageParagraphLength: metrics.averageWordsPerParagraph,
				readingTime: metrics.readingTimeMinutes,
				fleschReadingEase,
				fleschKincaidGrade,
			};
		});

		// Store in predictive cache for future access
		await this.predictiveMetricsCache
			.set(cacheKey, result, context, 'metrics-session')
			.catch(() => {
				getLogger('metrics-analyzer').warn('Metrics cache write failed');
			});

		return result;
	}
}
