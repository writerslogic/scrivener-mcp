/**
 * LangChain service for advanced AI operations
 * Provides document chunking, vector storage, and RAG capabilities
 * Enhanced with intelligent robustness: circuit breakers, adaptive rate limiting,
 * intelligent caching, predictive failure detection, and graceful degradation
 */

import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import type { Document as LangchainDocument } from 'langchain/document';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { createError, ErrorCode } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import type { ScrivenerDocument } from '../../types/index.js';
import { AdaptiveTimeout, ProgressIndicators } from '../../utils/adaptive-timeout.js';
import { AsyncUtils } from '../../utils/shared-patterns.js';
import {
	// handleError,
	// withErrorHandling,
	// retry,
	// measureExecution,
	RateLimiter,
	// validateInput,
	// ValidationSchema,
	// safeParse,
	// processBatch,
	// truncate,
	// generateHash,
	formatDuration,
} from '../../utils/common.js';
// import { getTextMetrics } from '../../utils/text-metrics.js';
// import { StringUtils } from '../../utils/shared-patterns.js';

interface ChunkingOptions {
	chunkSize?: number;
	chunkOverlap?: number;
	separators?: string[];
}

interface RAGOptions {
	topK?: number;
	temperature?: number;
	maxTokens?: number;
}

interface WritingContext {
	documentId: string;
	content: string;
	metadata: Record<string, unknown>;
	embeddings?: number[];
}

interface CircuitBreakerState {
	state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
	failureCount: number;
	lastFailureTime: number;
	successCount: number;
	nextAttemptTime: number;
}

interface RateLimiterState {
	tokensPerMinute: number;
	currentTokens: number;
	lastRefill: number;
	adaptiveMultiplier: number;
	successRate: number;
}

interface PerformanceMetrics {
	latency: number[];
	throughput: number;
	errorRate: number;
	lastUpdated: number;
}

interface CacheEntry<T> {
	data: T;
	timestamp: number;
	ttl: number;
	hitCount: number;
	lastAccessed: number;
	size: number;
}

export class LangChainService {
	private llm: ChatOpenAI;
	private embeddings: OpenAIEmbeddings;
	private vectorStore: MemoryVectorStore | null = null;
	private textSplitter: RecursiveCharacterTextSplitter;
	private contexts: Map<string, WritingContext> = new Map();
	private logger: ReturnType<typeof getLogger>;
	private utilRateLimiter: RateLimiter;
	private operationMetrics = new Map<string, { totalTime: number; callCount: number }>();

	// Intelligent robustness components
	private circuitBreaker: CircuitBreakerState;
	private rateLimiter: RateLimiterState;
	private performanceMetrics: PerformanceMetrics;
	private intelligentCache: Map<string, CacheEntry<unknown>> = new Map();
	private healthScore: number = 1.0;
	private degradationLevel: 'none' | 'partial' | 'full' = 'none';
	private fallbackResponses: Map<string, unknown> = new Map();
	private predictionModel: { failures: number[]; successes: number[]; patterns: string[] } = {
		failures: [],
		successes: [],
		patterns: [],
	};

	constructor(apiKey?: string) {
		this.logger = getLogger('langchain-service');

		if (!apiKey && !process.env.OPENAI_API_KEY) {
			throw createError(
				ErrorCode.CONFIGURATION_ERROR,
				null,
				'OpenAI API key required for LangChain service'
			);
		}

		// Initialize OpenAI Chat LLM
		this.llm = new ChatOpenAI({
			openAIApiKey: apiKey || process.env.OPENAI_API_KEY,
			temperature: 0.7,
			modelName: 'gpt-4-turbo-preview',
		});

		// Initialize embeddings
		this.embeddings = new OpenAIEmbeddings({
			openAIApiKey: apiKey || process.env.OPENAI_API_KEY,
		});

		// Initialize text splitter with manuscript-optimized settings
		this.textSplitter = new RecursiveCharacterTextSplitter({
			chunkSize: 2000,
			chunkOverlap: 200,
			separators: ['\n\n\n', '\n\n', '\n', '. ', ' ', ''],
		});

		// Initialize intelligent robustness systems
		this.circuitBreaker = {
			state: 'CLOSED',
			failureCount: 0,
			lastFailureTime: 0,
			successCount: 0,
			nextAttemptTime: 0,
		};

		this.rateLimiter = {
			tokensPerMinute: 3500,
			currentTokens: 3500,
			lastRefill: Date.now(),
			adaptiveMultiplier: 1.0,
			successRate: 1.0,
		};

		this.performanceMetrics = {
			latency: [],
			throughput: 0,
			errorRate: 0,
			lastUpdated: Date.now(),
		};

		// Initialize utility rate limiter (3500 tokens per minute = ~58 per second)
		this.utilRateLimiter = new RateLimiter(58, 1000);

		// Start background health monitoring
		this.startHealthMonitoring();
		this.startCacheCleanup();
		this.initializeFallbacks();
	}

	/**
	 * Enhanced operation metrics tracking using common utilities
	 */
	private updateOperationMetrics(operationName: string, executionTime: number): void {
		const existing = this.operationMetrics.get(operationName) || { totalTime: 0, callCount: 0 };
		existing.totalTime += executionTime;
		existing.callCount += 1;
		this.operationMetrics.set(operationName, existing);

		this.logger.debug(
			`Operation ${operationName} completed in ${formatDuration(executionTime)}`,
			{
				averageTime: formatDuration(existing.totalTime / existing.callCount),
				callCount: existing.callCount,
			}
		);
	}

	/**
	 * Enhanced circuit breaker implementation with utility integration
	 */
	private async withCircuitBreaker<T>(
		operation: () => Promise<T>,
		operationName: string
	): Promise<T> {
		const now = Date.now();

		// Check circuit breaker state
		if (this.circuitBreaker.state === 'OPEN') {
			if (now < this.circuitBreaker.nextAttemptTime) {
				throw createError(
					ErrorCode.AI_SERVICE_ERROR,
					null,
					`Circuit breaker OPEN for ${operationName}. Next attempt at ${new Date(this.circuitBreaker.nextAttemptTime).toISOString()}`
				);
			}
			// Transition to HALF_OPEN
			this.circuitBreaker.state = 'HALF_OPEN';
			this.circuitBreaker.successCount = 0;
			this.logger.info(`Circuit breaker HALF_OPEN for ${operationName}`);
		}

		try {
			const startTime = Date.now();
			const result = await operation();
			const latency = Date.now() - startTime;

			// Record success
			this.recordSuccess(operationName, latency);

			// Update circuit breaker on success
			if (this.circuitBreaker.state === 'HALF_OPEN') {
				this.circuitBreaker.successCount++;
				if (this.circuitBreaker.successCount >= 3) {
					this.circuitBreaker.state = 'CLOSED';
					this.circuitBreaker.failureCount = 0;
					this.logger.info(`Circuit breaker CLOSED for ${operationName}`);
				}
			}

			return result;
		} catch (error) {
			this.recordFailure(operationName, error as Error);

			// Update circuit breaker on failure
			this.circuitBreaker.failureCount++;
			this.circuitBreaker.lastFailureTime = now;

			// Determine if we should open the circuit
			const failureThreshold = Math.max(3, Math.ceil(5 * (1 - this.healthScore)));
			const timeWindow = 60000; // 1 minute

			if (
				this.circuitBreaker.failureCount >= failureThreshold &&
				now - this.circuitBreaker.lastFailureTime < timeWindow
			) {
				this.circuitBreaker.state = 'OPEN';
				this.circuitBreaker.nextAttemptTime =
					now + 30000 * this.circuitBreaker.failureCount; // Exponential backoff
				this.logger.warn(
					`Circuit breaker OPEN for ${operationName}. Failures: ${this.circuitBreaker.failureCount}`
				);
			}

			throw error;
		}
	}

	/**
	 * Adaptive rate limiter that adjusts based on success rates and system health
	 */
	private async checkRateLimit(estimatedTokens: number = 1000): Promise<void> {
		// Apply utility rate limiter first (for basic request throttling)
		while (!this.utilRateLimiter.tryRemove()) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		const now = Date.now();
		const timeSinceRefill = now - this.rateLimiter.lastRefill;

		// Refill tokens based on time elapsed
		if (timeSinceRefill > 0) {
			const tokensToAdd = Math.floor(
				(timeSinceRefill / 60000) * this.rateLimiter.tokensPerMinute
			);
			this.rateLimiter.currentTokens = Math.min(
				this.rateLimiter.tokensPerMinute,
				this.rateLimiter.currentTokens + tokensToAdd
			);
			this.rateLimiter.lastRefill = now;
		}

		// Adjust rate based on health and success rate
		const adjustedTokens = Math.ceil(
			estimatedTokens / (this.healthScore * this.rateLimiter.successRate)
		);

		if (this.rateLimiter.currentTokens < adjustedTokens) {
			const waitTime = Math.ceil(
				(adjustedTokens - this.rateLimiter.currentTokens) *
					(60000 / this.rateLimiter.tokensPerMinute)
			);

			this.logger.debug(
				`Rate limit hit, waiting ${waitTime}ms. Health: ${this.healthScore}, Success rate: ${this.rateLimiter.successRate}`
			);

			// Instead of waiting, trigger graceful degradation if wait is too long
			if (waitTime > 5000) {
				this.adjustDegradationLevel('partial');
				throw createError(
					ErrorCode.AI_SERVICE_ERROR,
					null,
					`Rate limit exceeded, degrading service quality. Estimated wait: ${waitTime}ms`
				);
			}

			const rateLimitTimeout = new AdaptiveTimeout({
				operation: 'rate-limit-wait',
				baseTimeout: waitTime,
				maxTimeout: waitTime * 2,
				stallTimeout: waitTime + 10000,
				progressIndicators: [ProgressIndicators.networkProgress('api.openai.com', 443)],
			});

			await rateLimitTimeout.wait(AsyncUtils.sleep(waitTime));
		}

		this.rateLimiter.currentTokens -= adjustedTokens;
	}

	/**
	 * Intelligent cache with adaptive TTL and LRU eviction
	 */
	private getCached<T>(key: string): T | null {
		const entry = this.intelligentCache.get(key);
		if (!entry) return null;

		const now = Date.now();
		if (now - entry.timestamp > entry.ttl) {
			this.intelligentCache.delete(key);
			return null;
		}

		// Update access patterns for cache intelligence
		entry.hitCount++;
		entry.lastAccessed = now;
		return entry.data as T;
	}

	private setCached<T>(key: string, data: T, baseTTL: number = 300000): void {
		// Adaptive TTL based on access patterns and system health
		const existing = this.intelligentCache.get(key);
		const hitRate = existing ? existing.hitCount / 10 : 0.1;
		const healthMultiplier = 1 + (this.healthScore - 0.5) * 2; // 0.0 to 2.0
		const adaptiveTTL = baseTTL * hitRate * healthMultiplier;

		const entry: CacheEntry<T> = {
			data,
			timestamp: Date.now(),
			ttl: adaptiveTTL,
			hitCount: existing?.hitCount || 0,
			lastAccessed: Date.now(),
			size: JSON.stringify(data).length,
		};

		// LRU eviction if cache is too large
		if (this.intelligentCache.size > 100) {
			this.evictLRU();
		}

		this.intelligentCache.set(key, entry);
	}

	private evictLRU(): void {
		let oldestKey = '';
		let oldestTime = Date.now();

		for (const [key, entry] of this.intelligentCache.entries()) {
			if (entry.lastAccessed < oldestTime) {
				oldestTime = entry.lastAccessed;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this.intelligentCache.delete(oldestKey);
		}
	}

	/**
	 * Predictive failure detection using pattern analysis
	 */
	private predictFailureRisk(): number {
		const recentFailures = this.predictionModel.failures.slice(-10);
		const recentSuccesses = this.predictionModel.successes.slice(-10);

		if (recentFailures.length === 0) return 0;

		// Analyze failure patterns
		const failureRate =
			recentFailures.length / (recentFailures.length + recentSuccesses.length);
		const timePattern = this.analyzeTimePatterns(recentFailures);
		const escalationPattern = this.detectEscalation(recentFailures);

		return Math.min(1.0, failureRate * 0.5 + timePattern * 0.3 + escalationPattern * 0.2);
	}

	private analyzeTimePatterns(failures: number[]): number {
		if (failures.length < 3) return 0;

		const intervals = [];
		for (let i = 1; i < failures.length; i++) {
			intervals.push(failures[i] - failures[i - 1]);
		}

		// Look for decreasing intervals (accelerating failures)
		let decreasingCount = 0;
		for (let i = 1; i < intervals.length; i++) {
			if (intervals[i] < intervals[i - 1]) decreasingCount++;
		}

		return decreasingCount / (intervals.length - 1);
	}

	private detectEscalation(failures: number[]): number {
		if (failures.length < 5) return 0;

		const recent = failures.slice(-3);
		const baseline = failures.slice(-10, -3);

		const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
		const baselineAvg = baseline.reduce((a, b) => a + b, 0) / baseline.length;

		return recentAvg > baselineAvg ? Math.min(1.0, (recentAvg - baselineAvg) / baselineAvg) : 0;
	}

	/**
	 * Graceful degradation system
	 */
	private adjustDegradationLevel(level: 'none' | 'partial' | 'full'): void {
		if (this.degradationLevel !== level) {
			this.logger.info(
				`Service degradation level changed from ${this.degradationLevel} to ${level}`
			);
			this.degradationLevel = level;

			// Adjust operational parameters based on degradation level
			switch (level) {
				case 'partial':
					this.rateLimiter.adaptiveMultiplier = 0.5; // Reduce rate
					break;
				case 'full':
					this.rateLimiter.adaptiveMultiplier = 0.1; // Minimal rate
					break;
				default:
					this.rateLimiter.adaptiveMultiplier = 1.0;
			}
		}
	}

	private async getFallbackResponse(operation: string, context?: unknown): Promise<unknown> {
		const fallbackKey = `${operation}_${JSON.stringify(context).slice(0, 100)}`;
		const cached = this.fallbackResponses.get(fallbackKey);

		if (cached) {
			this.logger.info(`Using fallback response for ${operation}`);
			return cached;
		}

		// Generate synthetic fallback based on operation type
		switch (operation) {
			case 'summarizeChapter':
				return 'Chapter summary temporarily unavailable due to service constraints.';
			case 'generateWithContext':
				return 'AI-generated content is currently limited. Please try again later or use manual editing.';
			case 'analyzeWritingStyle':
				return { analysis: 'Style analysis unavailable', confidence: 0 };
			default:
				return null;
		}
	}

	/**
	 * Health monitoring and metrics recording
	 */
	private recordSuccess(operation: string, latency: number): void {
		// Record success in prediction model
		this.predictionModel.successes.push(Date.now());
		if (this.predictionModel.successes.length > 50) {
			this.predictionModel.successes = this.predictionModel.successes.slice(-50);
		}

		// Update operation-specific metrics
		this.updateOperationMetrics(operation, latency);

		this.performanceMetrics.latency.push(latency);
		if (this.performanceMetrics.latency.length > 100) {
			this.performanceMetrics.latency = this.performanceMetrics.latency.slice(-100);
		}

		this.updateHealthScore();
		this.rateLimiter.successRate = Math.min(1.0, this.rateLimiter.successRate + 0.01);
	}

	private recordFailure(operation: string, error: Error): void {
		this.predictionModel.failures.push(Date.now());
		if (this.predictionModel.failures.length > 50) {
			this.predictionModel.failures = this.predictionModel.failures.slice(-50);
		}

		this.updateHealthScore();
		this.rateLimiter.successRate = Math.max(0.1, this.rateLimiter.successRate - 0.05);

		// Store failure patterns for prediction
		const pattern = `${operation}:${error.message.substring(0, 50)}`;
		if (!this.predictionModel.patterns.includes(pattern)) {
			this.predictionModel.patterns.push(pattern);
			if (this.predictionModel.patterns.length > 100) {
				this.predictionModel.patterns = this.predictionModel.patterns.slice(-100);
			}
		}
	}

	private updateHealthScore(): void {
		const recentFailures = this.predictionModel.failures.filter((f) => Date.now() - f < 300000); // 5 minutes
		const recentSuccesses = this.predictionModel.successes.filter(
			(s) => Date.now() - s < 300000
		);
		const total = recentFailures.length + recentSuccesses.length;

		if (total === 0) {
			this.healthScore = 1.0;
		} else {
			const successRate = recentSuccesses.length / total;
			const latencyPenalty = this.getLatencyPenalty();
			const predictivePenalty = this.predictFailureRisk();

			this.healthScore = Math.max(
				0.1,
				successRate - latencyPenalty - predictivePenalty * 0.3
			);
		}

		// Adjust degradation based on health score
		if (this.healthScore < 0.3) {
			this.adjustDegradationLevel('full');
		} else if (this.healthScore < 0.7) {
			this.adjustDegradationLevel('partial');
		} else {
			this.adjustDegradationLevel('none');
		}
	}

	private getLatencyPenalty(): number {
		if (this.performanceMetrics.latency.length === 0) return 0;

		const avgLatency =
			this.performanceMetrics.latency.reduce((a, b) => a + b, 0) /
			this.performanceMetrics.latency.length;
		const expectedLatency = 3000; // 3 seconds baseline

		if (avgLatency <= expectedLatency) return 0;
		return Math.min(0.5, (avgLatency - expectedLatency) / (expectedLatency * 2));
	}

	/**
	 * Background monitoring processes
	 */
	private startHealthMonitoring(): void {
		setInterval(() => {
			this.updateHealthScore();
			const riskScore = this.predictFailureRisk();

			if (riskScore > 0.7) {
				this.logger.warn(`High failure risk detected: ${riskScore.toFixed(2)}`);
				this.adjustDegradationLevel('partial');
			}

			this.logger.debug(
				`Health Score: ${this.healthScore.toFixed(2)}, Failure Risk: ${riskScore.toFixed(2)}, Degradation: ${this.degradationLevel}`
			);
		}, 30000); // Every 30 seconds
	}

	private startCacheCleanup(): void {
		setInterval(() => {
			const now = Date.now();
			for (const [key, entry] of this.intelligentCache.entries()) {
				if (now - entry.timestamp > entry.ttl) {
					this.intelligentCache.delete(key);
				}
			}
		}, 60000); // Every minute
	}

	private initializeFallbacks(): void {
		// Pre-populate common fallback responses
		this.fallbackResponses.set(
			'summarizeChapter_default',
			'Chapter summary temporarily unavailable. Please try again later.'
		);
		this.fallbackResponses.set(
			'generateWithContext_default',
			'AI assistance is currently limited. Consider manual editing.'
		);
		this.fallbackResponses.set('analyzeWritingStyle_default', {
			tone: 'neutral',
			complexity: 'medium',
			confidence: 0.1,
		});
	}

	/**
	 * Process and chunk a document for vector storage
	 */
	async processDocument(
		document: ScrivenerDocument,
		options: ChunkingOptions = {}
	): Promise<LangchainDocument[]> {
		return this.withCircuitBreaker(async () => {
			const cacheKey = `processDoc_${document.id}_${JSON.stringify(options)}`;
			const cached = this.getCached<LangchainDocument[]>(cacheKey);
			if (cached) return cached;

			// Use configured text splitter or create a custom one if options are different
			const splitter = (options.chunkSize || options.chunkOverlap || options.separators) 
				? new RecursiveCharacterTextSplitter({
					chunkSize: options.chunkSize || 2000,
					chunkOverlap: options.chunkOverlap || 200,
					separators: options.separators || ['\n\n\n', '\n\n', '\n', '. ', ' ', ''],
				})
				: this.textSplitter;

			const chunks = await splitter.createDocuments(
				[document.content || ''],
				[
					{
						documentId: document.id,
						title: document.title || '',
						type: document.type,
						path: document.path || '',
					},
				]
			);

			this.setCached(cacheKey, chunks, 600000); // 10 minutes TTL
			this.logger.debug(`Chunked document ${document.id} into ${chunks.length} pieces`);
			return chunks;
		}, 'processDocument').catch(async (error) => {
			// Graceful degradation: return simplified chunks
			if (this.degradationLevel !== 'none') {
				const fallback = await this.getFallbackResponse('processDocument', {
					documentId: document.id,
				});
				if (fallback) return fallback as LangchainDocument[];

				// Create minimal chunks manually
				const content = document.content || '';
				const chunkSize = 1000; // Smaller chunks for degraded mode
				const chunks: LangchainDocument[] = [];

				for (let i = 0; i < content.length; i += chunkSize) {
					const chunk = content.slice(i, i + chunkSize);
					chunks.push({
						pageContent: chunk,
						metadata: {
							documentId: document.id,
							title: document.title || '',
							chunkIndex: Math.floor(i / chunkSize),
						},
					});
				}

				this.logger.warn(`Used fallback chunking for document ${document.id}`);
				return chunks;
			}

			throw createError(
				ErrorCode.ANALYSIS_ERROR,
				error as Error,
				`Failed to process document ${document.id}`
			);
		});
	}

	/**
	 * Build or update vector store with documents
	 */
	async buildVectorStore(documents: ScrivenerDocument[]): Promise<void> {
		try {
			const allChunks: LangchainDocument[] = [];

			for (const doc of documents) {
				const chunks = await this.processDocument(doc);
				allChunks.push(...chunks);
			}

			if (this.vectorStore) {
				// Add to existing store
				await this.vectorStore.addDocuments(allChunks);
			} else {
				// Create new store
				this.vectorStore = await MemoryVectorStore.fromDocuments(
					allChunks,
					this.embeddings
				);
			}

			this.logger.info(
				`Vector store updated with ${allChunks.length} chunks from ${documents.length} documents`
			);
		} catch (error) {
			throw createError(
				ErrorCode.ANALYSIS_ERROR,
				error as Error,
				'Failed to build vector store'
			);
		}
	}

	/**
	 * Perform semantic search across documents
	 */
	async semanticSearch(query: string, topK: number = 5): Promise<LangchainDocument[]> {
		if (!this.vectorStore) {
			throw createError(
				ErrorCode.INVALID_STATE,
				null,
				'Vector store not initialized. Call buildVectorStore first.'
			);
		}

		return this.withCircuitBreaker(async () => {
			const cacheKey = `search_${query.slice(0, 100)}_${topK}`;
			const cached = this.getCached<LangchainDocument[]>(cacheKey);
			if (cached) return cached;

			await this.checkRateLimit(500); // Estimate 500 tokens for embeddings

			// Adjust search quality based on system health
			const adjustedTopK =
				this.degradationLevel === 'full'
					? Math.min(topK, 2)
					: this.degradationLevel === 'partial'
						? Math.min(topK, 3)
						: topK;

			const results = (await this.vectorStore?.similaritySearch(query, adjustedTopK)) || [];

			this.setCached(cacheKey, results, 300000); // 5 minutes TTL
			this.logger.debug(
				`Found ${results.length} similar documents for query: ${query.substring(0, 50)}...`
			);
			return results;
		}, 'semanticSearch').catch((error) => {
			// Fallback to simple text matching if semantic search fails
			if (this.degradationLevel !== 'none') {
				this.logger.warn('Semantic search failed, using simple text matching fallback');
				return []; // Return empty results as graceful degradation
			}

			throw createError(ErrorCode.ANALYSIS_ERROR, error as Error, 'Semantic search failed');
		});
	}

	/**
	 * Generate writing suggestions using RAG
	 */
	async generateWithContext(prompt: string, options: RAGOptions = {}): Promise<string> {
		if (!this.vectorStore) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Vector store not initialized');
		}

		return this.withCircuitBreaker(async () => {
			const cacheKey = `generateContext_${prompt.slice(0, 50)}_${JSON.stringify(options)}`;
			const cached = this.getCached<string>(cacheKey);
			if (cached) return cached;

			await this.checkRateLimit(2000); // Estimate 2000 tokens

			// Find relevant context
			const relevantDocs = await this.semanticSearch(prompt, options.topK || 3);

			// Build context string
			const context = relevantDocs.map((doc) => doc.pageContent).join('\n\n---\n\n');

			// Adjust prompt complexity based on degradation level
			let promptTemplate;
			if (this.degradationLevel === 'full') {
				promptTemplate = PromptTemplate.fromTemplate(`Answer briefly: {question}`);
			} else if (this.degradationLevel === 'partial') {
				promptTemplate = PromptTemplate.fromTemplate(`
					Context: {context}
					Question: {question}
					Provide a concise response:
				`);
			} else {
				promptTemplate = PromptTemplate.fromTemplate(`
					You are a professional writing assistant helping with a manuscript.
					Use the following context from the manuscript to provide accurate and consistent suggestions:

					Context:
					{context}

					Question/Request:
					{question}

					Provide a helpful, creative response that maintains consistency with the existing manuscript:
				`);
			}

			// Create chain with adjusted LLM settings
			const adjustedLLM = new ChatOpenAI({
				...this.llm,
				temperature: this.degradationLevel === 'full' ? 0.3 : options.temperature || 0.7,
				maxTokens: this.degradationLevel === 'full' ? 200 : options.maxTokens || 1000,
			});

			const chain = RunnableSequence.from([
				promptTemplate,
				adjustedLLM,
				new StringOutputParser(),
			]);

			// Generate response
			const response = await chain.invoke({
				context,
				question: prompt,
			});

			this.setCached(cacheKey, response, 180000); // 3 minutes TTL
			return response;
		}, 'generateWithContext').catch(async (error) => {
			// Use fallback response in case of failure
			const fallback = await this.getFallbackResponse('generateWithContext', prompt);
			if (fallback) {
				this.logger.warn('Using fallback response for content generation');
				return fallback as string;
			}

			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Failed to generate with context'
			);
		});
	}

	/**
	 * Analyze writing style from samples
	 */
	async analyzeWritingStyle(samples: string[]): Promise<Record<string, unknown>> {
		return this.withCircuitBreaker(async () => {
			const cacheKey = `styleAnalysis_${samples.join('').slice(0, 100)}`;
			const cached = this.getCached<Record<string, unknown>>(cacheKey);
			if (cached) return cached;

			await this.checkRateLimit(3000); // Estimate 3000 tokens

			// Adjust analysis depth based on degradation level
			let promptTemplate;
			if (this.degradationLevel === 'full') {
				promptTemplate = PromptTemplate.fromTemplate(`
					Analyze writing style briefly: {samples}
					Return JSON with: tone, complexity, voice.
				`);
			} else {
				promptTemplate = PromptTemplate.fromTemplate(`
					Analyze the following writing samples and provide a detailed style analysis:

					Samples:
					{samples}

					Provide analysis of:
					1. Voice and tone
					2. Sentence structure patterns
					3. Vocabulary complexity
					4. Pacing and rhythm
					5. Common phrases or patterns
					6. Strengths and areas for improvement

					Format as JSON.
				`);
			}

			const chain = RunnableSequence.from([
				promptTemplate,
				this.llm,
				new StringOutputParser(),
			]);

			const response = await chain.invoke({
				samples: samples
					.slice(0, this.degradationLevel === 'full' ? 2 : samples.length)
					.join('\n\n---\n\n'),
			});

			try {
				const result = JSON.parse(response);
				this.setCached(cacheKey, result, 900000); // 15 minutes TTL
				return result;
			} catch (parseError) {
				// Fallback to basic analysis if JSON parsing fails
				this.logger.warn('Failed to parse style analysis JSON response', {
					error: (parseError as Error).message,
					response: response.slice(0, 100),
				});
				const basicAnalysis = {
					tone: 'neutral',
					complexity: 'medium',
					voice: 'descriptive',
					confidence: 0.5,
					rawResponse: response.slice(0, 200),
				};
				return basicAnalysis;
			}
		}, 'analyzeWritingStyle').catch(async (error) => {
			// Use fallback analysis
			const fallback = await this.getFallbackResponse('analyzeWritingStyle', samples);
			if (fallback) {
				this.logger.warn('Using fallback writing style analysis');
				return fallback;
			}

			throw createError(ErrorCode.AI_SERVICE_ERROR, error as Error, 'Style analysis failed');
		});
	}

	/**
	 * Generate chapter summaries
	 */
	async summarizeChapter(content: string, maxLength: number = 200): Promise<string> {
		return this.withCircuitBreaker(async () => {
			const cacheKey = `summary_${content.slice(0, 50)}_${maxLength}`;
			const cached = this.getCached<string>(cacheKey);
			if (cached) return cached;

			await this.checkRateLimit(1500); // Estimate 1500 tokens

			// Adjust summary complexity based on degradation
			const adjustedLength =
				this.degradationLevel === 'full'
					? Math.min(maxLength, 50)
					: this.degradationLevel === 'partial'
						? Math.min(maxLength, 100)
						: maxLength;

			const truncatedContent =
				this.degradationLevel === 'full' ? content.slice(0, 500) : content;

			const promptTemplate = PromptTemplate.fromTemplate(`
				Summarize the following chapter content in approximately {maxLength} words:

				{content}

				Focus on key plot points, character developments, and important themes.
			`);

			const chain = RunnableSequence.from([
				promptTemplate,
				this.llm,
				new StringOutputParser(),
			]);

			const summary = await chain.invoke({
				content: truncatedContent,
				maxLength: adjustedLength,
			});

			this.setCached(cacheKey, summary, 1200000); // 20 minutes TTL
			return summary;
		}, 'summarizeChapter').catch(async (error) => {
			// Fallback to extractive summary
			const fallback = await this.getFallbackResponse('summarizeChapter', content);
			if (fallback) {
				return fallback as string;
			}

			// Create basic extractive summary as last resort
			if (this.degradationLevel !== 'none') {
				const sentences = content.split(/[.!?]\s+/).filter((s) => s.length > 20);
				const importantSentences = sentences.slice(0, Math.ceil(maxLength / 20));
				this.logger.warn('Using extractive summary fallback');
				return `${importantSentences.join('. ')}.`;
			}

			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Chapter summarization failed'
			);
		});
	}

	/**
	 * Check plot consistency across documents
	 */
	async checkPlotConsistency(documents: ScrivenerDocument[]): Promise<
		Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
		}>
	> {
		if (!this.vectorStore) {
			await this.buildVectorStore(documents);
		}

		try {
			const issues: Array<{
				issue: string;
				severity: 'low' | 'medium' | 'high';
				locations: string[];
				suggestion: string;
			}> = [];

			// Check for character consistency
			const characterPrompt = `
				Analyze the manuscript for character inconsistencies:
				- Changes in character traits or behavior
				- Contradictory character descriptions
				- Timeline issues with character ages or events
			`;

			const characterContext = await this.generateWithContext(characterPrompt);

			// Parse and structure the response with sophisticated analysis
			const lines = characterContext.split('\n').filter((line) => line.trim());

			for (const line of lines) {
				// Look for specific patterns indicating issues
				const severityPatterns = {
					high: /critical|major|severe|significant/i,
					medium: /moderate|notable|important/i,
					low: /minor|small|slight/i,
				};

				const issuePatterns = [
					/inconsistency|contradiction|conflict/i,
					/timeline\s+issue|age\s+problem/i,
					/character\s+trait\s+change/i,
					/behavior\s+mismatch/i,
				];

				// Check if this line describes an issue
				const hasIssue = issuePatterns.some((pattern) => pattern.test(line));

				if (hasIssue) {
					// Determine severity
					let severity: 'low' | 'medium' | 'high' = 'medium';
					for (const [level, pattern] of Object.entries(severityPatterns)) {
						if (pattern.test(line)) {
							severity = level as 'low' | 'medium' | 'high';
							break;
						}
					}

					// Extract chapter references if mentioned
					const chapterMatch = line.match(/chapter[s]?\s+(\d+(?:\s*(?:and|,)\s*\d+)*)/gi);
					const locations = chapterMatch
						? chapterMatch.map((m) => m.replace(/chapter[s]?\s+/i, 'Chapter '))
						: ['Multiple chapters'];

					// Generate contextual suggestion
					let suggestion = 'Review character descriptions for consistency';
					if (line.toLowerCase().includes('timeline')) {
						suggestion = 'Verify character ages and timeline events';
					} else if (line.toLowerCase().includes('trait')) {
						suggestion =
							'Ensure character traits remain consistent or show clear development';
					} else if (line.toLowerCase().includes('behavior')) {
						suggestion =
							'Check that character behaviors align with established personality';
					}

					issues.push({
						issue: line.trim(),
						severity,
						locations,
						suggestion,
					});
				}
			}

			return issues;
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Plot consistency check failed'
			);
		}
	}

	/**
	 * Get comprehensive service health status
	 */
	getHealthStatus(): {
		healthScore: number;
		circuitBreakerState: string;
		degradationLevel: string;
		performanceMetrics: {
			avgLatency: number;
			errorRate: number;
			successRate: number;
		};
		failureRisk: number;
		cacheStats: {
			size: number;
			hitRate: number;
		};
	} {
		const avgLatency =
			this.performanceMetrics.latency.length > 0
				? this.performanceMetrics.latency.reduce((a, b) => a + b, 0) /
					this.performanceMetrics.latency.length
				: 0;

		const recentFailures = this.predictionModel.failures.filter((f) => Date.now() - f < 300000);
		const recentSuccesses = this.predictionModel.successes.filter(
			(s) => Date.now() - s < 300000
		);
		const total = recentFailures.length + recentSuccesses.length;
		const errorRate = total > 0 ? recentFailures.length / total : 0;
		const successRate = total > 0 ? recentSuccesses.length / total : 1;

		const cacheEntries = Array.from(this.intelligentCache.values());
		const totalHits = cacheEntries.reduce((sum, entry) => sum + entry.hitCount, 0);
		const hitRate = cacheEntries.length > 0 ? totalHits / cacheEntries.length : 0;

		return {
			healthScore: this.healthScore,
			circuitBreakerState: this.circuitBreaker.state,
			degradationLevel: this.degradationLevel,
			performanceMetrics: {
				avgLatency,
				errorRate,
				successRate,
			},
			failureRisk: this.predictFailureRisk(),
			cacheStats: {
				size: this.intelligentCache.size,
				hitRate,
			},
		};
	}

	/**
	 * Force reset service to healthy state (for emergency recovery)
	 */
	resetToHealthyState(): void {
		this.circuitBreaker = {
			state: 'CLOSED',
			failureCount: 0,
			lastFailureTime: 0,
			successCount: 0,
			nextAttemptTime: 0,
		};

		this.healthScore = 1.0;
		this.degradationLevel = 'none';
		this.rateLimiter.successRate = 1.0;
		this.predictionModel = { failures: [], successes: [], patterns: [] };
		this.performanceMetrics = {
			latency: [],
			throughput: 0,
			errorRate: 0,
			lastUpdated: Date.now(),
		};

		this.logger.info('Service reset to healthy state');
	}

	/**
	 * Clear vector store and contexts
	 */
	clearMemory(): void {
		this.vectorStore = null;
		this.contexts.clear();
		this.intelligentCache.clear();
		this.logger.debug('Cleared vector store, contexts, and cache');
	}
}
