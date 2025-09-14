/**
 * Operation Metrics Utilities
 * Consolidates duplicate metric tracking code across services
 */

import { formatDuration } from './common.js';

export interface OperationMetrics {
	totalTime: number;
	callCount: number;
	successCount?: number;
}

export interface MetricsResult {
	averageTime: number;
	callCount: number;
	successRate?: number;
}

/**
 * Centralized operation metrics tracking class
 * Eliminates duplicate metric tracking code across services
 */
export class OperationMetricsTracker {
	private metrics = new Map<string, OperationMetrics>();
	private logger?: (message: string, meta?: Record<string, unknown>) => void;

	constructor(logger?: (message: string, meta?: Record<string, unknown>) => void) {
		this.logger = logger;
	}

	/**
	 * Update metrics for an operation
	 */
	updateMetrics(
		operationName: string,
		executionTime: number,
		success: boolean = true,
		logPrefix: string = 'Operation'
	): void {
		const existing = this.metrics.get(operationName) || {
			totalTime: 0,
			callCount: 0,
			successCount: 0,
		};

		existing.totalTime += executionTime;
		existing.callCount += 1;
		if (success) existing.successCount = (existing.successCount || 0) + 1;

		this.metrics.set(operationName, existing);

		if (this.logger) {
			const averageTime = existing.totalTime / existing.callCount;
			const successRate = existing.successCount
				? (existing.successCount / existing.callCount) * 100
				: undefined;

			this.logger(
				`${logPrefix} ${operationName} ${success ? 'succeeded' : 'failed'} in ${formatDuration(executionTime)}`,
				{
					averageTime: formatDuration(averageTime),
					callCount: existing.callCount,
					...(successRate !== undefined && { successRate: `${successRate.toFixed(1)}%` }),
					success,
				}
			);
		}
	}

	/**
	 * Get all metrics
	 */
	getMetrics(): Record<string, MetricsResult> {
		const result: Record<string, MetricsResult> = {};
		for (const [operation, metrics] of this.metrics.entries()) {
			result[operation] = {
				averageTime: metrics.totalTime / metrics.callCount,
				callCount: metrics.callCount,
				...(metrics.successCount !== undefined && {
					successRate: (metrics.successCount / metrics.callCount) * 100,
				}),
			};
		}
		return result;
	}

	/**
	 * Get metrics for a specific operation
	 */
	getOperationMetrics(operationName: string): MetricsResult | undefined {
		const metrics = this.metrics.get(operationName);
		if (!metrics) return undefined;

		return {
			averageTime: metrics.totalTime / metrics.callCount,
			callCount: metrics.callCount,
			...(metrics.successCount !== undefined && {
				successRate: (metrics.successCount / metrics.callCount) * 100,
			}),
		};
	}

	/**
	 * Clear all metrics
	 */
	clearMetrics(): void {
		this.metrics.clear();
	}

	/**
	 * Reset specific operation metrics
	 */
	resetOperation(operationName: string): void {
		this.metrics.delete(operationName);
	}
}

/**
 * Utility function to measure and track operation execution
 * Eliminates the repetitive performance.now() pattern
 */
export async function measureAndTrackOperation<T>(
	operationName: string,
	operation: () => Promise<T>,
	metricsTracker: OperationMetricsTracker,
	logPrefix?: string
): Promise<T> {
	const startTime = performance.now();

	try {
		const result = await operation();
		metricsTracker.updateMetrics(operationName, performance.now() - startTime, true, logPrefix);
		return result;
	} catch (error) {
		metricsTracker.updateMetrics(
			operationName,
			performance.now() - startTime,
			false,
			logPrefix
		);
		throw error;
	}
}

/**
 * Utility function for synchronous operation measurement
 */
export function measureAndTrackOperationSync<T>(
	operationName: string,
	operation: () => T,
	metricsTracker: OperationMetricsTracker,
	logPrefix?: string
): T {
	const startTime = performance.now();

	try {
		const result = operation();
		metricsTracker.updateMetrics(operationName, performance.now() - startTime, true, logPrefix);
		return result;
	} catch (error) {
		metricsTracker.updateMetrics(
			operationName,
			performance.now() - startTime,
			false,
			logPrefix
		);
		throw error;
	}
}

/**
 * Decorator for automatic method metrics tracking
 */
export function trackMetrics(operationName?: string, logPrefix?: string) {
	return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value;
		const finalOperationName = operationName || propertyKey;

		descriptor.value = async function (
			this: { metricsTracker: OperationMetricsTracker },
			...args: unknown[]
		) {
			if (!this.metricsTracker) {
				throw new Error(
					'Class must have a metricsTracker property to use @trackMetrics decorator'
				);
			}

			return await measureAndTrackOperation(
				finalOperationName,
				() => originalMethod.apply(this, args),
				this.metricsTracker,
				logPrefix
			);
		};

		return descriptor;
	};
}
