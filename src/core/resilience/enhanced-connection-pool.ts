/**
 * Enhanced Connection Pool with Health Monitoring
 * Advanced connection pooling with health checks, automatic failover, and performance monitoring
 */

import Database from 'better-sqlite3';
import { getLogger } from '../logger.js';
import { AppError, ErrorCode, sleep } from '../../utils/common.js';
import { CircuitBreaker, CircuitBreakerFactory } from './circuit-breaker.js';
import { RetryStrategies } from './retry-strategies.js';
import { globalMetricsRegistry } from './metrics-collector.js';
import { HealthCheck, HealthStatus, StandardHealthChecks } from './health-checks.js';

export interface ConnectionPoolConfig {
	/** Minimum number of connections to maintain */
	minConnections: number;
	/** Maximum number of connections */
	maxConnections: number;
	/** Connection acquisition timeout (ms) */
	acquireTimeout: number;
	/** Connection idle timeout (ms) */
	idleTimeout: number;
	/** Connection validation timeout (ms) */
	validationTimeout: number;
	/** Validation query to test connection health */
	validationQuery?: string;
	/** Connection retry configuration */
	retryConfig: {
		maxAttempts: number;
		initialDelay: number;
		maxDelay: number;
		factor: number;
	};
	/** Health check interval (ms) */
	healthCheckInterval: number;
	/** Enable connection pre-warming */
	enablePreWarming: boolean;
	/** Pre-warming delay between connections (ms) */
	preWarmingDelay: number;
	/** Pool name for metrics */
	poolName: string;
}

export interface ConnectionMetrics {
	totalConnections: number;
	activeConnections: number;
	idleConnections: number;
	pendingAcquisitions: number;
	totalAcquisitions: number;
	successfulAcquisitions: number;
	failedAcquisitions: number;
	totalValidations: number;
	validationFailures: number;
	averageAcquisitionTime: number;
	averageValidationTime: number;
	connectionErrors: number;
	poolUtilization: number;
	healthStatus: HealthStatus;
}

export interface PooledConnection<T> {
	connection: T;
	id: string;
	createdAt: number;
	lastUsed: number;
	timesUsed: number;
	isValid: boolean;
	validatedAt?: number;
}

export interface ConnectionFactory<T> {
	create(): Promise<T>;
	destroy(connection: T): Promise<void>;
	validate(connection: T): Promise<boolean>;
}

/**
 * Enhanced Connection Pool with health monitoring and automatic failover
 */
export class EnhancedConnectionPool<T> {
	private connections: PooledConnection<T>[] = [];
	private activeConnections = new Set<PooledConnection<T>>();
	private acquisitionQueue: Array<{
		resolve: (connection: PooledConnection<T>) => void;
		reject: (error: Error) => void;
		timestamp: number;
	}> = [];
	
	private healthCheck?: HealthCheck;
	private healthCheckTimer?: NodeJS.Timeout;
	private validationTimer?: NodeJS.Timeout;
	private isShuttingDown = false;
	
	private readonly logger = getLogger('enhanced-pool');
	private readonly circuitBreaker: CircuitBreaker;
	private readonly retryStrategy = RetryStrategies.createDatabase();
	
	// Metrics
	private metrics = {
		totalAcquisitions: 0,
		successfulAcquisitions: 0,
		failedAcquisitions: 0,
		totalValidations: 0,
		validationFailures: 0,
		connectionErrors: 0,
		acquisitionTimes: [] as number[],
		validationTimes: [] as number[],
	};

	constructor(
		private readonly factory: ConnectionFactory<T>,
		private readonly config: ConnectionPoolConfig
	) {
		this.circuitBreaker = CircuitBreakerFactory.getCircuitBreaker(
			`pool-${config.poolName}`,
			{
				failureThreshold: 5,
				successThreshold: 3,
				timeWindow: 60000,
				openTimeout: 30000,
			}
		);

		this.initializePool();
		this.setupHealthChecks();
		this.setupMetrics();
		
		this.logger.info(`Enhanced connection pool initialized: ${config.poolName}`, {
			minConnections: config.minConnections,
			maxConnections: config.maxConnections,
			acquireTimeout: config.acquireTimeout,
		});
	}

	/**
	 * Acquire a connection from the pool
	 */
	async acquire(): Promise<PooledConnection<T>> {
		if (this.isShuttingDown) {
			throw new AppError(
				'Connection pool is shutting down',
				ErrorCode.OPERATION_CANCELLED
			);
		}

		this.metrics.totalAcquisitions++;
		const startTime = Date.now();

		try {
			const connection = await this.circuitBreaker.execute(async () => {
				return await this.retryStrategy.execute(async () => {
					return await this.doAcquire();
				});
			});

			this.metrics.successfulAcquisitions++;
			this.updateAcquisitionTime(Date.now() - startTime);
			
			this.logger.debug(`Connection acquired: ${connection.id}`, {
				poolName: this.config.poolName,
				timesUsed: connection.timesUsed,
			});

			return connection;

		} catch (error) {
			this.metrics.failedAcquisitions++;
			this.updateAcquisitionTime(Date.now() - startTime);
			
			this.logger.error('Failed to acquire connection', {
				poolName: this.config.poolName,
				error: (error as Error).message,
			});

			throw error;
		}
	}

	/**
	 * Release a connection back to the pool
	 */
	release(pooledConnection: PooledConnection<T>): void {
		if (this.activeConnections.has(pooledConnection)) {
			this.activeConnections.delete(pooledConnection);
			pooledConnection.lastUsed = Date.now();
			pooledConnection.timesUsed++;

			// Return to idle pool if still valid
			if (pooledConnection.isValid && !this.isShuttingDown) {
				this.connections.push(pooledConnection);
				this.processAcquisitionQueue();
			} else {
				// Destroy invalid connection
				this.destroyConnection(pooledConnection);
			}

			this.logger.debug(`Connection released: ${pooledConnection.id}`, {
				poolName: this.config.poolName,
				timesUsed: pooledConnection.timesUsed,
			});
		}
	}

	/**
	 * Execute a function with an acquired connection
	 */
	async execute<R>(fn: (connection: T) => Promise<R>): Promise<R> {
		const pooledConnection = await this.acquire();
		
		try {
			return await fn(pooledConnection.connection);
		} finally {
			this.release(pooledConnection);
		}
	}

	/**
	 * Shutdown the pool and clean up resources
	 */
	async shutdown(): Promise<void> {
		this.isShuttingDown = true;

		this.logger.info(`Shutting down connection pool: ${this.config.poolName}`);

		// Stop timers
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
		}
		if (this.validationTimer) {
			clearInterval(this.validationTimer);
		}

		// Reject pending acquisitions
		for (const pending of this.acquisitionQueue) {
			pending.reject(new AppError(
				'Connection pool is shutting down',
				ErrorCode.OPERATION_CANCELLED
			));
		}
		this.acquisitionQueue = [];

		// Wait for active connections to be released (with timeout)
		const shutdownTimeout = 30000; // 30 seconds
		const shutdownStart = Date.now();
		
		while (this.activeConnections.size > 0 && 
			   Date.now() - shutdownStart < shutdownTimeout) {
			await sleep(100);
		}

		// Force close remaining active connections
		for (const activeConnection of this.activeConnections) {
			await this.destroyConnection(activeConnection);
		}

		// Close all idle connections
		const closePromises = this.connections.map(conn => this.destroyConnection(conn));
		await Promise.allSettled(closePromises);

		this.connections = [];
		this.activeConnections.clear();

		this.logger.info(`Connection pool shutdown complete: ${this.config.poolName}`);
	}

	/**
	 * Get current pool metrics
	 */
	getMetrics(): ConnectionMetrics {
		const totalConnections = this.connections.length + this.activeConnections.size;
		
		return {
			totalConnections,
			activeConnections: this.activeConnections.size,
			idleConnections: this.connections.length,
			pendingAcquisitions: this.acquisitionQueue.length,
			totalAcquisitions: this.metrics.totalAcquisitions,
			successfulAcquisitions: this.metrics.successfulAcquisitions,
			failedAcquisitions: this.metrics.failedAcquisitions,
			totalValidations: this.metrics.totalValidations,
			validationFailures: this.metrics.validationFailures,
			averageAcquisitionTime: this.calculateAverageTime(this.metrics.acquisitionTimes),
			averageValidationTime: this.calculateAverageTime(this.metrics.validationTimes),
			connectionErrors: this.metrics.connectionErrors,
			poolUtilization: totalConnections > 0 ? this.activeConnections.size / totalConnections : 0,
			healthStatus: this.healthCheck?.getCurrentStatus() || HealthStatus.UNKNOWN,
		};
	}

	/**
	 * Validate all connections in the pool
	 */
	async validateConnections(): Promise<void> {
		this.logger.debug(`Validating connections: ${this.config.poolName}`);

		// Validate idle connections
		const validationPromises = this.connections.map(async (pooledConnection) => {
			await this.validateConnection(pooledConnection);
		});

		await Promise.allSettled(validationPromises);

		// Remove invalid connections
		this.connections = this.connections.filter(conn => {
			if (!conn.isValid) {
				this.destroyConnection(conn);
				return false;
			}
			return true;
		});

		// Ensure minimum connections
		await this.ensureMinimumConnections();
	}

	private async initializePool(): Promise<void> {
		try {
			// Create minimum connections
			await this.ensureMinimumConnections();

			// Start background tasks
			this.startBackgroundTasks();

			// Pre-warm connections if enabled
			if (this.config.enablePreWarming) {
				await this.preWarmConnections();
			}

		} catch (error) {
			this.logger.error('Failed to initialize connection pool', {
				poolName: this.config.poolName,
				error: (error as Error).message,
			});
			throw error;
		}
	}

	private async doAcquire(): Promise<PooledConnection<T>> {
		// Try to get an idle connection first
		const idleConnection = this.connections.pop();
		if (idleConnection) {
			// Validate connection before use
			if (await this.validateConnection(idleConnection)) {
				this.activeConnections.add(idleConnection);
				return idleConnection;
			} else {
				await this.destroyConnection(idleConnection);
			}
		}

		// Create new connection if under limit
		if (this.getTotalConnectionCount() < this.config.maxConnections) {
			const newConnection = await this.createConnection();
			this.activeConnections.add(newConnection);
			return newConnection;
		}

		// Wait for a connection to become available
		return await this.waitForConnection();
	}

	private async waitForConnection(): Promise<PooledConnection<T>> {
		return new Promise<PooledConnection<T>>((resolve, reject) => {
			const timeout = setTimeout(() => {
				// Remove from queue
				const index = this.acquisitionQueue.findIndex(item => item.resolve === resolve);
				if (index >= 0) {
					this.acquisitionQueue.splice(index, 1);
				}
				
				reject(new AppError(
					`Connection acquisition timed out after ${this.config.acquireTimeout}ms`,
					ErrorCode.TIMEOUT
				));
			}, this.config.acquireTimeout);

			this.acquisitionQueue.push({
				resolve: (connection: PooledConnection<T>) => {
					clearTimeout(timeout);
					resolve(connection);
				},
				reject: (error: Error) => {
					clearTimeout(timeout);
					reject(error);
				},
				timestamp: Date.now(),
			});
		});
	}

	private processAcquisitionQueue(): void {
		while (this.acquisitionQueue.length > 0 && this.connections.length > 0) {
			const pending = this.acquisitionQueue.shift();
			const connection = this.connections.pop();
			
			if (pending && connection) {
				this.activeConnections.add(connection);
				pending.resolve(connection);
			}
		}
	}

	private async createConnection(): Promise<PooledConnection<T>> {
		try {
			const connection = await this.factory.create();
			const pooledConnection: PooledConnection<T> = {
				connection,
				id: this.generateConnectionId(),
				createdAt: Date.now(),
				lastUsed: Date.now(),
				timesUsed: 0,
				isValid: true,
			};

			this.logger.debug(`New connection created: ${pooledConnection.id}`, {
				poolName: this.config.poolName,
			});

			return pooledConnection;

		} catch (error) {
			this.metrics.connectionErrors++;
			this.logger.error('Failed to create connection', {
				poolName: this.config.poolName,
				error: (error as Error).message,
			});
			throw error;
		}
	}

	private async destroyConnection(pooledConnection: PooledConnection<T>): Promise<void> {
		try {
			await this.factory.destroy(pooledConnection.connection);
			this.logger.debug(`Connection destroyed: ${pooledConnection.id}`, {
				poolName: this.config.poolName,
			});
		} catch (error) {
			this.logger.error(`Error destroying connection: ${pooledConnection.id}`, {
				poolName: this.config.poolName,
				error: (error as Error).message,
			});
		}
	}

	private async validateConnection(pooledConnection: PooledConnection<T>): Promise<boolean> {
		const startTime = Date.now();
		this.metrics.totalValidations++;

		try {
			const isValid = await this.factory.validate(pooledConnection.connection);
			pooledConnection.isValid = isValid;
			pooledConnection.validatedAt = Date.now();

			if (!isValid) {
				this.metrics.validationFailures++;
			}

			this.updateValidationTime(Date.now() - startTime);
			return isValid;

		} catch (error) {
			this.metrics.validationFailures++;
			pooledConnection.isValid = false;
			this.updateValidationTime(Date.now() - startTime);

			this.logger.warn(`Connection validation failed: ${pooledConnection.id}`, {
				poolName: this.config.poolName,
				error: (error as Error).message,
			});

			return false;
		}
	}

	private async ensureMinimumConnections(): Promise<void> {
		while (this.getTotalConnectionCount() < this.config.minConnections) {
			try {
				const connection = await this.createConnection();
				this.connections.push(connection);
			} catch (error) {
				this.logger.error('Failed to create minimum connection', {
					poolName: this.config.poolName,
					error: (error as Error).message,
				});
				break; // Don't keep trying if creation fails
			}
		}
	}

	private async preWarmConnections(): Promise<void> {
		this.logger.info(`Pre-warming connections: ${this.config.poolName}`);

		for (let i = this.connections.length; i < this.config.maxConnections; i++) {
			try {
				const connection = await this.createConnection();
				this.connections.push(connection);
				
				if (this.config.preWarmingDelay > 0) {
					await sleep(this.config.preWarmingDelay);
				}
			} catch (error) {
				this.logger.warn('Pre-warming connection failed', {
					poolName: this.config.poolName,
					error: (error as Error).message,
				});
				break;
			}
		}

		this.logger.info(`Pre-warming complete: ${this.config.poolName}`, {
			totalConnections: this.connections.length,
		});
	}

	private startBackgroundTasks(): void {
		// Connection validation timer
		this.validationTimer = setInterval(() => {
			this.validateConnections().catch(error => {
				this.logger.error('Background validation failed', {
					poolName: this.config.poolName,
					error: (error as Error).message,
				});
			});
		}, this.config.healthCheckInterval);

		// Idle connection cleanup timer
		setInterval(() => {
			this.cleanupIdleConnections();
		}, this.config.idleTimeout);
	}

	private cleanupIdleConnections(): void {
		const now = Date.now();
		const toRemove: PooledConnection<T>[] = [];

		for (const connection of this.connections) {
			if (now - connection.lastUsed > this.config.idleTimeout) {
				toRemove.push(connection);
			}
		}

		// Remove expired connections
		for (const connection of toRemove) {
			const index = this.connections.indexOf(connection);
			if (index >= 0) {
				this.connections.splice(index, 1);
				this.destroyConnection(connection);
			}
		}

		if (toRemove.length > 0) {
			this.logger.debug(`Cleaned up ${toRemove.length} idle connections`, {
				poolName: this.config.poolName,
			});

			// Ensure minimum connections after cleanup
			this.ensureMinimumConnections().catch(error => {
				this.logger.error('Failed to maintain minimum connections', {
					poolName: this.config.poolName,
					error: (error as Error).message,
				});
			});
		}
	}

	private setupHealthChecks(): void {
		this.healthCheck = new HealthCheck(
			StandardHealthChecks.database(
				this.config.poolName,
				async () => {
					const metrics = this.getMetrics();
					return metrics.totalConnections > 0 && 
						   metrics.healthStatus !== HealthStatus.UNHEALTHY;
				},
				{
					name: `pool-${this.config.poolName}`,
					interval: this.config.healthCheckInterval,
					timeout: 10000,
					failureThreshold: 3,
					recoveryThreshold: 2,
					retryOnFailure: true,
					critical: true,
				}
			)
		);

		this.healthCheck.start();
	}

	private setupMetrics(): void {
		// Register pool metrics
		const poolGauge = globalMetricsRegistry.gauge(
			`pool.connections.${this.config.poolName}`,
			`Total connections in pool ${this.config.poolName}`,
			{ pool: this.config.poolName }
		);

		const activeGauge = globalMetricsRegistry.gauge(
			`pool.connections.active.${this.config.poolName}`,
			`Active connections in pool ${this.config.poolName}`,
			{ pool: this.config.poolName }
		);

		const acquisitionTimer = globalMetricsRegistry.timer(
			`pool.acquisition.time.${this.config.poolName}`,
			`Connection acquisition time for pool ${this.config.poolName}`,
			{ pool: this.config.poolName }
		);

		// Update metrics periodically
		setInterval(() => {
			const metrics = this.getMetrics();
			poolGauge.set(metrics.totalConnections);
			activeGauge.set(metrics.activeConnections);
		}, 30000); // Every 30 seconds
	}

	private getTotalConnectionCount(): number {
		return this.connections.length + this.activeConnections.size;
	}

	private generateConnectionId(): string {
		return `${this.config.poolName}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
	}

	private updateAcquisitionTime(time: number): void {
		this.metrics.acquisitionTimes.push(time);
		if (this.metrics.acquisitionTimes.length > 1000) {
			this.metrics.acquisitionTimes.shift();
		}
	}

	private updateValidationTime(time: number): void {
		this.metrics.validationTimes.push(time);
		if (this.metrics.validationTimes.length > 1000) {
			this.metrics.validationTimes.shift();
		}
	}

	private calculateAverageTime(times: number[]): number {
		if (times.length === 0) return 0;
		return times.reduce((sum, time) => sum + time, 0) / times.length;
	}
}

/**
 * SQLite Connection Factory
 */
export class SQLiteConnectionFactory implements ConnectionFactory<Database.Database> {
	constructor(
		private dbPath: string,
		private options?: {
			enableWAL?: boolean;
			cacheSize?: number;
			tempStore?: 'MEMORY' | 'FILE';
			mmapSize?: number;
		}
	) {}

	async create(): Promise<Database.Database> {
		const db = new Database(this.dbPath);
		
		// Apply optimizations
		if (this.options?.enableWAL !== false) {
			db.pragma('journal_mode = WAL');
		}
		
		db.pragma('synchronous = NORMAL');
		db.pragma(`cache_size = ${this.options?.cacheSize || -64000}`); // 64MB default
		db.pragma(`temp_store = ${this.options?.tempStore || 'MEMORY'}`);
		
		if (this.options?.mmapSize) {
			db.pragma(`mmap_size = ${this.options.mmapSize}`);
		}
		
		db.pragma('optimize');
		
		return db;
	}

	async destroy(connection: Database.Database): Promise<void> {
		connection.close();
	}

	async validate(connection: Database.Database): Promise<boolean> {
		try {
			// Simple validation query
			const result = connection.prepare('SELECT 1 as test').get() as { test: number };
			return result && result.test === 1;
		} catch {
			return false;
		}
	}
}

/**
 * Pool Manager for managing multiple connection pools
 */
export class ConnectionPoolManager {
	private pools = new Map<string, EnhancedConnectionPool<any>>();
	private readonly logger = getLogger('pool-manager');

	/**
	 * Create or get connection pool
	 */
	getPool<T>(
		name: string,
		factory: ConnectionFactory<T>,
		config: Partial<ConnectionPoolConfig>
	): EnhancedConnectionPool<T> {
		if (this.pools.has(name)) {
			return this.pools.get(name) as EnhancedConnectionPool<T>;
		}

		const poolConfig: ConnectionPoolConfig = {
			minConnections: 2,
			maxConnections: 10,
			acquireTimeout: 10000,
			idleTimeout: 300000,
			validationTimeout: 5000,
			retryConfig: {
				maxAttempts: 3,
				initialDelay: 1000,
				maxDelay: 5000,
				factor: 2,
			},
			healthCheckInterval: 30000,
			enablePreWarming: false,
			preWarmingDelay: 100,
			poolName: name,
			...config,
		};

		const pool = new EnhancedConnectionPool(factory, poolConfig);
		this.pools.set(name, pool);

		this.logger.info(`Connection pool created: ${name}`);
		return pool;
	}

	/**
	 * Get all pool metrics
	 */
	getAllMetrics(): Record<string, ConnectionMetrics> {
		const metrics: Record<string, ConnectionMetrics> = {};
		for (const [name, pool] of this.pools) {
			metrics[name] = pool.getMetrics();
		}
		return metrics;
	}

	/**
	 * Shutdown all pools
	 */
	async shutdownAll(): Promise<void> {
		const shutdownPromises = Array.from(this.pools.values()).map(pool => pool.shutdown());
		await Promise.allSettled(shutdownPromises);
		this.pools.clear();
		this.logger.info('All connection pools shutdown');
	}
}

// Global pool manager
export const globalPoolManager = new ConnectionPoolManager();