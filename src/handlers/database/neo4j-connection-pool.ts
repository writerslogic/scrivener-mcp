/**
 * Neo4j Connection Pool with Health Monitoring and Circuit Breaker
 */

import type { Driver, Session, SessionMode, ManagedTransaction, QueryResult } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { EventEmitter } from 'events';
import { getLogger } from '../../core/logger.js';
import { AppError, ErrorCode, formatDuration, measureExecution } from '../../utils/common.js';
import type { QueryParameters } from '../../types/database.js';

const logger = getLogger('neo4j-pool');

export interface Neo4jPoolConfig {
  maxConnectionPoolSize: number;
  connectionAcquisitionTimeout: number;
  connectionTimeout: number;
  maxTransactionRetryTime: number;
  healthCheckInterval: number;
  circuitBreakerThreshold: number;
  circuitBreakerTimeout: number;
  retryDelayMs: number;
  maxRetries: number;
}

export interface PoolHealth {
  isHealthy: boolean;
  connectionCount: number;
  availableConnections: number;
  busyConnections: number;
  circuitBreakerState: 'closed' | 'open' | 'half-open';
  lastHealthCheck: Date;
  errorRate: number;
  averageResponseTime: number;
}

export interface ConnectionStats {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  averageExecutionTime: number;
  totalExecutionTime: number;
  lastActivity: Date;
  errors: Array<{ error: string; timestamp: Date }>;
}

interface CircuitBreaker {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailureTime: Date | null;
  nextAttemptTime: Date | null;
}

/**
 * Enhanced Neo4j connection pool with monitoring and resilience
 */
export class Neo4jConnectionPool extends EventEmitter {
  private driver: Driver | null = null;
  private config: Neo4jPoolConfig;
  private uri: string;
  private auth: { username: string; password: string };
  private database: string;
  private healthTimer?: NodeJS.Timeout;
  private circuitBreaker: CircuitBreaker;
  private stats: ConnectionStats;
  private isInitialized = false;

  constructor(
    uri: string,
    username: string,
    password: string,
    database = 'scrivener',
    config: Partial<Neo4jPoolConfig> = {}
  ) {
    super();
    
    this.uri = uri;
    this.auth = { username, password };
    this.database = database;
    
    this.config = {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 10000,
      connectionTimeout: 30000,
      maxTransactionRetryTime: 30000,
      healthCheckInterval: 30000,
      circuitBreakerThreshold: 5,
      circuitBreakerTimeout: 60000,
      retryDelayMs: 1000,
      maxRetries: 3,
      ...config,
    };

    this.circuitBreaker = {
      state: 'closed',
      failureCount: 0,
      lastFailureTime: null,
      nextAttemptTime: null,
    };

    this.stats = {
      totalQueries: 0,
      successfulQueries: 0,
      failedQueries: 0,
      averageExecutionTime: 0,
      totalExecutionTime: 0,
      lastActivity: new Date(),
      errors: [],
    };
  }

  /**
   * Initialize the connection pool
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      this.driver = neo4j.driver(
        this.uri,
        neo4j.auth.basic(this.auth.username, this.auth.password),
        {
          maxConnectionPoolSize: this.config.maxConnectionPoolSize,
          connectionAcquisitionTimeout: this.config.connectionAcquisitionTimeout,
          connectionTimeout: this.config.connectionTimeout,
          maxTransactionRetryTime: this.config.maxTransactionRetryTime,
          logging: {
            level: 'warn',
            logger: (level, message) => {
              logger.debug(`Neo4j Driver [${level}]: ${message}`);
            },
          },
        }
      );

      // Verify connectivity
      await this.driver.verifyConnectivity({ database: this.database });
      
      this.isInitialized = true;
      this.startHealthChecks();
      
      logger.info('Neo4j connection pool initialized', {
        uri: this.uri,
        database: this.database,
        maxPoolSize: this.config.maxConnectionPoolSize,
      });

      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize Neo4j connection pool', { error });
      throw new AppError(
        `Neo4j connection failed: ${(error as Error).message}`,
        ErrorCode.DATABASE_ERROR
      );
    }
  }

  /**
   * Execute a query with automatic retry and circuit breaker protection
   */
  async query(
    cypher: string,
    parameters: QueryParameters = {},
    mode: SessionMode = 'READ'
  ): Promise<QueryResult> {
    if (!this.isReady()) {
      throw new AppError(
        'Connection pool not ready or circuit breaker is open',
        ErrorCode.INVALID_STATE
      );
    }

    const startTime = Date.now();
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < this.config.maxRetries) {
      attempt++;
      
      const session = this.createSession(mode);
      try {
        const result = await measureExecution(async () => {
          return await session.run(cypher, parameters);
        });

        // Update statistics
        this.updateStats(true, result.ms);
        this.resetCircuitBreaker();

        logger.debug('Query executed successfully', {
          cypher: cypher.substring(0, 100),
          executionTime: formatDuration(result.ms),
          attempt,
        });

        return result.result;

      } catch (error) {
        lastError = error as Error;
        this.updateStats(false, Date.now() - startTime);
        
        if (this.isRetryableError(error as Error) && attempt < this.config.maxRetries) {
          logger.warn(`Query failed, retrying (${attempt}/${this.config.maxRetries})`, {
            error: (error as Error).message,
            cypher: cypher.substring(0, 50),
          });
          
          await this.delay(this.config.retryDelayMs * attempt);
          continue;
        }
        
        this.recordFailure();
        throw error;
        
      } finally {
        await session.close();
      }
    }

    this.recordFailure();
    throw lastError || new AppError('Query failed after retries', ErrorCode.DATABASE_ERROR);
  }

  /**
   * Execute a read transaction with retry logic
   */
  async readTransaction<T>(
    work: (tx: ManagedTransaction) => Promise<T>,
    retryOptions?: { maxRetries?: number; retryDelayMs?: number }
  ): Promise<T> {
    return this.executeTransaction('READ', work, retryOptions);
  }

  /**
   * Execute a write transaction with retry logic
   */
  async writeTransaction<T>(
    work: (tx: ManagedTransaction) => Promise<T>,
    retryOptions?: { maxRetries?: number; retryDelayMs?: number }
  ): Promise<T> {
    return this.executeTransaction('WRITE', work, retryOptions);
  }

  /**
   * Get pool health status
   */
  async getHealth(): Promise<PoolHealth> {
    const isHealthy = this.isReady() && await this.performHealthCheck();
    
    return {
      isHealthy,
      connectionCount: this.getConnectionCount(),
      availableConnections: this.getAvailableConnections(),
      busyConnections: this.getBusyConnections(),
      circuitBreakerState: this.circuitBreaker.state,
      lastHealthCheck: new Date(),
      errorRate: this.calculateErrorRate(),
      averageResponseTime: this.stats.averageExecutionTime,
    };
  }

  /**
   * Get connection statistics
   */
  getStats(): ConnectionStats {
    return {
      ...this.stats,
      errors: [...this.stats.errors], // Return a copy
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalQueries: 0,
      successfulQueries: 0,
      failedQueries: 0,
      averageExecutionTime: 0,
      totalExecutionTime: 0,
      lastActivity: new Date(),
      errors: [],
    };
    
    logger.info('Connection pool statistics reset');
  }

  /**
   * Check if the pool is ready for queries
   */
  isReady(): boolean {
    return this.isInitialized && 
           this.driver !== null && 
           this.circuitBreaker.state !== 'open';
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }

    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }

    this.isInitialized = false;
    this.emit('closed');
    
    logger.info('Neo4j connection pool closed');
  }

  // Private methods

  private createSession(mode: SessionMode = 'READ'): Session {
    if (!this.driver) {
      throw new AppError('Driver not initialized', ErrorCode.INVALID_STATE);
    }

    return this.driver.session({
      database: this.database,
      defaultAccessMode: mode === 'WRITE' ? neo4j.session.WRITE : neo4j.session.READ,
    });
  }

  private async executeTransaction<T>(
    mode: 'READ' | 'WRITE',
    work: (tx: ManagedTransaction) => Promise<T>,
    retryOptions?: { maxRetries?: number; retryDelayMs?: number }
  ): Promise<T> {
    if (!this.isReady()) {
      throw new AppError(
        'Connection pool not ready or circuit breaker is open',
        ErrorCode.INVALID_STATE
      );
    }

    const maxRetries = retryOptions?.maxRetries ?? this.config.maxRetries;
    const retryDelayMs = retryOptions?.retryDelayMs ?? this.config.retryDelayMs;
    
    const session = this.createSession(mode);
    let attempt = 0;
    let lastError: Error | null = null;

    try {
      while (attempt < maxRetries) {
        attempt++;
        
        try {
          const startTime = Date.now();
          
          const result = mode === 'READ'
            ? await session.executeRead(work)
            : await session.executeWrite(work);
            
          const executionTime = Date.now() - startTime;
          this.updateStats(true, executionTime);
          this.resetCircuitBreaker();
          
          return result;
          
        } catch (error) {
          lastError = error as Error;
          
          if (this.isRetryableError(error as Error) && attempt < maxRetries) {
            logger.warn(`Transaction failed, retrying (${attempt}/${maxRetries})`, {
              error: (error as Error).message,
              mode,
            });
            
            await this.delay(retryDelayMs * attempt);
            continue;
          }
          
          throw error;
        }
      }
      
      throw lastError || new AppError('Transaction failed after retries', ErrorCode.DATABASE_ERROR);
      
    } catch (error) {
      this.updateStats(false, 0);
      this.recordFailure();
      throw error;
      
    } finally {
      await session.close();
    }
  }

  private updateStats(success: boolean, executionTime: number): void {
    this.stats.totalQueries++;
    this.stats.lastActivity = new Date();
    
    if (success) {
      this.stats.successfulQueries++;
      this.stats.totalExecutionTime += executionTime;
      this.stats.averageExecutionTime = 
        this.stats.totalExecutionTime / this.stats.successfulQueries;
    } else {
      this.stats.failedQueries++;
    }
  }

  private recordFailure(): void {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = new Date();
    
    // Record error for statistics
    this.stats.errors.push({
      error: `Failure recorded at ${new Date().toISOString()}`,
      timestamp: new Date(),
    });
    
    // Keep only last 100 errors
    if (this.stats.errors.length > 100) {
      this.stats.errors.splice(0, this.stats.errors.length - 100);
    }

    // Check if circuit breaker should open
    if (this.circuitBreaker.failureCount >= this.config.circuitBreakerThreshold) {
      this.openCircuitBreaker();
    }
  }

  private openCircuitBreaker(): void {
    this.circuitBreaker.state = 'open';
    this.circuitBreaker.nextAttemptTime = new Date(
      Date.now() + this.config.circuitBreakerTimeout
    );
    
    logger.warn('Circuit breaker opened due to repeated failures', {
      failureCount: this.circuitBreaker.failureCount,
      nextAttemptTime: this.circuitBreaker.nextAttemptTime,
    });
    
    this.emit('circuitBreakerOpen');
  }

  private resetCircuitBreaker(): void {
    if (this.circuitBreaker.state !== 'closed') {
      this.circuitBreaker.state = 'closed';
      this.circuitBreaker.failureCount = 0;
      this.circuitBreaker.lastFailureTime = null;
      this.circuitBreaker.nextAttemptTime = null;
      
      logger.info('Circuit breaker reset to closed state');
      this.emit('circuitBreakerReset');
    }
  }

  private async checkCircuitBreaker(): Promise<void> {
    if (this.circuitBreaker.state === 'open') {
      const now = new Date();
      if (this.circuitBreaker.nextAttemptTime && now >= this.circuitBreaker.nextAttemptTime) {
        this.circuitBreaker.state = 'half-open';
        logger.info('Circuit breaker moved to half-open state');
        this.emit('circuitBreakerHalfOpen');
      }
    }
  }

  private isRetryableError(error: Error): boolean {
    const retryableCodes = [
      'ServiceUnavailable',
      'TransientError',
      'DatabaseUnavailable',
      'ConstraintValidationFailed', // Sometimes transient
    ];
    
    return retryableCodes.some(code => error.message.includes(code));
  }

  private calculateErrorRate(): number {
    if (this.stats.totalQueries === 0) return 0;
    return this.stats.failedQueries / this.stats.totalQueries;
  }

  private getConnectionCount(): number {
    // This would require access to driver internals
    // Return estimated value based on pool configuration
    return Math.min(this.config.maxConnectionPoolSize, 10);
  }

  private getAvailableConnections(): number {
    // Estimate based on activity
    return Math.max(0, this.getConnectionCount() - this.getBusyConnections());
  }

  private getBusyConnections(): number {
    // Estimate based on recent activity
    const recentActivity = Date.now() - this.stats.lastActivity.getTime();
    return recentActivity < 1000 ? Math.ceil(this.getConnectionCount() * 0.3) : 0;
  }

  private async performHealthCheck(): Promise<boolean> {
    if (!this.driver) return false;
    
    try {
      await this.driver.verifyConnectivity({ database: this.database });
      return true;
    } catch (error) {
      logger.warn('Health check failed', { error: (error as Error).message });
      return false;
    }
  }

  private startHealthChecks(): void {
    this.healthTimer = setInterval(async () => {
      await this.checkCircuitBreaker();
      
      if (this.circuitBreaker.state !== 'open') {
        const isHealthy = await this.performHealthCheck();
        this.emit('healthCheck', { healthy: isHealthy });
        
        if (!isHealthy) {
          this.recordFailure();
        }
      }
    }, this.config.healthCheckInterval);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}