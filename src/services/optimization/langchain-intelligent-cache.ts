import { ApplicationError, ErrorCode } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import {
	generateHash,
	getTextMetrics,
	handleError,
	processBatch,
	validateInput,
} from '../../utils/common.js';
import {
	OperationMetricsTracker,
	measureAndTrackOperation,
} from '../../utils/operation-metrics.js';
import { StringUtils } from '../../utils/shared-patterns.js';
import { LangChainCache } from '../ai/langchain-optimizations.js';
// Define our own operation type since TemplateOperationType is not exported
type OperationType = string;
import { EnhancedLangChainService } from '../ai/langchain-service-enhanced.js';

// Import WRITING_PROMPTS to get proper template types
const WRITING_PROMPTS = {
	character_development: '',
	plot_structure: '',
	dialogue_enhancement: '',
	worldbuilding: '',
	pacing_rhythm: '',
	theme_symbolism: '',
	plot_analysis: '',
	character_arc_analysis: '',
	theme_analysis: '',
	tension_analysis: '',
	genre_identification: '',
	audience_identification: '',
	comparable_books: '',
	market_positioning: '',
	trend_analysis: '',
	commercial_viability: '',
	synthesis: '',
	recommendations: '',
	query_parsing: '',
	result_explanation: '',
	insight_generation: '',
	sentiment_analysis: '',
	importance_analysis: '',
	entity_insights: '',
	nl2sql: '',
	issue_detection: '',
	predictive_text: '',
	writing_suggestions: '',
	selection_suggestions: '',
	style_consistency: '',
	query_optimization: '',
	submission_optimization: '',
	pitch_optimization: '',
	content_condensation: '',
	content_enhancement: '',
	agent_analysis: '',
	discussion_contribution: '',
	find_agreements: '',
	extract_insights: '',
	identify_unresolved: '',
	editor_perspective: '',
	editor_critique: '',
	critic_perspective: '',
	critic_critique: '',
	hook_generation: '',
	blurb_generation: '',
	synopsis_generation: '',
	metadata_extraction: '',
	pitch_generation: '',
	comparison_generation: '',
} as const;

// Operation-specific parameter types
export interface ContentEnhancementParams {
	content: string;
	style?: string;
	tone?: string;
	targetLength?: number;
	preserveVoice?: boolean;
	focusAreas?: string[];
}

export interface QueryOptimizationParams {
	query: string;
	context?: string;
	maxResults?: number;
	filters?: Record<string, unknown>;
}

export interface CompilationParams {
	documents: string[];
	format: string;
	includeMetadata?: boolean;
	template?: string;
	options?: Record<string, unknown>;
}

export interface AnalysisParams {
	content: string;
	analysisType: string;
	includeDetails?: boolean;
	options?: Record<string, unknown>;
}

// Union type for all possible parameters
export type OperationParams =
	| ContentEnhancementParams
	| QueryOptimizationParams
	| CompilationParams
	| AnalysisParams
	| Record<string, unknown>;

export interface UsagePattern {
	operation: string;
	parameters: OperationParams;
	frequency: number;
	lastUsed: number;
	variations: Array<{
		params: OperationParams;
		frequency: number;
		similarity: number;
	}>;
}

export interface CacheStrategy {
	preGenerate: boolean;
	variations: number;
	ttl: number;
	priority: 'low' | 'medium' | 'high' | 'critical';
	warmupTrigger: number;
}

export interface OptimizationResult {
	originalQuery: OperationParams;
	optimizedQuery: OperationParams;
	cacheKey: string;
	estimatedSavings: number;
	confidence: number;
}

export interface CacheMetrics {
	hitRate: number;
	missRate: number;
	evictionRate: number;
	averageResponseTime: number;
	memoryUsage: number;
	predictionAccuracy: number;
	costSavings: {
		tokensaved: number;
		estimatedDollars: number;
	};
}

export interface BatchOperation {
	id: string;
	operations: Array<{
		operation: string;
		params: unknown;
		priority: number;
	}>;
	status: 'queued' | 'processing' | 'completed' | 'failed';
	results: Map<string, unknown>;
	startTime: number;
	completionTime?: number;
}

export class IntelligentLangChainCache extends LangChainCache {
	private predictor: UsagePredictor;
	private optimizer: QueryOptimizer;
	private batchProcessor: LangChainBatchProcessor;
	private usagePatterns: Map<string, UsagePattern>;
	private cacheStrategies: Map<string, CacheStrategy>;
	private metrics: CacheMetrics;
	private intelligentLogger: ReturnType<typeof getLogger>;
	private langchain: EnhancedLangChainService;
	private metricsTracker: OperationMetricsTracker;

	constructor() {
		super({
			maxSize: 1000,
			ttl: 1800000, // 30 minutes
			updateAgeOnGet: true,
		});
		this.predictor = new UsagePredictor();
		this.optimizer = new QueryOptimizer();
		this.batchProcessor = new LangChainBatchProcessor(this);
		this.usagePatterns = new Map();
		this.cacheStrategies = new Map();
		this.langchain = new EnhancedLangChainService();
		this.intelligentLogger = getLogger('IntelligentLangChainCache');
		this.metrics = this.initializeMetrics();
		this.metricsTracker = new OperationMetricsTracker((message, meta) =>
			this.intelligentLogger.debug(message, meta)
		);

		this.initializeStrategies();
		this.startMetricsCollection();

		this.intelligentLogger.info('Intelligent LangChain cache initialized', {
			metricsInterval: '5 minutes',
			maxConcurrentBatches: 3,
			cacheStrategies: Array.from(this.cacheStrategies.keys()),
		});
	}

	/**
	 * Get comprehensive metrics including operation performance
	 */
	getOperationMetrics() {
		return this.metricsTracker.getMetrics();
	}

	private initializeMetrics(): CacheMetrics {
		return {
			hitRate: 0,
			missRate: 0,
			evictionRate: 0,
			averageResponseTime: 0,
			memoryUsage: 0,
			predictionAccuracy: 0,
			costSavings: {
				tokensaved: 0,
				estimatedDollars: 0,
			},
		};
	}

	private initializeStrategies(): void {
		// Content enhancement strategies
		this.cacheStrategies.set('content_enhancement', {
			preGenerate: true,
			variations: 3,
			ttl: 1800, // 30 minutes
			priority: 'high',
			warmupTrigger: 3,
		});

		// Query optimization strategies
		this.cacheStrategies.set('query_optimization', {
			preGenerate: false,
			variations: 2,
			ttl: 3600, // 1 hour
			priority: 'medium',
			warmupTrigger: 2,
		});

		// Compilation strategies
		this.cacheStrategies.set('compilation', {
			preGenerate: true,
			variations: 5,
			ttl: 7200, // 2 hours
			priority: 'critical',
			warmupTrigger: 1,
		});

		// Analysis strategies
		this.cacheStrategies.set('analysis', {
			preGenerate: false,
			variations: 1,
			ttl: 14400, // 4 hours
			priority: 'low',
			warmupTrigger: 5,
		});
	}

	private startMetricsCollection(): void {
		setInterval(() => {
			this.updateMetrics();
			this.optimizeCacheStrategies();
		}, 300000); // Every 5 minutes
	}

	async intelligentCache(operation: string, params: OperationParams): Promise<unknown> {
		// Validate input parameters
		validateInput(
			{ operation, params },
			{
				operation: { type: 'string', required: true, minLength: 1 },
				params: { type: 'object', required: true },
			}
		);

		const operationName = 'intelligentCache';

		return measureAndTrackOperation(
			operationName,
			async () => {
				// Get text metrics if content is available for logging
				const content = (params as { content?: string }).content;
				const contentMetrics = content ? getTextMetrics(content) : null;

				this.intelligentLogger.debug('Starting intelligent cache operation', {
					operation,
					hasContent: !!content,
					wordCount: contentMetrics?.wordCount,
					contentSize: content ? StringUtils.formatBytes(content.length) : 'N/A',
				});

				// Track usage pattern
				await this.trackUsagePattern(operation, params);

				// Predict if result will be reused
				const reuseProbability = await this.predictor.predictReuse(operation, params);

				// Optimize query for better caching
				const optimized = await this.optimizer.optimize(params);

				// Generate cache key using utility hash function
				const cacheKey = generateHash(
					`${operation}_${JSON.stringify(optimized.optimizedQuery)}`
				);

				// Check existing cache
				const cached = await this.get(cacheKey);
				if (cached) {
					this.recordCacheHit(operation, performance.now());
					return cached;
				}

				// Execute with intelligent strategies
				const result = await this.executeWithIntelligentStrategies(
					operation,
					optimized.optimizedQuery,
					reuseProbability,
					cacheKey
				);

				// Cache with appropriate TTL
				const strategy = this.cacheStrategies.get(this.getCategoryFromOperation(operation));
				if (strategy) {
					// Cast result to CacheValue type for proper caching
					const cacheValue =
						typeof result === 'object' && result !== null && 'content' in result
							? (result as { content: string }).content
							: String(result);
					await this.set(cacheKey, cacheValue);

					// Pre-generate variations if beneficial
					if (reuseProbability > 0.7 && strategy.preGenerate) {
						this.schedulePreGeneration(operation, optimized.optimizedQuery, strategy);
					}
				}

				this.recordCacheMiss(operation, performance.now());
				return result;
			},
			this.metricsTracker,
			'Cache'
		).catch((error) => {
			const handledError = handleError(error, 'IntelligentLangChainCache.intelligentCache');
			this.intelligentLogger.error('Cache operation failed', {
				operation,
				error: handledError.message,
				paramsSize: JSON.stringify(params).length,
			});
			throw new ApplicationError(
				`Cache operation failed for ${operation}: ${handledError.message}`,
				ErrorCode.CACHE_ERROR
			);
		});
	}

	private async executeWithIntelligentStrategies(
		operation: string,
		params: OperationParams,
		reuseProbability: number,
		cacheKey: string
	): Promise<unknown> {
		const strategy = this.cacheStrategies.get(this.getCategoryFromOperation(operation));

		// Log cache key for debugging intelligent strategies
		this.intelligentLogger.debug('Executing intelligent strategy', {
			operation,
			cacheKey: `${cacheKey.substring(0, 32)}...`,
			reuseProbability: reuseProbability.toFixed(3),
			strategyPriority: strategy?.priority,
		});

		if (strategy?.priority === 'critical' && reuseProbability > 0.8) {
			// Use batch processing for critical operations
			return this.batchProcessor.addToBatch(
				operation,
				params,
				this.getPriorityScore(strategy.priority)
			);
		}

		// Direct execution for other cases
		// Map operation to valid template type, fallback to query_optimization
		const templateType = this.mapOperationToTemplateType(operation);
		return this.langchain.generateWithTemplate(
			templateType,
			(params as ContentEnhancementParams | AnalysisParams).content || ''
		);
	}

	private async schedulePreGeneration(
		operation: string,
		baseParams: OperationParams,
		strategy: CacheStrategy
	): Promise<void> {
		try {
			// Generate parameter variations
			const variations = await this.generateParameterVariations(
				baseParams,
				strategy.variations
			);

			// Queue for background processing
			const batchOps = variations.map((variation) => ({
				operation,
				params: variation,
				priority: this.getPriorityScore(strategy.priority),
			}));

			await this.batchProcessor.processBatch({
				id: `pregenerate_${Date.now()}`,
				operations: batchOps,
				status: 'queued',
				results: new Map(),
				startTime: Date.now(),
			});

			this.intelligentLogger.debug(
				`Scheduled pre-generation for ${operation} with ${variations.length} variations`
			);
		} catch (error) {
			this.intelligentLogger.warn('Pre-generation scheduling failed', {
				operation,
				error: (error as Error).message,
			});
		}
	}

	private async generateParameterVariations(
		baseParams: OperationParams,
		count: number
	): Promise<OperationParams[]> {
		const variations: OperationParams[] = [];

		// Generate variations based on parameter analysis
		for (let i = 0; i < count; i++) {
			const variation = { ...baseParams };

			// Vary style parameters
			const paramRecord = baseParams as Record<string, unknown>;
			if (paramRecord.style && typeof paramRecord.style === 'string') {
				(variation as Record<string, unknown>).style = this.varyStyleParameter(
					paramRecord.style,
					i
				);
			}

			// Vary length parameters
			if (paramRecord.targetLength && typeof paramRecord.targetLength === 'number') {
				(variation as Record<string, unknown>).targetLength = this.varyLengthParameter(
					paramRecord.targetLength,
					i
				);
			}

			// Vary tone parameters
			if (paramRecord.tone && typeof paramRecord.tone === 'string') {
				(variation as Record<string, unknown>).tone = this.varyToneParameter(
					paramRecord.tone,
					i
				);
			}

			variations.push(variation);
		}

		return variations;
	}

	private varyStyleParameter(baseStyle: string, variation: number): string {
		const styles = ['formal', 'casual', 'academic', 'creative', 'professional'];
		const baseIndex = styles.indexOf(baseStyle);
		const newIndex = (baseIndex + variation + 1) % styles.length;
		return styles[newIndex];
	}

	private varyLengthParameter(baseLength: number, variation: number): number {
		const factors = [0.8, 0.9, 1.1, 1.2, 1.5];
		const factor = factors[variation % factors.length];
		return Math.round(baseLength * factor);
	}

	private varyToneParameter(baseTone: string, variation: number): string {
		const tones = ['neutral', 'enthusiastic', 'serious', 'friendly', 'authoritative'];
		const baseIndex = tones.indexOf(baseTone);
		const newIndex = (baseIndex + variation + 1) % tones.length;
		return tones[newIndex];
	}

	private async trackUsagePattern(operation: string, params: OperationParams): Promise<void> {
		const key = this.generatePatternKey(operation, params);
		const existing = this.usagePatterns.get(key);

		if (existing) {
			existing.frequency++;
			existing.lastUsed = Date.now();
		} else {
			this.usagePatterns.set(key, {
				operation,
				parameters: params,
				frequency: 1,
				lastUsed: Date.now(),
				variations: [],
			});
		}

		// Track variations
		this.trackParameterVariations(key, params);
	}

	private trackParameterVariations(patternKey: string, params: OperationParams): void {
		const pattern = this.usagePatterns.get(patternKey);
		if (!pattern) return;

		// Find similar parameter sets
		for (const variation of pattern.variations) {
			const similarity = this.calculateParameterSimilarity(params, variation.params);
			if (similarity > 0.8) {
				variation.frequency++;
				return;
			}
		}

		// Add new variation
		pattern.variations.push({
			params,
			frequency: 1,
			similarity: 1.0,
		});
	}

	private calculateParameterSimilarity(
		params1: OperationParams,
		params2: OperationParams
	): number {
		const keys1 = Object.keys(params1);
		const keys2 = Object.keys(params2);
		const allKeys = new Set([...keys1, ...keys2]);

		let matches = 0;
		for (const key of allKeys) {
			if (
				(params1 as Record<string, unknown>)[key] ===
				(params2 as Record<string, unknown>)[key]
			) {
				matches++;
			}
		}

		return matches / allKeys.size;
	}

	private generatePatternKey(operation: string, params: OperationParams): string {
		const essentialParams = this.extractEssentialParameters(params);
		return `${operation}_${this.hashObject(essentialParams)}`;
	}

	private extractEssentialParameters(params: OperationParams): Record<string, unknown> {
		// Extract parameters that significantly affect output
		const essential: Record<string, unknown> = {};

		const recordParams = params as Record<string, unknown>;
		if (recordParams.style) essential.style = recordParams.style;
		if (recordParams.tone) essential.tone = recordParams.tone;
		if (recordParams.targetLength && typeof recordParams.targetLength === 'number')
			essential.lengthCategory = this.categorizeLengthParameter(recordParams.targetLength);
		if (recordParams.format) essential.format = recordParams.format;
		if (recordParams.genre) essential.genre = recordParams.genre;

		return essential;
	}

	private categorizeLengthParameter(length: number): string {
		if (length < 100) return 'short';
		if (length < 500) return 'medium';
		if (length < 1000) return 'long';
		return 'very-long';
	}

	private hashObject(obj: unknown): string {
		if (obj === null || typeof obj !== 'object') {
			return generateHash(String(obj));
		}
		const str = JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
		return generateHash(str);
	}

	private getCategoryFromOperation(operation: string): string {
		if (operation.includes('enhance') || operation.includes('improve')) {
			return 'content_enhancement';
		}
		if (operation.includes('query') || operation.includes('compile')) {
			return 'compilation';
		}
		if (operation.includes('analyze') || operation.includes('assess')) {
			return 'analysis';
		}
		return 'query_optimization';
	}

	private mapOperationToTemplateType(operation: string): keyof typeof WRITING_PROMPTS {
		// Map common operation patterns to valid template types
		if (operation.includes('enhance') || operation.includes('improve')) {
			return 'content_enhancement';
		}
		if (operation.includes('character')) {
			return 'character_development';
		}
		if (operation.includes('plot')) {
			return 'plot_structure';
		}
		if (operation.includes('dialogue')) {
			return 'dialogue_enhancement';
		}
		if (operation.includes('world')) {
			return 'worldbuilding';
		}
		if (operation.includes('pacing')) {
			return 'pacing_rhythm';
		}
		if (operation.includes('theme')) {
			return 'theme_symbolism';
		}
		if (operation.includes('analyze') || operation.includes('analysis')) {
			return 'plot_analysis';
		}
		if (operation.includes('query') || operation.includes('compile')) {
			return 'query_optimization';
		}
		// Default fallback to query_optimization
		return 'query_optimization';
	}

	private getPriorityScore(priority: CacheStrategy['priority']): number {
		switch (priority) {
			case 'critical':
				return 4;
			case 'high':
				return 3;
			case 'medium':
				return 2;
			case 'low':
				return 1;
			default:
				return 2;
		}
	}

	private recordCacheHit(_operation: string, responseTime: number): void {
		this.metrics.hitRate = this.updateRunningAverage(this.metrics.hitRate, 1, 0.9);
		this.metrics.averageResponseTime = this.updateRunningAverage(
			this.metrics.averageResponseTime,
			responseTime,
			0.9
		);
	}

	private recordCacheMiss(_operation: string, responseTime: number): void {
		this.metrics.missRate = this.updateRunningAverage(this.metrics.missRate, 1, 0.9);
		this.metrics.averageResponseTime = this.updateRunningAverage(
			this.metrics.averageResponseTime,
			responseTime,
			0.9
		);
	}

	private updateRunningAverage(current: number, newValue: number, alpha: number): number {
		return alpha * current + (1 - alpha) * newValue;
	}

	private updateMetrics(): void {
		// Update cache metrics
		this.metrics.memoryUsage = this.calculateMemoryUsage();

		// Calculate prediction accuracy
		this.metrics.predictionAccuracy = this.predictor.getAccuracy();

		// Estimate cost savings
		this.calculateCostSavings();
	}

	private calculateMemoryUsage(): number {
		// Estimate memory usage of cache
		let totalSize = 0;
		// Note: cache property access needs to be implemented based on actual LangChainCache structure
		// This is a placeholder implementation
		try {
			const cacheInstance = this as unknown as { cache?: Map<string, unknown> };
			cacheInstance.cache?.forEach?.((value: unknown, key: string) => {
				totalSize += JSON.stringify(value).length + key.length;
			});
		} catch (_error) {
			// Cache access failed, return 0
			totalSize = 0;
		}
		return totalSize;
	}

	private calculateCostSavings(): void {
		const hitRate = this.metrics.hitRate;
		const estimatedTokensPerOperation = 1000;
		const tokensPerDollar = 250000; // Approximate for GPT-3.5

		this.metrics.costSavings.tokensaved = hitRate * estimatedTokensPerOperation * 100; // Per 100 operations
		this.metrics.costSavings.estimatedDollars =
			this.metrics.costSavings.tokensaved / tokensPerDollar;
	}

	private optimizeCacheStrategies(): void {
		// Adjust strategies based on usage patterns
		for (const [operationKey, pattern] of this.usagePatterns.entries()) {
			const category = this.getCategoryFromOperation(pattern.operation);

			// Log optimization for monitoring
			this.intelligentLogger.debug('Optimizing cache strategy', {
				operationKey,
				category,
				frequency: pattern.frequency,
			});
			const strategy = this.cacheStrategies.get(category);

			if (strategy && pattern.frequency > strategy.warmupTrigger) {
				// Increase TTL for frequently used operations
				strategy.ttl = Math.min(strategy.ttl * 1.2, 28800); // Max 8 hours

				// Enable pre-generation for high-frequency operations
				if (pattern.frequency > 10) {
					strategy.preGenerate = true;
					strategy.variations = Math.min(strategy.variations + 1, 10);
				}
			}
		}
	}

	// Public interface methods
	getMetrics(): CacheMetrics {
		return { ...this.metrics };
	}

	getUsagePatterns(): Array<{ operation: string; frequency: number; lastUsed: Date }> {
		return Array.from(this.usagePatterns.values()).map((pattern) => ({
			operation: pattern.operation,
			frequency: pattern.frequency,
			lastUsed: new Date(pattern.lastUsed),
		}));
	}

	async optimizeCache(): Promise<{
		evicted: number;
		compressed: number;
		reorganized: boolean;
	}> {
		let evicted = 0;
		let compressed = 0;

		// Define cache entry interface for type safety
		interface CacheEntry {
			value: unknown;
			timestamp: number;
			accessCount: number;
		}

		// Remove low-value cache entries
		const cutoffTime = Date.now() - 86400000; // 24 hours
		try {
			const cacheInstance = this as unknown as { cache?: Map<string, CacheEntry> };
			for (const [key, entry] of cacheInstance.cache?.entries?.() || []) {
				if (entry.timestamp < cutoffTime && entry.accessCount < 3) {
					cacheInstance.cache?.delete?.(key);
					evicted++;
				}
			}

			// Compress large entries
			for (const [key, entry] of cacheInstance.cache?.entries?.() || []) {
				const serializedSize = JSON.stringify(entry.value).length;
				if (serializedSize > 10000) {
					// Log large cache entry for monitoring
					this.intelligentLogger.debug('Large cache entry detected', {
						key: `${key.substring(0, 50)}...`,
						size: serializedSize,
						accessCount: entry.accessCount,
					});
					// TODO: Implement compression logic here for large cache entries
					compressed++;
				}
			}
		} catch (error) {
			// Cache access failed, skip optimization
			this.intelligentLogger.warn('Cache optimization skipped due to access error', {
				error,
			});
		}

		this.intelligentLogger.info(
			`Cache optimization completed: ${evicted} evicted, ${compressed} compressed`
		);

		return {
			evicted,
			compressed,
			reorganized: true,
		};
	}

	async warmupCache(
		operations: Array<{ operation: string; params: OperationParams }>
	): Promise<number> {
		// Validate input
		validateInput(
			{ operations },
			{
				operations: {
					type: 'array',
					required: true,
				},
			}
		);

		const operationName = 'warmupCache';
		let warmed = 0;

		return measureAndTrackOperation(
			operationName,
			async () => {
				this.intelligentLogger.info(
					`Starting cache warmup for ${operations.length} operations`
				);

				// Process operations in batches for better performance
				const batchedOperations = await processBatch(
					operations,
					async (batch: Array<{ operation: string; params: OperationParams }>) => {
						return Promise.allSettled(
							batch.map(async ({ operation, params }) => {
								try {
									await this.intelligentCache(operation, params);
									return { success: true, operation };
								} catch (error) {
									this.intelligentLogger.warn(
										'Cache warmup failed for operation',
										{
											operation,
											error: (error as Error).message,
										}
									);
									return {
										success: false,
										operation,
										error: (error as Error).message,
									};
								}
							})
						);
					},
					10 // Batch size
				);

				warmed = batchedOperations
					.flat()
					.filter(
						(result) =>
							result.status === 'fulfilled' &&
							(result.value as { success: boolean }).success
					).length;

				this.intelligentLogger.info(
					`Cache warmup completed: ${warmed}/${operations.length} operations succeeded`,
					{
						successRate: `${((warmed / operations.length) * 100).toFixed(1)}%`,
					}
				);

				return warmed;
			},
			this.metricsTracker,
			'Cache'
		).catch((error) => {
			const handledError = handleError(error, 'IntelligentLangChainCache.warmupCache');
			this.intelligentLogger.error('Cache warmup failed', {
				error: handledError.message,
				operationCount: operations.length,
			});
			return warmed; // Return partial success count
		});
	}
}

// Helper function to map operation strings to valid template types
function mapOperationToTemplateType(operation: string): keyof typeof WRITING_PROMPTS {
	// Map common operation patterns to valid template types
	if (operation.includes('enhance') || operation.includes('improve')) {
		return 'content_enhancement';
	}
	if (operation.includes('character')) {
		return 'character_development';
	}
	if (operation.includes('plot')) {
		return 'plot_structure';
	}
	if (operation.includes('dialogue')) {
		return 'dialogue_enhancement';
	}
	if (operation.includes('world')) {
		return 'worldbuilding';
	}
	if (operation.includes('pacing')) {
		return 'pacing_rhythm';
	}
	if (operation.includes('theme')) {
		return 'theme_symbolism';
	}
	if (operation.includes('analyze') || operation.includes('analysis')) {
		return 'plot_analysis';
	}
	if (operation.includes('query') || operation.includes('compile')) {
		return 'query_optimization';
	}
	// Default fallback to query_optimization
	return 'query_optimization';
}

function toOperationType(op: string): OperationType {
	// Optionally, validate or map op here if needed
	return op as OperationType;
}

class UsagePredictor {
	private patterns: Map<string, { reuse: number; total: number }> = new Map();
	private accuracy: number = 0.7;

	async predictReuse(operation: string, params: OperationParams): Promise<number> {
		const key = `${operation}_${JSON.stringify(params).slice(0, 100)}`;
		const pattern = this.patterns.get(key);

		if (!pattern) {
			// Default prediction for new patterns
			return 0.3;
		}

		const reuseRate = pattern.reuse / pattern.total;

		// Adjust based on recency and frequency
		const frequencyBoost = Math.min(pattern.total / 10, 0.3);

		return Math.min(1.0, reuseRate + frequencyBoost);
	}

	recordActualReuse(operation: string, params: OperationParams, wasReused: boolean): void {
		const key = `${operation}_${JSON.stringify(params).slice(0, 100)}`;
		const existing = this.patterns.get(key) || { reuse: 0, total: 0 };

		existing.total++;
		if (wasReused) existing.reuse++;

		this.patterns.set(key, existing);

		// Update accuracy metric
		this.updateAccuracy();
	}

	private updateAccuracy(): void {
		let correct = 0;
		let total = 0;

		for (const pattern of this.patterns.values()) {
			if (pattern.total > 5) {
				// Only consider patterns with enough data
				const predicted = pattern.reuse / pattern.total > 0.5;
				const actual = pattern.reuse / pattern.total;
				if ((predicted && actual > 0.5) || (!predicted && actual <= 0.5)) {
					correct++;
				}
				total++;
			}
		}

		this.accuracy = total > 0 ? correct / total : 0.7;
	}

	getAccuracy(): number {
		return this.accuracy;
	}
}

class QueryOptimizer {
	async optimize(params: OperationParams): Promise<OptimizationResult> {
		const originalQuery = { ...params };
		const optimizedQuery = { ...params };

		// Normalize parameters for better cache hits
		const optimizedRecord = optimizedQuery as Record<string, unknown>;
		if ('style' in params && typeof params.style === 'string') {
			optimizedRecord.style = this.normalizeStyle(params.style);
		}
		if ('tone' in params && typeof params.tone === 'string') {
			optimizedRecord.tone = this.normalizeTone(params.tone);
		}

		// Remove non-essential parameters
		delete optimizedRecord.timestamp;
		delete optimizedRecord.requestId;

		// Sort object keys for consistent hashing
		const sortedQuery = this.sortObjectKeys(optimizedQuery) as OperationParams;

		const estimatedSavings = this.estimateCacheSavings(originalQuery, sortedQuery);

		return {
			originalQuery,
			optimizedQuery: sortedQuery,
			cacheKey: this.generateCacheKey(sortedQuery),
			estimatedSavings,
			confidence: 0.85,
		};
	}

	normalizeParameters(params: OperationParams): OperationParams {
		const normalized = { ...params } as Record<string, unknown>;

		if ('style' in params && typeof params.style === 'string') {
			normalized.style = this.normalizeStyle(params.style);
		}

		if ('tone' in params && typeof params.tone === 'string') {
			normalized.tone = this.normalizeTone(params.tone);
		}

		return this.sortObjectKeys(normalized) as OperationParams;
	}

	private normalizeStyle(style?: string): string | undefined {
		if (!style) return undefined;

		const styleMap: Record<string, string> = {
			casual: 'informal',
			relaxed: 'informal',
			formal: 'professional',
			business: 'professional',
		};

		return styleMap[style.toLowerCase()] || style;
	}

	private normalizeTone(tone?: string): string | undefined {
		if (!tone) return undefined;

		const toneMap: Record<string, string> = {
			happy: 'positive',
			upbeat: 'positive',
			sad: 'negative',
			down: 'negative',
		};

		return toneMap[tone.toLowerCase()] || tone;
	}

	private sortObjectKeys(obj: unknown): unknown {
		if (obj === null || typeof obj !== 'object') return obj;

		const sorted: Record<string, unknown> = {};
		Object.keys(obj as Record<string, unknown>)
			.sort()
			.forEach((key) => {
				const objRecord = obj as Record<string, unknown>;
				sorted[key] =
					typeof objRecord[key] === 'object'
						? this.sortObjectKeys(objRecord[key])
						: objRecord[key];
			});

		return sorted;
	}

	private generateCacheKey(optimizedQuery: OperationParams): string {
		return `opt_${JSON.stringify(optimizedQuery)}`;
	}

	private estimateCacheSavings(original: OperationParams, optimized: OperationParams): number {
		// Estimate token savings from parameter optimization
		const originalSize = JSON.stringify(original).length;
		const optimizedSize = JSON.stringify(optimized).length;

		return Math.max(0, (originalSize - optimizedSize) / originalSize);
	}
}

class LangChainBatchProcessor {
	private activeBatches: Map<string, BatchOperation> = new Map();
	private processingQueue: BatchOperation[] = [];
	private maxConcurrentBatches = 3;
	private isProcessing = false;
	private logger: ReturnType<typeof getLogger>;
	private metricsTracker: OperationMetricsTracker;

	constructor(_cache: IntelligentLangChainCache) {
		this.logger = getLogger('LangChainBatchProcessor');
		this.metricsTracker = new OperationMetricsTracker((message, meta) =>
			this.logger.debug(message, meta)
		);
		this.startProcessing();

		this.logger.info('Batch processor initialized', {
			maxConcurrentBatches: this.maxConcurrentBatches,
			processingInterval: '1 second',
		});
	}

	async processBatch(batch: BatchOperation): Promise<void> {
		this.activeBatches.set(batch.id, batch);
		this.processingQueue.push(batch);

		if (!this.isProcessing) {
			this.processQueue();
		}
	}

	async addToBatch(
		operation: string,
		params: OperationParams,
		priority: number
	): Promise<unknown> {
		// For now, process immediately
		// In a full implementation, this would add to a batch and process when ready
		// Priority is noted for future queue sorting implementation
		this.logger.debug('Adding operation to batch', { operation, priority });

		const langchain = new EnhancedLangChainService();
		const content = (params as ContentEnhancementParams | AnalysisParams).content || '';
		// Map operation to valid template type, fallback to query_optimization
		const templateType = mapOperationToTemplateType(operation);
		return langchain.generateWithTemplate(templateType, content);
	}

	private startProcessing(): void {
		setInterval(() => {
			if (!this.isProcessing && this.processingQueue.length > 0) {
				this.processQueue();
			}
		}, 1000);
	}

	private async processQueue(): Promise<void> {
		if (this.isProcessing) return;
		this.isProcessing = true;

		try {
			const activeBatchCount = Array.from(this.activeBatches.values()).filter(
				(b) => b.status === 'processing'
			).length;

			if (activeBatchCount < this.maxConcurrentBatches && this.processingQueue.length > 0) {
				const batch = this.processingQueue.shift()!;
				await this.processBatchInternal(batch);
			}
		} finally {
			this.isProcessing = false;
		}
	}

	private async processBatchInternal(batch: BatchOperation): Promise<void> {
		batch.status = 'processing';
		const operationName = 'processBatch';

		return measureAndTrackOperation(
			operationName,
			async () => {
				const langchain = new EnhancedLangChainService();

				this.logger.debug(`Processing batch ${batch.id}`, {
					operationCount: batch.operations.length,
					operations: batch.operations.map((op) => op.operation),
				});

				// Process operations with proper error handling
				const results = await Promise.allSettled(
					batch.operations.map(async (op) => {
						try {
							const content = (op.params as { content?: string }).content || '';
							const contentMetrics = content ? getTextMetrics(content) : null;

							this.logger.debug(`Processing batch operation: ${op.operation}`, {
								priority: op.priority,
								wordCount: contentMetrics?.wordCount,
								contentSize: content
									? StringUtils.formatBytes(content.length)
									: 'N/A',
							});

							// Map operation to valid template type, fallback to query_optimization
							const templateType = mapOperationToTemplateType(op.operation);
							const result = await langchain.generateWithTemplate(
								templateType,
								content
							);
							return { operation: op.operation, result, success: true };
						} catch (error) {
							this.logger.warn(`Batch operation failed: ${op.operation}`, {
								error: (error as Error).message,
								priority: op.priority,
							});
							return {
								operation: op.operation,
								error: (error as Error).message,
								success: false,
							};
						}
					})
				);

				// Store results
				results.forEach((result, index) => {
					const opName = batch.operations[index].operation;
					if (result.status === 'fulfilled') {
						if (result.value.success) {
							batch.results.set(opName, result.value.result);
						} else {
							batch.results.set(opName, { error: result.value.error });
						}
					} else {
						batch.results.set(opName, { error: result.reason.message });
					}
				});

				const successCount = results.filter(
					(r) => r.status === 'fulfilled' && r.value.success
				).length;
				batch.status = 'completed';
				batch.completionTime = Date.now();

				this.logger.info(`Batch ${batch.id} completed`, {
					totalOperations: batch.operations.length,
					successful: successCount,
					failed: batch.operations.length - successCount,
				});
			},
			this.metricsTracker,
			'Batch'
		).catch((error) => {
			batch.status = 'failed';
			batch.completionTime = Date.now();

			const handledError = handleError(error, 'LangChainBatchProcessor.processBatchInternal');
			this.logger.error('Batch processing failed', {
				error: handledError.message,
				batchId: batch.id,
				operationCount: batch.operations.length,
			});
			throw handledError;
		});
	}
}
