import { collectProseExamples } from 'narrative-lens';
// import type { ScrivenerDocument } from '../scrivener-project.js';
import { getLogger } from '../core/logger.js';
import { webContentParser } from '../services/web-content-parser.js';
import type {
	ContentExtractionOptions,
	ParsedWebContent,
	ReadabilityComparison,
	ReadabilityMetrics,
	ReadabilityTrends,
	ResearchData,
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
import { getWritingTextMetrics as getTextMetrics } from '../utils/text-metrics.js';

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
	unavailable?: string[];
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
	private disposed = false;
	private isProcessingQueue = false;
	private readonly maxCacheSize = 1000;

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
			this.memoizeAsync.bind(this)
		);

		this.styleAnalyzer = new StyleAnalyzer(this.predictiveStyleCache);

		this.structureAnalyzer = new StructureAnalyzer();

		this.qualityAnalyzer = new QualityAnalyzer(wordClassifier);

		this.emotionAnalyzer = new EmotionAnalyzer();

		this.pacingAnalyzer = new PacingAnalyzer();

		this.suggestionGenerator = new SuggestionGenerator();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.predictiveAnalysisCache.dispose();
		this.predictiveMetricsCache.dispose();
		this.predictiveStyleCache.dispose();
		this.memoizedCalculations.clear();
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
		if (!this.disposed) this.memoizedCalculations.set(key, result);
		return result;
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
		const contentHash = generateHash(content);
		const cacheKey = `analysis:availability-v2:${documentId}:${contentHash}`;
		const context = [documentId, 'content-analysis', contentHash.substring(0, 8)];

		// Try predictive cache first
		const cachedResult = await this.predictiveAnalysisCache
			.get(cacheKey, context, 'analysis-session')
			.catch(() => {
				logger.warn('Analysis cache read failed');
				return undefined;
			});
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
						required: false,
						minLength: 0,
						maxLength: 5_000_000,
					},
					documentId: { type: 'string', required: true, minLength: 1, maxLength: 255 },
				}
			);

			// Pre-calculate metrics once for reuse
			const textMetrics = getTextMetrics(content);
			const contentHash = generateHash(content);

			logger.debug('Analyzing content for document', {
				documentId: truncate(documentId, 50),
				contentHash: truncate(contentHash, 12),
				wordCount: textMetrics.wordCount,
				sentenceCount: textMetrics.sentenceCount,
				contentSize: formatBytes(content.length),
				readingTime: formatDuration(textMetrics.readingTimeMinutes * 60 * 1000),
			});

			// Execute analysis steps with optimized error handling
			const unavailable: string[] = [];
			const executionResult = await measureExecution(async () => {
				const fallback = this.getMinimalAnalysis(documentId, textMetrics);
				const attempt = async <T>(
					name: string,
					operation: () => T | Promise<T>,
					unavailableValue: T
				): Promise<T> => {
					try {
						return await operation();
					} catch {
						unavailable.push(name);
						logger.warn(`Analysis unavailable: ${name}`, { documentId });
						return unavailableValue;
					}
				};
				const metrics = await attempt(
					'metrics',
					() => this.metricsAnalyzer.calculateMetrics(content, textMetrics),
					fallback.metrics
				);
				const structure = await attempt(
					'structure',
					() => this.structureAnalyzer.analyzeStructure(content),
					fallback.structure
				);
				const proseFindings = await attempt(
					'prose',
					() => collectProseExamples([content]),
					[]
				);
				const style = await attempt(
					'style',
					() => this.styleAnalyzer.analyzeStyle(content, proseFindings),
					fallback.style
				);
				const quality = await attempt(
					'quality',
					() => this.qualityAnalyzer.assessQuality(content, proseFindings),
					fallback.quality
				);
				const emotions = await attempt(
					'emotions',
					() => this.emotionAnalyzer.analyzeEmotions(content),
					fallback.emotions
				);
				const pacing = await attempt(
					'pacing',
					() => this.pacingAnalyzer.analyzePacing(content),
					fallback.pacing
				);
				const nativeSuggestions: Suggestion[] = proseFindings.map((finding) => ({
					type: 'style',
					severity: 'minor',
					issue: finding.issueType,
					suggestion: finding.suggestion,
					example: finding.snippet,
				}));
				const suggestions = await attempt(
					'suggestions',
					() =>
						this.suggestionGenerator.generateSuggestions(
							content,
							metrics,
							style,
							quality,
							proseFindings
						),
					nativeSuggestions
				);
				return {
					unavailable,
					...fallback,
					metrics,
					structure,
					style,
					quality,
					emotions,
					pacing,
					suggestions,
				};
			});

			logger.debug('Content analysis completed', {
				documentId: truncate(documentId, 50),
				executionTime: formatDuration(executionResult.ms),
				cacheKey: `analysis:availability-v2:${documentId}:${truncate(contentHash, 8)}`,
			});

			// Store result in predictive cache for future access
			if (
				unavailable.length === 0 &&
				executionResult.result.style.sentenceVariety !== 'unavailable'
			)
				await this.predictiveAnalysisCache
					.set(cacheKey, executionResult.result, context, 'analysis-session')
					.catch(() => logger.warn('Analysis cache write failed'));

			return executionResult.result;
		} catch (error) {
			throw new Error(`ContentAnalyzer.analyzeContent failed: ${(error as Error).message}`, {
				cause: error,
			});
		}
	}

	async getAdvancedReadabilityAnalysis(content: string): Promise<ReadabilityMetrics> {
		return advancedReadabilityService.calculateMetrics(content);
	}

	/**
	 * Compare readability between two texts
	 */
	async compareReadability(text1: string, text2: string): Promise<ReadabilityComparison> {
		return advancedReadabilityService.compareReadability(text1, text2);
	}

	async analyzeReadabilityTrends(
		content: string,
		segments: number = 10
	): Promise<ReadabilityTrends> {
		return advancedReadabilityService.analyzeReadabilityTrends(content, segments);
	}

	parseWebContent(
		html: string,
		baseUrl?: string,
		options?: ContentExtractionOptions
	): ParsedWebContent {
		return webContentParser.parseHtmlContent(html, baseUrl, options);
	}

	convertHtmlToMarkdown(
		html: string,
		options?: { preserveImages?: boolean; preserveLinks?: boolean }
	): string {
		return webContentParser.htmlToMarkdown(html, options);
	}

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

		const totals = metricsArray.reduce(
			(acc, curr) => ({
				wordCount: acc.wordCount + curr.wordCount,
				sentenceCount: acc.sentenceCount + curr.sentenceCount,
				paragraphCount: acc.paragraphCount + curr.paragraphCount,
			}),
			{ wordCount: 0, sentenceCount: 0, paragraphCount: 0 }
		);

		return {
			...totals,
			averageSentenceLength: totals.sentenceCount
				? totals.wordCount / totals.sentenceCount
				: null,
			averageParagraphLength: totals.paragraphCount
				? totals.wordCount / totals.paragraphCount
				: null,
			readingTime: Math.ceil(totals.wordCount / 250),
			// Clamped native scores cannot be aggregated; final analysis measures the complete source.
			fleschReadingEase: null,
			fleschKincaidGrade: null,
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
				fleschReadingEase: null,
				fleschKincaidGrade: null,
			},
			style: this.styleAnalyzer.getDefaultStyleAnalysis(),
			structure: {
				sceneBreaks: null,
				chapters: null,
				averageSceneLength: null,
				openingStrength: 'unassessed',
				endingStrength: 'unavailable',
				hookPresence: null,
				cliffhangers: null,
			},
			quality: this.qualityAnalyzer.getDefaultQualityIndicators(),
			suggestions: [],
			emotions: this.emotionAnalyzer.getDefaultEmotionalAnalysis(),
			pacing: this.pacingAnalyzer.getDefaultPacingAnalysis(),
		};
	}
}
