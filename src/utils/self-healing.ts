/**
 * Self-Healing Systems with Automatic Recovery
 * Circuit breakers, health checks, automatic failover, and recovery strategies
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { AsyncUtils } from './shared-patterns.js';

export interface HealthCheck {
	id: string;
	name: string;
	description: string;
	interval: number;
	timeout: number;
	retries: number;
	enabled: boolean;
	critical: boolean;
	check: () => Promise<HealthCheckResult>;
	onFailure?: (result: HealthCheckResult) => Promise<void>;
	onRecovery?: (result: HealthCheckResult) => Promise<void>;
}

export interface HealthCheckResult {
	id: string;
	status: 'healthy' | 'degraded' | 'unhealthy';
	message: string;
	details?: Record<string, unknown>;
	timestamp: number;
	duration: number;
	metadata?: Record<string, unknown>;
}

export interface CircuitBreakerConfig {
	failureThreshold: number;
	resetTimeout: number;
	monitoringPeriod: number;
	halfOpenMaxCalls: number;
	errorThresholdPercentage: number;
	volumeThreshold: number;
}

export interface CircuitBreakerState {
	state: 'closed' | 'open' | 'half-open';
	failures: number;
	successCount: number;
	lastFailureTime?: number;
	lastStateChange: number;
	totalCalls: number;
	successfulCalls: number;
	failedCalls: number;
	recentCalls: Array<{ timestamp: number; success: boolean; duration: number }>;
}

export interface RecoveryStrategy {
	id: string;
	name: string;
	description: string;
	triggers: RecoveryTrigger[];
	actions: RecoveryAction[];
	cooldownPeriod: number;
	maxRetries: number;
	enabled: boolean;
	priority: number;
}

export interface RecoveryTrigger {
	type:
		| 'health-check-failure'
		| 'circuit-breaker-open'
		| 'resource-exhaustion'
		| 'performance-degradation'
		| 'manual';
	conditions: Record<string, unknown>;
}

export interface RecoveryAction {
	type:
		| 'restart-service'
		| 'clear-cache'
		| 'scale-resources'
		| 'failover'
		| 'throttle-requests'
		| 'custom';
	config: Record<string, unknown>;
	timeout: number;
	retries: number;
}

export interface SystemHealth {
	status: 'healthy' | 'degraded' | 'unhealthy';
	score: number; // 0-100
	lastUpdate: number;
	checks: Map<string, HealthCheckResult>;
	issues: SystemIssue[];
	recoveryActions: RecoveryExecution[];
}

export interface SystemIssue {
	id: string;
	severity: 'low' | 'medium' | 'high' | 'critical';
	title: string;
	description: string;
	source: string;
	detectedAt: number;
	resolvedAt?: number;
	status: 'open' | 'investigating' | 'resolved' | 'suppressed';
	metadata: Record<string, unknown>;
}

export interface RecoveryExecution {
	id: string;
	strategyId: string;
	triggeredBy: string;
	startedAt: number;
	completedAt?: number;
	status: 'running' | 'completed' | 'failed' | 'cancelled';
	actions: Array<{
		action: RecoveryAction;
		status: 'pending' | 'running' | 'completed' | 'failed';
		startedAt?: number;
		completedAt?: number;
		error?: Error;
		result?: unknown;
	}>;
	result?: {
		success: boolean;
		message: string;
		details?: Record<string, unknown>;
	};
}

export class CircuitBreaker extends EventEmitter {
	private config: CircuitBreakerConfig;
	private state: CircuitBreakerState;
	private name: string;

	constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
		super();
		this.name = name;
		this.config = {
			failureThreshold: 5,
			resetTimeout: 60000, // 1 minute
			monitoringPeriod: 300000, // 5 minutes
			halfOpenMaxCalls: 3,
			errorThresholdPercentage: 50,
			volumeThreshold: 10,
			...config,
		};

		this.state = {
			state: 'closed',
			failures: 0,
			successCount: 0,
			lastStateChange: Date.now(),
			totalCalls: 0,
			successfulCalls: 0,
			failedCalls: 0,
			recentCalls: [],
		};
	}

	async execute<T>(operation: () => Promise<T>): Promise<T> {
		if (this.state.state === 'open') {
			if (this.shouldAttemptReset()) {
				this.state.state = 'half-open';
				this.state.lastStateChange = Date.now();
				this.emit('state-change', { from: 'open', to: 'half-open', circuit: this.name });
			} else {
				const error = new Error(`Circuit breaker '${this.name}' is OPEN`);
				(error as Error & { circuitBreakerOpen?: boolean }).circuitBreakerOpen = true;
				throw error;
			}
		}

		if (
			this.state.state === 'half-open' &&
			this.state.successCount >= this.config.halfOpenMaxCalls
		) {
			const error = new Error(`Circuit breaker '${this.name}' is HALF-OPEN and at max calls`);
			(error as Error & { circuitBreakerHalfOpen?: boolean }).circuitBreakerHalfOpen = true;
			throw error;
		}

		const startTime = performance.now();
		let success = false;
		let error: Error | undefined;

		try {
			const result = await operation();
			success = true;
			this.onSuccess(performance.now() - startTime);
			return result;
		} catch (err) {
			error = err instanceof Error ? err : new Error(String(err));
			this.onFailure(performance.now() - startTime);
			throw error;
		} finally {
			this.recordCall(success, performance.now() - startTime);
		}
	}

	private onSuccess(_duration: number): void {
		this.state.totalCalls++;
		this.state.successfulCalls++;

		if (this.state.state === 'half-open') {
			this.state.successCount++;
			if (this.state.successCount >= this.config.halfOpenMaxCalls) {
				this.state.state = 'closed';
				this.state.failures = 0;
				this.state.successCount = 0;
				this.state.lastStateChange = Date.now();
				this.emit('state-change', { from: 'half-open', to: 'closed', circuit: this.name });
			}
		} else if (this.state.state === 'closed') {
			this.state.failures = Math.max(0, this.state.failures - 1); // Gradually recover
		}
	}

	private onFailure(_duration: number): void {
		this.state.totalCalls++;
		this.state.failedCalls++;
		this.state.failures++;
		this.state.lastFailureTime = Date.now();

		if (this.state.state === 'half-open') {
			this.state.state = 'open';
			this.state.lastStateChange = Date.now();
			this.emit('state-change', { from: 'half-open', to: 'open', circuit: this.name });
		} else if (this.state.state === 'closed' && this.shouldOpenCircuit()) {
			this.state.state = 'open';
			this.state.lastStateChange = Date.now();
			this.emit('state-change', { from: 'closed', to: 'open', circuit: this.name });
		}
	}

	private shouldOpenCircuit(): boolean {
		// Check if we have enough volume
		if (this.state.totalCalls < this.config.volumeThreshold) {
			return false;
		}

		// Check failure threshold
		if (this.state.failures >= this.config.failureThreshold) {
			return true;
		}

		// Check error percentage in recent calls
		const now = Date.now();
		const recentCalls = this.state.recentCalls.filter(
			(call) => now - call.timestamp < this.config.monitoringPeriod
		);

		if (recentCalls.length >= this.config.volumeThreshold) {
			const errorCount = recentCalls.filter((call) => !call.success).length;
			const errorPercentage = (errorCount / recentCalls.length) * 100;
			return errorPercentage >= this.config.errorThresholdPercentage;
		}

		return false;
	}

	private shouldAttemptReset(): boolean {
		return Date.now() - this.state.lastStateChange >= this.config.resetTimeout;
	}

	private recordCall(success: boolean, duration: number): void {
		this.state.recentCalls.push({
			timestamp: Date.now(),
			success,
			duration,
		});

		// Keep only recent calls within monitoring period
		const cutoff = Date.now() - this.config.monitoringPeriod;
		this.state.recentCalls = this.state.recentCalls.filter((call) => call.timestamp > cutoff);
	}

	getState(): CircuitBreakerState {
		return { ...this.state };
	}

	reset(): void {
		this.state = {
			state: 'closed',
			failures: 0,
			successCount: 0,
			lastStateChange: Date.now(),
			totalCalls: 0,
			successfulCalls: 0,
			failedCalls: 0,
			recentCalls: [],
		};
		this.emit('reset', { circuit: this.name });
	}
}

export class SelfHealingSystem extends EventEmitter {
	private healthChecks = new Map<string, HealthCheck>();
	private circuitBreakers = new Map<string, CircuitBreaker>();
	private recoveryStrategies = new Map<string, RecoveryStrategy>();
	private systemHealth: SystemHealth;
	private activeRecoveries = new Map<string, RecoveryExecution>();
	private suppressedIssues = new Set<string>();

	private healthCheckTimer?: NodeJS.Timeout;
	private cleanupTimer?: NodeJS.Timeout;
	private isShuttingDown = false;

	constructor() {
		super();

		this.systemHealth = {
			status: 'healthy',
			score: 100,
			lastUpdate: Date.now(),
			checks: new Map(),
			issues: [],
			recoveryActions: [],
		};

		this.setupPeriodicTasks();
		this.setupDefaultStrategies();
	}

	// Health Check Management
	registerHealthCheck(check: HealthCheck): void {
		this.healthChecks.set(check.id, check);
		this.emit('health-check-registered', check);
	}

	unregisterHealthCheck(id: string): boolean {
		const removed = this.healthChecks.delete(id);
		if (removed) {
			this.systemHealth.checks.delete(id);
			this.emit('health-check-unregistered', { id });
		}
		return removed;
	}

	async runHealthCheck(id: string): Promise<HealthCheckResult> {
		const check = this.healthChecks.get(id);
		if (!check) {
			throw new Error(`Health check '${id}' not found`);
		}

		const startTime = performance.now();
		let attempt = 0;
		let lastError: Error | undefined;

		while (attempt < check.retries + 1) {
			try {
				const result = await Promise.race([
					check.check(),
					this.createTimeoutPromise(check.timeout),
				]);

				result.duration = performance.now() - startTime;
				result.timestamp = Date.now();

				this.systemHealth.checks.set(id, result);
				this.updateSystemHealth();

				if (result.status !== 'healthy' && check.onFailure) {
					await check.onFailure(result);
				} else if (result.status === 'healthy' && check.onRecovery) {
					const previousResult = this.systemHealth.checks.get(id);
					if (previousResult && previousResult.status !== 'healthy') {
						await check.onRecovery(result);
					}
				}

				this.emit('health-check-completed', result);
				return result;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				attempt++;

				if (attempt < check.retries + 1) {
					await AsyncUtils.sleep(1000 * attempt); // Exponential backoff
				}
			}
		}

		// All retries failed
		const failedResult: HealthCheckResult = {
			id,
			status: 'unhealthy',
			message: `Health check failed after ${check.retries + 1} attempts: ${lastError?.message}`,
			details: { error: lastError?.message, attempts: attempt },
			timestamp: Date.now(),
			duration: performance.now() - startTime,
		};

		this.systemHealth.checks.set(id, failedResult);
		this.updateSystemHealth();

		if (check.onFailure) {
			await check.onFailure(failedResult);
		}

		this.emit('health-check-completed', failedResult);
		return failedResult;
	}

	private async createTimeoutPromise(timeout: number): Promise<never> {
		return new Promise((_, reject) => {
			setTimeout(() => reject(new Error('Health check timeout')), timeout);
		});
	}

	// Circuit Breaker Management
	createCircuitBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
		const breaker = new CircuitBreaker(name, config);
		this.circuitBreakers.set(name, breaker);

		breaker.on('state-change', (event) => {
			this.emit('circuit-breaker-state-change', event);

			if (event.to === 'open') {
				this.createIssue({
					severity: 'high',
					title: `Circuit Breaker Opened`,
					description: `Circuit breaker '${name}' has opened due to failures`,
					source: 'circuit-breaker',
					metadata: { circuitBreaker: name, event },
				});
			}
		});

		this.emit('circuit-breaker-created', { name, breaker });
		return breaker;
	}

	getCircuitBreaker(name: string): CircuitBreaker | undefined {
		return this.circuitBreakers.get(name);
	}

	// Recovery Strategy Management
	registerRecoveryStrategy(strategy: RecoveryStrategy): void {
		this.recoveryStrategies.set(strategy.id, strategy);
		this.emit('recovery-strategy-registered', strategy);
	}

	async triggerRecovery(
		strategyId: string,
		triggeredBy: string,
		_metadata?: Record<string, unknown>
	): Promise<string> {
		const strategy = this.recoveryStrategies.get(strategyId);
		if (!strategy || !strategy.enabled) {
			throw new Error(`Recovery strategy '${strategyId}' not found or disabled`);
		}

		// Check cooldown
		const recentExecutions = this.systemHealth.recoveryActions.filter(
			(action) =>
				action.strategyId === strategyId &&
				Date.now() - action.startedAt < strategy.cooldownPeriod
		);

		if (recentExecutions.length > 0) {
			throw new Error(`Recovery strategy '${strategyId}' is in cooldown period`);
		}

		const execution: RecoveryExecution = {
			id: this.generateId(),
			strategyId,
			triggeredBy,
			startedAt: Date.now(),
			status: 'running',
			actions: strategy.actions.map((action) => ({
				action,
				status: 'pending',
			})),
		};

		this.activeRecoveries.set(execution.id, execution);
		this.systemHealth.recoveryActions.push(execution);

		this.emit('recovery-started', execution);

		// Execute actions sequentially
		this.executeRecoveryActions(execution).catch((error) => {
			execution.status = 'failed';
			execution.completedAt = Date.now();
			execution.result = {
				success: false,
				message: `Recovery failed: ${error.message}`,
				details: { error: error.message },
			};
			this.emit('recovery-failed', execution);
		});

		return execution.id;
	}

	private async executeRecoveryActions(execution: RecoveryExecution): Promise<void> {
		try {
			for (const actionExecution of execution.actions) {
				actionExecution.status = 'running';
				actionExecution.startedAt = Date.now();

				try {
					const result = await this.executeRecoveryAction(actionExecution.action);
					actionExecution.status = 'completed';
					actionExecution.completedAt = Date.now();
					actionExecution.result = result;
				} catch (error) {
					actionExecution.status = 'failed';
					actionExecution.completedAt = Date.now();
					actionExecution.error =
						error instanceof Error ? error : new Error(String(error));

					// Decide whether to continue or abort based on action criticality
					if (actionExecution.action.config.critical) {
						throw error;
					}
				}
			}

			execution.status = 'completed';
			execution.completedAt = Date.now();
			execution.result = {
				success: true,
				message: 'Recovery completed successfully',
				details: {
					actionsCompleted: execution.actions.filter((a) => a.status === 'completed')
						.length,
					actionsFailed: execution.actions.filter((a) => a.status === 'failed').length,
				},
			};

			this.emit('recovery-completed', execution);
		} finally {
			this.activeRecoveries.delete(execution.id);
		}
	}

	private async executeRecoveryAction(action: RecoveryAction): Promise<unknown> {
		const timeout = action.timeout || 30000;

		const execute = async (): Promise<unknown> => {
			switch (action.type) {
				case 'restart-service':
					return this.executeRestartService(action.config);
				case 'clear-cache':
					return this.executeClearCache(action.config);
				case 'scale-resources':
					return this.executeScaleResources(action.config);
				case 'failover':
					return this.executeFailover(action.config);
				case 'throttle-requests':
					return this.executeThrottleRequests(action.config);
				case 'custom':
					return this.executeCustomAction(action.config);
				default:
					throw new Error(`Unknown recovery action type: ${action.type}`);
			}
		};

		return Promise.race([
			execute(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Recovery action timeout')), timeout)
			),
		]);
	}

	private async executeRestartService(config: Record<string, unknown>): Promise<string> {
		const serviceName = config.serviceName as string;
		this.emit('service-restart-requested', { serviceName });
		// Implementation would restart the actual service
		return `Service ${serviceName} restart initiated`;
	}

	private async executeClearCache(config: Record<string, unknown>): Promise<string> {
		const cacheType = config.cacheType as string;
		this.emit('cache-clear-requested', { cacheType });
		// Implementation would clear the specified cache
		return `Cache ${cacheType} cleared`;
	}

	private async executeScaleResources(config: Record<string, unknown>): Promise<string> {
		const resourceType = config.resourceType as string;
		const scaleFactor = config.scaleFactor as number;
		this.emit('resource-scaling-requested', { resourceType, scaleFactor });
		// Implementation would scale resources
		return `Resources scaled: ${resourceType} by factor ${scaleFactor}`;
	}

	private async executeFailover(config: Record<string, unknown>): Promise<string> {
		const primaryService = config.primaryService as string;
		const fallbackService = config.fallbackService as string;
		this.emit('failover-requested', { primaryService, fallbackService });
		// Implementation would perform failover
		return `Failover completed: ${primaryService} -> ${fallbackService}`;
	}

	private async executeThrottleRequests(config: Record<string, unknown>): Promise<string> {
		const throttleRate = config.throttleRate as number;
		this.emit('throttling-requested', { throttleRate });
		// Implementation would apply request throttling
		return `Request throttling applied: ${throttleRate}%`;
	}

	private async executeCustomAction(config: Record<string, unknown>): Promise<unknown> {
		const handler = config.handler as (config: Record<string, unknown>) => Promise<unknown>;
		if (typeof handler !== 'function') {
			throw new Error('Custom action handler must be a function');
		}
		return handler(config);
	}

	// Issue Management
	private createIssue(issue: Omit<SystemIssue, 'id' | 'detectedAt' | 'status'>): SystemIssue {
		const newIssue: SystemIssue = {
			...issue,
			id: this.generateId(),
			detectedAt: Date.now(),
			status: 'open',
		};

		this.systemHealth.issues.push(newIssue);
		this.emit('issue-detected', newIssue);

		// Auto-trigger recovery strategies
		this.evaluateRecoveryTriggers(newIssue);

		return newIssue;
	}

	private evaluateRecoveryTriggers(issue: SystemIssue): void {
		for (const strategy of this.recoveryStrategies.values()) {
			if (!strategy.enabled) continue;

			for (const trigger of strategy.triggers) {
				if (this.shouldTriggerRecovery(trigger, issue)) {
					this.triggerRecovery(strategy.id, `auto-trigger:${issue.id}`, { issue }).catch(
						(error) => {
							this.emit('auto-recovery-failed', {
								strategy: strategy.id,
								issue: issue.id,
								error,
							});
						}
					);
					break; // Only trigger once per strategy
				}
			}
		}
	}

	private shouldTriggerRecovery(trigger: RecoveryTrigger, issue: SystemIssue): boolean {
		switch (trigger.type) {
			case 'health-check-failure':
				return (
					issue.source === 'health-check' &&
					issue.severity === trigger.conditions.severity
				);
			case 'circuit-breaker-open':
				return issue.source === 'circuit-breaker';
			case 'resource-exhaustion':
				return issue.source === 'resource-monitor' && issue.severity === 'critical';
			case 'performance-degradation':
				return issue.source === 'performance-monitor';
			default:
				return false;
		}
	}

	// System Health Management
	private updateSystemHealth(): void {
		const checks = Array.from(this.systemHealth.checks.values());
		const totalChecks = checks.length;

		if (totalChecks === 0) {
			this.systemHealth.status = 'healthy';
			this.systemHealth.score = 100;
			return;
		}

		const healthyChecks = checks.filter((c) => c.status === 'healthy').length;
		const degradedChecks = checks.filter((c) => c.status === 'degraded').length;
		const unhealthyChecks = checks.filter((c) => c.status === 'unhealthy').length;

		// Calculate health score
		this.systemHealth.score = Math.round(
			(healthyChecks * 100 + degradedChecks * 50 + unhealthyChecks * 0) / totalChecks
		);

		// Determine overall status
		if (unhealthyChecks > 0) {
			this.systemHealth.status = 'unhealthy';
		} else if (degradedChecks > 0) {
			this.systemHealth.status = 'degraded';
		} else {
			this.systemHealth.status = 'healthy';
		}

		this.systemHealth.lastUpdate = Date.now();
		this.emit('system-health-updated', this.systemHealth);
	}

	// Default Recovery Strategies
	private setupDefaultStrategies(): void {
		// Memory pressure recovery
		this.registerRecoveryStrategy({
			id: 'memory-pressure-recovery',
			name: 'Memory Pressure Recovery',
			description: 'Clear caches and trigger garbage collection when memory usage is high',
			triggers: [
				{
					type: 'resource-exhaustion',
					conditions: { resource: 'memory', severity: 'high' },
				},
			],
			actions: [
				{
					type: 'clear-cache',
					config: { cacheType: 'all' },
					timeout: 10000,
					retries: 1,
				},
				{
					type: 'custom',
					config: {
						handler: async () => {
							if (global.gc) {
								global.gc();
								return 'Garbage collection triggered';
							}
							return 'Garbage collection not available';
						},
					},
					timeout: 5000,
					retries: 0,
				},
			],
			cooldownPeriod: 60000, // 1 minute
			maxRetries: 3,
			enabled: true,
			priority: 1,
		});

		// Circuit breaker recovery
		this.registerRecoveryStrategy({
			id: 'circuit-breaker-recovery',
			name: 'Circuit Breaker Recovery',
			description: 'Attempt to recover from circuit breaker failures',
			triggers: [
				{
					type: 'circuit-breaker-open',
					conditions: {},
				},
			],
			actions: [
				{
					type: 'throttle-requests',
					config: { throttleRate: 50 },
					timeout: 5000,
					retries: 0,
				},
			],
			cooldownPeriod: 120000, // 2 minutes
			maxRetries: 2,
			enabled: true,
			priority: 2,
		});
	}

	// Periodic Tasks
	private setupPeriodicTasks(): void {
		// Run health checks
		this.healthCheckTimer = setInterval(() => {
			this.runAllHealthChecks();
		}, 30000); // Every 30 seconds

		// Cleanup old data
		this.cleanupTimer = setInterval(() => {
			this.performCleanup();
		}, 300000); // Every 5 minutes
	}

	private async runAllHealthChecks(): Promise<void> {
		if (this.isShuttingDown) return;

		const promises = Array.from(this.healthChecks.values())
			.filter((check) => check.enabled)
			.map((check) =>
				this.runHealthCheck(check.id).catch((error) => {
					this.emit('health-check-error', { checkId: check.id, error });
				})
			);

		await Promise.allSettled(promises);
	}

	private performCleanup(): void {
		const now = Date.now();
		const retentionPeriod = 24 * 60 * 60 * 1000; // 24 hours

		// Clean up old issues
		this.systemHealth.issues = this.systemHealth.issues.filter(
			(issue) =>
				issue.status !== 'resolved' || now - (issue.resolvedAt || 0) < retentionPeriod
		);

		// Clean up old recovery actions
		this.systemHealth.recoveryActions = this.systemHealth.recoveryActions.filter(
			(action) => now - action.startedAt < retentionPeriod
		);

		// Clean up old health check results
		for (const [id, result] of this.systemHealth.checks) {
			if (now - result.timestamp > retentionPeriod) {
				this.systemHealth.checks.delete(id);
			}
		}
	}

	// Public API
	getSystemHealth(): SystemHealth {
		return { ...this.systemHealth };
	}

	getCircuitBreakerStates(): Record<string, CircuitBreakerState> {
		const states: Record<string, CircuitBreakerState> = {};
		for (const [name, breaker] of this.circuitBreakers) {
			states[name] = breaker.getState();
		}
		return states;
	}

	async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);

		// Cancel active recoveries
		for (const recovery of this.activeRecoveries.values()) {
			recovery.status = 'cancelled';
			recovery.completedAt = Date.now();
		}

		this.emit('shutdown');
	}

	private generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}
}
