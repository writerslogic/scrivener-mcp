/**
 * Network Resilience Utilities
 * Provides intelligent connection handling, retries, and fallbacks
 */

import { ApplicationError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import { retry } from './common.js';

const logger = getLogger('network-resilience');

export interface NetworkOptions {
	timeout: number;
	retries: number;
	backoff: 'linear' | 'exponential';
	jitter: boolean;
	circuitBreaker?: CircuitBreakerOptions;
}

export interface CircuitBreakerOptions {
	failureThreshold: number;
	recoveryTimeout: number;
	monitoringPeriod: number;
}

export interface ConnectionResult {
	success: boolean;
	latency?: number;
	error?: string;
	fallbackUsed?: boolean;
}

export class NetworkResilience {
	private static readonly DEFAULT_OPTIONS: NetworkOptions = {
		timeout: 5000,
		retries: 3,
		backoff: 'exponential',
		jitter: true,
		circuitBreaker: {
			failureThreshold: 5,
			recoveryTimeout: 30000,
			monitoringPeriod: 60000,
		},
	};

	private static circuitBreakers = new Map<string, CircuitBreaker>();

	/**
	 * Test network connectivity with resilience
	 */
	static async testConnection(
		host: string,
		port: number,
		options: Partial<NetworkOptions> = {}
	): Promise<ConnectionResult> {
		const opts = { ...NetworkResilience.DEFAULT_OPTIONS, ...options };
		const circuitBreakerId = `${host}:${port}`;

		// Check circuit breaker
		if (opts.circuitBreaker) {
			const circuitBreaker = NetworkResilience.getCircuitBreaker(
				circuitBreakerId,
				opts.circuitBreaker
			);
			if (circuitBreaker.isOpen()) {
				return {
					success: false,
					error: 'Circuit breaker is open',
				};
			}
		}

		const startTime = Date.now();

		try {
			await NetworkResilience.connectWithResilience(host, port, opts);
			const latency = Date.now() - startTime;

			// Record success in circuit breaker
			if (opts.circuitBreaker) {
				const circuitBreaker = NetworkResilience.getCircuitBreaker(
					circuitBreakerId,
					opts.circuitBreaker
				);
				circuitBreaker.recordSuccess();
			}

			return {
				success: true,
				latency,
			};
		} catch (error) {
			// Record failure in circuit breaker
			if (opts.circuitBreaker) {
				const circuitBreaker = NetworkResilience.getCircuitBreaker(
					circuitBreakerId,
					opts.circuitBreaker
				);
				circuitBreaker.recordFailure();
			}

			return {
				success: false,
				error: (error as Error).message,
			};
		}
	}

	/**
	 * Connect with intelligent retry and fallback
	 */
	private static async connectWithResilience(
		host: string,
		port: number,
		options: NetworkOptions
	): Promise<void> {
		return retry(
			async () => {
				const net = await import('net');
				const socket = new net.Socket();

				return new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						socket.destroy();
						reject(
							new ApplicationError(
								`Connection timeout after ${options.timeout}ms`,
								ErrorCode.TIMEOUT,
								{ host, port, timeout: options.timeout }
							)
						);
					}, options.timeout);

					socket.connect(port, host, () => {
						clearTimeout(timeout);
						socket.destroy();
						resolve();
					});

					socket.on('error', (error) => {
						clearTimeout(timeout);
						socket.destroy();
						reject(
							new ApplicationError(
								`Connection failed: ${error.message}`,
								ErrorCode.CONNECTION_ERROR,
								{ host, port, originalError: error.message }
							)
						);
					});
				});
			},
			{
				maxAttempts: options.retries + 1,
				initialDelay: 1000,
				factor: options.backoff === 'exponential' ? 2 : 1,
				maxDelay: 10000,
				jitter: options.jitter,
			}
		);
	}

	/**
	 * Get or create circuit breaker for a connection
	 */
	private static getCircuitBreaker(id: string, options: CircuitBreakerOptions): CircuitBreaker {
		if (!NetworkResilience.circuitBreakers.has(id)) {
			NetworkResilience.circuitBreakers.set(id, new CircuitBreaker(options));
		}
		return NetworkResilience.circuitBreakers.get(id)!;
	}

	/**
	 * Test multiple connection options and return the best one
	 */
	static async findBestConnection(
		connections: Array<{ host: string; port: number; priority?: number }>,
		options: Partial<NetworkOptions> = {}
	): Promise<{ host: string; port: number; latency: number } | null> {
		// Sort by priority (higher first)
		const sortedConnections = connections.sort((a, b) => (b.priority || 0) - (a.priority || 0));

		// Test connections in parallel
		const results = await Promise.allSettled(
			sortedConnections.map(async (conn) => {
				const result = await NetworkResilience.testConnection(
					conn.host,
					conn.port,
					options
				);
				return { ...conn, result };
			})
		);

		// Find the best successful connection
		type ConnectionWithResult = {
			result: ConnectionResult;
			host: string;
			port: number;
			priority?: number;
		};
		const successful = results
			.filter(
				(result): result is PromiseFulfilledResult<ConnectionWithResult> =>
					result.status === 'fulfilled'
			)
			.map((result) => result.value)
			.filter((conn) => conn.result.success)
			.sort((a, b) => {
				// Sort by priority first, then by latency
				const priorityDiff = (b.priority || 0) - (a.priority || 0);
				if (priorityDiff !== 0) return priorityDiff;
				return (a.result.latency || Infinity) - (b.result.latency || Infinity);
			});

		if (successful.length === 0) {
			return null;
		}

		const best = successful[0];
		return {
			host: best.host,
			port: best.port,
			latency: best.result.latency!,
		};
	}

	/**
	 * Create adaptive timeout based on network conditions
	 */
	static calculateAdaptiveTimeout(
		baseTimeout: number,
		recentLatencies: number[],
		percentile: number = 95
	): number {
		// Validate inputs
		if (baseTimeout <= 0) {
			logger.warn('Invalid baseTimeout, using default 5000ms', { baseTimeout });
			baseTimeout = 5000;
		}

		if (recentLatencies.length === 0) {
			return baseTimeout;
		}

		// Filter out invalid latencies
		const validLatencies = recentLatencies.filter(
			(lat) => typeof lat === 'number' && !isNaN(lat) && lat >= 0
		);

		if (validLatencies.length === 0) {
			return baseTimeout;
		}

		// Calculate percentile latency
		const sorted = validLatencies.sort((a, b) => a - b);
		const index = Math.floor((percentile / 100) * (sorted.length - 1));
		const percentileLatency = sorted[Math.max(0, Math.min(index, sorted.length - 1))];

		// Adaptive timeout = percentile latency + safety margin
		const adaptiveTimeout = percentileLatency * 3; // 3x percentile as safety margin

		// Ensure it's within reasonable bounds (0.5x to 5x base timeout)
		const minTimeout = Math.max(baseTimeout * 0.5, 1000); // At least 1 second
		const maxTimeout = Math.min(baseTimeout * 5, 60000); // At most 60 seconds

		return Math.max(Math.min(adaptiveTimeout, maxTimeout), minTimeout);
	}
}

/**
 * Circuit Breaker implementation for network resilience
 */
class CircuitBreaker {
	private failures = 0;
	private lastFailureTime = 0;
	private state: 'closed' | 'open' | 'half-open' = 'closed';

	constructor(private options: CircuitBreakerOptions) {}

	isOpen(): boolean {
		if (this.state === 'open') {
			const now = Date.now();
			if (now - this.lastFailureTime >= this.options.recoveryTimeout) {
				this.state = 'half-open';
				return false;
			}
			return true;
		}
		return false;
	}

	recordSuccess(): void {
		this.failures = 0;
		this.state = 'closed';
	}

	recordFailure(): void {
		this.failures++;
		this.lastFailureTime = Date.now();

		if (this.failures >= this.options.failureThreshold) {
			this.state = 'open';
			logger.warn('Circuit breaker opened', {
				failures: this.failures,
				threshold: this.options.failureThreshold,
			});
		}
	}

	getState(): string {
		return this.state;
	}

	getFailures(): number {
		return this.failures;
	}
}

/**
 * Network health monitor
 */
export class NetworkHealthMonitor {
	private latencyHistory: number[] = [];
	private readonly maxHistory = 50;

	recordLatency(latency: number): void {
		// Validate latency value
		if (typeof latency !== 'number' || isNaN(latency) || latency < 0) {
			logger.warn('Invalid latency value ignored', { latency });
			return;
		}

		this.latencyHistory.push(latency);
		if (this.latencyHistory.length > this.maxHistory) {
			this.latencyHistory.shift();
		}
	}

	getAverageLatency(): number {
		if (this.latencyHistory.length === 0) return 0;
		return this.latencyHistory.reduce((sum, lat) => sum + lat, 0) / this.latencyHistory.length;
	}

	getPercentileLatency(percentile: number): number {
		if (this.latencyHistory.length === 0) return 0;
		if (percentile < 0 || percentile > 100) {
			logger.warn('Invalid percentile value', { percentile });
			return 0;
		}

		const sorted = [...this.latencyHistory].sort((a, b) => a - b);
		const index = Math.floor((percentile / 100) * (sorted.length - 1));
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
	}

	isHealthy(maxLatency: number = 5000): boolean {
		const p95 = this.getPercentileLatency(95);
		return p95 < maxLatency;
	}

	getHealthScore(): number {
		if (this.latencyHistory.length === 0) return 1;

		const avg = this.getAverageLatency();
		const p95 = this.getPercentileLatency(95);

		// Health score based on latency (1 = excellent, 0 = terrible)
		const avgScore = Math.max(0, 1 - avg / 10000); // 10s = 0 score
		const p95Score = Math.max(0, 1 - p95 / 15000); // 15s = 0 score

		return (avgScore + p95Score) / 2;
	}
}
