// import type { ScrivenerDocument } from '../scrivener-project.js';
import { cached, caches } from '../core/cache.js';
import { getLogger } from '../core/logger.js';
import { webContentParser } from '../services/web-content-parser.js';
import type {
	ContentExtractionOptions,
	ParsedWebContent,
	ReadabilityComparison,
	ReadabilityMetrics,
	ReadabilityTrends,
	ResearchData,
	WritingSuggestion,
} from '../types/analysis.js';
import { PredictiveCacheFactory } from '../utils/predictive-cache.js';
import { advancedReadabilityService } from './advanced-readability.js';
import { classifier as wordClassifier } from './ml-word-classifier-pro.js';
// Import missing utility functions
import {
	generateHash,
	truncate,
	validateInput,
	formatBytes,
	formatDuration,
	measureExecution,
} from '../utils/common.js';
import {
	getWritingTextMetrics as getTextMetrics,
	splitIntoSentences,
} from '../utils/text-metrics.js';

// Import the new modular analyzers
import {
	MetricsAnalyzer,
	StyleAnalyzer,
	StructureAnalyzer,
	QualityAnalyzer,
	EmotionAnalyzer,
	PacingAnalyzer,
	SuggestionGenerator,
	type WritingMetrics,
	type StyleAnalysis,
	type StructureAnalysis,
	type QualityIndicators,
	type EmotionalAnalysis,
	type PacingAnalysis,
	type Suggestion,
} from './analyzers/index.js';

const logger = getLogger('content-analyzer');

export interface ContentAnalysis {
	documentId: string;
	timestamp: string;
	metrics: WritingMetrics;
	style: StyleAnalysis;
	structure: StructureAnalysis;
	quality: QualityIndicators;
	suggestions: Suggestion[];
	emotions: EmotionalAnalysis;
	pacing: PacingAnalysis;
}

// Re-export types for backward compatibility
export type {
	WritingMetrics,
	StyleAnalysis,
	StructureAnalysis,
	QualityIndicators,
	EmotionalAnalysis,
	PacingAnalysis,
	Suggestion,
};

export class ContentAnalyzer {
	// Caching and resource-reuse structures
	private readonly memoizedCalculations = new Map<string, unknown>();
	private readonly resourcePool = new Map<string, unknown[]>();
	private readonly analysisQueue: Array<{
		content: string;
		documentId: string;
		resolve: (value: ContentAnalysis) => void;
		reject: (error: Error) => void;
	}> = [];

	// ML-powered predictive caches for intelligent prefetching
	private readonly predictiveAnalysisCache =
		PredictiveCacheFactory.createAnalysisCache<ContentAnalysis>();
	private readonly predictiveMetricsCache =
		PredictiveCacheFactory.createMetadataCache<WritingMetrics>();
	private readonly predictiveStyleCache =
		PredictiveCacheFactory.createMetadataCache<StyleAnalysis>();
	private isProcessingQueue = false;
	private readonly maxCacheSize = 1000;
	private readonly maxPoolSize = 50;

	// Analyzer instances
	private readonly metricsAnalyzer: MetricsAnalyzer;
	private readonly styleAnalyzer: StyleAnalyzer;
	private readonly structureAnalyzer: StructureAnalyzer;
	private readonly qualityAnalyzer: QualityAnalyzer;
	private readonly emotionAnalyzer: EmotionAnalyzer;
	private readonly pacingAnalyzer: PacingAnalyzer;
	private readonly suggestionGenerator: SuggestionGenerator;

	constructor() {
		// Initialize analyzers with required dependencies
		this.metricsAnalyzer = new MetricsAnalyzer(
			this.predictiveMetricsCache,
			this.memoizeAsync.bind(this),
			this.getResourceFromPool.bind(this),
			this.returnResourceToPool.bind(this)
		);

		this.styleAnalyzer = new StyleAnalyzer(
			this.predictiveStyleCache,
			this.countSyllables.bind(this)
		);

		this.structureAnalyzer = new StructureAnalyzer();

		this.qualityAnalyzer = new QualityAnalyzer(wordClassifier);

		this.emotionAnalyzer = new EmotionAnalyzer();

		this.pacingAnalyzer = new PacingAnalyzer();

		this.suggestionGenerator = new SuggestionGenerator();
	}

	private async memoizeAsync<T>(key: string, calculator: () => Promise<T>): Promise<T> {
		const cached = this.memoizedCalculations.get(key);
		if (cached !== undefined) {
			return cached as T;
		}

		// Clean cache if too large
		if (this.memoizedCalculations.size >= this.maxCacheSize) {
			const keys = [...this.memoizedCalculations.keys()];
			const toDelete = keys.slice(0, Math.floor(this.maxCacheSize * 0.2));
			toDelete.forEach((k) => this.memoizedCalculations.delete(k));
		}

		const result = await calculator();
		this.memoizedCalculations.set(key, result);
		return result;
	}

	private getResourceFromPool<T>(type: string, creator: () => T): T {
		const existing = this.resourcePool.get(type);
		const pool = existing || [];

		if (!existing) {
			this.resourcePool.set(type, pool);
		}

		if (pool.length > 0) {
			return pool.pop() as T;
		}

		return creator();
	}

	private returnResourceToPool<T>(type: string, resource: T): void {
		const existing = this.resourcePool.get(type);
		const pool = existing || [];

		if (!existing) {
			this.resourcePool.set(type, pool);
		}

		if (pool.length < this.maxPoolSize) {
			pool.push(resource);
		}
	}

	private async processAnalysisQueue(): Promise<void> {
		if (this.isProcessingQueue || this.analysisQueue.length === 0) {
			return;
		}

		this.isProcessingQueue = true;

		try {
			// Process in batches for better performance using lock-free queue
			const batchSize = 5;
			const batch: Array<{
				content: string;
				documentId: string;
				resolve: (value: ContentAnalysis) => void;
				reject: (error: Error) => void;
			}> = [];

			// Dequeue items into batch
			for (let i = 0; i < batchSize; i++) {
				const item = this.analysisQueue.shift();
				if (!item) break;
				batch.push(item);
			}

			if (batch.length > 0) {
				await Promise.all(
					batch.map(async ({ content, documentId, resolve, reject }) => {
						try {
							const result = await this.performAnalysis(content, documentId);
							resolve(result);
						} catch (error) {
							reject(error as Error);
						}
					})
				);

				// Continue processing if there are more items
				if (this.analysisQueue.length > 0) {
					setImmediate(() => this.processAnalysisQueue());
				}
			}
		} finally {
			this.isProcessingQueue = false;
		}
	}

	private async performAnalysis(content: string, documentId: string): Promise<ContentAnalysis> {
		return this.analyzeContentDirect(content, documentId);
	}

	// Enhanced analyze method with intelligent queuing and optimization
	async analyzeContent(content: string, documentId: string): Promise<ContentAnalysis> {
		// Intelligent content size detection for queue vs immediate processing
		const contentSize = content.length;
		const isLargeContent = contentSize > 50000; // 50KB threshold

		if (isLargeContent) {
			// Queue large content for batch processing using lock-free queue
			return new Promise((resolve, reject) => {
				this.analysisQueue.push({ content, documentId, resolve, reject });
				this.processAnalysisQueue().catch(reject);
			});
		}

		// Process smaller content immediately with caching
		return this.analyzeContentDirect(content, documentId);
	}

	async analyzeContentDirect(content: string, documentId: string): Promise<ContentAnalysis> {
		// Create intelligent cache key with content fingerprint
		const contentHash = generateHash(content.substring(0, 1000));
		const cacheKey = `analysis:${documentId}:${contentHash}`;
		const context = [documentId, 'content-analysis', contentHash.substring(0, 8)];

		// Try predictive cache first
		const cachedResult = await this.predictiveAnalysisCache.get(
			cacheKey,
			context,
			'analysis-session'
		);
		if (cachedResult) {
			logger.debug('Predictive cache hit for analysis', {
				documentId: truncate(documentId, 50),
				cacheKey: truncate(cacheKey, 50),
			});
			return cachedResult;
		}
		try {
			validateInput(
				{ content, documentId },
				{
					content: {
						type: 'string',
						required: true,
						minLength: 10,
						maxLength: 5_000_000,
					},
					documentId: { type: 'string', required: true, minLength: 1, maxLength: 255 },
				}
			);

			// Pre-calculate metrics once for reuse
			const textMetrics = getTextMetrics(content);
			const contentHash = generateHash(content.substring(0, 1000));
			const truncatedContent = truncate(content, 5000); // Limit for performance

			logger.debug('Analyzing content for document', {
				documentId: truncate(documentId, 50),
				contentHash: truncate(contentHash, 12),
				wordCount: textMetrics.wordCount,
				sentenceCount: textMetrics.sentenceCount,
				contentSize: formatBytes(content.length),
				readingTime: formatDuration(textMetrics.readingTimeMinutes * 60 * 1000),
			});

			// Execute analysis steps with optimized error handling
			const executionResult = await measureExecution(async () => {
				try {
					// Run lightweight analyses first using the new modular analyzers
					const metrics = await this.metricsAnalyzer.calculateMetrics(
						content,
						textMetrics
					);
					const structure = this.structureAnalyzer.analyzeStructure(content);

					// Run heavier analyses with fallbacks
					const [style, quality, emotions, pacing] = await Promise.allSettled([
						this.styleAnalyzer.analyzeStyle(content),
						this.qualityAnalyzer.assessQuality(content),
						this.emotionAnalyzer.analyzeEmotions(content),
						this.pacingAnalyzer.analyzePacing(content),
					]);

					// Generate suggestions based on completed analyses
					const suggestions = await this.suggestionGenerator.generateSuggestions(
						truncatedContent,
						metrics,
						style.status === 'fulfilled' ? style.value : this.getDefaultStyleAnalysis(),
						quality.status === 'fulfilled'
							? quality.value
							: this.getDefaultQualityIndicators()
					);

					return {
						documentId,
						timestamp: new Date().toISOString(),
						metrics,
						style:
							style.status === 'fulfilled'
								? style.value
								: this.getDefaultStyleAnalysis(),
						structure,
						quality:
							quality.status === 'fulfilled'
								? quality.value
								: this.getDefaultQualityIndicators(),
						suggestions,
						emotions:
							emotions.status === 'fulfilled'
								? emotions.value
								: this.getDefaultEmotionalAnalysis(),
						pacing:
							pacing.status === 'fulfilled'
								? pacing.value
								: this.getDefaultPacingAnalysis(),
					};
				} catch (error) {
					logger.warn('Analysis step failed, using fallback data', { error, documentId });
					return this.getMinimalAnalysis(documentId, textMetrics);
				}
			});

			logger.debug('Content analysis completed', {
				documentId: truncate(documentId, 50),
				executionTime: formatDuration(executionResult.ms),
				cacheKey: `analysis:${documentId}:${truncate(contentHash, 8)}`,
			});

			// Store result in predictive cache for future access
			await this.predictiveAnalysisCache.set(
				cacheKey,
				executionResult.result,
				context,
				'analysis-session'
			);

			return executionResult.result;
		} catch (error) {
			throw new Error(`ContentAnalyzer.analyzeContent failed: ${(error as Error).message}`);
		}
	}

	// Helper methods that are still used by analyzers
	private countSyllables(words: string[]): number {
		return words.reduce((count, word) => {
			word = word.toLowerCase().replace(/[^a-z]/g, '');
			let syllables = 0;
			let previousWasVowel = false;

			for (let i = 0; i < word.length; i++) {
				const isVowel = /[aeiou]/.test(word[i]);
				if (isVowel && !previousWasVowel) syllables++;
				previousWasVowel = isVowel;
			}

			// Adjustments
			if (word.endsWith('e')) syllables--;
			if (word.endsWith('le') && word.length > 2) syllables++;
			if (syllables === 0) syllables = 1;

			return count + syllables;
		}, 0);
	}

	/**
	 * Get advanced readability analysis using multiple algorithms
	 */
	async getAdvancedReadabilityAnalysis(content: string): Promise<ReadabilityMetrics> {
		return advancedReadabilityService.calculateMetrics(content);
	}

	/**
	 * Compare readability between two texts
	 */
	async compareReadability(text1: string, text2: string): Promise<ReadabilityComparison> {
		return advancedReadabilityService.compareReadability(text1, text2);
	}

	/**
	 * Analyze readability trends across document sections
	 */
	async analyzeReadabilityTrends(
		content: string,
		segments: number = 10
	): Promise<ReadabilityTrends> {
		return advancedReadabilityService.analyzeReadabilityTrends(content, segments);
	}

	/**
	 * Parse HTML content and extract text
	 */
	parseWebContent(
		html: string,
		baseUrl?: string,
		options?: ContentExtractionOptions
	): ParsedWebContent {
		return webContentParser.parseHtmlContent(html, baseUrl, options);
	}

	/**
	 * Convert HTML to Markdown
	 */
	convertHtmlToMarkdown(
		html: string,
		options?: { preserveImages?: boolean; preserveLinks?: boolean }
	): string {
		return webContentParser.htmlToMarkdown(html, options);
	}

	/**
	 * Extract research data from web content
	 */
	extractResearchData(parsedContent: ParsedWebContent, keywords?: string[]): ResearchData {
		return webContentParser.extractResearchData(parsedContent, keywords);
	}

	// Intelligent content streaming for very large documents
	async *analyzeContentStream(
		content: string,
		documentId: string,
		chunkSize = 10000
	): AsyncGenerator<Partial<ContentAnalysis>, ContentAnalysis, unknown> {
		const chunks = this.intelligentChunk(content, chunkSize);
		const partialResults: Partial<ContentAnalysis>[] = [];

		logger.debug('Starting streaming analysis', {
			documentId: truncate(documentId, 50),
			totalChunks: chunks.length,
			chunkSize,
			contentSize: formatBytes(content.length),
		});

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const chunkAnalysis = await this.analyzeContentDirect(
				chunk,
				`${documentId}-chunk-${i}`
			);

			partialResults.push(chunkAnalysis);

			// Yield progressive result
			const progressiveResult = this.mergePartialAnalyses(partialResults);
			progressiveResult.documentId = documentId;

			yield progressiveResult;
		}

		// Final comprehensive analysis
		return await this.analyzeContentDirect(content, documentId);
	}

	private intelligentChunk(content: string, targetSize: number): string[] {
		// Intelligent chunking that respects sentence and paragraph boundaries
		const chunks: string[] = [];
		const paragraphs = content.split(/\n\n+/);
		let currentChunk = '';

		for (const paragraph of paragraphs) {
			if (currentChunk.length + paragraph.length > targetSize && currentChunk.length > 0) {
				chunks.push(currentChunk.trim());
				currentChunk = paragraph;
			} else {
				currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
			}
		}

		if (currentChunk.trim()) {
			chunks.push(currentChunk.trim());
		}

		return chunks.length > 0 ? chunks : [content];
	}

	private mergePartialAnalyses(
		partialResults: Partial<ContentAnalysis>[]
	): Partial<ContentAnalysis> {
		if (partialResults.length === 0) return {};
		if (partialResults.length === 1) return partialResults[0];

		// Intelligent merging of analysis results
		const merged: Partial<ContentAnalysis> = {
			timestamp: new Date().toISOString(),
			metrics: this.mergeMetrics(
				partialResults.map((r) => r.metrics).filter((m): m is WritingMetrics => Boolean(m))
			),
			suggestions: partialResults.flatMap((r) => r.suggestions || []),
		};

		return merged;
	}

	private mergeMetrics(metricsArray: WritingMetrics[]): WritingMetrics | undefined {
		if (metricsArray.length === 0) return undefined;

		const totals = metricsArray.reduce((acc, curr) => ({
			wordCount: acc.wordCount + curr.wordCount,
			sentenceCount: acc.sentenceCount + curr.sentenceCount,
			paragraphCount: acc.paragraphCount + curr.paragraphCount,
			averageSentenceLength: acc.averageSentenceLength + curr.averageSentenceLength,
			averageParagraphLength: acc.averageParagraphLength + curr.averageParagraphLength,
			readingTime: acc.readingTime + curr.readingTime,
			fleschReadingEase: acc.fleschReadingEase + curr.fleschReadingEase,
			fleschKincaidGrade: acc.fleschKincaidGrade + curr.fleschKincaidGrade,
		}));

		return {
			...totals,
			averageSentenceLength: totals.averageSentenceLength / metricsArray.length,
			averageParagraphLength: totals.averageParagraphLength / metricsArray.length,
			fleschReadingEase: totals.fleschReadingEase / metricsArray.length,
			fleschKincaidGrade: totals.fleschKincaidGrade / metricsArray.length,
		};
	}

	// Fallback methods for graceful degradation
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

	private getDefaultEmotionalAnalysis(): EmotionalAnalysis {
		return {
			dominantEmotion: 'neutral',
			emotionalArc: [],
			tensionLevel: 50,
			moodConsistency: 75,
		};
	}

	private getDefaultPacingAnalysis(): PacingAnalysis {
		return {
			overall: 'moderate',
			sections: [],
			actionVsReflection: 1.0,
			recommendedAdjustments: [],
		};
	}

	private getMinimalAnalysis(
		documentId: string,
		textMetrics: ReturnType<typeof getTextMetrics>
	): ContentAnalysis {
		return {
			documentId,
			timestamp: new Date().toISOString(),
			metrics: {
				wordCount: textMetrics.wordCount,
				sentenceCount: textMetrics.sentenceCount,
				paragraphCount: textMetrics.paragraphCount,
				averageSentenceLength: textMetrics.averageWordsPerSentence,
				averageParagraphLength: textMetrics.averageWordsPerParagraph,
				readingTime: textMetrics.readingTimeMinutes,
				fleschReadingEase: 60,
				fleschKincaidGrade: 8,
			},
			style: this.getDefaultStyleAnalysis(),
			structure: {
				sceneBreaks: 0,
				chapters: 0,
				averageSceneLength: textMetrics.wordCount,
				openingStrength: 'moderate',
				endingStrength: 'moderate',
				hookPresence: false,
				cliffhangers: 0,
			},
			quality: this.getDefaultQualityIndicators(),
			suggestions: [],
			emotions: this.getDefaultEmotionalAnalysis(),
			pacing: this.getDefaultPacingAnalysis(),
		};
	}
}
