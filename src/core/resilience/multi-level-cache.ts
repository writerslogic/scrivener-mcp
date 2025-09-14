/**
 * Multi-Level Caching System
 * Implements L1 (memory) and L2 (Redis) caching with intelligent cache warming and invalidation
 */

import { createHash } from 'crypto';
import { LRUCache } from '../cache.js';
import { getLogger } from '../logger.js';
import { AppError, ErrorCode, sleep } from '../../utils/common.js';
import { CircuitBreaker, CircuitBreakerFactory } from './circuit-breaker.js';
import { RetryStrategies } from './retry-strategies.js';

export interface CacheConfig {
	/** Enable L1 (memory) cache */
	enableL1: boolean;
	/** Enable L2 (Redis) cache */
	enableL2: boolean;
	/** L1 cache configuration */
	l1Config?: {
		ttl?: number;
		maxSize?: number;
		maxEntries?: number;
	};
	/** L2 cache configuration */
	l2Config?: {
		ttl?: number;
		host?: string;
		port?: number;
		password?: string;
		db?: number;
		keyPrefix?: string;
		compression?: boolean;
		maxRetries?: number;
	};
	/** Cache warming configuration */
	warmingConfig?: {
		enabled: boolean;
		batchSize: number;
		concurrency: number;
		warmupDelay: number;
	};
	/** Cache name for metrics */
	name?: string;
}

export interface CacheMetrics {
	l1Hits: number;
	l1Misses: number;
	l1Sets: number;
	l1Deletes: number;
	l1Size: number;
	l2Hits: number;
	l2Misses: number;
	l2Sets: number;
	l2Deletes: number;
	l2Errors: number;
	totalRequests: number;
	hitRatio: number;
	l1HitRatio: number;
	l2HitRatio: number;
	averageGetTime: number;
	averageSetTime: number;
}

export interface CacheEntry<T> {
	data: T;
	timestamp: number;
	ttl: number;
	compressed?: boolean;
	metadata?: Record<string, unknown>;
}

export class MultiLevelCache<T = unknown> {
	private l1Cache?: LRUCache<CacheEntry<T>>;
	private l2Client?: any; // Redis client
	private metrics: CacheMetrics = {
		l1Hits: 0,
		l1Misses: 0,
		l1Sets: 0,
		l1Deletes: 0,
		l1Size: 0,
		l2Hits: 0,
		l2Misses: 0,
		l2Sets: 0,
		l2Deletes: 0,
		l2Errors: 0,
		totalRequests: 0,
		hitRatio: 0,
		l1HitRatio: 0,
		l2HitRatio: 0,
		averageGetTime: 0,
		averageSetTime: 0,
	};
	
	private readonly logger = getLogger('multi-level-cache');
	private readonly circuitBreaker: CircuitBreaker;
	private readonly retryStrategy = RetryStrategies.createFast();
	private getTimes: number[] = [];
	private setTimes: number[] = [];

	constructor(private readonly config: CacheConfig) {
		this.circuitBreaker = CircuitBreakerFactory.getCircuitBreaker(
			`cache-${config.name || 'default'}`,
			{
				failureThreshold: 3,
				successThreshold: 2,
				timeWindow: 30000,
				openTimeout: 10000,
			}
		);

		this.initializeCaches();
		this.logger.info(`Multi-level cache initialized: ${config.name || 'unnamed'}`, {
			l1Enabled: config.enableL1,
			l2Enabled: config.enableL2,
		});
	}

	/**
	 * Get value from cache (L1 -> L2 -> miss)
	 */
	async get(key: string): Promise<T | null> {
		const startTime = Date.now();
		this.metrics.totalRequests++;

		try {
			// Try L1 cache first
			if (this.config.enableL1 && this.l1Cache) {
				const l1Result = this.l1Cache.get(this.normalizeKey(key));
				if (l1Result && this.isEntryValid(l1Result)) {
					this.metrics.l1Hits++;
					this.updateGetTime(Date.now() - startTime);
					this.logger.debug(`L1 cache hit: ${key}`);
					return l1Result.data;
				} else if (l1Result) {
					// Entry expired, remove from L1
					this.l1Cache.delete(this.normalizeKey(key));
				}
			}

			this.metrics.l1Misses++;

			// Try L2 cache
			if (this.config.enableL2 && this.l2Client) {
				const l2Result = await this.getFromL2(key);
				if (l2Result) {
					this.metrics.l2Hits++;
					
					// Populate L1 cache with L2 result
					if (this.config.enableL1 && this.l1Cache) {
						this.l1Cache.set(this.normalizeKey(key), l2Result);
						this.metrics.l1Sets++;
					}
					
					this.updateGetTime(Date.now() - startTime);
					this.logger.debug(`L2 cache hit: ${key}`);
					return l2Result.data;
				}
			}

			this.metrics.l2Misses++;
			this.updateGetTime(Date.now() - startTime);
			return null;

		} catch (error) {
			this.logger.error(`Cache get error for key ${key}:`, { error: (error as Error).message });
			this.updateGetTime(Date.now() - startTime);
			return null;
		}
	}

	/**
	 * Set value in cache (both L1 and L2)
	 */
	async set(key: string, value: T, ttl?: number, metadata?: Record<string, unknown>): Promise<void> {
		const startTime = Date.now();
		const entry: CacheEntry<T> = {
			data: value,
			timestamp: Date.now(),
			ttl: ttl || 300000, // 5 minutes default
			metadata,
		};

		try {
			// Set in L1 cache
			if (this.config.enableL1 && this.l1Cache) {
				this.l1Cache.set(this.normalizeKey(key), entry, entry.ttl);
				this.metrics.l1Sets++;
			}

			// Set in L2 cache
			if (this.config.enableL2) {
				await this.setInL2(key, entry);
				this.metrics.l2Sets++;
			}

			this.updateSetTime(Date.now() - startTime);
			this.logger.debug(`Cache set: ${key}`, { ttl: entry.ttl, hasMetadata: !!metadata });

		} catch (error) {
			this.logger.error(`Cache set error for key ${key}:`, { error: (error as Error).message });
			this.updateSetTime(Date.now() - startTime);
			throw error;
		}
	}

	/**
	 * Delete from both cache levels
	 */
	async delete(key: string): Promise<boolean> {
		let deleted = false;

		try {
			// Delete from L1
			if (this.config.enableL1 && this.l1Cache) {
				if (this.l1Cache.delete(this.normalizeKey(key))) {
					deleted = true;
					this.metrics.l1Deletes++;
				}
			}

			// Delete from L2
			if (this.config.enableL2 && this.l2Client) {
				if (await this.deleteFromL2(key)) {
					deleted = true;
					this.metrics.l2Deletes++;
				}
			}

			if (deleted) {
				this.logger.debug(`Cache delete: ${key}`);
			}

			return deleted;

		} catch (error) {
			this.logger.error(`Cache delete error for key ${key}:`, { error: (error as Error).message });
			return false;
		}
	}

	/**
	 * Clear all cache levels
	 */
	async clear(): Promise<void> {
		try {
			// Clear L1
			if (this.config.enableL1 && this.l1Cache) {
				this.l1Cache.clear();
			}

			// Clear L2 (with prefix if configured)
			if (this.config.enableL2 && this.l2Client) {
				await this.clearL2();
			}

			this.logger.info('Cache cleared');

		} catch (error) {
			this.logger.error('Cache clear error:', { error: (error as Error).message });
			throw error;
		}
	}

	/**
	 * Warm cache with data
	 */
	async warmCache(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
		if (!this.config.warmingConfig?.enabled) {
			return;
		}

		const { batchSize, concurrency, warmupDelay } = this.config.warmingConfig;
		
		this.logger.info(`Starting cache warming with ${entries.length} entries`);

		// Process entries in batches with concurrency control
		const batches = this.chunkArray(entries, batchSize);
		const semaphore = new Semaphore(concurrency);

		const warmingPromises = batches.map(async (batch, batchIndex) => {
			await semaphore.acquire();
			
			try {
				await sleep(batchIndex * warmupDelay); // Stagger batches
				
				for (const { key, value, ttl } of batch) {
					try {
						await this.set(key, value, ttl);
					} catch (error) {
						this.logger.warn(`Failed to warm cache entry: ${key}`, {
							error: (error as Error).message,
						});
					}
				}
				
				this.logger.debug(`Warmed batch ${batchIndex + 1}/${batches.length} (${batch.length} entries)`);
			} finally {
				semaphore.release();
			}
		});

		await Promise.all(warmingPromises);
		this.logger.info('Cache warming completed');
	}

	/**
	 * Get cache metrics
	 */
	getMetrics(): CacheMetrics {
		const totalGets = this.metrics.l1Hits + this.metrics.l1Misses;
		const totalL2Gets = this.metrics.l2Hits + this.metrics.l2Misses;
		
		return {
			...this.metrics,
			l1Size: this.l1Cache?.getSize() || 0,
			hitRatio: totalGets > 0 ? (this.metrics.l1Hits + this.metrics.l2Hits) / totalGets : 0,
			l1HitRatio: totalGets > 0 ? this.metrics.l1Hits / totalGets : 0,
			l2HitRatio: totalL2Gets > 0 ? this.metrics.l2Hits / totalL2Gets : 0,
			averageGetTime: this.getTimes.length > 0 ? 
				this.getTimes.reduce((sum, time) => sum + time, 0) / this.getTimes.length : 0,
			averageSetTime: this.setTimes.length > 0 ? 
				this.setTimes.reduce((sum, time) => sum + time, 0) / this.setTimes.length : 0,
		};
	}

	/**
	 * Reset metrics
	 */
	resetMetrics(): void {
		this.metrics = {
			l1Hits: 0,
			l1Misses: 0,
			l1Sets: 0,
			l1Deletes: 0,
			l1Size: 0,
			l2Hits: 0,
			l2Misses: 0,
			l2Sets: 0,
			l2Deletes: 0,
			l2Errors: 0,
			totalRequests: 0,
			hitRatio: 0,
			l1HitRatio: 0,
			l2HitRatio: 0,
			averageGetTime: 0,
			averageSetTime: 0,
		};
		this.getTimes = [];
		this.setTimes = [];
	}

	private initializeCaches(): void {
		// Initialize L1 cache
		if (this.config.enableL1) {
			this.l1Cache = new LRUCache<CacheEntry<T>>({
				ttl: this.config.l1Config?.ttl || 300000,
				maxSize: this.config.l1Config?.maxSize || 50 * 1024 * 1024,
				maxEntries: this.config.l1Config?.maxEntries || 1000,
			});
		}

		// Initialize L2 cache (Redis client would be initialized here)
		if (this.config.enableL2) {
			// Note: Redis client initialization would happen here
			// For now, we'll simulate it or it can be injected
			this.logger.info('L2 cache (Redis) initialization would happen here');
		}
	}

	private async getFromL2(key: string): Promise<CacheEntry<T> | null> {
		if (!this.l2Client) return null;

		try {
			return await this.circuitBreaker.execute(async () => {
				return await this.retryStrategy.execute(async () => {
					// Redis get operation would happen here
					// For now, return null to simulate cache miss
					return null;
				});
			});
		} catch (error) {
			this.metrics.l2Errors++;
			this.logger.error(`L2 cache get error: ${key}`, { error: (error as Error).message });
			return null;
		}
	}

	private async setInL2(key: string, entry: CacheEntry<T>): Promise<void> {
		if (!this.l2Client) return;

		try {
			await this.circuitBreaker.execute(async () => {
				return await this.retryStrategy.execute(async () => {
					// Redis set operation would happen here
					// Compress data if configured
					let dataToStore = entry;
					if (this.config.l2Config?.compression && this.shouldCompress(entry.data)) {
						dataToStore = { ...entry, compressed: true };
						// Compression logic would happen here
					}

					// Redis setex operation simulation
					this.logger.debug(`L2 cache set: ${key} (TTL: ${entry.ttl}ms)`);
				});
			});
		} catch (error) {
			this.metrics.l2Errors++;
			this.logger.error(`L2 cache set error: ${key}`, { error: (error as Error).message });
			throw error;
		}
	}

	private async deleteFromL2(key: string): Promise<boolean> {
		if (!this.l2Client) return false;

		try {
			return await this.circuitBreaker.execute(async () => {
				return await this.retryStrategy.execute(async () => {
					// Redis del operation would happen here
					return true; // Simulate successful deletion
				});
			});
		} catch (error) {
			this.metrics.l2Errors++;
			this.logger.error(`L2 cache delete error: ${key}`, { error: (error as Error).message });
			return false;
		}
	}

	private async clearL2(): Promise<void> {
		if (!this.l2Client) return;

		try {
			await this.circuitBreaker.execute(async () => {
				// If prefix is configured, only clear keys with that prefix
				const prefix = this.config.l2Config?.keyPrefix;
				if (prefix) {
					// Use SCAN and DEL pattern to clear prefixed keys
					this.logger.debug(`Clearing L2 cache with prefix: ${prefix}`);
				} else {
					// Clear entire database
					this.logger.debug('Clearing entire L2 cache database');
				}
			});
		} catch (error) {
			this.metrics.l2Errors++;
			this.logger.error('L2 cache clear error:', { error: (error as Error).message });
			throw error;
		}
	}

	private isEntryValid(entry: CacheEntry<T>): boolean {
		return Date.now() - entry.timestamp <= entry.ttl;
	}

	private normalizeKey(key: string): string {
		return createHash('sha256').update(key).digest('hex').substring(0, 32);
	}

	private shouldCompress(data: T): boolean {
		// Only compress large objects/strings
		if (typeof data === 'string') {
			return data.length > 1024; // 1KB threshold
		}
		if (typeof data === 'object' && data !== null) {
			try {
				return JSON.stringify(data).length > 1024;
			} catch {
				return false;
			}
		}
		return false;
	}

	private updateGetTime(time: number): void {
		this.getTimes.push(time);
		if (this.getTimes.length > 100) {
			this.getTimes.shift(); // Keep only recent times
		}
	}

	private updateSetTime(time: number): void {
		this.setTimes.push(time);
		if (this.setTimes.length > 100) {
			this.setTimes.shift(); // Keep only recent times
		}
	}

	private chunkArray<U>(array: U[], size: number): U[][] {
		const chunks: U[][] = [];
		for (let i = 0; i < array.length; i += size) {
			chunks.push(array.slice(i, i + size));
		}
		return chunks;
	}
}

/**
 * Semaphore for controlling concurrency
 */
class Semaphore {
	private tokens: number;
	private waitingResolvers: Array<() => void> = [];

	constructor(private maxTokens: number) {
		this.tokens = maxTokens;
	}

	async acquire(): Promise<void> {
		if (this.tokens > 0) {
			this.tokens--;
			return;
		}

		return new Promise<void>((resolve) => {
			this.waitingResolvers.push(resolve);
		});
	}

	release(): void {
		this.tokens++;
		const resolve = this.waitingResolvers.shift();
		if (resolve) {
			this.tokens--;
			resolve();
		}
	}
}

/**
 * Cache Manager for coordinating multiple cache instances
 */
export class CacheManager {
	private caches = new Map<string, MultiLevelCache>();

	/**
	 * Create or get cache instance
	 */
	getCache<T = unknown>(name: string, config?: CacheConfig): MultiLevelCache<T> {
		if (this.caches.has(name)) {
			return this.caches.get(name) as MultiLevelCache<T>;
		}

		const cacheConfig: CacheConfig = {
			enableL1: true,
			enableL2: false, // Default to L1 only
			name,
			...config,
		};

		const cache = new MultiLevelCache<T>(cacheConfig);
		this.caches.set(name, cache);
		return cache;
	}

	/**
	 * Get all cache metrics
	 */
	getAllMetrics(): Record<string, CacheMetrics> {
		const metrics: Record<string, CacheMetrics> = {};
		for (const [name, cache] of this.caches) {
			metrics[name] = cache.getMetrics();
		}
		return metrics;
	}

	/**
	 * Clear all caches
	 */
	async clearAll(): Promise<void> {
		const clearPromises = Array.from(this.caches.values()).map(cache => cache.clear());
		await Promise.all(clearPromises);
	}

	/**
	 * Reset all metrics
	 */
	resetAllMetrics(): void {
		for (const cache of this.caches.values()) {
			cache.resetMetrics();
		}
	}
}

// Global cache manager instance
export const globalCacheManager = new CacheManager();