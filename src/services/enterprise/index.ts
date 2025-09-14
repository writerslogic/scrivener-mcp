/**
 * Enterprise Service Layer - Production-ready architectural patterns
 *
 * This module demonstrates enterprise-grade software architecture with:
 * - Circuit Breaker & Bulkhead Isolation patterns for resilience
 * - Distributed tracing and comprehensive observability
 * - Multi-layer intelligent caching with compression
 * - Advanced security with threat detection and rate limiting
 * - Performance profiling and optimization
 *
 * Usage Example:
 *
 * ```typescript
 * import { EnterpriseServiceOrchestrator } from './enterprise-service-orchestrator.js';
 *
 * const orchestrator = new EnterpriseServiceOrchestrator({
 *   serviceName: 'scrivener-mcp',
 *   samplingRate: 0.1,
 *   globalCacheSize: 1000
 * });
 *
 * // Register a service with enterprise patterns
 * orchestrator.registerService({
 *   name: 'document-service',
 *   circuitBreaker: {
 *     failureThreshold: 5,
 *     timeout: 60000,
 *     resetTimeout: 300000,
 *     monitoringWindow: 60000,
 *     healthCheckInterval: 10000
 *   },
 *   bulkhead: {
 *     maxConcurrency: 10,
 *     queueTimeout: 30000,
 *     rejectionStrategy: 'queue'
 *   },
 *   cache: {
 *     maxSize: 500,
 *     maxAge: 30 * 60 * 1000,
 *     compressionThreshold: 1024
 *   },
 *   security: {
 *     validationRules: [
 *       {
 *         field: 'documentId',
 *         type: 'uuid',
 *         required: true,
 *         sanitize: true
 *       }
 *     ],
 *     rateLimitPolicies: [
 *       {
 *         name: 'standard',
 *         windowMs: 60000,
 *         maxRequests: 100,
 *         keyGenerator: (context) => context.ipAddress
 *       }
 *     ],
 *     requireAuthentication: true
 *   },
 *   observability: {
 *     sampling: 0.1,
 *     enableMetrics: true,
 *     enableTracing: true
 *   }
 * });
 *
 * // Execute operations with enterprise patterns applied
 * const result = await orchestrator.execute(
 *   'document-service',
 *   {
 *     operation: 'getDocument',
 *     data: { documentId: 'uuid-here' },
 *     context: {
 *       ipAddress: '192.168.1.1',
 *       userAgent: 'MyApp/1.0',
 *       sessionId: 'session-123',
 *       userId: 'user-456'
 *     }
 *   },
 *   async (data, context) => {
 *     // Your business logic here
 *     return await getDocumentFromDatabase(data.documentId);
 *   }
 * );
 * ```
 */

// Import and export all enterprise components
import { EnterpriseServiceOrchestrator } from './enterprise-service-orchestrator.js';
export { EnterpriseServiceOrchestrator };

export {
	EnterpriseCircuitBreaker,
	BulkheadIsolation,
	EnterpriseRateLimiter,
} from './service-foundation.js';

export {
	ObservabilityManager,
	DistributedTracer,
	MetricsCollector,
	AlertManager,
} from './observability.js';

export { IntelligentCache, PerformanceProfiler } from './performance-optimizer.js';

export {
	SecurityValidator,
	SecurityRateLimiter,
	SecurityContextManager,
} from './security-layer.js';

// Export types
export type {
	CircuitBreakerConfig,
	BulkheadConfig,
	RateLimitConfig,
	ServiceMetrics,
} from './service-foundation.js';

export type { Span, TraceContext, MetricPoint, Alert } from './observability.js';

export type { CacheEntry, CacheMetrics, PerformanceProfile } from './performance-optimizer.js';

export type {
	SecurityContext,
	ThreatEvent,
	ValidationRule,
	SecurityPolicy,
} from './security-layer.js';

export type {
	ServiceConfig,
	ServiceRequest,
	ServiceResponse,
} from './enterprise-service-orchestrator.js';

/**
 * Factory function to create a pre-configured enterprise orchestrator
 */
export function createEnterpriseOrchestrator(options: {
	serviceName: string;
	environment?: 'development' | 'staging' | 'production';
	samplingRate?: number;
	cacheSize?: number;
}) {
	const config = {
		serviceName: options.serviceName,
		samplingRate: options.samplingRate || (options.environment === 'production' ? 0.01 : 0.1),
		globalCacheSize: options.cacheSize || 1000,
	};

	return new EnterpriseServiceOrchestrator(config);
}

/**
 * Pre-configured service configurations for common patterns
 */
export const ServiceConfigurations = {
	/**
	 * High-throughput service configuration
	 */
	highThroughput: {
		circuitBreaker: {
			failureThreshold: 10,
			timeout: 60000,
			resetTimeout: 180000,
			monitoringWindow: 30000,
			healthCheckInterval: 5000,
		},
		bulkhead: {
			maxConcurrency: 50,
			queueTimeout: 10000,
			rejectionStrategy: 'fail-fast' as const,
		},
		cache: {
			maxSize: 2000,
			maxAge: 15 * 60 * 1000, // 15 minutes
			compressionThreshold: 2048,
		},
	},

	/**
	 * Security-focused service configuration
	 */
	securityFocused: {
		circuitBreaker: {
			failureThreshold: 3,
			timeout: 120000,
			resetTimeout: 600000,
			monitoringWindow: 60000,
			healthCheckInterval: 15000,
		},
		security: {
			rateLimitPolicies: [
				{
					name: 'strict',
					windowMs: 60000,
					maxRequests: 20,
					keyGenerator: (context: { ipAddress: string }) => context.ipAddress,
				},
				{
					name: 'user',
					windowMs: 60000,
					maxRequests: 100,
					keyGenerator: (context: { userId?: string; ipAddress: string }) =>
						context.userId || context.ipAddress,
				},
			],
			requireAuthentication: true,
		},
	},

	/**
	 * Resource-constrained service configuration
	 */
	resourceConstrained: {
		circuitBreaker: {
			failureThreshold: 5,
			timeout: 30000,
			resetTimeout: 120000,
			monitoringWindow: 60000,
			healthCheckInterval: 10000,
		},
		bulkhead: {
			maxConcurrency: 5,
			queueTimeout: 30000,
			rejectionStrategy: 'queue' as const,
		},
		cache: {
			maxSize: 100,
			maxAge: 5 * 60 * 1000, // 5 minutes
			compressionThreshold: 512,
		},
	},
} as const;
