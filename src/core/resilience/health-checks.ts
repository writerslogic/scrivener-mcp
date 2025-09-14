/**
 * Health Check System
 * Comprehensive health monitoring for services, databases, and external dependencies
 */

import { getLogger } from '../logger.js';
import { AppError, ErrorCode, sleep } from '../../utils/common.js';
import { CircuitBreakerFactory } from './circuit-breaker.js';
import { RetryStrategies } from './retry-strategies.js';

export enum HealthStatus {
	HEALTHY = 'HEALTHY',
	DEGRADED = 'DEGRADED',
	UNHEALTHY = 'UNHEALTHY',
	UNKNOWN = 'UNKNOWN'
}

export interface HealthCheckConfig {
	/** Unique name for the health check */
	name: string;
	/** Health check function */
	check: () => Promise<HealthCheckResult>;
	/** How often to run the check (ms) */
	interval: number;
	/** Timeout for individual checks (ms) */
	timeout: number;
	/** Number of consecutive failures before marking unhealthy */
	failureThreshold: number;
	/** Number of consecutive successes to mark healthy again */
	recoveryThreshold: number;
	/** Enable retries for transient failures */
	retryOnFailure: boolean;
	/** Tags for grouping and filtering */
	tags?: string[];
	/** Critical health check (affects overall system health) */
	critical: boolean;
	/** Enabled state */
	enabled: boolean;
}

export interface HealthCheckResult {
	status: HealthStatus;
	message?: string;
	details?: Record<string, unknown>;
	timestamp: number;
	responseTime: number;
	metadata?: Record<string, unknown>;
}

export interface SystemHealthStatus {
	status: HealthStatus;
	timestamp: number;
	checks: Record<string, HealthCheckResult>;
	summary: {
		total: number;
		healthy: number;
		degraded: number;
		unhealthy: number;
		unknown: number;
		critical: {
			total: number;
			healthy: number;
			unhealthy: number;
		};
	};
}

export class HealthCheck {
	private currentStatus = HealthStatus.UNKNOWN;
	private consecutiveFailures = 0;
	private consecutiveSuccesses = 0;
	private lastCheck?: HealthCheckResult;
	private checkInterval?: NodeJS.Timeout;
	private readonly logger = getLogger('health-check');
	private readonly retryStrategy = RetryStrategies.createFast();

	constructor(private readonly config: HealthCheckConfig) {
		this.logger.debug(`Health check initialized: ${config.name}`, {
			interval: config.interval,
			timeout: config.timeout,
			failureThreshold: config.failureThreshold,
			critical: config.critical,
		});
	}

	/**
	 * Start periodic health checking
	 */
	start(): void {
		if (this.checkInterval) {
			this.stop();
		}

		if (!this.config.enabled) {
			this.logger.debug(`Health check disabled: ${this.config.name}`);
			return;
		}

		this.checkInterval = setInterval(() => {
			this.performCheck().catch(error => {
				this.logger.error(`Health check error: ${this.config.name}`, {
					error: (error as Error).message,
				});
			});
		}, this.config.interval);

		// Perform initial check
		this.performCheck().catch(error => {
			this.logger.error(`Initial health check error: ${this.config.name}`, {
				error: (error as Error).message,
			});
		});

		this.logger.info(`Health check started: ${this.config.name}`);
	}

	/**
	 * Stop periodic health checking
	 */
	stop(): void {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = undefined;
		}

		this.logger.info(`Health check stopped: ${this.config.name}`);
	}

	/**
	 * Perform a single health check
	 */
	async performCheck(): Promise<HealthCheckResult> {
		const startTime = Date.now();

		try {
			// Execute health check with timeout and optional retries
			const result = await this.executeWithTimeout(
				async () => {
					if (this.config.retryOnFailure) {
						return await this.retryStrategy.execute(() => this.config.check());
					} else {
						return await this.config.check();
					}
				},
				this.config.timeout
			);

			result.timestamp = Date.now();
			result.responseTime = Date.now() - startTime;

			this.onCheckComplete(result);
			return result;

		} catch (error) {
			const result: HealthCheckResult = {
				status: HealthStatus.UNHEALTHY,
				message: `Health check failed: ${(error as Error).message}`,
				details: { error: (error as Error).message },
				timestamp: Date.now(),
				responseTime: Date.now() - startTime,
			};

			this.onCheckComplete(result);
			return result;
		}
	}

	/**
	 * Get current health status
	 */
	getCurrentStatus(): HealthStatus {
		return this.currentStatus;
	}

	/**
	 * Get last check result
	 */
	getLastResult(): HealthCheckResult | undefined {
		return this.lastCheck;
	}

	/**
	 * Get health check configuration
	 */
	getConfig(): HealthCheckConfig {
		return { ...this.config };
	}

	private onCheckComplete(result: HealthCheckResult): void {
		this.lastCheck = result;

		if (result.status === HealthStatus.HEALTHY) {
			this.consecutiveSuccesses++;
			this.consecutiveFailures = 0;

			// Check if we should transition to healthy
			if (this.currentStatus !== HealthStatus.HEALTHY &&
				this.consecutiveSuccesses >= this.config.recoveryThreshold) {
				this.transitionToStatus(HealthStatus.HEALTHY, result.message);
			}

		} else if (result.status === HealthStatus.UNHEALTHY) {
			this.consecutiveFailures++;
			this.consecutiveSuccesses = 0;

			// Check if we should transition to unhealthy
			if (this.currentStatus !== HealthStatus.UNHEALTHY &&
				this.consecutiveFailures >= this.config.failureThreshold) {
				this.transitionToStatus(HealthStatus.UNHEALTHY, result.message);
			}

		} else if (result.status === HealthStatus.DEGRADED) {
			this.consecutiveSuccesses = 0;
			this.consecutiveFailures = 0;
			
			if (this.currentStatus !== HealthStatus.DEGRADED) {
				this.transitionToStatus(HealthStatus.DEGRADED, result.message);
			}
		}
	}

	private transitionToStatus(newStatus: HealthStatus, message?: string): void {
		const oldStatus = this.currentStatus;
		this.currentStatus = newStatus;

		this.logger.info(`Health check status transition: ${this.config.name}`, {
			from: oldStatus,
			to: newStatus,
			message,
			consecutiveFailures: this.consecutiveFailures,
			consecutiveSuccesses: this.consecutiveSuccesses,
		});
	}

	private async executeWithTimeout<T>(
		fn: () => Promise<T>,
		timeout: number
	): Promise<T> {
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new AppError(
					`Health check timed out after ${timeout}ms`,
					ErrorCode.TIMEOUT
				));
			}, timeout);
		});

		return await Promise.race([fn(), timeoutPromise]);
	}
}

/**
 * Health Check Manager
 */
export class HealthCheckManager {
	private healthChecks = new Map<string, HealthCheck>();
	private readonly logger = getLogger('health-manager');

	/**
	 * Register a health check
	 */
	register(config: HealthCheckConfig): HealthCheck {
		if (this.healthChecks.has(config.name)) {
			throw new AppError(
				`Health check already registered: ${config.name}`,
				ErrorCode.CONFIGURATION_ERROR
			);
		}

		const healthCheck = new HealthCheck(config);
		this.healthChecks.set(config.name, healthCheck);

		this.logger.info(`Health check registered: ${config.name}`, {
			interval: config.interval,
			critical: config.critical,
			enabled: config.enabled,
		});

		return healthCheck;
	}

	/**
	 * Unregister a health check
	 */
	unregister(name: string): boolean {
		const healthCheck = this.healthChecks.get(name);
		if (healthCheck) {
			healthCheck.stop();
			this.healthChecks.delete(name);
			this.logger.info(`Health check unregistered: ${name}`);
			return true;
		}
		return false;
	}

	/**
	 * Start all health checks
	 */
	startAll(): void {
		for (const healthCheck of this.healthChecks.values()) {
			healthCheck.start();
		}
		this.logger.info(`Started ${this.healthChecks.size} health checks`);
	}

	/**
	 * Stop all health checks
	 */
	stopAll(): void {
		for (const healthCheck of this.healthChecks.values()) {
			healthCheck.stop();
		}
		this.logger.info(`Stopped ${this.healthChecks.size} health checks`);
	}

	/**
	 * Get health check by name
	 */
	getHealthCheck(name: string): HealthCheck | undefined {
		return this.healthChecks.get(name);
	}

	/**
	 * Get system health status
	 */
	getSystemHealth(): SystemHealthStatus {
		const checks: Record<string, HealthCheckResult> = {};
		let healthyCount = 0;
		let degradedCount = 0;
		let unhealthyCount = 0;
		let unknownCount = 0;
		let criticalTotal = 0;
		let criticalHealthy = 0;
		let criticalUnhealthy = 0;

		for (const [name, healthCheck] of this.healthChecks) {
			const result = healthCheck.getLastResult();
			const config = healthCheck.getConfig();
			
			if (result) {
				checks[name] = result;
				
				switch (result.status) {
					case HealthStatus.HEALTHY:
						healthyCount++;
						if (config.critical) {
							criticalTotal++;
							criticalHealthy++;
						}
						break;
					case HealthStatus.DEGRADED:
						degradedCount++;
						break;
					case HealthStatus.UNHEALTHY:
						unhealthyCount++;
						if (config.critical) {
							criticalTotal++;
							criticalUnhealthy++;
						}
						break;
					default:
						unknownCount++;
						break;
				}
			} else {
				// No check result yet
				unknownCount++;
				if (config.critical) {
					criticalTotal++;
				}
			}
		}

		// Determine overall system health
		let systemStatus = HealthStatus.HEALTHY;
		
		if (criticalUnhealthy > 0) {
			systemStatus = HealthStatus.UNHEALTHY;
		} else if (unhealthyCount > 0 || degradedCount > 0) {
			systemStatus = HealthStatus.DEGRADED;
		} else if (unknownCount > 0 || criticalTotal === 0) {
			systemStatus = HealthStatus.UNKNOWN;
		}

		return {
			status: systemStatus,
			timestamp: Date.now(),
			checks,
			summary: {
				total: this.healthChecks.size,
				healthy: healthyCount,
				degraded: degradedCount,
				unhealthy: unhealthyCount,
				unknown: unknownCount,
				critical: {
					total: criticalTotal,
					healthy: criticalHealthy,
					unhealthy: criticalUnhealthy,
				},
			},
		};
	}

	/**
	 * Get health checks by tag
	 */
	getHealthChecksByTag(tag: string): HealthCheck[] {
		const result: HealthCheck[] = [];
		
		for (const healthCheck of this.healthChecks.values()) {
			const config = healthCheck.getConfig();
			if (config.tags && config.tags.includes(tag)) {
				result.push(healthCheck);
			}
		}

		return result;
	}
}

/**
 * Predefined Health Checks
 */
export class StandardHealthChecks {
	/**
	 * Database connectivity health check
	 */
	static database(
		name: string,
		checkFn: () => Promise<boolean>,
		config?: Partial<HealthCheckConfig>
	): HealthCheckConfig {
		return {
			name: `database-${name}`,
			check: async () => {
				const startTime = Date.now();
				try {
					const isConnected = await checkFn();
					const responseTime = Date.now() - startTime;

					if (isConnected) {
						return {
							status: HealthStatus.HEALTHY,
							message: 'Database connection successful',
							responseTime,
							timestamp: Date.now(),
							details: { connectionTime: responseTime },
						};
					} else {
						return {
							status: HealthStatus.UNHEALTHY,
							message: 'Database connection failed',
							responseTime,
							timestamp: Date.now(),
						};
					}
				} catch (error) {
					return {
						status: HealthStatus.UNHEALTHY,
						message: `Database error: ${(error as Error).message}`,
						responseTime: Date.now() - startTime,
						timestamp: Date.now(),
						details: { error: (error as Error).message },
					};
				}
			},
			interval: 30000, // 30 seconds
			timeout: 10000,  // 10 seconds
			failureThreshold: 3,
			recoveryThreshold: 2,
			retryOnFailure: true,
			tags: ['database', 'critical'],
			critical: true,
			enabled: true,
			...config,
		};
	}

	/**
	 * External API health check
	 */
	static externalApi(
		name: string,
		url: string,
		config?: Partial<HealthCheckConfig>
	): HealthCheckConfig {
		return {
			name: `api-${name}`,
			check: async () => {
				const startTime = Date.now();
				try {
					// Simple HTTP health check (would use actual HTTP client)
					const responseTime = Date.now() - startTime;
					
					// Simulate API check
					const isHealthy = Math.random() > 0.1; // 90% success rate for demo
					
					if (isHealthy) {
						return {
							status: HealthStatus.HEALTHY,
							message: `API ${name} is responsive`,
							responseTime,
							timestamp: Date.now(),
							details: { url, responseTime },
						};
					} else {
						return {
							status: HealthStatus.UNHEALTHY,
							message: `API ${name} is not responding`,
							responseTime,
							timestamp: Date.now(),
							details: { url },
						};
					}
				} catch (error) {
					return {
						status: HealthStatus.UNHEALTHY,
						message: `API error: ${(error as Error).message}`,
						responseTime: Date.now() - startTime,
						timestamp: Date.now(),
						details: { url, error: (error as Error).message },
					};
				}
			},
			interval: 60000, // 1 minute
			timeout: 15000,  // 15 seconds
			failureThreshold: 2,
			recoveryThreshold: 1,
			retryOnFailure: true,
			tags: ['api', 'external'],
			critical: false,
			enabled: true,
			...config,
		};
	}

	/**
	 * Memory usage health check
	 */
	static memoryUsage(
		thresholdPercent: number = 80,
		config?: Partial<HealthCheckConfig>
	): HealthCheckConfig {
		return {
			name: 'memory-usage',
			check: async () => {
				const memoryUsage = process.memoryUsage();
				const totalMemory = require('os').totalmem();
				const freeMemory = require('os').freemem();
				const usedMemory = totalMemory - freeMemory;
				const usagePercent = (usedMemory / totalMemory) * 100;

				const details = {
					heapUsed: memoryUsage.heapUsed,
					heapTotal: memoryUsage.heapTotal,
					external: memoryUsage.external,
					rss: memoryUsage.rss,
					systemUsagePercent: usagePercent,
					threshold: thresholdPercent,
				};

				let status = HealthStatus.HEALTHY;
				let message = `Memory usage: ${usagePercent.toFixed(1)}%`;

				if (usagePercent > thresholdPercent) {
					status = HealthStatus.UNHEALTHY;
					message = `Memory usage critical: ${usagePercent.toFixed(1)}%`;
				} else if (usagePercent > thresholdPercent * 0.8) {
					status = HealthStatus.DEGRADED;
					message = `Memory usage elevated: ${usagePercent.toFixed(1)}%`;
				}

				return {
					status,
					message,
					timestamp: Date.now(),
					responseTime: 1,
					details,
				};
			},
			interval: 30000, // 30 seconds
			timeout: 5000,   // 5 seconds
			failureThreshold: 3,
			recoveryThreshold: 2,
			retryOnFailure: false,
			tags: ['system', 'memory'],
			critical: true,
			enabled: true,
			...config,
		};
	}
}

// Global health check manager
export const globalHealthManager = new HealthCheckManager();