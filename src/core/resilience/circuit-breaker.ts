/**
 * Circuit Breaker Pattern Implementation
 * Prevents cascading failures by temporarily blocking calls to failing services
 */

import { getLogger } from '../logger.js';
import { AppError, ErrorCode } from '../../utils/common.js';

export enum CircuitBreakerState {
	CLOSED = 'CLOSED',     // Normal operation
	OPEN = 'OPEN',         // Circuit is open, requests fail fast
	HALF_OPEN = 'HALF_OPEN' // Testing if service has recovered
}

export interface CircuitBreakerConfig {
	/** Failure threshold to open circuit */
	failureThreshold: number;
	/** Success threshold to close circuit when half-open */
	successThreshold: number;
	/** Time window for counting failures (ms) */
	timeWindow: number;
	/** Time to wait before attempting recovery (ms) */
	openTimeout: number;
	/** Optional custom error predicate */
	isError?: (error: Error) => boolean;
	/** Circuit breaker name for logging */
	name?: string;
}

export interface CircuitBreakerMetrics {
	state: CircuitBreakerState;
	failureCount: number;
	successCount: number;
	lastFailureTime?: number;
	lastSuccessTime?: number;
	totalRequests: number;
	totalFailures: number;
	totalSuccesses: number;
	openTime?: number;
	halfOpenTime?: number;
}

export class CircuitBreaker<T = unknown> {
	private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
	private failureCount = 0;
	private successCount = 0;
	private lastFailureTime?: number;
	private lastSuccessTime?: number;
	private totalRequests = 0;
	private totalFailures = 0;
	private totalSuccesses = 0;
	private openTime?: number;
	private halfOpenTime?: number;
	private readonly logger = getLogger('circuit-breaker');

	constructor(private readonly config: CircuitBreakerConfig) {
		this.logger.info(`Circuit breaker initialized: ${config.name || 'unnamed'}`, {
			failureThreshold: config.failureThreshold,
			successThreshold: config.successThreshold,
			timeWindow: config.timeWindow,
			openTimeout: config.openTimeout,
		});
	}

	/**
	 * Execute function with circuit breaker protection
	 */
	async execute<R>(fn: () => Promise<R>): Promise<R> {
		if (this.state === CircuitBreakerState.OPEN) {
			if (this.shouldAttemptReset()) {
				this.moveToHalfOpen();
			} else {
				throw new AppError(
					`Circuit breaker is OPEN for ${this.config.name || 'service'}`,
					ErrorCode.SERVICE_UNAVAILABLE,
					{ circuitBreakerMetrics: this.getMetrics() }
				);
			}
		}

		this.totalRequests++;

		try {
			const result = await fn();
			this.onSuccess();
			return result;
		} catch (error) {
			this.onFailure(error as Error);
			throw error;
		}
	}

	/**
	 * Get current circuit breaker metrics
	 */
	getMetrics(): CircuitBreakerMetrics {
		return {
			state: this.state,
			failureCount: this.failureCount,
			successCount: this.successCount,
			lastFailureTime: this.lastFailureTime,
			lastSuccessTime: this.lastSuccessTime,
			totalRequests: this.totalRequests,
			totalFailures: this.totalFailures,
			totalSuccesses: this.totalSuccesses,
			openTime: this.openTime,
			halfOpenTime: this.halfOpenTime,
		};
	}

	/**
	 * Reset circuit breaker to closed state
	 */
	reset(): void {
		this.state = CircuitBreakerState.CLOSED;
		this.failureCount = 0;
		this.successCount = 0;
		this.openTime = undefined;
		this.halfOpenTime = undefined;
		
		this.logger.info(`Circuit breaker reset: ${this.config.name || 'unnamed'}`);
	}

	private onSuccess(): void {
		this.successCount++;
		this.totalSuccesses++;
		this.lastSuccessTime = Date.now();

		if (this.state === CircuitBreakerState.HALF_OPEN) {
			if (this.successCount >= this.config.successThreshold) {
				this.moveToClosed();
			}
		} else {
			// Reset failure count on success in closed state
			this.failureCount = 0;
		}
	}

	private onFailure(error: Error): void {
		// Check if error should count as failure
		if (this.config.isError && !this.config.isError(error)) {
			return;
		}

		this.failureCount++;
		this.totalFailures++;
		this.lastFailureTime = Date.now();

		if (this.state === CircuitBreakerState.HALF_OPEN) {
			this.moveToOpen();
		} else if (this.state === CircuitBreakerState.CLOSED) {
			if (this.failureCount >= this.config.failureThreshold) {
				this.moveToOpen();
			}
		}
	}

	private moveToOpen(): void {
		this.state = CircuitBreakerState.OPEN;
		this.openTime = Date.now();
		this.halfOpenTime = undefined;
		
		this.logger.warn(`Circuit breaker opened: ${this.config.name || 'unnamed'}`, {
			failureCount: this.failureCount,
			threshold: this.config.failureThreshold,
		});
	}

	private moveToHalfOpen(): void {
		this.state = CircuitBreakerState.HALF_OPEN;
		this.halfOpenTime = Date.now();
		this.successCount = 0;
		this.failureCount = 0;
		
		this.logger.info(`Circuit breaker half-open: ${this.config.name || 'unnamed'}`);
	}

	private moveToClosed(): void {
		this.state = CircuitBreakerState.CLOSED;
		this.failureCount = 0;
		this.successCount = 0;
		this.openTime = undefined;
		this.halfOpenTime = undefined;
		
		this.logger.info(`Circuit breaker closed: ${this.config.name || 'unnamed'}`);
	}

	private shouldAttemptReset(): boolean {
		if (!this.openTime) return false;
		return Date.now() - this.openTime >= this.config.openTimeout;
	}
}

/**
 * Circuit Breaker Factory with common configurations
 */
export class CircuitBreakerFactory {
	private static breakers = new Map<string, CircuitBreaker>();

	/**
	 * Get or create circuit breaker for service
	 */
	static getCircuitBreaker(
		name: string,
		config?: Partial<CircuitBreakerConfig>
	): CircuitBreaker {
		if (this.breakers.has(name)) {
			return this.breakers.get(name)!;
		}

		const defaultConfig: CircuitBreakerConfig = {
			failureThreshold: 5,
			successThreshold: 2,
			timeWindow: 60000, // 1 minute
			openTimeout: 30000, // 30 seconds
			name,
			...config,
		};

		const breaker = new CircuitBreaker(defaultConfig);
		this.breakers.set(name, breaker);
		return breaker;
	}

	/**
	 * Get all circuit breakers
	 */
	static getAllCircuitBreakers(): Map<string, CircuitBreaker> {
		return new Map(this.breakers);
	}

	/**
	 * Get circuit breaker metrics for all breakers
	 */
	static getAllMetrics(): Record<string, CircuitBreakerMetrics> {
		const metrics: Record<string, CircuitBreakerMetrics> = {};
		for (const [name, breaker] of this.breakers) {
			metrics[name] = breaker.getMetrics();
		}
		return metrics;
	}

	/**
	 * Reset all circuit breakers
	 */
	static resetAll(): void {
		for (const breaker of this.breakers.values()) {
			breaker.reset();
		}
	}
}

/**
 * Predefined circuit breakers for common services
 */
export const CircuitBreakers = {
	// OpenAI API calls
	openai: CircuitBreakerFactory.getCircuitBreaker('openai', {
		failureThreshold: 3,
		successThreshold: 2,
		timeWindow: 60000,
		openTimeout: 60000, // Longer timeout for API recovery
		isError: (error: Error) => {
			// Don't count rate limits as failures
			return !error.message.includes('rate_limit');
		},
	}),

	// Database connections
	database: CircuitBreakerFactory.getCircuitBreaker('database', {
		failureThreshold: 5,
		successThreshold: 3,
		timeWindow: 30000,
		openTimeout: 10000, // Quick recovery for local databases
	}),

	// Neo4j connections
	neo4j: CircuitBreakerFactory.getCircuitBreaker('neo4j', {
		failureThreshold: 3,
		successThreshold: 2,
		timeWindow: 60000,
		openTimeout: 30000,
	}),

	// Redis/KeyDB cache
	cache: CircuitBreakerFactory.getCircuitBreaker('cache', {
		failureThreshold: 5,
		successThreshold: 2,
		timeWindow: 30000,
		openTimeout: 15000, // Cache should recover quickly
	}),

	// Web content parsing
	webParser: CircuitBreakerFactory.getCircuitBreaker('web-parser', {
		failureThreshold: 5,
		successThreshold: 2,
		timeWindow: 120000, // Longer window for web requests
		openTimeout: 30000,
		isError: (error: Error) => {
			// Don't count network timeouts as critical failures
			return !error.message.includes('timeout');
		},
	}),

	// LangChain operations
	langchain: CircuitBreakerFactory.getCircuitBreaker('langchain', {
		failureThreshold: 3,
		successThreshold: 2,
		timeWindow: 60000,
		openTimeout: 45000,
	}),
};