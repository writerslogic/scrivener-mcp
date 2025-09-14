/**
 * Advanced Cache Strategies and Patterns
 * Implements sophisticated caching patterns for optimal performance
 */

import { EventEmitter } from 'events';
import { getLogger } from '../../core/logger.js';
import { formatDuration, measureExecution } from '../../utils/common.js';
import type { RedisClusterManager } from './redis-cluster-manager.js';

const logger = getLogger('cache-strategies');

export interface CacheStrategy {
  name: string;
  description: string;
  execute<T>(key: string, fetchFn: () => Promise<T>, options?: CacheOptions): Promise<T>;
}

export interface CacheOptions {
  ttl?: number;
  tags?: string[];
  refreshThreshold?: number;
  lockTimeout?: number;
  fallbackValue?: unknown;
  metrics?: boolean;
}

export interface CacheMetrics {
  strategy: string;
  hits: number;
  misses: number;
  refreshes: number;
  lockWaits: number;
  averageLatency: number;
  errorRate: number;
}

export interface RefreshAheadConfig {
  refreshThreshold: number; // Percentage of TTL remaining when refresh is triggered
  refreshProbability: number; // Probability of refresh (0-1)
  maxRefreshConcurrency: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringPeriod: number;
}

/**
 * Cache-Aside Strategy (Lazy Loading)
 */
export class CacheAsideStrategy implements CacheStrategy {
  name = 'cache-aside';
  description = 'Lazy loading with cache-aside pattern';

  constructor(private cacheManager: RedisClusterManager) {}

  async execute<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    // Try to get from cache first
    const cached = await this.cacheManager.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Cache miss - fetch from source
    const value = await fetchFn();
    
    // Store in cache for future requests
    await this.cacheManager.set(key, value, {
      ttl: options.ttl,
      tags: options.tags,
    });

    return value;
  }
}

/**
 * Write-Through Strategy
 */
export class WriteThroughStrategy implements CacheStrategy {
  name = 'write-through';
  description = 'Write to cache and data source simultaneously';

  constructor(
    private cacheManager: RedisClusterManager,
    private writeFn: <T>(key: string, value: T) => Promise<void>
  ) {}

  async execute<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    const cached = await this.cacheManager.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await fetchFn();
    
    // Write to both cache and data source
    await Promise.all([
      this.cacheManager.set(key, value, options),
      this.writeFn(key, value),
    ]);

    return value;
  }
}

/**
 * Refresh-Ahead Strategy
 */
export class RefreshAheadStrategy implements CacheStrategy {
  name = 'refresh-ahead';
  description = 'Proactively refresh cache before expiration';

  private refreshInProgress = new Set<string>();
  private config: RefreshAheadConfig;

  constructor(
    private cacheManager: RedisClusterManager,
    config: Partial<RefreshAheadConfig> = {}
  ) {
    this.config = {
      refreshThreshold: 0.8, // Refresh when 80% of TTL has passed
      refreshProbability: 0.1, // 10% chance of triggering refresh
      maxRefreshConcurrency: 5,
      ...config,
    };
  }

  async execute<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    const cached = await this.cacheManager.get<T>(key);
    
    if (cached !== null) {
      // Check if we should refresh proactively
      if (this.shouldRefresh(key, options.refreshThreshold)) {
        this.scheduleRefresh(key, fetchFn, options);
      }
      return cached;
    }

    // Cache miss - fetch immediately
    const value = await fetchFn();
    await this.cacheManager.set(key, value, options);
    
    return value;
  }

  private shouldRefresh(key: string, customThreshold?: number): boolean {
    const threshold = customThreshold || this.config.refreshThreshold;
    
    // Simple probability-based decision
    // In production, you'd check actual TTL remaining
    return (
      Math.random() < this.config.refreshProbability &&
      this.refreshInProgress.size < this.config.maxRefreshConcurrency &&
      !this.refreshInProgress.has(key)
    );
  }

  private scheduleRefresh<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions
  ): void {
    if (this.refreshInProgress.has(key)) return;
    
    this.refreshInProgress.add(key);

    // Background refresh
    setImmediate(async () => {
      try {
        const value = await fetchFn();
        await this.cacheManager.set(key, value, options);
        
        logger.debug('Proactive cache refresh completed', { key });
      } catch (error) {
        logger.warn('Proactive cache refresh failed', { key, error });
      } finally {
        this.refreshInProgress.delete(key);
      }
    });
  }
}

/**
 * Read-Through Strategy with Circuit Breaker
 */
export class ReadThroughStrategy implements CacheStrategy {
  name = 'read-through';
  description = 'Read-through with circuit breaker protection';

  private circuitBreaker: {
    state: 'closed' | 'open' | 'half-open';
    failures: number;
    lastFailureTime: Date | null;
    nextAttemptTime: Date | null;
  };

  constructor(
    private cacheManager: RedisClusterManager,
    private config: CircuitBreakerConfig = {
      failureThreshold: 5,
      recoveryTimeout: 60000,
      monitoringPeriod: 300000,
    }
  ) {
    this.circuitBreaker = {
      state: 'closed',
      failures: 0,
      lastFailureTime: null,
      nextAttemptTime: null,
    };
  }

  async execute<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    const cached = await this.cacheManager.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Check circuit breaker state
    if (this.circuitBreaker.state === 'open') {
      if (this.shouldAttemptRecovery()) {
        this.circuitBreaker.state = 'half-open';
      } else {
        if (options.fallbackValue !== undefined) {
          return options.fallbackValue as T;
        }
        throw new Error('Circuit breaker is open and no fallback value provided');
      }
    }

    try {
      const value = await fetchFn();
      await this.cacheManager.set(key, value, options);
      
      // Reset circuit breaker on success
      if (this.circuitBreaker.state === 'half-open') {
        this.circuitBreaker.state = 'closed';
        this.circuitBreaker.failures = 0;
      }

      return value;

    } catch (error) {
      this.recordFailure();
      
      if (options.fallbackValue !== undefined) {
        logger.warn('Using fallback value due to fetch error', { key, error });
        return options.fallbackValue as T;
      }
      
      throw error;
    }
  }

  private shouldAttemptRecovery(): boolean {
    const now = new Date();
    return this.circuitBreaker.nextAttemptTime !== null && 
           now >= this.circuitBreaker.nextAttemptTime;
  }

  private recordFailure(): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailureTime = new Date();

    if (this.circuitBreaker.failures >= this.config.failureThreshold) {
      this.circuitBreaker.state = 'open';
      this.circuitBreaker.nextAttemptTime = new Date(
        Date.now() + this.config.recoveryTimeout
      );
      
      logger.warn('Circuit breaker opened', {
        failures: this.circuitBreaker.failures,
        nextAttemptTime: this.circuitBreaker.nextAttemptTime,
      });
    }
  }
}

/**
 * Multi-Level Cache Strategy
 */
export class MultiLevelStrategy implements CacheStrategy {
  name = 'multi-level';
  description = 'Multi-level caching with L1 (memory) and L2 (Redis)';

  private l1Cache = new Map<string, { value: unknown; expires: number }>();
  private l1MaxSize = 1000;
  private l1TTL = 60000; // 1 minute

  constructor(private cacheManager: RedisClusterManager) {}

  async execute<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    // Check L1 cache first (fastest)
    const l1Entry = this.l1Cache.get(key);
    if (l1Entry && l1Entry.expires > Date.now()) {
      return l1Entry.value as T;
    }

    // Check L2 cache (Redis)
    const l2Value = await this.cacheManager.get<T>(key);
    if (l2Value !== null) {
      // Store in L1 for faster future access
      this.setL1(key, l2Value);
      return l2Value;
    }

    // Cache miss - fetch from source
    const value = await fetchFn();
    
    // Store in both levels
    await Promise.all([
      this.setL1(key, value),
      this.cacheManager.set(key, value, options),
    ]);

    return value;
  }

  private setL1<T>(key: string, value: T): void {
    // Implement LRU eviction if cache is full
    if (this.l1Cache.size >= this.l1MaxSize) {
      const oldestKey = this.l1Cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.l1Cache.delete(oldestKey);
      }
    }

    this.l1Cache.set(key, {
      value,
      expires: Date.now() + this.l1TTL,
    });
  }

  clearL1(): void {
    this.l1Cache.clear();
  }
}

/**
 * Write-Behind (Write-Back) Strategy
 */
export class WriteBehindStrategy implements CacheStrategy {
  name = 'write-behind';
  description = 'Asynchronous write-back to data source';

  private writeQueue = new Map<string, { value: unknown; timestamp: number }>();
  private flushInterval = 30000; // 30 seconds
  private flushTimer?: NodeJS.Timeout;

  constructor(
    private cacheManager: RedisClusterManager,
    private persistFn: <T>(entries: Array<{ key: string; value: T }>) => Promise<void>
  ) {
    this.startFlushTimer();
  }

  async execute<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    const cached = await this.cacheManager.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await fetchFn();
    
    // Write to cache immediately
    await this.cacheManager.set(key, value, options);
    
    // Queue for background persistence
    this.writeQueue.set(key, { value, timestamp: Date.now() });

    return value;
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(async () => {
      await this.flushWrites();
    }, this.flushInterval);
  }

  private async flushWrites(): Promise<void> {
    if (this.writeQueue.size === 0) return;

    const entries = Array.from(this.writeQueue.entries()).map(([key, data]) => ({
      key,
      value: data.value,
    }));

    this.writeQueue.clear();

    try {
      await this.persistFn(entries);
      logger.debug('Flushed writes to data source', { count: entries.length });
    } catch (error) {
      logger.error('Failed to flush writes', { count: entries.length, error });
      
      // Re-queue failed writes
      for (const entry of entries) {
        this.writeQueue.set(entry.key, { 
          value: entry.value, 
          timestamp: Date.now() 
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    // Final flush
    await this.flushWrites();
  }
}

/**
 * Intelligent Cache Manager with Strategy Selection
 */
export class IntelligentCacheManager extends EventEmitter {
  private strategies = new Map<string, CacheStrategy>();
  private metrics = new Map<string, CacheMetrics>();
  private defaultStrategy = 'cache-aside';

  constructor(private cacheManager: RedisClusterManager) {
    super();
    this.initializeStrategies();
  }

  private initializeStrategies(): void {
    // Register available strategies
    this.addStrategy(new CacheAsideStrategy(this.cacheManager));
    this.addStrategy(new RefreshAheadStrategy(this.cacheManager));
    this.addStrategy(new ReadThroughStrategy(this.cacheManager));
    this.addStrategy(new MultiLevelStrategy(this.cacheManager));
  }

  addStrategy(strategy: CacheStrategy): void {
    this.strategies.set(strategy.name, strategy);
    this.metrics.set(strategy.name, {
      strategy: strategy.name,
      hits: 0,
      misses: 0,
      refreshes: 0,
      lockWaits: 0,
      averageLatency: 0,
      errorRate: 0,
    });
  }

  async get<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions & { strategy?: string } = {}
  ): Promise<T> {
    const strategyName = options.strategy || this.defaultStrategy;
    const strategy = this.strategies.get(strategyName);
    
    if (!strategy) {
      throw new Error(`Unknown cache strategy: ${strategyName}`);
    }

    const startTime = Date.now();
    
    try {
      const result = await strategy.execute(key, fetchFn, options);
      
      // Update metrics
      const latency = Date.now() - startTime;
      this.updateMetrics(strategyName, true, latency);
      
      return result;
      
    } catch (error) {
      const latency = Date.now() - startTime;
      this.updateMetrics(strategyName, false, latency);
      throw error;
    }
  }

  /**
   * Automatically select the best strategy based on access patterns
   */
  async intelligentGet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    const pattern = await this.analyzeAccessPattern(key);
    const strategy = this.selectStrategyForPattern(pattern);
    
    return this.get(key, fetchFn, { ...options, strategy });
  }

  getMetrics(strategy?: string): CacheMetrics | Map<string, CacheMetrics> {
    if (strategy) {
      return this.metrics.get(strategy) || this.createEmptyMetrics(strategy);
    }
    return new Map(this.metrics);
  }

  generatePerformanceReport(): string {
    let report = '# Cache Performance Report\n\n';
    
    for (const [strategyName, metrics] of this.metrics) {
      const hitRate = (metrics.hits + metrics.misses) > 0 
        ? (metrics.hits / (metrics.hits + metrics.misses) * 100).toFixed(2)
        : '0.00';
        
      report += `## ${strategyName} Strategy\n`;
      report += `- **Hit Rate**: ${hitRate}%\n`;
      report += `- **Average Latency**: ${metrics.averageLatency.toFixed(2)}ms\n`;
      report += `- **Error Rate**: ${(metrics.errorRate * 100).toFixed(2)}%\n`;
      report += `- **Total Requests**: ${metrics.hits + metrics.misses}\n\n`;
    }
    
    return report;
  }

  // Private helper methods

  private updateMetrics(strategyName: string, success: boolean, latency: number): void {
    const metrics = this.metrics.get(strategyName);
    if (!metrics) return;

    if (success) {
      metrics.hits++;
    } else {
      metrics.misses++;
    }

    // Update average latency (exponential moving average)
    metrics.averageLatency = metrics.averageLatency * 0.9 + latency * 0.1;
    
    // Update error rate (last 1000 requests)
    const totalRequests = metrics.hits + metrics.misses;
    if (totalRequests > 0) {
      metrics.errorRate = metrics.misses / totalRequests;
    }
  }

  private async analyzeAccessPattern(key: string): Promise<{
    frequency: 'high' | 'medium' | 'low';
    predictability: 'predictable' | 'random';
    dataSize: 'small' | 'large';
    volatility: 'stable' | 'volatile';
  }> {
    // Simplified pattern analysis - in production, you'd track actual metrics
    return {
      frequency: 'medium',
      predictability: 'random',
      dataSize: 'small',
      volatility: 'stable',
    };
  }

  private selectStrategyForPattern(pattern: {
    frequency: string;
    predictability: string;
    dataSize: string;
    volatility: string;
  }): string {
    // Intelligent strategy selection based on access patterns
    if (pattern.frequency === 'high' && pattern.predictability === 'predictable') {
      return 'refresh-ahead';
    }
    
    if (pattern.dataSize === 'small' && pattern.frequency === 'high') {
      return 'multi-level';
    }
    
    if (pattern.volatility === 'volatile') {
      return 'read-through';
    }
    
    return 'cache-aside'; // Default fallback
  }

  private createEmptyMetrics(strategy: string): CacheMetrics {
    return {
      strategy,
      hits: 0,
      misses: 0,
      refreshes: 0,
      lockWaits: 0,
      averageLatency: 0,
      errorRate: 0,
    };
  }
}