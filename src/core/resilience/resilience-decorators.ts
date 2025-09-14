/**
 * Resilience Decorators for Service Integration
 * Easy-to-use decorators that add circuit breaking, retries, caching, and monitoring to services
 */

import { getLogger } from '../logger.js';
import { CircuitBreaker as CircuitBreakerClass, CircuitBreakerFactory } from './circuit-breaker.js';
import { RetryStrategy, RetryStrategies } from './retry-strategies.js';
import { MultiLevelCache, globalCacheManager } from './multi-level-cache.js';
import { globalMetricsRegistry } from './metrics-collector.js';
import { globalProfiler } from './performance-profiler.js';
import { AppError, ErrorCode, generateHash } from '../../utils/common.js';

export interface ResilienceConfig {
	/** Enable circuit breaker */
	circuitBreaker?: {
		enabled: boolean;
		name?: string;
		failureThreshold?: number;
		successThreshold?: number;
		timeWindow?: number;
		openTimeout?: number;
	};
	/** Enable retry mechanism */
	retry?: {
		enabled: boolean;
		strategy?: 'conservative' | 'aggressive' | 'fast' | 'network' | 'database';
		maxAttempts?: number;
		initialDelay?: number;
		maxDelay?: number;
		backoffMultiplier?: number;
		jitter?: boolean;
	};
	/** Enable caching */
	cache?: {
		enabled: boolean;
		cacheName?: string;
		keyGenerator?: (...args: any[]) => string;
		ttl?: number;
		enableL1?: boolean;
		enableL2?: boolean;
		tags?: Record<string, string>;
	};
	/** Enable metrics collection */
	metrics?: {
		enabled: boolean;
		operationName?: string;
		tags?: Record<string, string>;
	};
	/** Enable performance profiling */
	profiling?: {
		enabled: boolean;
		operationName?: string;
		sampleRate?: number;
		tags?: Record<string, string>;
	};
	/** Timeout configuration */
	timeout?: {
		enabled: boolean;
		duration: number;
	};
}

/**
 * Master resilience decorator that combines all resilience patterns
 */
export function Resilient(config: ResilienceConfig = {}) {
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value;
		const className = target.constructor.name;
		const operationName = `${className}.${propertyKey}`;
		const logger = getLogger('resilience-decorator');

		// Initialize components based on configuration
		let circuitBreaker: CircuitBreakerClass | undefined;
		let retryStrategy: RetryStrategy | undefined;
		let cache: MultiLevelCache | undefined;

		// Setup circuit breaker
		if (config.circuitBreaker?.enabled) {
			const cbName = config.circuitBreaker.name || operationName;
			circuitBreaker = CircuitBreakerFactory.getCircuitBreaker(cbName, {
				failureThreshold: config.circuitBreaker.failureThreshold || 5,
				successThreshold: config.circuitBreaker.successThreshold || 2,
				timeWindow: config.circuitBreaker.timeWindow || 60000,
				openTimeout: config.circuitBreaker.openTimeout || 30000,
				name: cbName,
			});
		}

		// Setup retry strategy
		if (config.retry?.enabled) {
			const strategyType = config.retry.strategy || 'conservative';
			switch (strategyType) {
				case 'conservative':
					retryStrategy = RetryStrategies.createConservative(circuitBreaker, operationName);
					break;
				case 'aggressive':
					retryStrategy = RetryStrategies.createAggressive(circuitBreaker, operationName);
					break;
				case 'fast':
					retryStrategy = RetryStrategies.createFast(circuitBreaker, operationName);
					break;
				case 'network':
					retryStrategy = RetryStrategies.createNetwork(circuitBreaker, operationName);
					break;
				case 'database':
					retryStrategy = RetryStrategies.createDatabase(circuitBreaker, operationName);
					break;
			}
		}

		// Setup cache
		if (config.cache?.enabled) {
			const cacheName = config.cache.cacheName || `${className}-cache`;
			cache = globalCacheManager.getCache(cacheName, {
				enableL1: config.cache.enableL1 !== false,
				enableL2: config.cache.enableL2 || false,
				name: cacheName,
				l1Config: {
					ttl: config.cache.ttl || 300000,
				},
			});
		}

		// Setup metrics
		let metricsEnabled = config.metrics?.enabled !== false;
		let counter: any, timer: any, errorCounter: any;
		
		if (metricsEnabled) {
			const metricName = config.metrics?.operationName || operationName;
			const tags = config.metrics?.tags || { class: className, method: propertyKey };
			
			counter = globalMetricsRegistry.counter(
				`operations.${metricName}.total`,
				`Total calls to ${metricName}`,
				tags
			);
			
			timer = globalMetricsRegistry.timer(
				`operations.${metricName}.duration`,
				`Duration of ${metricName} calls`,
				tags
			);
			
			errorCounter = globalMetricsRegistry.counter(
				`operations.${metricName}.errors`,
				`Errors in ${metricName}`,
				tags
			);
		}

		// Setup profiling
		let profilingEnabled = config.profiling?.enabled !== false;
		const profilingOperationName = config.profiling?.operationName || operationName;
		const profilingTags = config.profiling?.tags || { class: className, method: propertyKey };

		// Create the resilient wrapper
		descriptor.value = async function (...args: any[]) {
			// Generate cache key if caching is enabled
			let cacheKey: string | undefined;
			if (cache && config.cache?.enabled) {
				if (config.cache.keyGenerator) {
					cacheKey = config.cache.keyGenerator(...args);
				} else {
					cacheKey = generateCacheKey(operationName, args);
				}

				// Try cache first
				try {
					const cachedResult = await cache.get(cacheKey);
					if (cachedResult !== null) {
						if (metricsEnabled) {
							counter?.increment();
						}
						logger.debug(`Cache hit for ${operationName}`, { cacheKey });
						return cachedResult;
					}
				} catch (error) {
					logger.warn(`Cache get failed for ${operationName}`, {
						error: (error as Error).message,
						cacheKey,
					});
				}
			}

			// Start metrics and profiling
			if (metricsEnabled) {
				counter?.increment();
			}

			const profiler = profilingEnabled ? globalProfiler.startOperation(profilingOperationName, profilingTags) : null;

			try {
				// Execute with timeout if configured
				let executionPromise: Promise<any>;

				if (config.timeout?.enabled && config.timeout.duration > 0) {
					executionPromise = executeWithTimeout(
						async () => {
							// Execute with retry and circuit breaker
							if (retryStrategy) {
								return await retryStrategy.execute(async () => {
									return await originalMethod.apply(this, args);
								});
							} else if (circuitBreaker) {
								return await circuitBreaker.execute(async () => {
									return await originalMethod.apply(this, args);
								});
							} else {
								return await originalMethod.apply(this, args);
							}
						},
						config.timeout.duration
					);
				} else {
					// Execute with retry and circuit breaker (no timeout)
					if (retryStrategy) {
						executionPromise = retryStrategy.execute(async () => {
							return await originalMethod.apply(this, args);
						});
					} else if (circuitBreaker) {
						executionPromise = circuitBreaker.execute(async () => {
							return await originalMethod.apply(this, args);
						});
					} else {
						executionPromise = originalMethod.apply(this, args);
					}
				}

				// Measure execution time
				const result = metricsEnabled && timer ? 
					await timer.timeAsync(() => executionPromise) : 
					await executionPromise;

				// Cache the result if caching is enabled
				if (cache && cacheKey && config.cache?.enabled) {
					try {
						await cache.set(cacheKey, result, config.cache.ttl, config.cache.tags);
						logger.debug(`Result cached for ${operationName}`, { cacheKey });
					} catch (error) {
						logger.warn(`Cache set failed for ${operationName}`, {
							error: (error as Error).message,
							cacheKey,
						});
					}
				}

				// Mark profiler as successful
				profiler?.success();

				return result;

			} catch (error) {
				// Record error metrics
				if (metricsEnabled) {
					errorCounter?.increment();
				}

				// Record profiler error
				profiler?.error(error as Error);

				logger.error(`Error in ${operationName}`, {
					error: (error as Error).message,
					args: args.length,
				});

				throw error;

			} finally {
				// Finish profiling
				profiler?.finish();
			}
		};

		return descriptor;
	};
}

/**
 * Circuit Breaker decorator
 */
export function CircuitBreaker(name?: string, config?: {
	failureThreshold?: number;
	successThreshold?: number;
	timeWindow?: number;
	openTimeout?: number;
}) {
	return Resilient({
		circuitBreaker: {
			enabled: true,
			name,
			...config,
		},
	});
}

/**
 * Retry decorator
 */
export function Retry(strategy: 'conservative' | 'aggressive' | 'fast' | 'network' | 'database' = 'conservative', config?: {
	maxAttempts?: number;
	initialDelay?: number;
	maxDelay?: number;
	backoffMultiplier?: number;
	jitter?: boolean;
}) {
	return Resilient({
		retry: {
			enabled: true,
			strategy,
			...config,
		},
	});
}

/**
 * Cache decorator
 */
export function Cached(config?: {
	cacheName?: string;
	keyGenerator?: (...args: any[]) => string;
	ttl?: number;
	enableL1?: boolean;
	enableL2?: boolean;
	tags?: Record<string, string>;
}) {
	return Resilient({
		cache: {
			enabled: true,
			...config,
		},
	});
}

/**
 * Metrics decorator
 */
export function Metrics(operationName?: string, tags?: Record<string, string>) {
	return Resilient({
		metrics: {
			enabled: true,
			operationName,
			tags,
		},
	});
}

/**
 * Performance profiling decorator
 */
export function Profile(operationName?: string, config?: {
	sampleRate?: number;
	tags?: Record<string, string>;
}) {
	return Resilient({
		profiling: {
			enabled: true,
			operationName,
			sampleRate: config?.sampleRate,
			tags: config?.tags,
		},
	});
}

/**
 * Timeout decorator
 */
export function Timeout(duration: number) {
	return Resilient({
		timeout: {
			enabled: true,
			duration,
		},
	});
}

/**
 * Rate limiting decorator
 */
export function RateLimit(requestsPerSecond: number, burstSize?: number) {
	const rateLimiter = new TokenBucket(requestsPerSecond, burstSize || requestsPerSecond);
	
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value;
		const operationName = `${target.constructor.name}.${propertyKey}`;
		const logger = getLogger('rate-limit-decorator');

		descriptor.value = async function (...args: any[]) {
			if (!rateLimiter.tryConsume()) {
				const error = new AppError(
					`Rate limit exceeded for ${operationName}`,
					ErrorCode.RATE_LIMITED,
					{ requestsPerSecond, operationName }
				);
				
				logger.warn('Rate limit exceeded', {
					operationName,
					requestsPerSecond,
				});
				
				throw error;
			}

			return await originalMethod.apply(this, args);
		};

		return descriptor;
	};
}

/**
 * Bulkhead decorator for resource isolation
 */
export function Bulkhead(semaphoreSize: number, queueSize?: number) {
	const semaphore = new Semaphore(semaphoreSize, queueSize || 100);
	
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value;
		const operationName = `${target.constructor.name}.${propertyKey}`;
		const logger = getLogger('bulkhead-decorator');

		descriptor.value = async function (...args: any[]) {
			try {
				await semaphore.acquire();
				return await originalMethod.apply(this, args);
			} catch (error) {
				logger.error(`Bulkhead execution failed for ${operationName}`, {
					error: (error as Error).message,
				});
				throw error;
			} finally {
				semaphore.release();
			}
		};

		return descriptor;
	};
}

// Helper functions and classes

function generateCacheKey(operationName: string, args: any[]): string {
	const argsHash = generateHash(JSON.stringify(args));
	return `${operationName}:${argsHash}`;
}

async function executeWithTimeout<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => {
			reject(new AppError(
				`Operation timed out after ${timeout}ms`,
				ErrorCode.TIMEOUT
			));
		}, timeout);
	});

	return await Promise.race([fn(), timeoutPromise]);
}

/**
 * Token Bucket for rate limiting
 */
class TokenBucket {
	private tokens: number;
	private lastRefill: number;

	constructor(
		private refillRate: number,
		private capacity: number
	) {
		this.tokens = capacity;
		this.lastRefill = Date.now();
	}

	tryConsume(tokens: number = 1): boolean {
		this.refill();
		
		if (this.tokens >= tokens) {
			this.tokens -= tokens;
			return true;
		}
		
		return false;
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = (now - this.lastRefill) / 1000;
		const tokensToAdd = Math.floor(elapsed * this.refillRate);
		
		if (tokensToAdd > 0) {
			this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
			this.lastRefill = now;
		}
	}
}

/**
 * Semaphore for bulkhead pattern
 */
class Semaphore {
	private available: number;
	private waitQueue: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
		timestamp: number;
	}> = [];

	constructor(
		private maxConcurrency: number,
		private maxQueueSize: number = 100
	) {
		this.available = maxConcurrency;
	}

	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return Promise.resolve();
		}

		if (this.waitQueue.length >= this.maxQueueSize) {
			throw new AppError(
				'Bulkhead queue is full',
				ErrorCode.RESOURCE_EXHAUSTED,
				{ maxQueueSize: this.maxQueueSize }
			);
		}

		return new Promise<void>((resolve, reject) => {
			this.waitQueue.push({
				resolve,
				reject,
				timestamp: Date.now(),
			});
		});
	}

	release(): void {
		const next = this.waitQueue.shift();
		if (next) {
			next.resolve();
		} else {
			this.available++;
		}
	}

	getStats(): { available: number; queued: number; maxConcurrency: number } {
		return {
			available: this.available,
			queued: this.waitQueue.length,
			maxConcurrency: this.maxConcurrency,
		};
	}
}

/**
 * Combine multiple resilience decorators
 */
export function ResilientService(config: {
	circuitBreaker?: boolean;
	retry?: 'conservative' | 'aggressive' | 'fast' | 'network' | 'database';
	cache?: boolean;
	metrics?: boolean;
	profiling?: boolean;
	timeout?: number;
	rateLimit?: number;
	bulkhead?: number;
}) {
	return function <T extends { new(...args: any[]): {} }>(constructor: T) {
		// Apply decorators to all methods
		const prototype = constructor.prototype;
		const methods = Object.getOwnPropertyNames(prototype);

		for (const method of methods) {
			if (method !== 'constructor' && typeof prototype[method] === 'function') {
				const resilienceConfig: ResilienceConfig = {};

				if (config.circuitBreaker) {
					resilienceConfig.circuitBreaker = { enabled: true };
				}

				if (config.retry) {
					resilienceConfig.retry = { enabled: true, strategy: config.retry };
				}

				if (config.cache) {
					resilienceConfig.cache = { enabled: true };
				}

				if (config.metrics !== false) {
					resilienceConfig.metrics = { enabled: true };
				}

				if (config.profiling !== false) {
					resilienceConfig.profiling = { enabled: true };
				}

				if (config.timeout) {
					resilienceConfig.timeout = { enabled: true, duration: config.timeout };
				}

				// Apply resilience decorator
				const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
				if (descriptor) {
					Resilient(resilienceConfig)(prototype, method, descriptor);
					Object.defineProperty(prototype, method, descriptor);
				}
			}
		}

		return constructor;
	};
}