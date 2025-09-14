/**
 * KeyDB caching layer for SQLite queries
 * Provides intelligent caching for frequently accessed database operations
 */

import type { Redis } from 'ioredis';
import { getLogger } from '../../core/logger.js';
import { createBullMQConnection, detectConnection } from '../../services/queue/keydb-detector.js';
import { retry, withErrorHandling, safeParse, safeStringify } from '../../utils/common.js';
import type { SQLiteManager } from './sqlite-manager.js';

const logger = getLogger('keydb-cache');

export interface CacheOptions {
	ttl?: number; // Time to live in seconds
	prefix?: string; // Cache key prefix
	serialize?: (data: unknown) => string;
	deserialize?: (data: string) => unknown;
}

export interface CacheStats {
	hits: number;
	misses: number;
	size: number;
	hitRate: number;
}

/**
 * KeyDB-based cache for SQLite query results
 */
export class KeyDBCache {
	private client: Redis | null = null;
	private isConnected = false;
	private prefix: string;
	private defaultTTL: number;
	private stats = { hits: 0, misses: 0 };
	private logger: ReturnType<typeof getLogger>;

	constructor(options: CacheOptions = {}) {
		this.logger = getLogger('keydb-cache');
		this.prefix = options.prefix || 'sqlite:';
		this.defaultTTL = options.ttl || 300; // 5 minutes default
	}

	/**
	 * Initialize cache connection
	 */
	async initialize(): Promise<boolean> {
		return withErrorHandling(async () => {
			// Detect connection with retry
			const connectionInfo = await retry(() => detectConnection(), {
				maxAttempts: 3,
				initialDelay: 500,
			});

			if (!connectionInfo.isAvailable || !connectionInfo.url) {
				this.logger.info('KeyDB/Redis not available, caching disabled');
				return false;
			}

			this.client = createBullMQConnection(connectionInfo.url);

			// Test connection with retry
			await retry(() => this.client!.ping(), { maxAttempts: 3, initialDelay: 100 });
			this.isConnected = true;

			this.logger.info(`Cache initialized with ${connectionInfo.type}`, {
				version: connectionInfo.version,
				prefix: this.prefix,
				defaultTTL: this.defaultTTL,
			});

			return true;
		}, 'Cache initialization')();
	}

	/**
	 * Get cached value
	 */
	async get<T>(key: string): Promise<T | null> {
		if (!this.isConnected || !this.client) {
			return null;
		}

		return withErrorHandling(async () => {
			const cacheKey = this.prefix + key;
			const cached = await this.client!.get(cacheKey);

			if (cached) {
				this.stats.hits++;
				this.logger.debug(`Cache hit for key: ${key}`);
				return safeParse<T>(cached, null as T);
			}

			this.stats.misses++;
			this.logger.debug(`Cache miss for key: ${key}`);
			return null;
		}, 'Cache get')();
	}

	/**
	 * Set cached value
	 */
	async set(key: string, value: unknown, ttl?: number): Promise<boolean> {
		if (!this.isConnected || !this.client) {
			return false;
		}

		return withErrorHandling(async () => {
			const cacheKey = this.prefix + key;
			const serialized = safeStringify(value);
			const expiry = ttl || this.defaultTTL;

			// Use retry for cache set operation
			await retry(() => this.client!.setex(cacheKey, expiry, serialized), {
				maxAttempts: 2,
				initialDelay: 100,
			});
			this.logger.debug(`Cached value for key: ${key} (TTL: ${expiry}s)`);
			return true;
		}, 'Cache set')();
	}

	/**
	 * Delete cached value
	 */
	async del(key: string): Promise<boolean> {
		if (!this.isConnected || !this.client) {
			return false;
		}

		try {
			const cacheKey = this.prefix + key;
			const deleted = await this.client.del(cacheKey);

			if (deleted > 0) {
				this.logger.debug(`Deleted cached key: ${key}`);
				return true;
			}
			return false;
		} catch (error) {
			this.logger.error('Cache delete failed', { key, error: (error as Error).message });
			return false;
		}
	}

	/**
	 * Invalidate cache by pattern
	 */
	async invalidate(pattern: string): Promise<number> {
		if (!this.isConnected || !this.client) {
			return 0;
		}

		return withErrorHandling(async () => {
			const searchPattern = this.prefix + pattern;
			// Use SCAN instead of KEYS for production
			const keys = await this.scanKeys(searchPattern);

			if (keys.length > 0) {
				// Delete in batches for better performance
				const batchSize = 100;
				let totalDeleted = 0;

				for (let i = 0; i < keys.length; i += batchSize) {
					const batch = keys.slice(i, i + batchSize);
					const deleted = await retry(() => this.client!.del(...batch), {
						maxAttempts: 2,
						initialDelay: 50,
					});
					totalDeleted += deleted;
				}

				this.logger.info(`Invalidated ${totalDeleted} cached entries`, { pattern });
				return totalDeleted;
			}

			return 0;
		}, 'Cache invalidation')();
	}

	/**
	 * Scan keys using SCAN command (production-safe)
	 */
	private async scanKeys(pattern: string): Promise<string[]> {
		if (!this.client) return [];

		const keys: string[] = [];
		let cursor = '0';

		do {
			const [newCursor, batch] = await this.client.scan(
				cursor,
				'MATCH',
				pattern,
				'COUNT',
				100
			);
			cursor = newCursor;
			keys.push(...batch);
		} while (cursor !== '0');

		return keys;
	}

	/**
	 * Get or set cached value (cache-aside pattern)
	 */
	async getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttl?: number): Promise<T> {
		// Try to get from cache first
		const cached = await this.get<T>(key);
		if (cached !== null) {
			return cached;
		}

		// Fetch from source
		const value = await fetchFn();

		// Cache the result
		await this.set(key, value, ttl);

		return value;
	}

	/**
	 * Get cache statistics
	 */
	getStats(): CacheStats {
		const total = this.stats.hits + this.stats.misses;
		return {
			hits: this.stats.hits,
			misses: this.stats.misses,
			size: total,
			hitRate: total > 0 ? this.stats.hits / total : 0,
		};
	}

	/**
	 * Reset statistics
	 */
	resetStats(): void {
		this.stats = { hits: 0, misses: 0 };
	}

	/**
	 * Check if cache is available
	 */
	isAvailable(): boolean {
		return this.isConnected;
	}

	/**
	 * Close cache connection
	 */
	async close(): Promise<void> {
		if (this.client && this.isConnected) {
			await withErrorHandling(async () => {
				await this.client!.quit();
				this.isConnected = false;
				this.logger.info('Cache connection closed');
			}, 'Cache close')();
		}
	}
}

/**
 * Cached SQLite query executor
 * Wraps common query patterns with intelligent caching
 */
export class CachedSQLiteManager {
	private cache: KeyDBCache;
	private sqliteManager: SQLiteManager;

	constructor(sqliteManager: SQLiteManager, cacheOptions?: CacheOptions) {
		this.sqliteManager = sqliteManager;
		this.cache = new KeyDBCache(cacheOptions);
	}

	/**
	 * Initialize cache
	 */
	async initialize(): Promise<void> {
		await this.cache.initialize();
	}

	/**
	 * Cached query execution
	 */
	async query(sql: string, params: unknown[] = [], ttl?: number): Promise<unknown[]> {
		if (!this.cache.isAvailable()) {
			return this.sqliteManager.query(sql, params);
		}

		// Create cache key from SQL and params
		const cacheKey = `query:${this.hashQuery(sql, params)}`;

		return this.cache.getOrSet(
			cacheKey,
			async () => this.sqliteManager.query(sql, params),
			ttl
		);
	}

	/**
	 * Cached single row query
	 */
	async queryOne(sql: string, params: unknown[] = [], ttl?: number): Promise<unknown> {
		if (!this.cache.isAvailable()) {
			return this.sqliteManager.queryOne(sql, params);
		}

		const cacheKey = `queryOne:${this.hashQuery(sql, params)}`;

		return this.cache.getOrSet(
			cacheKey,
			async () => this.sqliteManager.queryOne(sql, params),
			ttl
		);
	}

	/**
	 * Execute write operation and invalidate related cache
	 */
	async execute(sql: string, params: unknown[] = []): Promise<unknown> {
		const result = this.sqliteManager.execute(sql, params);

		// Invalidate cache based on table being modified
		if (this.cache.isAvailable()) {
			const table = this.extractTableName(sql);
			if (table) {
				await this.cache.invalidate(`*:${table}:*`);
				await this.cache.invalidate(`query:*${table}*`);
			}
		}

		return result;
	}

	/**
	 * Transaction with cache invalidation
	 */
	transaction<T>(fn: () => T, retries?: number): T {
		const result = this.sqliteManager.transaction(fn, retries);

		// Invalidate all cache after transaction
		if (this.cache.isAvailable()) {
			this.cache.invalidate('*').catch((error) => {
				logger.warn('Failed to invalidate cache after transaction', { error });
			});
		}

		return result;
	}

	/**
	 * Hash query and parameters for cache key
	 */
	private hashQuery(sql: string, params: unknown[]): string {
		const combined = sql + safeStringify(params);
		// Simple hash function for demo - in production, use a proper hash
		let hash = 0;
		for (let i = 0; i < combined.length; i++) {
			const char = combined.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash).toString(36);
	}

	/**
	 * Extract table name from SQL for cache invalidation
	 */
	private extractTableName(sql: string): string | null {
		const match = sql.match(/(?:FROM|INTO|UPDATE|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
		return match ? match[1].toLowerCase() : null;
	}

	/**
	 * Get cache statistics
	 */
	getCacheStats(): CacheStats {
		return this.cache.getStats();
	}

	/**
	 * Close cache connection
	 */
	async close(): Promise<void> {
		await this.cache.close();
	}
}
