/**
 * Advanced Connection Pool for SQLite with monitoring and optimization
 */

import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logger.js';
import { AppError, ErrorCode, formatDuration, measureExecution } from '../../utils/common.js';

const logger = getLogger('sqlite-pool');

export interface PoolConfig {
  min: number;
  max: number;
  acquireTimeoutMs: number;
  idleTimeoutMs: number;
  reapIntervalMs: number;
  createRetryIntervalMs: number;
  createTimeoutMs: number;
  validateOnBorrow: boolean;
  validateOnReturn: boolean;
  maxUses: number; // Maximum uses before connection refresh
}

export interface PoolStats {
  size: number;
  available: number;
  borrowed: number;
  pending: number;
  min: number;
  max: number;
  created: number;
  destroyed: number;
  createErrors: number;
  acquireCount: number;
  acquireSuccessCount: number;
  acquireFailureCount: number;
  releaseCount: number;
  destroyedCount: number;
  acquireTime: {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
  };
}

interface PooledConnection {
  id: string;
  database: Database.Database;
  createdAt: Date;
  lastUsedAt: Date;
  useCount: number;
  isValid: boolean;
}

interface PendingRequest {
  resolve: (connection: PooledConnection) => void;
  reject: (error: Error) => void;
  requestedAt: Date;
  timeoutId?: NodeJS.Timeout;
}

/**
 * Advanced SQLite connection pool with comprehensive monitoring
 */
export class SQLiteConnectionPool extends EventEmitter {
  private config: PoolConfig;
  private dbPath: string;
  private connections = new Map<string, PooledConnection>();
  private availableConnections: PooledConnection[] = [];
  private borrowedConnections = new Set<string>();
  private pendingRequests: PendingRequest[] = [];
  private reaper?: NodeJS.Timeout;
  private stats = {
    created: 0,
    destroyed: 0,
    createErrors: 0,
    acquireCount: 0,
    acquireSuccessCount: 0,
    acquireFailureCount: 0,
    releaseCount: 0,
    destroyedCount: 0,
    acquireTimes: [] as number[],
  };
  private isDestroyed = false;

  constructor(dbPath: string, config: Partial<PoolConfig> = {}) {
    super();
    this.dbPath = dbPath;
    this.config = {
      min: 2,
      max: 10,
      acquireTimeoutMs: 10000,
      idleTimeoutMs: 300000, // 5 minutes
      reapIntervalMs: 60000, // 1 minute
      createRetryIntervalMs: 1000,
      createTimeoutMs: 5000,
      validateOnBorrow: true,
      validateOnReturn: true,
      maxUses: 1000,
      ...config,
    };

    this.setupReaper();
  }

  /**
   * Initialize the connection pool
   */
  async initialize(): Promise<void> {
    if (this.isDestroyed) {
      throw new AppError('Pool is destroyed', ErrorCode.INVALID_STATE);
    }

    // Ensure database directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Create minimum connections
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.config.min; i++) {
      promises.push(this.createConnection().then(() => {}));
    }

    await Promise.all(promises);
    logger.info(`Connection pool initialized with ${this.availableConnections.length} connections`);
  }

  /**
   * Acquire a connection from the pool
   */
  async acquire(): Promise<PooledConnection> {
    if (this.isDestroyed) {
      throw new AppError('Pool is destroyed', ErrorCode.INVALID_STATE);
    }

    const startTime = Date.now();
    this.stats.acquireCount++;

    try {
      // Try to get an available connection first
      let connection = this.getAvailableConnection();
      if (connection) {
        this.borrowConnection(connection);
        this.recordAcquireTime(Date.now() - startTime);
        this.stats.acquireSuccessCount++;
        return connection;
      }

      // Create new connection if under max limit
      if (this.connections.size < this.config.max) {
        try {
          connection = await this.createConnection();
          this.borrowConnection(connection);
          this.recordAcquireTime(Date.now() - startTime);
          this.stats.acquireSuccessCount++;
          return connection;
        } catch (error) {
          logger.warn('Failed to create new connection, waiting for available', { error });
        }
      }

      // Wait for available connection
      connection = await this.waitForConnection();
      this.borrowConnection(connection);
      this.recordAcquireTime(Date.now() - startTime);
      this.stats.acquireSuccessCount++;
      return connection;

    } catch (error) {
      this.stats.acquireFailureCount++;
      this.recordAcquireTime(Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Release a connection back to the pool
   */
  async release(connection: PooledConnection): Promise<void> {
    if (this.isDestroyed) {
      await this.destroyConnection(connection);
      return;
    }

    this.stats.releaseCount++;

    if (!this.borrowedConnections.has(connection.id)) {
      logger.warn('Attempting to release connection not in borrowed set', { 
        connectionId: connection.id 
      });
      return;
    }

    // Validate connection if configured
    if (this.config.validateOnReturn && !this.validateConnection(connection)) {
      await this.destroyConnection(connection);
      this.borrowedConnections.delete(connection.id);
      await this.ensureMinConnections();
      return;
    }

    // Check if connection should be refreshed due to high usage
    if (connection.useCount >= this.config.maxUses) {
      logger.debug('Refreshing high-usage connection', { 
        connectionId: connection.id,
        useCount: connection.useCount 
      });
      await this.destroyConnection(connection);
      this.borrowedConnections.delete(connection.id);
      await this.ensureMinConnections();
      return;
    }

    // Return to available pool
    this.borrowedConnections.delete(connection.id);
    connection.lastUsedAt = new Date();
    this.availableConnections.push(connection);

    // Process pending requests
    this.processPendingRequests();

    this.emit('release', connection);
  }

  /**
   * Execute query with automatic connection management
   */
  async query<T = unknown[]>(sql: string, params: unknown[] = []): Promise<T> {
    const connection = await this.acquire();
    try {
      const result = await measureExecution(async () => {
        return connection.database.prepare(sql).all(params) as T;
      });
      
      logger.debug('Query executed', { 
        sql: sql.substring(0, 100),
        executionTime: formatDuration(result.ms),
        connectionId: connection.id 
      });
      
      return result.result;
    } finally {
      await this.release(connection);
    }
  }

  /**
   * Execute single row query
   */
  async queryOne<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    const connection = await this.acquire();
    try {
      const result = connection.database.prepare(sql).get(params) as T;
      return result;
    } finally {
      await this.release(connection);
    }
  }

  /**
   * Execute write operation
   */
  async execute(sql: string, params: unknown[] = []): Promise<Database.RunResult> {
    const connection = await this.acquire();
    try {
      const result = connection.database.prepare(sql).run(params);
      return result;
    } finally {
      await this.release(connection);
    }
  }

  /**
   * Execute transaction
   */
  async transaction<T>(fn: (db: Database.Database) => T): Promise<T> {
    const connection = await this.acquire();
    try {
      return connection.database.transaction(() => fn(connection.database))();
    } finally {
      await this.release(connection);
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    const acquireTimes = this.stats.acquireTimes.slice().sort((a, b) => a - b);
    
    return {
      size: this.connections.size,
      available: this.availableConnections.length,
      borrowed: this.borrowedConnections.size,
      pending: this.pendingRequests.length,
      min: this.config.min,
      max: this.config.max,
      created: this.stats.created,
      destroyed: this.stats.destroyed,
      createErrors: this.stats.createErrors,
      acquireCount: this.stats.acquireCount,
      acquireSuccessCount: this.stats.acquireSuccessCount,
      acquireFailureCount: this.stats.acquireFailureCount,
      releaseCount: this.stats.releaseCount,
      destroyedCount: this.stats.destroyedCount,
      acquireTime: this.calculateAcquireTimeStats(acquireTimes),
    };
  }

  /**
   * Health check for the pool
   */
  async healthCheck(): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
    try {
      const stats = this.getStats();
      const connection = await this.acquire();
      
      try {
        // Test basic query
        connection.database.prepare('SELECT 1').get();
        
        const healthy = stats.available > 0 && 
                      stats.createErrors === 0 && 
                      stats.acquireFailureCount < stats.acquireSuccessCount;

        return {
          healthy,
          details: {
            stats,
            testQuerySuccessful: true,
            poolOperational: true,
          },
        };
      } finally {
        await this.release(connection);
      }
    } catch (error) {
      return {
        healthy: false,
        details: {
          error: (error as Error).message,
          stats: this.getStats(),
        },
      };
    }
  }

  /**
   * Destroy the connection pool
   */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    
    this.isDestroyed = true;

    // Clear reaper
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }

    // Reject all pending requests
    for (const request of this.pendingRequests) {
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.reject(new AppError('Pool is being destroyed', ErrorCode.INVALID_STATE));
    }
    this.pendingRequests.length = 0;

    // Close all connections
    const destroyPromises: Promise<void>[] = [];
    for (const connection of this.connections.values()) {
      destroyPromises.push(this.destroyConnection(connection));
    }

    await Promise.all(destroyPromises);
    this.connections.clear();
    this.availableConnections.length = 0;
    this.borrowedConnections.clear();

    this.emit('destroy');
    logger.info('Connection pool destroyed');
  }

  // Private methods

  private async createConnection(): Promise<PooledConnection> {
    try {
      const id = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const database = new Database(this.dbPath, {
        readonly: false,
        fileMustExist: false,
      });

      // Optimize connection
      database.exec('PRAGMA journal_mode = WAL');
      database.exec('PRAGMA synchronous = NORMAL');
      database.exec('PRAGMA cache_size = -8000'); // 8MB per connection
      database.exec('PRAGMA temp_store = MEMORY');
      database.exec('PRAGMA foreign_keys = ON');

      const connection: PooledConnection = {
        id,
        database,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        useCount: 0,
        isValid: true,
      };

      this.connections.set(id, connection);
      this.availableConnections.push(connection);
      this.stats.created++;

      this.emit('create', connection);
      logger.debug('Connection created', { connectionId: id });

      return connection;
    } catch (error) {
      this.stats.createErrors++;
      this.emit('createError', error);
      throw new AppError(
        `Failed to create database connection: ${(error as Error).message}`,
        ErrorCode.DATABASE_ERROR
      );
    }
  }

  private async destroyConnection(connection: PooledConnection): Promise<void> {
    try {
      this.connections.delete(connection.id);
      
      const index = this.availableConnections.indexOf(connection);
      if (index !== -1) {
        this.availableConnections.splice(index, 1);
      }

      connection.database.close();
      connection.isValid = false;
      this.stats.destroyed++;

      this.emit('destroy', connection);
      logger.debug('Connection destroyed', { connectionId: connection.id });
    } catch (error) {
      logger.warn('Error destroying connection', { 
        connectionId: connection.id,
        error: (error as Error).message 
      });
    }
  }

  private getAvailableConnection(): PooledConnection | null {
    while (this.availableConnections.length > 0) {
      const connection = this.availableConnections.shift()!;
      
      if (this.config.validateOnBorrow && !this.validateConnection(connection)) {
        this.destroyConnection(connection);
        continue;
      }
      
      return connection;
    }
    return null;
  }

  private borrowConnection(connection: PooledConnection): void {
    connection.lastUsedAt = new Date();
    connection.useCount++;
    this.borrowedConnections.add(connection.id);
  }

  private validateConnection(connection: PooledConnection): boolean {
    try {
      if (!connection.isValid) return false;
      
      // Test with a simple query
      connection.database.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  private async waitForConnection(): Promise<PooledConnection> {
    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        resolve,
        reject,
        requestedAt: new Date(),
      };

      // Set timeout
      request.timeoutId = setTimeout(() => {
        const index = this.pendingRequests.indexOf(request);
        if (index !== -1) {
          this.pendingRequests.splice(index, 1);
        }
        reject(new AppError(
          `Connection acquire timeout after ${this.config.acquireTimeoutMs}ms`,
          ErrorCode.TIMEOUT
        ));
      }, this.config.acquireTimeoutMs);

      this.pendingRequests.push(request);
    });
  }

  private processPendingRequests(): void {
    while (this.pendingRequests.length > 0 && this.availableConnections.length > 0) {
      const request = this.pendingRequests.shift()!;
      const connection = this.getAvailableConnection();
      
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      
      if (connection) {
        this.borrowConnection(connection);
        request.resolve(connection);
      }
    }
  }

  private async ensureMinConnections(): Promise<void> {
    const needed = this.config.min - this.availableConnections.length;
    if (needed > 0) {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < needed; i++) {
        promises.push(this.createConnection().then(() => {}));
      }
      await Promise.allSettled(promises);
    }
  }

  private setupReaper(): void {
    this.reaper = setInterval(async () => {
      await this.reapIdleConnections();
    }, this.config.reapIntervalMs);
  }

  private async reapIdleConnections(): Promise<void> {
    const now = Date.now();
    const connectionsToReap: PooledConnection[] = [];

    for (let i = this.availableConnections.length - 1; i >= 0; i--) {
      const connection = this.availableConnections[i];
      const idleTime = now - connection.lastUsedAt.getTime();
      
      if (idleTime > this.config.idleTimeoutMs && this.availableConnections.length > this.config.min) {
        connectionsToReap.push(connection);
        this.availableConnections.splice(i, 1);
      }
    }

    for (const connection of connectionsToReap) {
      await this.destroyConnection(connection);
    }

    if (connectionsToReap.length > 0) {
      logger.debug(`Reaped ${connectionsToReap.length} idle connections`);
    }
  }

  private recordAcquireTime(time: number): void {
    this.stats.acquireTimes.push(time);
    // Keep only last 1000 times to prevent memory bloat
    if (this.stats.acquireTimes.length > 1000) {
      this.stats.acquireTimes.splice(0, this.stats.acquireTimes.length - 1000);
    }
  }

  private calculateAcquireTimeStats(times: number[]): PoolStats['acquireTime'] {
    if (times.length === 0) {
      return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    }

    const sum = times.reduce((a, b) => a + b, 0);
    const mean = sum / times.length;
    
    return {
      min: times[0] || 0,
      max: times[times.length - 1] || 0,
      mean,
      p50: times[Math.floor(times.length * 0.5)] || 0,
      p95: times[Math.floor(times.length * 0.95)] || 0,
      p99: times[Math.floor(times.length * 0.99)] || 0,
    };
  }
}