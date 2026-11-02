/**
 * KeyDB caching layer for SQLite queries
 * Provides intelligent caching for frequently accessed database operations
 */

import { createHash, randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import type { Redis } from 'ioredis';
import { getLogger } from '../../core/logger.js';
import { createBullMQConnection, detectConnection } from '../../services/queue/keydb-detector.js';
import { retry, withErrorHandling, safeParse, safeStringify } from '../../utils/common.js';
import type { SQLiteManager } from './sqlite-manager.js';

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

	async initialize(): Promise<boolean> {
		return withErrorHandling(async () => {
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

	isAvailable(): boolean {
		return this.isConnected;
	}

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
	private readonly cacheIdentity = randomUUID();

	constructor(sqliteManager: SQLiteManager, cacheOptions?: CacheOptions) {
		this.sqliteManager = sqliteManager;
		this.cache = new KeyDBCache(cacheOptions);
	}

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

		const cacheKey = this.queryKey('query', sql, params);

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

		const cacheKey = this.queryKey('queryOne', sql, params);

		return this.cache.getOrSet(
			cacheKey,
			async () => this.sqliteManager.queryOne(sql, params),
			ttl
		);
	}

	async execute(sql: string, params: unknown[] = []): Promise<unknown> {
		return this.sqliteManager.execute(sql, params);
	}

	async transaction<T>(fn: () => T, retries?: number): Promise<T> {
		return this.sqliteManager.transaction(fn, retries);
	}

	private queryKey(kind: string, sql: string, params: unknown[]): string {
		// SQLite tracks local writes, other-connection commits and schema changes, including writes outside this wrapper.
		const generation = this.sqliteManager
			.getDatabase()
			.prepare(
				'SELECT total_changes() AS local, (SELECT data_version FROM pragma_data_version) AS external, (SELECT schema_version FROM pragma_schema_version) AS schema'
			)
			.get();
		const digest = createHash('sha256')
			.update(serialize([sql, params]))
			.digest('hex');
		return `${kind}:${this.cacheIdentity}:${JSON.stringify(generation)}:${digest}`;
	}

	getCacheStats(): CacheStats {
		return this.cache.getStats();
	}

	async close(): Promise<void> {
		await this.cache.close();
	}
}
