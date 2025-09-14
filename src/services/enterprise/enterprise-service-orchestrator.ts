/**
 * Enterprise Service Orchestrator - Unified service layer with advanced patterns
 * Orchestrates circuit breakers, observability, caching, security, and performance monitoring
 */

import { EventEmitter } from 'events';
import { createError, ErrorCode, handleError, generateHash } from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';

// Import enterprise components
import {
	EnterpriseCircuitBreaker,
	BulkheadIsolation,
	type CircuitBreakerConfig,
	type BulkheadConfig,
} from './service-foundation.js';
import { ObservabilityManager, type TraceContext, type Span } from './observability.js';
import { IntelligentCache, PerformanceProfiler } from './performance-optimizer.js';
import {
	SecurityValidator,
	SecurityRateLimiter,
	SecurityContextManager,
	type SecurityContext,
	type ValidationRule,
	type ThreatEvent,
} from './security-layer.js';

const logger = getLogger('enterprise-orchestrator');

// Orchestrator Types
export interface ServiceConfig {
	name: string;
	circuitBreaker?: CircuitBreakerConfig;
	bulkhead?: BulkheadConfig;
	cache?: {
		maxSize: number;
		maxAge?: number;
		compressionThreshold?: number;
	};
	security?: {
		validationRules?: ValidationRule[];
		rateLimitPolicies?: Array<{
			name: string;
			windowMs: number;
			maxRequests: number;
			keyGenerator: (context: SecurityContext) => string;
		}>;
		requireAuthentication?: boolean;
	};
	observability?: {
		sampling?: number;
		enableMetrics?: boolean;
		enableTracing?: boolean;
	};
}

export interface ServiceRequest<T = unknown> {
	operation: string;
	data?: T;
	context: {
		ipAddress: string;
		userAgent: string;
		sessionId?: string;
		userId?: string;
		traceContext?: TraceContext;
	};
	options?: {
		skipCache?: boolean;
		skipValidation?: boolean;
		skipRateLimit?: boolean;
		timeout?: number;
	};
}

export interface ServiceResponse<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
	metadata: {
		executionTime: number;
		fromCache: boolean;
		threats?: ThreatEvent[];
		traceId: string;
		spanId: string;
		performanceMetrics?: {
			cacheHitRate: number;
			circuitBreakerState: string;
			activeConnections: number;
		};
	};
}

// Enterprise Service Orchestrator
export class EnterpriseServiceOrchestrator extends EventEmitter {
	private services = new Map<
		string,
		{
			config: ServiceConfig;
			circuitBreaker?: EnterpriseCircuitBreaker;
			bulkhead?: BulkheadIsolation;
			cache?: IntelligentCache;
		}
	>();

	private observability: ObservabilityManager;
	private performanceProfiler: PerformanceProfiler;
	private securityValidator: SecurityValidator;
	private securityRateLimiter: SecurityRateLimiter;
	private securityContextManager: SecurityContextManager;
	private globalCache: IntelligentCache;

	constructor(options: { serviceName: string; samplingRate?: number; globalCacheSize?: number }) {
		super();

		// Initialize core components
		this.observability = new ObservabilityManager({
			serviceName: options.serviceName,
			samplingRate: options.samplingRate || 0.1,
		});

		this.performanceProfiler = new PerformanceProfiler();
		this.securityValidator = new SecurityValidator();
		this.securityRateLimiter = new SecurityRateLimiter();
		this.securityContextManager = new SecurityContextManager();

		this.globalCache = new IntelligentCache({
			maxSize: options.globalCacheSize || 1000,
			maxAge: 30 * 60 * 1000, // 30 minutes
			compressionThreshold: 1024,
		});

		this.setupHealthChecks();
		this.setupEventHandlers();
	}

	/**
	 * Register a service with enterprise patterns
	 */
	registerService(config: ServiceConfig): void {
		const service: {
			config: ServiceConfig;
			circuitBreaker?: EnterpriseCircuitBreaker;
			bulkhead?: BulkheadIsolation;
			cache?: IntelligentCache;
		} = { config };

		// Initialize circuit breaker if configured
		if (config.circuitBreaker) {
			service.circuitBreaker = new EnterpriseCircuitBreaker(
				config.name,
				config.circuitBreaker
			);

			service.circuitBreaker.on('state-change', (event: unknown) => {
				this.observability.incrementCounter('circuit_breaker_state_changes', 1, {
					service: config.name,
					from: (event as Record<string, unknown>).from as string,
					to: (event as Record<string, unknown>).to as string,
				});
			});
		}

		// Initialize bulkhead if configured
		if (config.bulkhead) {
			service.bulkhead = new BulkheadIsolation(config.name, config.bulkhead);
		}

		// Initialize service-specific cache if configured
		if (config.cache) {
			service.cache = new IntelligentCache(config.cache);

			service.cache.on('entry-evicted', (event) => {
				this.observability.incrementCounter('cache_evictions', 1, {
					service: config.name,
					level: event.level,
				});
			});
		}

		// Setup security rate limiting policies
		if (config.security?.rateLimitPolicies) {
			for (const policy of config.security.rateLimitPolicies) {
				this.securityRateLimiter.addPolicy(`${config.name}-${policy.name}`, {
					windowMs: policy.windowMs,
					maxRequests: policy.maxRequests,
					skipSuccessfulRequests: false,
					skipFailedRequests: false,
					keyGenerator: (context: Record<string, unknown>) => 
						policy.keyGenerator(context as unknown as SecurityContext),
				});
			}
		}

		this.services.set(config.name, service);
		logger.info('Service registered', {
			serviceName: config.name,
			features: {
				circuitBreaker: !!config.circuitBreaker,
				bulkhead: !!config.bulkhead,
				cache: !!config.cache,
				security: !!config.security,
			},
		});
	}

	/**
	 * Execute a service operation with all enterprise patterns applied
	 */
	async execute<TRequest, TResponse>(
		serviceName: string,
		request: ServiceRequest<TRequest>,
		handler: (data: TRequest, context: TraceContext) => Promise<TResponse>
	): Promise<ServiceResponse<TResponse>> {
		const service = this.services.get(serviceName);
		if (!service) {
			throw createError(ErrorCode.NOT_FOUND, { serviceName }, 'Service not found');
		}

		const startTime = Date.now();
		let span: Span | undefined;
		let securityContext: SecurityContext | undefined;
		let fromCache = false;
		let threats: ThreatEvent[] = [];

		try {
			// Create security context
			securityContext = this.securityContextManager.createSecurityContext(request.context);

			// Start distributed tracing
			span = this.observability.startSpan(
				`${serviceName}.${request.operation}`,
				request.context.traceContext,
				{
					'service.name': serviceName,
					'operation.name': request.operation,
					'client.ip': request.context.ipAddress,
					'user.id': request.context.userId,
				}
			);

			// Security validation
			if (!request.options?.skipValidation && service.config.security?.validationRules) {
				const validationResult = await this.securityValidator.validate(
					request.data || {},
					service.config.security.validationRules,
					securityContext
				);

				if (!validationResult.valid) {
					threats = validationResult.threats || [];
					const criticalThreats = threats.filter(
						(t) => t.severity === 'critical' || t.severity === 'high'
					);

					if (criticalThreats.length > 0) {
						// Log the security threat
						logger.warn('Security validation failed', { threats: criticalThreats });

						throw createError(
							ErrorCode.FORBIDDEN,
							{ threats: criticalThreats },
							'Request blocked due to security threats'
						);
					}
				}

				if (validationResult.threats) {
					threats.push(...validationResult.threats);
				}

				// Use sanitized data
				request.data = validationResult.sanitized as TRequest;
			}

			// Rate limiting
			if (!request.options?.skipRateLimit && service.config.security?.rateLimitPolicies) {
				for (const policy of service.config.security.rateLimitPolicies) {
					const rateLimitResult = await this.securityRateLimiter.checkLimit(
						`${serviceName}-${policy.name}`,
						securityContext,
						{ traceId: span.traceId, spanId: span.spanId, baggage: span.baggage }
					);

					if (!rateLimitResult.allowed) {
						if (rateLimitResult.threats) {
							threats.push(...rateLimitResult.threats);
						}

						// Log rate limit exceeded
						logger.warn('Rate limit exceeded', {
							policy: policy.name,
							context: securityContext,
						});

						throw createError(
							ErrorCode.RATE_LIMITED,
							{ resetTime: rateLimitResult.resetTime },
							'Rate limit exceeded'
						);
					}
				}
			}

			// Check cache
			const cacheKey = this.generateCacheKey(serviceName, request);
			let response: TResponse | undefined;

			if (!request.options?.skipCache && service.cache) {
				response = await service.cache.get(cacheKey, {
					traceId: span.traceId,
					spanId: span.spanId,
					baggage: span.baggage,
				});

				if (response) {
					fromCache = true;
					this.observability.incrementCounter('cache_hits', 1, { service: serviceName });
				} else {
					this.observability.incrementCounter('cache_misses', 1, {
						service: serviceName,
					});
				}
			}

			// Execute operation if not cached
			if (!response) {
				// Apply bulkhead isolation
				const executeOperation = async (): Promise<TResponse> => {
					const operationContext = {
						traceId: span!.traceId,
						spanId: span!.spanId,
						baggage: span!.baggage,
					};

					// Profile the operation
					return await this.performanceProfiler.profile(
						`${serviceName}.${request.operation}`,
						() => handler(request.data!, operationContext),
						operationContext
					);
				};

				if (service.bulkhead) {
					response = await service.bulkhead.execute(executeOperation, {
						traceId: span.traceId,
						spanId: span.spanId,
						baggage: span.baggage,
						startTime: Date.now(),
					});
				} else if (service.circuitBreaker) {
					response = await service.circuitBreaker.execute(executeOperation, {
						traceId: span.traceId,
						spanId: span.spanId,
						baggage: span.baggage,
						startTime: Date.now(),
					});
				} else {
					response = await executeOperation();
				}

				// Cache the response
				if (service.cache && response) {
					await service.cache.set(
						cacheKey,
						response,
						{
							tags: [serviceName, request.operation],
							ttl: 5 * 60 * 1000, // 5 minutes
						},
						{
							traceId: span.traceId,
							spanId: span.spanId,
							baggage: span.baggage,
						}
					);
				}
			}

			// Record metrics
			const executionTime = Date.now() - startTime;
			this.observability.recordHistogram('service_request_duration', executionTime, {
				service: serviceName,
				operation: request.operation,
				success: 'true',
			});

			this.observability.incrementCounter('service_requests_total', 1, {
				service: serviceName,
				operation: request.operation,
				status: 'success',
			});

			// Finish span
			this.observability.finishSpan(span, {
				'response.cached': fromCache,
				'response.size': JSON.stringify(response).length,
				'threats.count': threats.length,
			});

			return {
				success: true,
				data: response,
				metadata: {
					executionTime,
					fromCache,
					threats: threats.length > 0 ? threats : undefined,
					traceId: span.traceId,
					spanId: span.spanId,
					performanceMetrics: {
						cacheHitRate: this.calculateCacheHitRate(serviceName),
						circuitBreakerState:
							service.circuitBreaker?.getMetrics().circuitBreakerState || 'disabled',
						activeConnections: service.bulkhead?.getMetrics().activeTasks || 0,
					},
				},
			};
		} catch (error) {
			const executionTime = Date.now() - startTime;
			const appError = handleError(error, `service-execution-${serviceName}`);

			// Record error metrics
			this.observability.recordHistogram('service_request_duration', executionTime, {
				service: serviceName,
				operation: request.operation,
				success: 'false',
			});

			this.observability.incrementCounter('service_requests_total', 1, {
				service: serviceName,
				operation: request.operation,
				status: 'error',
			});

			// Finish span with error
			if (span) {
				logger.error('Service execution failed', { serviceName, error: appError.message });
				this.observability.finishSpan(span, {
					'error.type': appError.code,
					'threats.count': threats.length,
				});
			}

			return {
				success: false,
				error: appError.message,
				metadata: {
					executionTime,
					fromCache: false,
					threats: threats.length > 0 ? threats : undefined,
					traceId: span?.traceId || 'unknown',
					spanId: span?.spanId || 'unknown',
				},
			};
		}
	}

	/**
	 * Get comprehensive service metrics
	 */
	getServiceMetrics(serviceName?: string): Record<string, unknown> {
		const metrics: Record<string, unknown> = {};

		if (serviceName) {
			const service = this.services.get(serviceName);
			if (service) {
				metrics[serviceName] = {
					circuitBreaker: service.circuitBreaker?.getMetrics(),
					bulkhead: service.bulkhead?.getMetrics(),
					cache: service.cache?.getMetrics(),
					performance: this.performanceProfiler.getProfile(serviceName),
				};
			}
		} else {
			for (const [name, service] of this.services) {
				metrics[name] = {
					circuitBreaker: service.circuitBreaker?.getMetrics(),
					bulkhead: service.bulkhead?.getMetrics(),
					cache: service.cache?.getMetrics(),
					performance: this.performanceProfiler.getProfile(name),
				};
			}
		}

		metrics.global = {
			observability: this.observability.getObservabilityData(),
			security: this.securityRateLimiter.getStats(),
			cache: this.globalCache.getMetrics(),
			performance: {
				topSlowest: this.performanceProfiler.getTopSlowestOperations(5),
				highError: this.performanceProfiler.getHighErrorRateOperations(),
			},
		};

		return metrics;
	}

	private generateCacheKey(serviceName: string, request: ServiceRequest): string {
		const keyData = {
			service: serviceName,
			operation: request.operation,
			data: request.data,
			user: request.context.userId,
		};
		return generateHash(JSON.stringify(keyData));
	}

	private calculateCacheHitRate(serviceName: string): number {
		const service = this.services.get(serviceName);
		if (!service?.cache) return 0;

		const metrics = service.cache.getMetrics();
		return metrics.hitRate;
	}

	private setupHealthChecks(): void {
		this.observability.addHealthCheck('database', async () => {
			// Implement database health check
			return true;
		});

		this.observability.addHealthCheck('cache', async () => {
			try {
				await this.globalCache.set('health-check', 'ok', { ttl: 1000 });
				const result = await this.globalCache.get('health-check');
				return result === 'ok';
			} catch {
				return false;
			}
		});

		this.observability.addHealthCheck('security', async () => {
			return this.securityValidator.isIPBlocked('127.0.0.1') === false;
		});
	}

	private setupEventHandlers(): void {
		// Security event handlers
		this.securityRateLimiter.on('ip-blocked', (event) => {
			logger.warn('IP blocked by security layer', event);
			this.observability.incrementCounter('security_ip_blocks', 1, {
				ip: event.ip,
			});
		});

		// Cache event handlers
		this.globalCache.on('entry-evicted', (event) => {
			this.observability.incrementCounter('global_cache_evictions', 1, {
				level: event.level,
			});
		});

		// Performance monitoring
		setInterval(() => {
			const profiles = this.performanceProfiler.getAllProfiles();
			for (const profile of profiles) {
				this.observability.setGauge('operation_avg_response_time', profile.avgTime, {
					operation: profile.operationName,
				});
				this.observability.setGauge('operation_error_rate', profile.errorRate, {
					operation: profile.operationName,
				});
			}
		}, 30000); // Every 30 seconds
	}

	/**
	 * Graceful shutdown
	 */
	async shutdown(): Promise<void> {
		logger.info('Shutting down enterprise service orchestrator');

		// Shutdown all circuit breakers
		for (const service of this.services.values()) {
			if (service.circuitBreaker) {
				service.circuitBreaker.destroy();
			}
			if (service.cache) {
				service.cache.destroy();
			}
		}

		// Cleanup global resources
		this.globalCache.destroy();
		this.performanceProfiler.reset();

		this.removeAllListeners();
		logger.info('Enterprise service orchestrator shutdown complete');
	}
}
