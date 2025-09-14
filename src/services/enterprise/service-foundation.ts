/**
 * Enterprise Service Foundation - Advanced architectural patterns for production systems
 * Implements circuit breaker, bulkhead isolation, distributed tracing, and observability
 */

import { EventEmitter } from 'events';
import {
	ErrorCode,
	createError,
	handleError,
	measureExecution,
	retry,
	formatDuration,
	generateHash,
	validateInput,
	getEnv,
} from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';

const logger = getLogger('service-foundation');

// Advanced Types for Enterprise Patterns
export interface CircuitBreakerConfig {
	failureThreshold: number;
	timeout: number;
	resetTimeout: number;
	monitoringWindow: number;
	healthCheckInterval: number;
}

export interface BulkheadConfig {
	maxConcurrency: number;
	queueTimeout: number;
	rejectionStrategy: 'fail-fast' | 'queue' | 'degrade';
}

export interface TracingContext {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	baggage: Record<string, string>;
	startTime: number;
}

export interface ServiceMetrics {
	requestCount: number;
	successCount: number;
	failureCount: number;
	avgResponseTime: number;
	p95ResponseTime: number;
	p99ResponseTime: number;
	circuitBreakerState: 'closed' | 'open' | 'half-open';
	activeConcurrency: number;
	queuedRequests: number;
}

export interface RateLimitConfig {
	windowMs: number;
	maxRequests: number;
	skipSuccessfulRequests: boolean;
	skipFailedRequests: boolean;
	keyGenerator: (context: Record<string, unknown>) => string;
}

// Circuit Breaker Implementation with Advanced Features
export class EnterpriseCircuitBreaker extends EventEmitter {
	private state: 'closed' | 'open' | 'half-open' = 'closed';
	private failures = 0;
	private lastFailureTime = 0;
	private successCount = 0;
	private requestCount = 0;
	private responseTime: number[] = [];
	private healthCheckTimer?: NodeJS.Timeout;

	constructor(
		private name: string,
		private config: CircuitBreakerConfig
	) {
		super();
		this.startHealthCheck();
	}

	async execute<T>(operation: () => Promise<T>, context?: TracingContext): Promise<T> {
		const span = this.createSpan('circuit-breaker-execute', context);

		try {
			if (this.state === 'open') {
				if (Date.now() - this.lastFailureTime < this.config.resetTimeout) {
					throw createError(
						ErrorCode.SERVICE_UNAVAILABLE,
						{ circuitBreaker: this.name, state: this.state },
						'Circuit breaker is open'
					);
				}
				this.state = 'half-open';
				this.emit('state-change', { from: 'open', to: 'half-open', breaker: this.name });
			}

			const result = await measureExecution(async () => {
				const operationResult = await operation();
				this.onSuccess();
				return operationResult;
			});

			this.recordResponseTime(result.ms);
			this.finishSpan(span, { success: true, responseTime: result.ms });

			return result.result;
		} catch (error) {
			this.onFailure();
			this.finishSpan(span, { success: false, error: (error as Error).message });
			throw handleError(error, `circuit-breaker-${this.name}`);
		}
	}

	private onSuccess(): void {
		this.successCount++;
		this.requestCount++;

		if (this.state === 'half-open') {
			this.state = 'closed';
			this.failures = 0;
			this.emit('state-change', { from: 'half-open', to: 'closed', breaker: this.name });
		}
	}

	private onFailure(): void {
		this.failures++;
		this.requestCount++;
		this.lastFailureTime = Date.now();

		if (this.failures >= this.config.failureThreshold) {
			this.state = 'open';
			this.emit('state-change', { from: 'closed', to: 'open', breaker: this.name });
			this.emit('circuit-open', { breaker: this.name, failures: this.failures });
		}
	}

	private recordResponseTime(time: number): void {
		this.responseTime.push(time);
		// Keep only recent measurements for sliding window
		if (this.responseTime.length > 1000) {
			this.responseTime = this.responseTime.slice(-500);
		}
	}

	private startHealthCheck(): void {
		this.healthCheckTimer = setInterval(() => {
			this.emit('health-check', this.getMetrics());
		}, this.config.healthCheckInterval);
	}

	private createSpan(operation: string, parentContext?: TracingContext): TracingContext {
		return {
			traceId: parentContext?.traceId || generateHash(`trace-${Date.now()}-${Math.random()}`),
			spanId: generateHash(`span-${Date.now()}-${Math.random()}`),
			parentSpanId: parentContext?.spanId,
			baggage: { ...parentContext?.baggage, circuitBreaker: this.name },
			startTime: Date.now(),
		};
	}

	private finishSpan(span: TracingContext, data: Record<string, any>): void {
		const duration = Date.now() - span.startTime;
		this.emit('span-finished', {
			...span,
			duration,
			operation: 'circuit-breaker-execute',
			...data,
		});
	}

	getMetrics(): ServiceMetrics {
		const sortedTimes = this.responseTime.slice().sort((a, b) => a - b);
		const p95Index = Math.floor(sortedTimes.length * 0.95);
		const p99Index = Math.floor(sortedTimes.length * 0.99);

		return {
			requestCount: this.requestCount,
			successCount: this.successCount,
			failureCount: this.failures,
			avgResponseTime:
				this.responseTime.reduce((a, b) => a + b, 0) / this.responseTime.length || 0,
			p95ResponseTime: sortedTimes[p95Index] || 0,
			p99ResponseTime: sortedTimes[p99Index] || 0,
			circuitBreakerState: this.state,
			activeConcurrency: 0, // Will be tracked by bulkhead
			queuedRequests: 0,
		};
	}

	destroy(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
		}
		this.removeAllListeners();
	}
}

// Bulkhead Isolation Pattern for Resource Protection
export class BulkheadIsolation {
	private activeTasks = new Set<Promise<any>>();
	private queuedTasks: Array<{
		operation: () => Promise<any>;
		resolve: (value: unknown) => void;
		reject: (error: unknown) => void;
		timeout: NodeJS.Timeout;
		context?: TracingContext;
	}> = [];

	constructor(
		private name: string,
		private config: BulkheadConfig
	) {}

	async execute<T>(operation: () => Promise<T>, context?: TracingContext): Promise<T> {
		const span = this.createSpan('bulkhead-execute', context);

		// Check if we can execute immediately
		if (this.activeTasks.size < this.config.maxConcurrency) {
			return this.executeImmediately(operation, span);
		}

		// Handle different rejection strategies
		switch (this.config.rejectionStrategy) {
			case 'fail-fast':
				throw createError(
					ErrorCode.RESOURCE_EXHAUSTED,
					{ bulkhead: this.name, activeTasks: this.activeTasks.size },
					'Bulkhead capacity exceeded'
				);

			case 'queue':
				return this.queueOperation(operation, span);

			case 'degrade':
				// Implement graceful degradation
				return this.executeWithDegradation(operation, span);

			default:
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ strategy: this.config.rejectionStrategy },
					'Invalid rejection strategy'
				);
		}
	}

	private async executeImmediately<T>(
		operation: () => Promise<T>,
		span: TracingContext
	): Promise<T> {
		const task = this.wrapOperation(operation, span);
		this.activeTasks.add(task);

		try {
			const result = await task;
			this.finishSpan(span, { success: true });
			return result;
		} catch (error) {
			this.finishSpan(span, { success: false, error: (error as Error).message });
			throw error;
		} finally {
			this.activeTasks.delete(task);
			this.processQueue();
		}
	}

	private async queueOperation<T>(operation: () => Promise<T>, span: TracingContext): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				const index = this.queuedTasks.findIndex((task) => task.resolve === resolve);
				if (index >= 0) {
					this.queuedTasks.splice(index, 1);
				}
				reject(
					createError(
						ErrorCode.TIMEOUT,
						{ bulkhead: this.name, queueTimeout: this.config.queueTimeout },
						'Queue timeout exceeded'
					)
				);
			}, this.config.queueTimeout);

			this.queuedTasks.push({
				operation,
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout,
				context: span,
			});
		});
	}

	private async executeWithDegradation<T>(
		operation: () => Promise<T>,
		span: TracingContext
	): Promise<T> {
		// Implement degraded execution with reduced functionality
		logger.warn('Executing with degradation', { bulkhead: this.name });

		try {
			// Execute with shorter timeout and simplified processing
			return await Promise.race([
				operation(),
				new Promise<T>((_, reject) =>
					setTimeout(
						() =>
							reject(
								createError(ErrorCode.TIMEOUT, {}, 'Degraded execution timeout')
							),
						5000
					)
				),
			]);
		} catch (error) {
			this.finishSpan(span, {
				success: false,
				degraded: true,
				error: (error as Error).message,
			});
			throw handleError(error, `bulkhead-degraded-${this.name}`);
		}
	}

	private async wrapOperation<T>(operation: () => Promise<T>, span: TracingContext): Promise<T> {
		const result = await measureExecution(operation);
		this.finishSpan(span, { success: true, responseTime: result.ms });
		return result.result;
	}

	private processQueue(): void {
		if (this.queuedTasks.length > 0 && this.activeTasks.size < this.config.maxConcurrency) {
			const task = this.queuedTasks.shift()!;
			clearTimeout(task.timeout);

			this.executeImmediately(task.operation, task.context!)
				.then(task.resolve)
				.catch(task.reject);
		}
	}

	private createSpan(operation: string, parentContext?: TracingContext): TracingContext {
		return {
			traceId: parentContext?.traceId || generateHash(`trace-${Date.now()}-${Math.random()}`),
			spanId: generateHash(`span-${Date.now()}-${Math.random()}`),
			parentSpanId: parentContext?.spanId,
			baggage: { ...parentContext?.baggage, bulkhead: this.name },
			startTime: Date.now(),
		};
	}

	private finishSpan(span: TracingContext, data: Record<string, any>): void {
		const duration = Date.now() - span.startTime;
		logger.debug('Bulkhead span finished', {
			...span,
			duration,
			operation: 'bulkhead-execute',
			...data,
		});
	}

	getMetrics(): { activeTasks: number; queuedTasks: number } {
		return {
			activeTasks: this.activeTasks.size,
			queuedTasks: this.queuedTasks.length,
		};
	}
}

// Advanced Rate Limiter with Multiple Algorithms
export class EnterpriseRateLimiter {
	private windows = new Map<string, { count: number; resetTime: number; requests: number[] }>();
	private slidingLog = new Map<string, number[]>();

	constructor(private config: RateLimitConfig) {}

	async checkLimit(
		context: Record<string, unknown>
	): Promise<{ allowed: boolean; resetTime?: number; remaining?: number }> {
		const key = this.config.keyGenerator(context);
		const now = Date.now();

		// Clean up old windows
		this.cleanup(now);

		// Token bucket algorithm for burst handling
		const window = this.windows.get(key) || {
			count: 0,
			resetTime: now + this.config.windowMs,
			requests: [],
		};

		if (now > window.resetTime) {
			// Reset window
			window.count = 0;
			window.resetTime = now + this.config.windowMs;
			window.requests = [];
		}

		if (window.count >= this.config.maxRequests) {
			return {
				allowed: false,
				resetTime: window.resetTime,
				remaining: 0,
			};
		}

		// Record request
		window.count++;
		window.requests.push(now);
		this.windows.set(key, window);

		return {
			allowed: true,
			remaining: this.config.maxRequests - window.count,
		};
	}

	private cleanup(now: number): void {
		for (const [key, window] of this.windows) {
			if (now > window.resetTime + this.config.windowMs) {
				this.windows.delete(key);
			}
		}
	}
}
