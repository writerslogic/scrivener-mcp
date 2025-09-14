import { ApplicationError, ErrorCode } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import type { StyleGuide } from '../../memory-manager.js';
import { AdaptiveTimeout, ProgressIndicators } from '../../utils/adaptive-timeout.js';
import { requireEnv } from '../../utils/common.js';
import { AsyncUtils } from '../../utils/shared-patterns.js';
import { AdvancedLangChainFeatures } from '../ai/langchain-advanced-features.js';
import { EnhancedLangChainService } from '../ai/langchain-service-enhanced.js';
import type { EnhancementRequest, EnhancementResult, EnhancementType } from './content-enhancer.js';
import { ContentEnhancer } from './content-enhancer.js';
// Enterprise service foundation
import { ObservabilityManager } from '../enterprise/observability.js';
import { IntelligentCache, PerformanceProfiler } from '../enterprise/performance-optimizer.js';
import {
	BulkheadIsolation,
	EnterpriseCircuitBreaker,
	EnterpriseRateLimiter,
	type BulkheadConfig,
	type CircuitBreakerConfig,
} from '../enterprise/service-foundation.js';

interface EnhancementStrategy {
	template: string;
	contextWeight: number;
	stylePreservation: number;
	iterations: number;
}

interface EnhancementContext {
	surroundingText?: string;
	characterVoices?: string[];
	sceneType?: 'action' | 'dialogue' | 'description' | 'introspection';
	genre?: string;
	targetAudience?: string;
}

interface QualityMetrics {
	coherence: number;
	styleConsistency: number;
	readabilityImprovement: number;
	characterVoiceRetention: number;
}

interface EnhancementMetrics {
	successfulEnhancements: number;
	failedEnhancements: number;
	averageDuration: number;
	totalTokensUsed: number;
	qualityScores: number[];
	lastReset: number;
}

interface InitializationConfig {
	initTimeout: number;
	maxRetries: number;
	connectionPoolSize: number;
	healthCheckInterval: number;
	fallbackEnabled: boolean;
}

// Note: CacheEntry interface now imported from types/index.ts
// The centralized version has: { data: T; timestamp: number; ttl: number; size?: number; }
// If hitCount and lastAccessed are needed, they can be added to the centralized type

export class LangChainContentEnhancer {
	private langchain: EnhancedLangChainService;
	private advanced: AdvancedLangChainFeatures;
	private fallbackEnhancer: ContentEnhancer;
	private logger: ReturnType<typeof getLogger>;
	private enhancementStrategies: Map<EnhancementType, EnhancementStrategy>;
	private qualityThreshold = 0.85;
	private initialized = false;
	private healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

	// Enterprise service foundation components
	private circuitBreaker!: EnterpriseCircuitBreaker;
	private rateLimiter!: EnterpriseRateLimiter;
	private bulkhead!: BulkheadIsolation;
	private observability!: ObservabilityManager;
	private cache!: IntelligentCache<EnhancementResult>;
	private profiler!: PerformanceProfiler;
	private metrics: EnhancementMetrics;
	private config: InitializationConfig;
	private maxRetries = 3;
	private retryDelay = 1000;

	constructor(config: Partial<InitializationConfig> = {}) {
		this.langchain = new EnhancedLangChainService();
		this.advanced = new AdvancedLangChainFeatures();
		this.fallbackEnhancer = new ContentEnhancer();
		this.logger = getLogger('LangChainContentEnhancer');
		this.enhancementStrategies = this.initializeStrategies();

		// Initialize configuration with defaults
		this.config = {
			initTimeout: config.initTimeout || 30000, // 30 second init timeout
			maxRetries: config.maxRetries || 3,
			connectionPoolSize: config.connectionPoolSize || 10,
			healthCheckInterval: config.healthCheckInterval || 30000,
			fallbackEnabled: config.fallbackEnabled ?? true,
		};

		// Initialize enterprise service foundation components
		this.initializeEnterpriseComponents();

		// Initialize metrics
		this.metrics = {
			successfulEnhancements: 0,
			failedEnhancements: 0,
			averageDuration: 0,
			totalTokensUsed: 0,
			qualityScores: [],
			lastReset: Date.now(),
		};

		// Start enterprise monitoring
		this.startEnterpriseMonitoring();
	}

	private initializeEnterpriseComponents(): void {
		// Circuit breaker for LangChain API calls
		const circuitBreakerConfig: CircuitBreakerConfig = {
			failureThreshold: 5,
			timeout: 60000, // 1 minute
			resetTimeout: 300000, // 5 minutes
			monitoringWindow: 120000, // 2 minutes
			healthCheckInterval: this.config.healthCheckInterval,
		};
		this.circuitBreaker = new EnterpriseCircuitBreaker(
			'content-enhancer',
			circuitBreakerConfig
		);

		// Rate limiter for API calls
		this.rateLimiter = new EnterpriseRateLimiter({
			windowMs: 60000, // 1 minute
			maxRequests: 50, // 50 enhancements per minute
			skipSuccessfulRequests: false,
			skipFailedRequests: false,
			keyGenerator: (context: Record<string, unknown>) =>
				`enhancement-${context.operation || 'default'}`,
		});

		// Bulkhead isolation for concurrent operations
		const bulkheadConfig: BulkheadConfig = {
			maxConcurrency: this.config.connectionPoolSize,
			queueTimeout: 30000, // 30 seconds
			rejectionStrategy: 'queue',
		};
		this.bulkhead = new BulkheadIsolation('content-enhancer', bulkheadConfig);

		// Observability for distributed tracing
		this.observability = new ObservabilityManager({ serviceName: 'content-enhancer' });

		// Intelligent cache for enhancement results
		this.cache = new IntelligentCache<EnhancementResult>({
			maxSize: 1000,
			maxAge: 3600000, // 1 hour
			compressionThreshold: 1024, // 1KB
		});

		// Performance profiler
		this.profiler = new PerformanceProfiler();

		// Set up event handlers
		this.setupEventHandlers();
	}

	private setupEventHandlers(): void {
		// Circuit breaker events
		this.circuitBreaker.on('state-change', (event) => {
			this.logger.warn('Circuit breaker state changed', event);
			this.observability.incrementCounter('circuit_breaker_state_changes', 1, {
				from: event.from,
				to: event.to,
			});
		});

		// Rate limiter events
		// Note: Rate limiter events setup would go here if the component supports it

		// Bulkhead events
		// Note: Bulkhead events setup would go here if the component supports it
	}

	private startEnterpriseMonitoring(): void {
		// Health monitoring with enterprise patterns
		setInterval(() => {
			this.checkServiceHealth();
			this.updateMetrics();
			this.cleanupResources();
		}, this.config.healthCheckInterval);
	}

	private checkServiceHealth(): void {
		try {
			const circuitBreakerMetrics = this.circuitBreaker.getMetrics();
			const cacheMetrics = this.cache.getMetrics();
			this.profiler.getProfile('enhancement');

			// Determine health status
			if (circuitBreakerMetrics.circuitBreakerState === 'open') {
				this.healthStatus = 'unhealthy';
			} else if (
				this.metrics.failedEnhancements /
					(this.metrics.successfulEnhancements + this.metrics.failedEnhancements) >
				0.1
			) {
				this.healthStatus = 'degraded';
			} else {
				this.healthStatus = 'healthy';
			}

			// Report metrics
			this.observability.setGauge('health_status', this.healthStatus === 'healthy' ? 1 : 0);
			this.observability.setGauge('cache_hit_rate', cacheMetrics.hitRate);
			this.observability.recordHistogram(
				'enhancement_duration',
				this.metrics.averageDuration
			);
		} catch (error) {
			this.logger.error('Health check failed', { error });
			this.healthStatus = 'unhealthy';
		}
	}

	private updateMetrics(): void {
		// Update rolling averages and reset counters if needed
		const now = Date.now();
		const timeSinceReset = now - this.metrics.lastReset;

		// Reset metrics every hour
		if (timeSinceReset > 3600000) {
			this.metrics = {
				successfulEnhancements: 0,
				failedEnhancements: 0,
				averageDuration: this.metrics.averageDuration,
				totalTokensUsed: 0,
				qualityScores: [],
				lastReset: now,
			};
		}
	}

	private cleanupResources(): void {
		// Clean up expired cache entries and optimize memory usage
		this.cache.clear();
		this.profiler.reset();
	}

	private generateCacheKey(request: EnhancementRequest): string {
		const keyData = {
			content: request.content,
			type: request.type,
			styleGuide: request.styleGuide,
			context: request.context,
			options: request.options,
		};
		return `enhancement:${Buffer.from(JSON.stringify(keyData)).toString('base64').slice(0, 64)}`;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;

		try {
			// Validate configuration
			requireEnv('OPENAI_API_KEY');

			// Initialize services with configurable timeout
			const initTimeout = new AdaptiveTimeout({
				operation: 'content-enhancer-initialization',
				baseTimeout: this.config.initTimeout,
				maxTimeout: this.config.initTimeout * 1.5,
				progressIndicators: [
					ProgressIndicators.processHeartbeat('langchain-service'),
					ProgressIndicators.networkProgress('api.openai.com', 443),
				],
				stallTimeout: this.config.initTimeout + 5000,
			});

			// Initialize services within timeout
			await initTimeout.wait(this.initializeServices());

			this.logger.info('Services initialized successfully');

			// Perform connection test
			await this.testConnection();

			this.initialized = true;
			this.healthStatus = 'healthy';
			this.logger.info('LangChain content enhancer initialized successfully', {
				initTimeout: this.config.initTimeout,
				connectionPoolSize: this.config.connectionPoolSize,
			});
		} catch (error) {
			this.healthStatus = 'unhealthy';
			this.logger.error('Failed to initialize LangChain content enhancer', {
				error: (error as Error).message,
				initTimeout: this.config.initTimeout,
			});
			throw new ApplicationError(
				'Content enhancer initialization failed',
				ErrorCode.INITIALIZATION_ERROR,
				error
			);
		}
	}

	private async initializeServices(): Promise<void> {
		// Services are initialized via their constructors, but we can perform
		// any additional async initialization here if needed
		await Promise.resolve(); // Placeholder for future async initialization
	}

	private async testConnection(): Promise<void> {
		try {
			// Test with a minimal enhancement request
			const testRequest: EnhancementRequest = {
				content: 'Test content.',
				type: 'grammar' as EnhancementType,
				options: {},
			};

			await this.enhanceWithRetry(testRequest, 1); // Single retry for test
			this.logger.debug('Connection test successful');
		} catch (error) {
			throw new ApplicationError(
				'Failed to connect to LangChain service',
				ErrorCode.CONNECTION_ERROR,
				error
			);
		}
	}

	private initializeStrategies(): Map<EnhancementType, EnhancementStrategy> {
		return new Map([
			[
				'improve-flow',
				{
					template: 'pacing_rhythm',
					contextWeight: 0.8,
					stylePreservation: 0.9,
					iterations: 2,
				},
			],
			[
				'enhance-descriptions',
				{
					template: 'worldbuilding',
					contextWeight: 0.7,
					stylePreservation: 0.85,
					iterations: 1,
				},
			],
			[
				'strengthen-dialogue',
				{
					template: 'dialogue_enhancement',
					contextWeight: 0.9,
					stylePreservation: 0.95,
					iterations: 2,
				},
			],
			[
				'show-dont-tell',
				{
					template: 'character_development',
					contextWeight: 0.8,
					stylePreservation: 0.9,
					iterations: 2,
				},
			],
			[
				'add-sensory-details',
				{
					template: 'sensory_immersion',
					contextWeight: 0.7,
					stylePreservation: 0.8,
					iterations: 1,
				},
			],
			[
				'strengthen-verbs',
				{
					template: 'prose_strengthening',
					contextWeight: 0.6,
					stylePreservation: 0.9,
					iterations: 1,
				},
			],
			[
				'vary-sentences',
				{
					template: 'rhythm_variation',
					contextWeight: 0.7,
					stylePreservation: 0.85,
					iterations: 1,
				},
			],
			[
				'fix-pacing',
				{
					template: 'pacing_adjustment',
					contextWeight: 0.8,
					stylePreservation: 0.9,
					iterations: 2,
				},
			],
		]);
	}

	async enhance(request: EnhancementRequest): Promise<EnhancementResult> {
		// Ensure service is initialized
		if (!this.initialized) {
			await this.initialize();
		}

		// Create trace context for observability
		const traceId =
			Math.random().toString(36).substring(2, 15) +
			Math.random().toString(36).substring(2, 15);
		const spanId = Math.random().toString(36).substring(2, 15);
		const traceContext = {
			traceId,
			spanId,
			startTime: Date.now(),
			baggage: {
				operation: 'enhance',
				type: request.type,
				contentLength: request.content.length.toString(),
			},
		};

		// Start distributed tracing
		const span = this.observability.startSpan(`enhancement.${request.type}`, traceContext, {
			'enhancement.type': request.type,
			'content.length': request.content.length,
			'service.name': 'langchain-content-enhancer',
		});

		try {
			// Validate and sanitize input
			const validatedRequest = await this.validateAndSanitizeRequest(request);

			// Check rate limiting
			const rateLimitResult = await this.rateLimiter.checkLimit({
				operation: validatedRequest.type,
				userId: 'system',
				ipAddress: '127.0.0.1',
			});

			if (!rateLimitResult.allowed) {
				this.observability.incrementCounter('rate_limit_exceeded', 1, {
					type: validatedRequest.type,
				});
				throw new ApplicationError('Rate limit exceeded', ErrorCode.RATE_LIMITED);
			}

			// Check cache first
			const cacheKey = this.generateCacheKey(validatedRequest);
			const cachedResult = await this.cache.get(cacheKey, traceContext);

			if (cachedResult) {
				this.observability.incrementCounter('cache_hits', 1, {
					type: validatedRequest.type,
				});
				this.observability.finishSpan(span, {
					'cache.hit': true,
					'result.cached': true,
				});
				return cachedResult;
			}

			this.observability.incrementCounter('cache_misses', 1, {
				type: validatedRequest.type,
			});

			// Execute enhancement with circuit breaker and bulkhead
			const result = await this.circuitBreaker.execute(async () => {
				return await this.bulkhead.execute(async () => {
					return await this.profiler.profile(
						`enhancement.${validatedRequest.type}`,
						() => this.enhanceWithRetry(validatedRequest),
						traceContext
					);
				}, traceContext);
			}, traceContext);

			// Cache the result
			await this.cache.set(
				cacheKey,
				result,
				{
					tags: [validatedRequest.type, 'enhancement'],
					ttl: 1800000, // 30 minutes
				},
				traceContext
			);

			// Update metrics
			this.metrics.successfulEnhancements++;
			this.metrics.qualityScores.push(result.qualityValidation?.overallScore || 0.8);

			// Finish span successfully
			this.observability.finishSpan(span, {
				'enhancement.success': true,
				'quality.score': result.qualityValidation?.overallScore || 0.8,
				'cache.hit': false,
			});

			return result;
		} catch (error) {
			// Update failure metrics
			this.metrics.failedEnhancements++;

			this.logger.error('LangChain enhancement failed completely', {
				error: (error as Error).message,
				type: request.type,
				traceId: traceContext.traceId,
			});

			// Update health status
			this.updateHealthStatus('degraded');

			// Record error metrics
			this.observability.incrementCounter('enhancement_failures', 1, {
				type: request.type,
				error: (error as Error).message,
			});

			// Finish span with error
			this.observability.finishSpan(span, {
				'enhancement.success': false,
				'error.message': (error as Error).message,
			});

			// Strategic fallback to rule-based enhancement
			this.logger.info('Attempting fallback to rule-based enhancement', {
				type: request.type,
				traceId: traceContext.traceId,
			});

			try {
				const fallbackResult = await this.fallbackEnhancer.enhance(request);

				// Mark as fallback in metrics
				this.observability.incrementCounter('fallback_enhancements', 1, {
					type: request.type,
				});

				return {
					...fallbackResult,
					// Add metadata indicating this was a fallback
					suggestions: [
						'Enhanced using rule-based fallback due to AI service issues',
						...fallbackResult.suggestions,
					],
				};
			} catch (fallbackError) {
				this.logger.error('Both AI and fallback enhancement failed', {
					aiError: (error as Error).message,
					fallbackError: (fallbackError as Error).message,
					type: request.type,
					traceId: traceContext.traceId,
				});

				// Record total failure
				this.observability.incrementCounter('total_enhancement_failures', 1, {
					type: request.type,
				});

				throw error; // Throw original AI error
			}
		}
	}

	private async enhanceWithRetry(
		request: EnhancementRequest,
		maxAttempts?: number
	): Promise<EnhancementResult> {
		const attempts = maxAttempts || this.maxRetries;
		let lastError: Error;

		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				this.logger.info(
					`Starting LangChain enhancement attempt ${attempt} for type: ${request.type}`
				);

				const strategy = this.enhancementStrategies.get(request.type);

				if (!strategy) {
					throw new ApplicationError(
						`No enhancement strategy found for type: ${request.type}`,
						ErrorCode.CONFIGURATION_ERROR
					);
				}

				// Check service health before proceeding
				if (this.healthStatus === 'unhealthy' && attempt === 1) {
					throw new ApplicationError(
						'Service is unhealthy, cannot perform enhancement',
						ErrorCode.SERVICE_UNAVAILABLE
					);
				}

				const context = await this.buildEnhancementContext(request);
				const enhanced = await this.performLangChainEnhancement(request, strategy, context);

				const qualityCheck = await this.validateEnhancement(
					request.content,
					enhanced,
					request.styleGuide
				);

				if (qualityCheck.overallScore < this.qualityThreshold) {
					throw new ApplicationError(
						`Quality score ${qualityCheck.overallScore} below threshold ${this.qualityThreshold}`,
						ErrorCode.VALIDATION_FAILED
					);
				}

				// TODO: Implement change explanation functionality
				const changes = `Enhanced content with ${request.type} improvements`;

				// Success - update health status
				this.updateHealthStatus('healthy');

				const result: EnhancementResult = {
					original: request.content,
					enhanced,
					changes: [
						{
							type: 'enhancement',
							original: `${request.content.substring(0, 50)}...`,
							replacement: `${enhanced.substring(0, 50)}...`,
							reason: changes,
							location: { start: 0, end: request.content.length },
						},
					],
					metrics: {
						originalWordCount: request.content.split(/\s+/).length,
						enhancedWordCount: enhanced.split(/\s+/).length,
						readabilityChange: qualityCheck.readabilityImprovement,
						changesApplied: 1,
					},
					suggestions: await this.generateAISuggestions(request.type, enhanced, context),
					qualityValidation: {
						coherence: qualityCheck.coherence || 0.8,
						consistency: qualityCheck.styleConsistency || 0.8,
						improvement: qualityCheck.readabilityImprovement || 0.8,
						overallScore: qualityCheck.overallScore,
					},
				};

				if (attempt > 1) {
					this.logger.info(`Enhancement succeeded on attempt ${attempt}`);
				}

				return result;
			} catch (error) {
				lastError = error as Error;

				if (!this.isRetryableError(lastError) || attempt === attempts) {
					this.logger.error(`Enhancement failed after ${attempt} attempts`, {
						error: lastError.message,
						type: request.type,
						totalAttempts: attempt,
					});
					break;
				}

				// Calculate exponential backoff delay
				const delay = Math.min(this.retryDelay * Math.pow(2, attempt - 1), 30000);

				this.logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
					error: lastError.message,
					type: request.type,
				});

				await this.sleep(delay);
			}
		}

		throw lastError!;
	}

	private async validateAndSanitizeRequest(
		request: EnhancementRequest
	): Promise<EnhancementRequest> {
		// Validate request structure
		if (!request || typeof request !== 'object') {
			throw new ApplicationError('Invalid enhancement request', ErrorCode.INVALID_INPUT);
		}

		if (!request.content || typeof request.content !== 'string') {
			throw new ApplicationError(
				'Content is required and must be a string',
				ErrorCode.INVALID_INPUT
			);
		}

		if (!request.type) {
			throw new ApplicationError('Enhancement type is required', ErrorCode.INVALID_INPUT);
		}

		// Sanitize content
		const sanitizedContent = this.sanitizeContent(request.content);

		// Validate content length
		if (sanitizedContent.length < 10) {
			throw new ApplicationError(
				'Content too short for enhancement (minimum 10 characters)',
				ErrorCode.INVALID_INPUT
			);
		}

		if (sanitizedContent.length > 50000) {
			throw new ApplicationError(
				'Content too long for enhancement (maximum 50,000 characters)',
				ErrorCode.INVALID_INPUT
			);
		}

		return {
			...request,
			content: sanitizedContent,
			options: request.options || {},
		};
	}

	private sanitizeContent(content: string): string {
		return (
			content
				// eslint-disable-next-line no-control-regex
				.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
				.replace(/\r\n/g, '\n') // Normalize line endings
				.trim()
		);
	}

	private isRetryableError(error: Error): boolean {
		const message = error.message.toLowerCase();

		// Retryable error patterns
		const retryablePatterns = [
			'rate limit',
			'timeout',
			'network error',
			'service unavailable',
			'internal server error',
			'connection',
			'429',
			'500',
			'503',
		];

		return retryablePatterns.some((pattern) => message.includes(pattern));
	}

	private updateHealthStatus(status: 'healthy' | 'degraded' | 'unhealthy'): void {
		if (this.healthStatus !== status) {
			this.logger.info(`Health status changed from ${this.healthStatus} to ${status}`);
			this.healthStatus = status;
		}
	}

	private async sleep(ms: number): Promise<void> {
		const sleepTimeout = new AdaptiveTimeout({
			operation: 'sleep-delay',
			baseTimeout: ms,
			maxTimeout: ms * 2,
			stallTimeout: ms + 5000,
		});

		return sleepTimeout.wait(AsyncUtils.sleep(ms));
	}

	// Public health monitoring methods
	public getHealthStatus(): 'healthy' | 'degraded' | 'unhealthy' {
		return this.healthStatus;
	}

	public isInitialized(): boolean {
		return this.initialized;
	}

	public async performHealthCheck(): Promise<boolean> {
		try {
			const testRequest: EnhancementRequest = {
				content: 'Health check test.',
				type: 'grammar' as EnhancementType,
				options: {},
			};

			await this.enhanceWithRetry(testRequest, 1);
			this.updateHealthStatus('healthy');
			return true;
		} catch (error) {
			this.logger.warn('Health check failed', { error: (error as Error).message });
			this.updateHealthStatus('unhealthy');
			return false;
		}
	}

	private async buildEnhancementContext(
		request: EnhancementRequest
	): Promise<EnhancementContext> {
		const context: EnhancementContext = {};

		if (request.context) {
			context.surroundingText = request.context;

			try {
				// Simple context analysis since analyzeContent method doesn't exist
				context.characterVoices = this.extractCharacterVoices(request.context);
				context.sceneType = this.detectSceneType(request.content);
				context.genre = 'general';
			} catch (error) {
				this.logger.warn('Failed to build advanced context', {
					error: (error as Error).message,
				});
			}
		}

		return context;
	}

	private extractCharacterVoices(context: string): string[] {
		// Extract character names from dialogue and context
		const characters: Set<string> = new Set();

		// Look for names before dialogue
		const namePattern = /([A-Z][a-z]+)\s+(?:said|asked|replied|whispered|shouted|murmured)/g;
		let match;
		while ((match = namePattern.exec(context)) !== null) {
			characters.add(match[1]);
		}

		return Array.from(characters);
	}

	private detectSceneType(
		content: string
	): 'action' | 'dialogue' | 'description' | 'introspection' {
		if (content.includes('"') && content.split('"').length > 4) return 'dialogue';

		const actionWords = /\b(ran|jumped|fought|grabbed|threw|struck|moved|rushed|charged)\b/i;
		if (actionWords.test(content)) return 'action';

		const thoughtWords = /\b(thought|wondered|realized|remembered|felt|considered)\b/i;
		if (thoughtWords.test(content)) return 'introspection';

		return 'description';
	}

	private async performLangChainEnhancement(
		request: EnhancementRequest,
		strategy: EnhancementStrategy,
		context: EnhancementContext
	): Promise<string> {
		let enhanced = request.content;

		for (let iteration = 0; iteration < strategy.iterations; iteration++) {
			const prompt = this.buildEnhancementPrompt(
				enhanced,
				request,
				strategy,
				context,
				iteration
			);

			try {
				const result = await this.langchain.generateWithTemplate(
					strategy.template as any,
					enhanced,
					{
						customPrompt: prompt,
					}
				);

				enhanced = result.content;

				if (iteration < strategy.iterations - 1) {
					await AsyncUtils.sleep(100);
				}
			} catch (error) {
				this.logger.warn(`Enhancement iteration ${iteration + 1} failed`, {
					error: (error as Error).message,
				});
				break;
			}
		}

		return enhanced;
	}

	private buildEnhancementPrompt(
		_content: string,
		request: EnhancementRequest,
		_strategy: EnhancementStrategy,
		context: EnhancementContext,
		iteration: number
	): string {
		let prompt = `Please enhance this text for "${request.type}".`;

		if (iteration === 0) {
			prompt += ` Focus on ${this.getEnhancementFocus(request.type)}.`;
		} else {
			prompt += ` This is iteration ${iteration + 1}, refine the previous enhancement.`;
		}

		if (request.styleGuide) {
			const styleInstructions = this.buildStyleInstructions(request.styleGuide);
			if (styleInstructions) {
				prompt += ` Style requirements: ${styleInstructions}`;
			}
		}

		if (context.characterVoices?.length) {
			prompt += ` Preserve character voices for: ${context.characterVoices.join(', ')}.`;
		}

		if (context.sceneType) {
			prompt += ` This is a ${context.sceneType} scene.`;
		}

		if (context.surroundingText) {
			prompt += ` Context: ${context.surroundingText.slice(0, 200)}...`;
		}

		prompt += ' Maintain the original meaning and tone.';

		return prompt;
	}

	private getEnhancementFocus(type: EnhancementType): string {
		const focusMap: Record<EnhancementType, string> = {
			'improve-flow': 'improving sentence rhythm and transitions between ideas',
			'enhance-descriptions': 'adding vivid, specific details without overwriting',
			'strengthen-dialogue': 'making dialogue more natural and character-specific',
			'show-dont-tell': 'converting exposition into action and sensory details',
			'add-sensory-details': 'incorporating sight, sound, touch, smell, and taste',
			'strengthen-verbs': 'replacing weak verbs with stronger, more specific alternatives',
			'vary-sentences': 'creating varied sentence lengths and structures',
			'fix-pacing': 'adjusting sentence length and complexity for better pacing',
			rewrite: 'comprehensive rewriting while preserving core meaning',
			expand: 'adding relevant detail and depth',
			condense: 'removing unnecessary words while keeping essential meaning',
			'fix-continuity': 'ensuring consistency with established details',
			'match-style': 'adapting to match the specified writing style',
			'eliminate-filter-words': 'removing unnecessary filter words and qualifiers',
		};

		return focusMap[type] || 'general text improvement';
	}

	private buildStyleInstructions(styleGuide: StyleGuide): string {
		const instructions: string[] = [];

		if (styleGuide.tense) {
			instructions.push(`use ${styleGuide.tense} tense`);
		}

		if (styleGuide.pov) {
			instructions.push(`write in ${styleGuide.pov} perspective`);
		}

		if (styleGuide.tone) {
			instructions.push(`maintain ${styleGuide.tone} tone`);
		}

		if (styleGuide.sentenceComplexity) {
			instructions.push(`use ${styleGuide.sentenceComplexity} sentence structure`);
		}

		if (styleGuide.vocabularyLevel) {
			instructions.push(`use ${styleGuide.vocabularyLevel} vocabulary`);
		}

		return instructions.join(', ');
	}

	private async validateEnhancement(
		original: string,
		enhanced: string,
		styleGuide?: StyleGuide
	): Promise<QualityMetrics & { overallScore: number }> {
		try {
			const coherence = this.calculateCoherence(original, enhanced);
			const styleConsistency = await this.calculateStyleConsistency(
				original,
				enhanced,
				styleGuide
			);
			const readabilityImprovement = this.calculateReadabilityImprovement(original, enhanced);
			const characterVoiceRetention = this.calculateCharacterVoiceRetention(
				original,
				enhanced
			);

			const overallScore =
				coherence * 0.3 +
				styleConsistency * 0.3 +
				Math.max(0, readabilityImprovement / 100 + 0.5) * 0.2 +
				characterVoiceRetention * 0.2;

			return {
				coherence,
				styleConsistency,
				readabilityImprovement,
				characterVoiceRetention,
				overallScore: Math.max(0, Math.min(1, overallScore)),
			};
		} catch (error) {
			this.logger.warn('Quality validation failed, using heuristic', {
				error: (error as Error).message,
			});
			return {
				coherence: 0.8,
				styleConsistency: 0.8,
				readabilityImprovement: 0,
				characterVoiceRetention: 0.8,
				overallScore: 0.8,
			};
		}
	}

	private calculateReadabilityImprovement(original: string, enhanced: string): number {
		// Simple readability calculation based on sentence length and complexity
		const originalSentences = original.split(/[.!?]+/).filter((s) => s.trim().length > 0);
		const enhancedSentences = enhanced.split(/[.!?]+/).filter((s) => s.trim().length > 0);

		const originalAvgLength =
			originalSentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) /
			originalSentences.length;
		const enhancedAvgLength =
			enhancedSentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) /
			enhancedSentences.length;

		// Improvement is based on reaching optimal sentence length (15-20 words)
		const optimalLength = 17.5;
		const originalDistance = Math.abs(originalAvgLength - optimalLength);
		const enhancedDistance = Math.abs(enhancedAvgLength - optimalLength);

		return ((originalDistance - enhancedDistance) / originalDistance) * 100;
	}

	private calculateCoherence(original: string, enhanced: string): number {
		const originalWords = new Set(original.toLowerCase().split(/\s+/));
		const enhancedWords = new Set(enhanced.toLowerCase().split(/\s+/));

		let overlap = 0;
		originalWords.forEach((word) => {
			if (enhancedWords.has(word)) overlap++;
		});

		const coherenceScore = overlap / Math.max(originalWords.size, enhancedWords.size);
		return Math.max(0.3, coherenceScore);
	}

	private async calculateStyleConsistency(
		_original: string,
		enhanced: string,
		styleGuide?: StyleGuide
	): Promise<number> {
		if (!styleGuide) {
			return 0.9;
		}

		let score = 1.0;

		if (styleGuide.tense) {
			const tenseConsistency = this.checkTenseConsistency(enhanced, styleGuide.tense);
			score *= tenseConsistency;
		}

		if (styleGuide.sentenceComplexity) {
			const complexityScore = this.checkComplexityConsistency(
				enhanced,
				styleGuide.sentenceComplexity
			);
			score *= complexityScore;
		}

		return Math.max(0.5, score);
	}

	private checkTenseConsistency(text: string, targetTense: string): number {
		const verbs = text.match(/\b\w+ed\b|\b\w+ing\b|\b\w+s\b/g) || [];
		const pastTenseCount = (text.match(/\b\w+ed\b/g) || []).length;
		const presentTenseCount = (text.match(/\b\w+s\b/g) || []).length;

		if (verbs.length === 0) return 1.0;

		const targetCount = targetTense === 'past' ? pastTenseCount : presentTenseCount;
		return targetCount / verbs.length;
	}

	private checkComplexityConsistency(text: string, targetComplexity: string): number {
		const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
		const avgWordsPerSentence = text.split(/\s+/).length / sentences.length;

		if (targetComplexity === 'simple' && avgWordsPerSentence <= 15) return 1.0;
		if (targetComplexity === 'complex' && avgWordsPerSentence >= 15) return 1.0;
		if (targetComplexity === 'varied') return 0.9;

		return 0.7;
	}

	private calculateCharacterVoiceRetention(original: string, enhanced: string): number {
		const originalDialogue = (original.match(/"[^"]*"/g) || []).join(' ');
		const enhancedDialogue = (enhanced.match(/"[^"]*"/g) || []).join(' ');

		if (!originalDialogue && !enhancedDialogue) return 1.0;
		if (!originalDialogue || !enhancedDialogue) return 0.5;

		const originalWords = new Set(originalDialogue.toLowerCase().split(/\s+/));
		const enhancedWords = new Set(enhancedDialogue.toLowerCase().split(/\s+/));

		let overlap = 0;
		originalWords.forEach((word) => {
			if (enhancedWords.has(word)) overlap++;
		});

		return overlap / Math.max(originalWords.size, enhancedWords.size, 1);
	}

	private async generateAISuggestions(
		type: EnhancementType,
		content: string,
		_context: EnhancementContext
	): Promise<string[]> {
		try {
			const suggestionPrompt = `Based on this ${type} enhancement of the text, provide 3 specific suggestions for further improvement:

${content}

Focus on actionable advice that builds on the current enhancement.`;

			const result = await this.langchain.generateWithTemplate(
				'character_development' as any,
				suggestionPrompt,
				{
					customPrompt: suggestionPrompt,
				}
			);

			return result.content
				.split('\n')
				.filter((line) => line.trim().length > 0)
				.map((line) => line.replace(/^\d+\.\s*/, '').trim())
				.slice(0, 3);
		} catch (error) {
			this.logger.warn('AI suggestion generation failed', {
				error: (error as Error).message,
			});
			return [
				'Review the enhanced content for accuracy and consistency',
				'Ensure character voices remain authentic to their established personalities',
				'Verify that the enhancement maintains the intended tone and pacing',
			];
		}
	}

	async batchEnhance(requests: EnhancementRequest[]): Promise<EnhancementResult[]> {
		this.logger.info(`Starting batch enhancement for ${requests.length} requests`);

		const results: EnhancementResult[] = [];
		const batchSize = 3;

		for (let i = 0; i < requests.length; i += batchSize) {
			const batch = requests.slice(i, i + batchSize);

			const batchPromises = batch.map(async (request) => {
				try {
					return await this.enhance(request);
				} catch (error) {
					this.logger.error(`Batch enhancement failed for request ${i}`, {
						error: (error as Error).message,
					});
					return this.fallbackEnhancer.enhance(request);
				}
			});

			const batchResults = await Promise.all(batchPromises);
			results.push(...batchResults);

			if (i + batchSize < requests.length) {
				await AsyncUtils.sleep(200);
			}
		}

		this.logger.info(`Completed batch enhancement with ${results.length} results`);
		return results;
	}

	async previewEnhancement(request: EnhancementRequest): Promise<{
		preview: string;
		confidence: number;
		estimatedChanges: number;
	}> {
		try {
			const strategy = this.enhancementStrategies.get(request.type);
			if (!strategy) {
				return {
					preview: request.content,
					confidence: 0,
					estimatedChanges: 0,
				};
			}

			const context = await this.buildEnhancementContext(request);
			const prompt = this.buildEnhancementPrompt(
				request.content,
				request,
				strategy,
				context,
				0
			);

			const preview = await this.langchain.generateWithTemplate(
				'character_development' as any,
				request.content,
				{
					customPrompt: `${prompt} Provide only the first 100 words of the enhancement.`,
				}
			);

			const estimatedChanges = Math.floor(request.content.split(/\s+/).length / 10);

			return {
				preview: preview.content,
				confidence: strategy.stylePreservation,
				estimatedChanges,
			};
		} catch (error) {
			this.logger.warn('Enhancement preview failed', { error: (error as Error).message });
			return {
				preview: request.content,
				confidence: 0,
				estimatedChanges: 0,
			};
		}
	}
}
