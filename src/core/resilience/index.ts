/**
 * Resilience System - Main Export Module
 * Comprehensive error recovery and performance optimization system
 */

// Core resilience patterns
export * from './circuit-breaker.js';
export * from './retry-strategies.js';
export * from './multi-level-cache.js';
export * from './health-checks.js';
export * from './metrics-collector.js';
export * from './performance-profiler.js';
export * from './enhanced-connection-pool.js';
export * from './resilience-decorators.js';

// Re-export commonly used instances
export {
	CircuitBreakers,
	CircuitBreakerFactory,
} from './circuit-breaker.js';

export {
	RetryStrategies,
	globalRetryManager,
} from './retry-strategies.js';

export {
	globalCacheManager,
} from './multi-level-cache.js';

export {
	globalHealthManager,
	StandardHealthChecks,
} from './health-checks.js';

export {
	globalMetricsRegistry,
	globalMetricsCollector,
	MetricsDecorators,
} from './metrics-collector.js';

export {
	globalProfiler,
	ProfilerDecorators,
} from './performance-profiler.js';

export {
	globalPoolManager,
	SQLiteConnectionFactory,
} from './enhanced-connection-pool.js';

export {
	Resilient,
	CircuitBreaker,
	Retry,
	Cached,
	Metrics,
	Profile,
	Timeout,
	RateLimit,
	Bulkhead,
	ResilientService,
} from './resilience-decorators.js';

import { getLogger } from '../logger.js';
import { globalHealthManager, StandardHealthChecks } from './health-checks.js';
import { globalMetricsCollector } from './metrics-collector.js';
import { globalProfiler } from './performance-profiler.js';
import { globalCacheManager } from './multi-level-cache.js';

const logger = getLogger('resilience-system');

/**
 * Initialize the complete resilience system
 */
export function initializeResilienceSystem(): void {
	logger.info('Initializing resilience system...');

	try {
		// Start health checks for critical system components
		globalHealthManager.register(
			StandardHealthChecks.memoryUsage(80, {
				name: 'system-memory',
				interval: 30000,
				critical: true,
			})
		);

		// Start all health checks
		globalHealthManager.startAll();

		// Metrics collection is auto-started
		if (!globalMetricsCollector) {
			logger.warn('Metrics collector not started automatically');
		}

		// Performance profiler is auto-started
		if (!globalProfiler) {
			logger.warn('Performance profiler not started automatically');
		}

		logger.info('Resilience system initialized successfully', {
			healthChecks: 'started',
			metricsCollection: 'started',
			performanceProfiling: 'started',
			circuitBreakers: 'ready',
			retryStrategies: 'ready',
			cachingSystem: 'ready',
		});

	} catch (error) {
		logger.error('Failed to initialize resilience system', {
			error: (error as Error).message,
		});
		throw error;
	}
}

/**
 * Shutdown the resilience system gracefully
 */
export async function shutdownResilienceSystem(): Promise<void> {
	logger.info('Shutting down resilience system...');

	try {
		// Stop health checks
		globalHealthManager.stopAll();

		// Stop metrics collection
		globalMetricsCollector.stop();

		// Stop performance profiling
		globalProfiler.stop();

		// Clear all caches
		await globalCacheManager.clearAll();

		logger.info('Resilience system shutdown complete');

	} catch (error) {
		logger.error('Error during resilience system shutdown', {
			error: (error as Error).message,
		});
	}
}

/**
 * Get system health and performance summary
 */
export function getSystemStatus(): {
	health: any;
	metrics: any;
	profiling: any;
	circuitBreakers: any;
	caches: any;
} {
	return {
		health: globalHealthManager.getSystemHealth(),
		metrics: globalMetricsCollector.getLatestSnapshot(),
		profiling: globalProfiler.getMetrics(),
		circuitBreakers: require('./circuit-breaker.js').CircuitBreakerFactory.getAllMetrics(),
		caches: globalCacheManager.getAllMetrics(),
	};
}

// Initialize system if not in test environment
if (process.env.NODE_ENV !== 'test') {
	initializeResilienceSystem();

	// Graceful shutdown handlers
	process.on('SIGTERM', async () => {
		logger.info('Received SIGTERM, shutting down gracefully...');
		await shutdownResilienceSystem();
		process.exit(0);
	});

	process.on('SIGINT', async () => {
		logger.info('Received SIGINT, shutting down gracefully...');
		await shutdownResilienceSystem();
		process.exit(0);
	});

	// Handle uncaught exceptions and rejections
	process.on('uncaughtException', (error) => {
		logger.fatal('Uncaught exception', {
			error: error.message,
			stack: error.stack,
		});
		process.exit(1);
	});

	process.on('unhandledRejection', (reason, promise) => {
		logger.fatal('Unhandled rejection', {
			reason: String(reason),
			promise: String(promise),
		});
		process.exit(1);
	});
}