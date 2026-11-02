import { createHash, randomUUID } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { Redis } from 'ioredis';
import { getLogger } from '../../core/logger.js';
import { detectConnection } from '../../services/queue/keydb-detector.js';
import type { SQLiteManager } from './sqlite-manager.js';

export const MAX_CACHE_ENTRY_BYTES = 1024 * 1024;
const MAX_TTL_SECONDS = 2147483647;

export interface CacheOptions {
	ttl?: number;
	prefix?: string;
	serialize?: (data: unknown) => string;
	deserialize?: (data: string) => unknown;
}

export interface CacheStats {
	hits: number;
	misses: number;
	size: number;
	hitRate: number;
}

function validateTTL(ttl: number): void {
	if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS)
		throw new RangeError(`Cache TTL must be an integer between 1 and ${MAX_TTL_SECONDS}`);
}

export class KeyDBCache {
	private client: Redis | null = null;
	private initialized = false;
	private lifecycleTail: Promise<unknown> = Promise.resolve();
	private readonly prefix: string;
	private readonly defaultTTL: number;
	private readonly encode: (value: unknown) => string;
	private readonly decode: (value: string) => unknown;
	private readonly format: string;
	private stats = { hits: 0, misses: 0 };
	private readonly logger = getLogger('keydb-cache');

	constructor(options: CacheOptions = {}) {
		this.prefix = options.prefix ?? 'sqlite:';
		this.defaultTTL = options.ttl ?? 300;
		validateTTL(this.defaultTTL);
		if (
			(options.serialize === undefined) !== (options.deserialize === undefined) ||
			(options.serialize !== undefined && typeof options.serialize !== 'function') ||
			(options.deserialize !== undefined && typeof options.deserialize !== 'function')
		)
			throw new TypeError('Cache serialization requires both encode and decode functions');
		this.format = options.serialize ? 'custom1:' : 'v8-1:';
		this.encode = options.serialize ?? ((value) => serialize(value).toString('base64'));
		this.decode =
			options.deserialize ??
			((value) => {
				if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
					throw new Error('Invalid cache encoding');
				return deserialize(Buffer.from(value, 'base64'));
			});
	}

	initialize(): Promise<boolean> {
		return this.transition(async () => {
			if (this.isAvailable()) return true;
			if (this.client) this.disconnect(this.client);
			let client: Redis | undefined;
			try {
				const connection = await detectConnection();
				if (!connection.isAvailable || !connection.url) return false;
				client = new Redis(connection.url, {
					protocol: 2,
					lazyConnect: true,
					enableReadyCheck: false,
					enableOfflineQueue: false,
					maxRetriesPerRequest: 0,
					retryStrategy: () => null,
					connectTimeout: 1000,
					commandTimeout: 1000,
					socketTimeout: 1000,
					disconnectTimeout: 1000,
					disableClientInfo: true,
				});
				this.client = client;
				// Command rejections handle optional-server failures without logging connection credentials.
				client.on('error', () => undefined);
				await client.connect();
				if ((await client.ping()) !== 'PONG') throw new Error('Unexpected cache response');
				this.initialized = true;
				return true;
			} catch {
				if (client) this.disconnect(client);
				this.logger.warn('Query cache unavailable; using SQLite');
				return false;
			}
		});
	}

	async get<T>(key: string): Promise<T | null> {
		const client = this.client;
		if (!client || !this.isAvailable()) return null;
		let cached: Buffer;
		try {
			// The extra byte detects oversize values without downloading the entire entry.
			cached = await client.getrangeBuffer(this.prefix + key, 0, MAX_CACHE_ENTRY_BYTES);
		} catch {
			this.disconnect(client);
			this.logger.warn('Query cache read failed; using SQLite');
			this.stats.misses++;
			return null;
		}
		if (cached?.length && cached.length <= MAX_CACHE_ENTRY_BYTES) {
			try {
				const encoded = cached.toString('utf8');
				if (encoded.startsWith(this.format)) {
					const value = this.decode(encoded.slice(this.format.length)) as T;
					this.stats.hits++;
					return value;
				}
			} catch {
				this.logger.debug('Invalid query cache entry; using SQLite');
			}
		}
		this.stats.misses++;
		return null;
	}

	async set(key: string, value: unknown, ttl = this.defaultTTL): Promise<boolean> {
		validateTTL(ttl);
		const client = this.client;
		if (!client || !this.isAvailable()) return false;
		let encoded: string;
		try {
			const data = this.encode(value);
			if (typeof data !== 'string') return false;
			encoded = this.format + data;
			if (Buffer.byteLength(encoded) > MAX_CACHE_ENTRY_BYTES) return false;
		} catch {
			this.logger.debug('Query result cannot be cached');
			return false;
		}
		try {
			await client.setex(this.prefix + key, ttl, encoded);
			return true;
		} catch {
			this.disconnect(client);
			this.logger.warn('Query cache write failed; using SQLite');
			return false;
		}
	}

	async del(key: string): Promise<boolean> {
		const client = this.client;
		if (!client || !this.isAvailable()) return false;
		try {
			return (await client.del(this.prefix + key)) > 0;
		} catch {
			this.disconnect(client);
			this.logger.warn('Query cache delete failed');
			return false;
		}
	}

	async invalidate(pattern: string): Promise<number> {
		const client = this.client;
		if (!client || !this.isAvailable()) return 0;
		let deleted = 0;
		let cursor = '0';
		try {
			do {
				const [next, keys] = await client.scan(
					cursor,
					'MATCH',
					this.prefix + pattern,
					'COUNT',
					100
				);
				cursor = next;
				for (let start = 0; start < keys.length; start += 100)
					deleted += await client.del(...keys.slice(start, start + 100));
			} while (cursor !== '0');
		} catch {
			this.disconnect(client);
			this.logger.warn('Query cache invalidation incomplete');
		}
		return deleted;
	}

	async getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttl?: number): Promise<T> {
		const cached = await this.get<T>(key);
		if (cached !== null) return cached;
		const value = await fetchFn();
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

	resetStats(): void {
		this.stats = { hits: 0, misses: 0 };
	}

	isAvailable(): boolean {
		return this.initialized && this.client?.status === 'ready';
	}

	close(): Promise<void> {
		return this.transition(async () => {
			const client = this.client;
			if (!client) return;
			this.client = null;
			this.initialized = false;
			try {
				if (client.status === 'ready') await client.quit();
			} catch {
				this.logger.debug('Query cache quit failed; disconnecting');
			} finally {
				client.disconnect();
			}
		});
	}

	private disconnect(client: Redis): void {
		if (this.client === client) {
			this.client = null;
			this.initialized = false;
		}
		client.disconnect();
	}

	private transition<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.lifecycleTail.then(operation);
		this.lifecycleTail = pending.catch(() => undefined);
		return pending;
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
			.update(serialize([generation, sql, params]))
			.digest('hex');
		return `${kind}:${this.cacheIdentity}:${digest}`;
	}

	isAvailable(): boolean {
		return this.cache.isAvailable();
	}

	getCacheStats(): CacheStats {
		return this.cache.getStats();
	}

	async close(): Promise<void> {
		await this.cache.close();
	}
}
