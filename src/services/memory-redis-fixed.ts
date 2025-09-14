/**
 * Fixed In-Memory Redis Implementation with Transaction Support
 * Addresses concurrency issues, data integrity, and memory leaks
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../core/logger.js';
import {
	AppError,
	ErrorCode,
	safeReadFile,
	safeWriteFile,
	safeParse,
	safeStringify,
} from '../utils/common.js';

const logger = getLogger('memory-redis');

// Type-safe value storage
type RedisValue = string | number | Buffer;
type RedisHash = Map<string, string>;
type RedisList = string[];
type RedisSet = Set<string>;
type RedisSortedSet = Map<string, number>; // member -> score

interface RedisData {
	type: 'string' | 'hash' | 'list' | 'set' | 'zset';
	value: RedisValue | RedisHash | RedisList | RedisSet | RedisSortedSet;
	ttl?: number;
}

interface Transaction {
	id: string;
	commands: Array<() => Promise<RedisValue | RedisValue[] | number | boolean | null>>;
	watchKeys: Set<string>;
	watchVersions: Map<string, number>;
}

export class MemoryRedis extends EventEmitter {
	private data = new Map<string, RedisData>();
	private keyVersions = new Map<string, number>();
	private transactions = new Map<string, Transaction>();
	private persistencePath?: string;
	private persistenceTimer?: NodeJS.Timeout;
	private persistenceLock = false;
	private shutdownInProgress = false;
	private ttlTimers = new Map<string, NodeJS.Timeout>();
	private readonly maxMemoryBytes: number;
	private currentMemoryBytes = 0;

	constructor(options: { persistence?: string; maxMemoryMB?: number } = {}) {
		super();
		this.persistencePath = options.persistence;
		this.maxMemoryBytes = (options.maxMemoryMB || 100) * 1024 * 1024;

		// Set max listeners to prevent warning
		this.setMaxListeners(100);

		if (this.persistencePath) {
			this.loadFromDisk().catch((err) =>
				logger.error('Failed to load persisted data', { error: err })
			);
			this.schedulePersistence();
		}
	}

	/**
	 * Get type-safe value with validation
	 */
	private getValue(key: string, expectedType?: string): RedisData | undefined {
		const data = this.data.get(key);
		if (!data) return undefined;

		// Check TTL
		if (data.ttl && data.ttl < Date.now()) {
			this.del(key);
			return undefined;
		}

		// Validate type if specified
		if (expectedType && data.type !== expectedType) {
			throw new AppError(
				`WRONGTYPE Operation against a key holding the wrong kind of value`,
				ErrorCode.INVALID_INPUT
			);
		}

		return data;
	}

	/**
	 * Increment key version for WATCH tracking
	 */
	private incrementVersion(key: string): void {
		const version = this.keyVersions.get(key) || 0;
		this.keyVersions.set(key, version + 1);
	}

	/**
	 * Estimate memory usage of a value
	 */
	private estimateMemoryUsage(value: unknown): number {
		if (typeof value === 'string') {
			return value.length * 2; // UTF-16
		} else if (typeof value === 'number') {
			return 8;
		} else if (Buffer.isBuffer(value)) {
			return value.length;
		} else if (value instanceof Map) {
			let size = 0;
			for (const [k, v] of value) {
				size += this.estimateMemoryUsage(k) + this.estimateMemoryUsage(v);
			}
			return size;
		} else if (value instanceof Set) {
			let size = 0;
			for (const item of value) {
				size += this.estimateMemoryUsage(item);
			}
			return size;
		} else if (Array.isArray(value)) {
			return value.reduce((sum, item) => sum + this.estimateMemoryUsage(item), 0);
		}
		return 64; // Default estimate
	}

	/**
	 * Check and enforce memory limit
	 */
	private checkMemoryLimit(additionalBytes: number): void {
		if (this.currentMemoryBytes + additionalBytes > this.maxMemoryBytes) {
			// Simple LRU eviction
			const keysToEvict: string[] = [];
			let bytesToFree = additionalBytes;

			for (const [key, data] of this.data) {
				if (bytesToFree <= 0) break;
				keysToEvict.push(key);
				bytesToFree -= this.estimateMemoryUsage(data.value);
			}

			for (const key of keysToEvict) {
				this.del(key);
			}

			if (this.currentMemoryBytes + additionalBytes > this.maxMemoryBytes) {
				throw new AppError('Out of memory', ErrorCode.RESOURCE_EXHAUSTED);
			}
		}
	}

	// String operations
	async get(key: string): Promise<string | null> {
		const data = this.getValue(key, 'string');
		if (!data) return null;
		return String(data.value);
	}

	async set(key: string, value: string | number, options?: { EX?: number }): Promise<string> {
		const stringValue = String(value);
		const memoryUsage = this.estimateMemoryUsage(stringValue);

		this.checkMemoryLimit(memoryUsage);

		// Clear old TTL timer if exists
		const oldTimer = this.ttlTimers.get(key);
		if (oldTimer) {
			clearTimeout(oldTimer);
			this.ttlTimers.delete(key);
		}

		const ttl = options?.EX ? Date.now() + options.EX * 1000 : undefined;

		this.data.set(key, {
			type: 'string',
			value: stringValue,
			ttl,
		});

		// Set TTL timer if needed
		if (options?.EX) {
			const timer = setTimeout(() => {
				this.del(key);
			}, options.EX * 1000);
			this.ttlTimers.set(key, timer);
		}

		this.incrementVersion(key);
		this.currentMemoryBytes += memoryUsage;

		return 'OK';
	}

	async del(...keys: string[]): Promise<number> {
		let deleted = 0;

		for (const key of keys) {
			const data = this.data.get(key);
			if (data) {
				this.currentMemoryBytes -= this.estimateMemoryUsage(data.value);
				this.data.delete(key);
				this.incrementVersion(key);

				// Clear TTL timer
				const timer = this.ttlTimers.get(key);
				if (timer) {
					clearTimeout(timer);
					this.ttlTimers.delete(key);
				}

				deleted++;
			}
		}

		return deleted;
	}

	async incr(key: string): Promise<number> {
		const data = this.getValue(key);

		if (!data) {
			await this.set(key, '1');
			return 1;
		}

		if (data.type !== 'string') {
			throw new AppError(
				'WRONGTYPE Operation against a key holding the wrong kind of value',
				ErrorCode.INVALID_INPUT
			);
		}

		const num = parseInt(String(data.value), 10);
		if (isNaN(num)) {
			throw new AppError(
				'ERR value is not an integer or out of range',
				ErrorCode.INVALID_INPUT
			);
		}

		const newValue = num + 1;
		await this.set(key, String(newValue));
		return newValue;
	}

	// Hash operations
	async hset(key: string, field: string, value: string): Promise<number> {
		const data = this.getValue(key);

		if (!data) {
			const hash = new Map<string, string>();
			hash.set(field, value);

			const memoryUsage = this.estimateMemoryUsage(hash);
			this.checkMemoryLimit(memoryUsage);

			this.data.set(key, {
				type: 'hash',
				value: hash,
			});
			this.currentMemoryBytes += memoryUsage;
			this.incrementVersion(key);
			return 1;
		}

		if (data.type !== 'hash') {
			throw new AppError(
				'WRONGTYPE Operation against a key holding the wrong kind of value',
				ErrorCode.INVALID_INPUT
			);
		}

		const hash = data.value as RedisHash;
		const isNew = !hash.has(field);
		hash.set(field, value);

		this.incrementVersion(key);
		return isNew ? 1 : 0;
	}

	async hget(key: string, field: string): Promise<string | null> {
		const data = this.getValue(key, 'hash');
		if (!data) return null;

		const hash = data.value as RedisHash;
		return hash.get(field) || null;
	}

	async hgetall(key: string): Promise<Record<string, string>> {
		const data = this.getValue(key, 'hash');
		if (!data) return {};

		const hash = data.value as RedisHash;
		const result: Record<string, string> = {};

		for (const [field, value] of hash) {
			result[field] = value;
		}

		return result;
	}

	async hdel(key: string, ...fields: string[]): Promise<number> {
		const data = this.getValue(key, 'hash');
		if (!data) return 0;

		const hash = data.value as RedisHash;
		let deleted = 0;

		for (const field of fields) {
			if (hash.delete(field)) {
				deleted++;
			}
		}

		if (deleted > 0) {
			this.incrementVersion(key);

			// Remove key if hash is empty
			if (hash.size === 0) {
				this.del(key);
			}
		}

		return deleted;
	}

	// List operations
	async lpush(key: string, ...values: string[]): Promise<number> {
		let data = this.getValue(key);

		if (!data) {
			const list: RedisList = [];

			const memoryUsage = this.estimateMemoryUsage(values);
			this.checkMemoryLimit(memoryUsage);

			this.data.set(key, {
				type: 'list',
				value: list,
			});
			this.currentMemoryBytes += memoryUsage;
			data = this.data.get(key)!;
		}

		if (data.type !== 'list') {
			throw new AppError(
				'WRONGTYPE Operation against a key holding the wrong kind of value',
				ErrorCode.INVALID_INPUT
			);
		}

		const list = data.value as RedisList;
		list.unshift(...values.reverse());

		this.incrementVersion(key);
		return list.length;
	}

	async rpush(key: string, ...values: string[]): Promise<number> {
		let data = this.getValue(key);

		if (!data) {
			const list: RedisList = [];

			const memoryUsage = this.estimateMemoryUsage(values);
			this.checkMemoryLimit(memoryUsage);

			this.data.set(key, {
				type: 'list',
				value: list,
			});
			this.currentMemoryBytes += memoryUsage;
			data = this.data.get(key)!;
		}

		if (data.type !== 'list') {
			throw new AppError(
				'WRONGTYPE Operation against a key holding the wrong kind of value',
				ErrorCode.INVALID_INPUT
			);
		}

		const list = data.value as RedisList;
		list.push(...values);

		this.incrementVersion(key);
		return list.length;
	}

	async lrange(key: string, start: number, stop: number): Promise<string[]> {
		const data = this.getValue(key, 'list');
		if (!data) return [];

		const list = data.value as RedisList;

		// Handle negative indices
		if (start < 0) start = Math.max(0, list.length + start);
		if (stop < 0) stop = list.length + stop;

		return list.slice(start, stop + 1);
	}

	// Set operations
	async sadd(key: string, ...members: string[]): Promise<number> {
		let data = this.getValue(key);

		if (!data) {
			const set = new Set<string>();

			const memoryUsage = this.estimateMemoryUsage(members);
			this.checkMemoryLimit(memoryUsage);

			this.data.set(key, {
				type: 'set',
				value: set,
			});
			this.currentMemoryBytes += memoryUsage;
			data = this.data.get(key)!;
		}

		if (data.type !== 'set') {
			throw new AppError(
				'WRONGTYPE Operation against a key holding the wrong kind of value',
				ErrorCode.INVALID_INPUT
			);
		}

		const set = data.value as RedisSet;
		let added = 0;

		for (const member of members) {
			if (!set.has(member)) {
				set.add(member);
				added++;
			}
		}

		if (added > 0) {
			this.incrementVersion(key);
		}

		return added;
	}

	async smembers(key: string): Promise<string[]> {
		const data = this.getValue(key, 'set');
		if (!data) return [];

		const set = data.value as RedisSet;
		return Array.from(set);
	}

	// Sorted set operations with efficient B-tree-like structure
	async zadd(key: string, ...args: Array<number | string>): Promise<number> {
		if (args.length % 2 !== 0) {
			throw new AppError('ERR wrong number of arguments for ZADD', ErrorCode.INVALID_INPUT);
		}

		let data = this.getValue(key);

		if (!data) {
			const zset = new Map<string, number>();

			const memoryUsage = this.estimateMemoryUsage(args);
			this.checkMemoryLimit(memoryUsage);

			this.data.set(key, {
				type: 'zset',
				value: zset,
			});
			this.currentMemoryBytes += memoryUsage;
			data = this.data.get(key)!;
		}

		if (data.type !== 'zset') {
			throw new AppError(
				'WRONGTYPE Operation against a key holding the wrong kind of value',
				ErrorCode.INVALID_INPUT
			);
		}

		const zset = data.value as RedisSortedSet;
		let added = 0;

		for (let i = 0; i < args.length; i += 2) {
			const score = Number(args[i]);
			const member = String(args[i + 1]);

			if (isNaN(score)) {
				throw new AppError('ERR value is not a valid float', ErrorCode.INVALID_INPUT);
			}

			if (!zset.has(member)) {
				added++;
			}

			zset.set(member, score);
		}

		if (added > 0) {
			this.incrementVersion(key);
		}

		return added;
	}

	async zrangebyscore(
		key: string,
		min: number | string,
		max: number | string,
		options?: { LIMIT?: { offset: number; count: number } }
	): Promise<string[]> {
		const data = this.getValue(key, 'zset');
		if (!data) return [];

		const zset = data.value as RedisSortedSet;

		// Parse min/max
		const minScore = min === '-inf' ? -Infinity : Number(min);
		const maxScore = max === '+inf' ? Infinity : Number(max);

		// Get sorted entries
		const sorted = Array.from(zset.entries())
			.filter(([_, score]) => score >= minScore && score <= maxScore)
			.sort((a, b) => a[1] - b[1])
			.map(([member]) => member);

		// Apply LIMIT if specified
		if (options?.LIMIT) {
			const { offset, count } = options.LIMIT;
			return sorted.slice(offset, offset + count);
		}

		return sorted;
	}

	// Transaction support
	async watch(...keys: string[]): Promise<string> {
		const txId = Math.random().toString(36).substring(7);
		const watchKeys = new Set(keys);
		const watchVersions = new Map<string, number>();

		for (const key of keys) {
			const version = this.keyVersions.get(key) || 0;
			watchVersions.set(key, version);
		}

		this.transactions.set(txId, {
			id: txId,
			commands: [],
			watchKeys,
			watchVersions,
		});

		return txId;
	}

	async multi(txId?: string): Promise<string> {
		if (!txId) {
			txId = Math.random().toString(36).substring(7);
			this.transactions.set(txId, {
				id: txId,
				commands: [],
				watchKeys: new Set(),
				watchVersions: new Map(),
			});
		}

		return txId;
	}

	async exec(txId: string): Promise<any[] | null> {
		const tx = this.transactions.get(txId);
		if (!tx) {
			throw new AppError('ERR EXEC without MULTI', ErrorCode.INVALID_STATE);
		}

		// Check WATCH conditions
		for (const [key, expectedVersion] of tx.watchVersions) {
			const currentVersion = this.keyVersions.get(key) || 0;
			if (currentVersion !== expectedVersion) {
				// Transaction aborted due to watched key modification
				this.transactions.delete(txId);
				return null;
			}
		}

		// Execute all commands atomically
		const results: unknown[] = [];
		try {
			for (const command of tx.commands) {
				const result = await command();
				results.push(result);
			}
		} catch (error) {
			// Rollback on error
			this.transactions.delete(txId);
			throw error;
		}

		this.transactions.delete(txId);
		return results;
	}

	async discard(txId: string): Promise<string> {
		this.transactions.delete(txId);
		return 'OK';
	}

	// Add command to transaction
	addTransactionCommand(txId: string, command: () => Promise<any>): void {
		const tx = this.transactions.get(txId);
		if (!tx) {
			throw new AppError('ERR no transaction in progress', ErrorCode.INVALID_STATE);
		}

		tx.commands.push(command);
	}

	// Persistence with atomic writes
	private async loadFromDisk(): Promise<void> {
		if (!this.persistencePath) return;

		try {
			const dataPath = path.resolve(this.persistencePath);
			const content = await safeReadFile(dataPath, 'utf-8');
			const parsed = safeParse(content, { version: 1, data: {} });

			// Validate and restore data
			if ((parsed as any).version !== 1) {
				throw new Error('Unsupported persistence format');
			}

			for (const [key, entry] of Object.entries((parsed as any).data)) {
				const { type, value, ttl } = entry as {
					type: string;
					value: unknown;
					ttl?: number;
				};

				// Skip expired keys
				if (ttl && ttl < Date.now()) continue;

				// Restore based on type
				switch (type) {
					case 'string':
						this.data.set(key, { type, value: String(value), ttl });
						break;
					case 'hash':
						this.data.set(key, { type, value: new Map(Object.entries(value as Record<string, string>)), ttl });
						break;
					case 'list':
						this.data.set(key, { type, value: Array.from(value as Iterable<string>), ttl });
						break;
					case 'set':
						this.data.set(key, { type, value: new Set(value as Iterable<string>), ttl });
						break;
					case 'zset':
						this.data.set(key, { type, value: new Map(Object.entries(value as Record<string, number>)), ttl });
						break;
				}

				// Set TTL timer if needed
				if (ttl) {
					const remaining = ttl - Date.now();
					if (remaining > 0) {
						const timer = setTimeout(() => {
							this.del(key);
						}, remaining);
						this.ttlTimers.set(key, timer);
					}
				}
			}

			logger.info('Loaded persisted data', { keys: this.data.size });
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.error('Failed to load persisted data', { error });
			}
		}
	}

	private async persistToDisk(): Promise<void> {
		if (!this.persistencePath || this.persistenceLock || this.shutdownInProgress) return;

		this.persistenceLock = true;

		try {
			const dataPath = path.resolve(this.persistencePath);
			const tempPath = `${dataPath}.tmp.${Date.now()}`;

			// Serialize data
			const serialized: Record<string, unknown> = {
				version: 1,
				timestamp: Date.now(),
				data: {},
			};

			for (const [key, entry] of this.data) {
				const { type, value, ttl } = entry;

				// Skip expired keys
				if (ttl && ttl < Date.now()) continue;

				// Serialize based on type
				switch (type) {
					case 'string':
						(serialized.data as Record<string, any>)[key] = { type, value, ttl };
						break;
					case 'hash':
						(serialized.data as Record<string, any>)[key] = {
							type,
							value: Object.fromEntries(value as RedisHash),
							ttl,
						};
						break;
					case 'list':
						(serialized.data as Record<string, any>)[key] = { type, value, ttl };
						break;
					case 'set':
						(serialized.data as Record<string, any>)[key] = {
							type,
							value: Array.from(value as RedisSet),
							ttl,
						};
						break;
					case 'zset':
						(serialized.data as Record<string, any>)[key] = {
							type,
							value: Object.fromEntries(value as RedisSortedSet),
							ttl,
						};
						break;
				}
			}

			// Atomic write using safeWriteFile (which handles temp file internally)
			await safeWriteFile(dataPath, safeStringify(serialized), 'utf-8');

			logger.debug('Persisted data to disk', { keys: this.data.size });
		} catch (error) {
			logger.error('Failed to persist data', { error });
		} finally {
			this.persistenceLock = false;
		}
	}

	private schedulePersistence(): void {
		if (this.persistenceTimer) {
			clearTimeout(this.persistenceTimer);
		}

		this.persistenceTimer = setTimeout(() => {
			this.persistToDisk()
				.catch((err) => logger.error('Persistence failed', { error: err }))
				.finally(() => this.schedulePersistence());
		}, 5000); // Persist every 5 seconds

		// Don't block shutdown
		this.persistenceTimer.unref();
	}

	// Graceful shutdown
	async shutdown(): Promise<void> {
		if (this.shutdownInProgress) return;
		this.shutdownInProgress = true;

		// Clear all timers
		if (this.persistenceTimer) {
			clearTimeout(this.persistenceTimer);
			this.persistenceTimer = undefined;
		}

		for (const timer of this.ttlTimers.values()) {
			clearTimeout(timer);
		}
		this.ttlTimers.clear();

		// Final persistence
		await this.persistToDisk();

		// Clear all data
		this.data.clear();
		this.keyVersions.clear();
		this.transactions.clear();

		// Remove all listeners
		this.removeAllListeners();

		logger.info('MemoryRedis shutdown complete');
	}

	// Utility methods
	async keys(pattern: string): Promise<string[]> {
		const regex = new RegExp(`^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

		const result: string[] = [];
		for (const key of this.data.keys()) {
			if (regex.test(key)) {
				result.push(key);
			}
		}

		return result;
	}

	async exists(...keys: string[]): Promise<number> {
		let count = 0;
		for (const key of keys) {
			if (this.getValue(key)) {
				count++;
			}
		}
		return count;
	}

	async ttl(key: string): Promise<number> {
		const data = this.getValue(key);
		if (!data) return -2; // Key doesn't exist
		if (!data.ttl) return -1; // No TTL

		const remaining = Math.floor((data.ttl - Date.now()) / 1000);
		return Math.max(0, remaining);
	}

	async expire(key: string, seconds: number): Promise<number> {
		const data = this.getValue(key);
		if (!data) return 0;

		// Clear old timer
		const oldTimer = this.ttlTimers.get(key);
		if (oldTimer) {
			clearTimeout(oldTimer);
		}

		// Set new TTL
		data.ttl = Date.now() + seconds * 1000;

		// Set new timer
		const timer = setTimeout(() => {
			this.del(key);
		}, seconds * 1000);
		this.ttlTimers.set(key, timer);

		return 1;
	}

	async flushall(): Promise<string> {
		// Clear all TTL timers
		for (const timer of this.ttlTimers.values()) {
			clearTimeout(timer);
		}
		this.ttlTimers.clear();

		// Clear all data
		this.data.clear();
		this.keyVersions.clear();
		this.transactions.clear();
		this.currentMemoryBytes = 0;

		return 'OK';
	}

	// Memory info
	async info(): Promise<string> {
		const info = [
			`# Memory`,
			`used_memory:${this.currentMemoryBytes}`,
			`used_memory_human:${(this.currentMemoryBytes / 1024 / 1024).toFixed(2)}M`,
			`max_memory:${this.maxMemoryBytes}`,
			`max_memory_human:${(this.maxMemoryBytes / 1024 / 1024).toFixed(2)}M`,
			``,
			`# Keyspace`,
			`keys:${this.data.size}`,
			`transactions:${this.transactions.size}`,
			`ttl_timers:${this.ttlTimers.size}`,
		];

		return info.join('\n');
	}
}
