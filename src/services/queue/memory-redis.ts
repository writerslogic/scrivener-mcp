/**
 * In-memory Redis-compatible store for BullMQ
 * Provides a zero-dependency alternative to Redis for local development
 */

import { EventEmitter } from 'events';
import { getLogger } from '../../core/logger.js';
import { AppError, ErrorCode, readJSON, writeJSON } from '../../utils/common.js';

const logger = getLogger('memory-redis');

// Type definitions for stored data structures
interface StoredSet {
	_type: 'set';
	items: unknown[];
}

interface StoredList {
	_type: 'list';
	items: unknown[];
}

interface StoredHash {
	_type: 'hash';
	data: Record<string, unknown>;
}

interface StoredZSet {
	_type: 'zset';
	entries: [string, number][];
}

interface ZSetData {
	_scores: Map<string, number>;
	_members: Map<number, string>;
}

interface LegacySet {
	_isSet: true;
	items: unknown[];
}

type StoredValue =
	| string
	| number
	| boolean
	| Set<unknown>
	| unknown[]
	| Record<string, unknown>
	| ZSetData
	| StoredSet
	| StoredList
	| StoredHash
	| StoredZSet
	| LegacySet;

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		!(value instanceof Map) &&
		!(value instanceof Set)
	);
}

/**
 * Simple in-memory Redis-like store with persistence
 * Implements only the Redis commands used by BullMQ
 */
export class MemoryRedis extends EventEmitter {
	private data: Map<string, StoredValue> = new Map();
	private expiry: Map<string, number> = new Map();
	private persistPath: string | null = null;
	private persistInterval: NodeJS.Timeout | null = null;
	private cleanupInterval: NodeJS.Timeout | null = null;
	private connected = false;
	private persistTail: Promise<void> = Promise.resolve();
	private lifecycleTail: Promise<void> = Promise.resolve();
	private isCleaningExpiry = false;

	constructor(options: { persistPath?: string } = {}) {
		super();
		this.persistPath = options.persistPath || './data/memory-redis.json';
	}

	connect(): Promise<void> {
		return this.runLifecycle(() => this.connectStore());
	}

	private runLifecycle(operation: () => Promise<void>): Promise<void> {
		const pending = this.lifecycleTail.then(operation);
		this.lifecycleTail = pending.catch(() => undefined);
		return pending;
	}

	private async connectStore(): Promise<void> {
		if (this.connected) return;

		// Load persisted data
		if (this.persistPath) {
			let parsed: unknown;
			try {
				parsed = await readJSON(this.persistPath);
			} catch (error) {
				if (!(error instanceof AppError) || error.code !== ErrorCode.NOT_FOUND) throw error;
				parsed = { data: [], expiry: [] };
			}
			if (!isRecord(parsed) || !Array.isArray(parsed.data) || !Array.isArray(parsed.expiry)) {
				throw new Error('Invalid persisted Memory Redis data');
			}

			const restoredData = new Map<string, StoredValue>();
			for (const entry of parsed.data) {
				if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
					throw new Error('Invalid persisted Memory Redis entry');
				}
				restoredData.set(entry[0], this.restoreValue(entry[1]));
			}

			const restoredExpiry = new Map<string, number>();
			for (const entry of parsed.expiry) {
				if (
					!Array.isArray(entry) ||
					entry.length !== 2 ||
					typeof entry[0] !== 'string' ||
					typeof entry[1] !== 'number' ||
					!Number.isFinite(entry[1])
				) {
					throw new Error('Invalid persisted Memory Redis expiry');
				}
				restoredExpiry.set(entry[0], entry[1]);
			}
			this.data = restoredData;
			this.expiry = restoredExpiry;
			if (this.data.size > 0) {
				logger.info('Loaded persisted data', { entries: this.data.size });
			} else {
				logger.debug('No persisted data found');
			}
		}

		this.startTimers();

		this.connected = true;
		this.emit('connect');
		logger.info('Memory Redis connected');
	}

	private startTimers(): void {
		if (this.persistPath && !this.persistInterval) {
			this.persistInterval = setInterval(() => {
				this.persist().catch((error) => logger.error('Failed to persist data', { error }));
			}, 60000);
		}
		if (!this.cleanupInterval) {
			this.cleanupInterval = setInterval(() => this.cleanupExpired(), 30000);
		}
	}

	private restoreValue(value: unknown): StoredValue {
		if (isRecord(value)) {
			switch (value._type) {
				case 'set':
				case 'list':
					if (!Array.isArray(value.items)) {
						throw new Error('Invalid persisted Memory Redis collection');
					}
					return value._type === 'set' ? new Set(value.items) : value.items;
				case 'hash':
					if (!isRecord(value.data)) {
						throw new Error('Invalid persisted Memory Redis hash');
					}
					return value.data;
				case 'zset': {
					if (
						!Array.isArray(value.entries) ||
						value.entries.some(
							(entry) =>
								!Array.isArray(entry) ||
								entry.length !== 2 ||
								typeof entry[0] !== 'string' ||
								typeof entry[1] !== 'number' ||
								!Number.isFinite(entry[1])
						)
					) {
						throw new Error('Invalid persisted Memory Redis sorted set');
					}
					const scores = new Map<string, number>(value.entries);
					return {
						_scores: scores,
						_members: new Map(Array.from(scores, ([member, score]) => [score, member])),
					};
				}
			}
			if ('_isSet' in value && Array.isArray(value.items)) return new Set(value.items);
		}
		return value as StoredValue;
	}

	disconnect(): Promise<void> {
		return this.runLifecycle(() => this.disconnectStore());
	}

	private async disconnectStore(): Promise<void> {
		if (!this.connected) return;

		// Stop timers first
		if (this.persistInterval) {
			clearInterval(this.persistInterval);
			this.persistInterval = null;
		}

		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		try {
			await this.persist();
		} catch (error) {
			this.startTimers();
			throw error;
		}

		this.connected = false;
		this.emit('close');
		logger.info('Memory Redis disconnected');
	}

	async quit(): Promise<void> {
		return this.disconnect();
	}

	// Redis String Commands
	async get(key: string): Promise<string | null> {
		this.checkExpiry(key);
		const value = this.data.get(key);
		return typeof value === 'string' ? value : null;
	}

	async set(key: string, value: string, ...args: (string | number)[]): Promise<'OK'> {
		this.data.set(key, value);

		// Handle expiry
		if (args[0] === 'EX' && typeof args[1] === 'number') {
			this.expiry.set(key, Date.now() + args[1] * 1000);
		} else if (args[0] === 'PX' && typeof args[1] === 'number') {
			this.expiry.set(key, Date.now() + args[1]);
		}

		return 'OK';
	}

	async del(...keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			if (this.data.delete(key)) {
				deleted++;
				this.expiry.delete(key);
			}
		}
		return deleted;
	}

	async exists(...keys: string[]): Promise<number> {
		let count = 0;
		for (const key of keys) {
			this.checkExpiry(key);
			if (this.data.has(key)) count++;
		}
		return count;
	}

	async expire(key: string, seconds: number): Promise<number> {
		if (!this.data.has(key)) return 0;
		this.expiry.set(key, Date.now() + seconds * 1000);
		return 1;
	}

	async ttl(key: string): Promise<number> {
		if (!this.data.has(key)) return -2;
		const expiry = this.expiry.get(key);
		if (!expiry) return -1;
		return Math.max(0, Math.floor((expiry - Date.now()) / 1000));
	}

	// Redis List Commands (for BullMQ)
	async lpush(key: string, ...values: string[]): Promise<number> {
		let list = this.data.get(key) || [];
		if (!Array.isArray(list)) list = [];
		list.unshift(...values.reverse());
		this.data.set(key, list);
		return list.length;
	}

	async rpush(key: string, ...values: string[]): Promise<number> {
		let list = this.data.get(key) || [];
		if (!Array.isArray(list)) list = [];
		list.push(...values);
		this.data.set(key, list);
		return list.length;
	}

	async lpop(key: string): Promise<string | null> {
		const list = this.data.get(key);
		if (!Array.isArray(list) || list.length === 0) return null;
		const value = list.shift();
		if (list.length === 0) {
			this.data.delete(key);
		}
		return typeof value === 'string' ? value : null;
	}

	async rpop(key: string): Promise<string | null> {
		const list = this.data.get(key);
		if (!Array.isArray(list) || list.length === 0) return null;
		const value = list.pop();
		if (list.length === 0) {
			this.data.delete(key);
		}
		return typeof value === 'string' ? value : null;
	}

	async lrange(key: string, start: number, stop: number): Promise<string[]> {
		const list = this.data.get(key);
		if (!Array.isArray(list)) return [];

		// Handle negative indices
		if (start < 0) start = list.length + start;
		if (stop < 0) stop = list.length + stop;

		return list
			.slice(start, stop + 1)
			.filter((item): item is string => typeof item === 'string');
	}

	async llen(key: string): Promise<number> {
		const list = this.data.get(key);
		if (!Array.isArray(list)) return 0;
		return list.length;
	}

	async lrem(key: string, count: number, value: string): Promise<number> {
		const list = this.data.get(key);
		if (!Array.isArray(list)) return 0;

		let removed = 0;
		const newList: unknown[] = [];

		if (count > 0) {
			// Remove from head
			for (const item of list) {
				if (item === value && removed < count) {
					removed++;
				} else {
					newList.push(item);
				}
			}
		} else if (count < 0) {
			// Remove from tail
			for (let i = list.length - 1; i >= 0; i--) {
				if (list[i] === value && removed < Math.abs(count)) {
					removed++;
				} else {
					newList.unshift(list[i]);
				}
			}
		} else {
			// Remove all
			for (const item of list) {
				if (item === value) {
					removed++;
				} else {
					newList.push(item);
				}
			}
		}

		if (newList.length === 0) {
			this.data.delete(key);
		} else {
			this.data.set(key, newList);
		}

		return removed;
	}

	// Redis Hash Commands (for BullMQ job data)
	async hset(key: string, field: string, value: string): Promise<number> {
		let hash = this.data.get(key);
		if (
			!hash ||
			typeof hash !== 'object' ||
			Array.isArray(hash) ||
			hash instanceof Set ||
			hash instanceof Map
		) {
			hash = {};
		}
		const isNew = !(field in hash);
		(hash as Record<string, string>)[field] = value;
		this.data.set(key, hash);
		return isNew ? 1 : 0;
	}

	async hget(key: string, field: string): Promise<string | null> {
		const hash = this.data.get(key);
		if (
			!hash ||
			typeof hash !== 'object' ||
			Array.isArray(hash) ||
			hash instanceof Set ||
			hash instanceof Map
		) {
			return null;
		}
		return (hash as Record<string, string>)[field] || null;
	}

	async hgetall(key: string): Promise<Record<string, string>> {
		const hash = this.data.get(key);
		if (
			!hash ||
			typeof hash !== 'object' ||
			Array.isArray(hash) ||
			hash instanceof Set ||
			hash instanceof Map
		) {
			return {};
		}
		return { ...(hash as Record<string, string>) };
	}

	async hdel(key: string, ...fields: string[]): Promise<number> {
		const hash = this.data.get(key);
		if (
			!hash ||
			typeof hash !== 'object' ||
			Array.isArray(hash) ||
			hash instanceof Set ||
			hash instanceof Map
		) {
			return 0;
		}

		let deleted = 0;
		for (const field of fields) {
			if (field in hash) {
				delete (hash as Record<string, string>)[field];
				deleted++;
			}
		}

		if (Object.keys(hash as Record<string, string>).length === 0) {
			this.data.delete(key);
		}

		return deleted;
	}

	// Redis Set Commands (for BullMQ)
	async sadd(key: string, ...members: string[]): Promise<number> {
		let set = this.data.get(key);
		if (!set || !(set instanceof Set)) {
			set = new Set();
		}

		const sizeBefore = set.size;
		for (const member of members) {
			set.add(member);
		}
		this.data.set(key, set);

		return set.size - sizeBefore;
	}

	async srem(key: string, ...members: string[]): Promise<number> {
		const set = this.data.get(key);
		if (!set || !(set instanceof Set)) return 0;

		let removed = 0;
		for (const member of members) {
			if (set.delete(member)) removed++;
		}

		if (set.size === 0) {
			this.data.delete(key);
		}

		return removed;
	}

	async smembers(key: string): Promise<string[]> {
		const set = this.data.get(key);
		if (!set || !(set instanceof Set)) return [];
		return Array.from(set).filter((item): item is string => typeof item === 'string');
	}

	async scard(key: string): Promise<number> {
		const set = this.data.get(key);
		if (!set || !(set instanceof Set)) return 0;
		return set.size;
	}

	// Redis Sorted Set Commands (for BullMQ delayed jobs)
	async zadd(key: string, ...args: (number | string)[]): Promise<number> {
		let zset = this.data.get(key);
		if (!zset || typeof zset !== 'object' || !('_scores' in zset) || !('_members' in zset)) {
			zset = { _scores: new Map(), _members: new Map() };
		}

		let added = 0;
		for (let i = 0; i < args.length; i += 2) {
			if (i + 1 >= args.length) break; // Ensure we have both score and member

			const score = parseFloat(String(args[i]));
			const member = args[i + 1];

			// Validate score and member
			if (isNaN(score) || !isFinite(score)) {
				continue; // Skip invalid scores
			}

			if (member === null || member === undefined) {
				continue; // Skip invalid members
			}

			const typedZset = zset as ZSetData;
			if (!typedZset._scores.has(String(member))) {
				added++;
			}

			typedZset._scores.set(String(member), score);
			typedZset._members.set(score, String(member));
		}

		this.data.set(key, zset);
		return added;
	}

	async zrange(key: string, start: number, stop: number, ...args: string[]): Promise<string[]> {
		const zset = this.data.get(key);
		if (!zset || typeof zset !== 'object' || !('_scores' in zset)) {
			return [];
		}

		const typedZset = zset as ZSetData;
		const scores = typedZset._scores;
		if (!(scores instanceof Map)) {
			return [];
		}

		const entries = Array.from(scores.entries()) as [string, number][];
		const sorted = entries.sort((a, b) => a[1] - b[1]).map(([member]) => member);

		// Handle negative indices
		if (start < 0) start = sorted.length + start;
		if (stop < 0) stop = sorted.length + stop;

		const result = sorted.slice(start, stop + 1);

		// Handle WITHSCORES
		if (args.includes('WITHSCORES')) {
			const withScores: string[] = [];
			for (const member of result) {
				withScores.push(member, String(scores.get(member)));
			}
			return withScores;
		}

		return result;
	}

	async zrem(key: string, ...members: string[]): Promise<number> {
		const zset = this.data.get(key);
		if (!zset || typeof zset !== 'object' || !('_scores' in zset)) {
			return 0;
		}

		const typedZset = zset as ZSetData;
		const scores = typedZset._scores;
		if (!(scores instanceof Map)) {
			return 0;
		}

		let removed = 0;
		for (const member of members) {
			if (scores.delete(member)) {
				removed++;
			}
		}

		if (scores.size === 0) {
			this.data.delete(key);
		}

		return removed;
	}

	// Utility methods
	private checkExpiry(key: string): void {
		const expiry = this.expiry.get(key);
		if (expiry && expiry < Date.now()) {
			this.data.delete(key);
			this.expiry.delete(key);
		}
	}

	// Clean up all expired keys in batch
	private cleanupExpired(): void {
		if (this.isCleaningExpiry) return;
		this.isCleaningExpiry = true;
		try {
			const now = Date.now();
			const expiredKeys: string[] = [];

			for (const [key, expiry] of this.expiry.entries()) {
				if (expiry < now) {
					expiredKeys.push(key);
				}
			}

			for (const key of expiredKeys) {
				this.data.delete(key);
				this.expiry.delete(key);
			}
		} finally {
			this.isCleaningExpiry = false;
		}
	}

	private persist(): Promise<void> {
		if (!this.persistPath) return Promise.resolve();
		const pending = this.persistTail.then(() => this._doPersist());
		this.persistTail = pending.catch(() => undefined);
		return pending;
	}

	private async _doPersist(): Promise<void> {
		const dataSnapshot = new Map(this.data);
		const expirySnapshot = new Map(this.expiry);
		const serializableData: Array<[string, unknown]> = [];
		for (const [key, value] of dataSnapshot.entries()) {
			if (value instanceof Set) {
				serializableData.push([key, { _type: 'set', items: Array.from(value) }]);
			} else if (Array.isArray(value)) {
				serializableData.push([key, { _type: 'list', items: value }]);
			} else if (isRecord(value) && value._scores instanceof Map) {
				serializableData.push([
					key,
					{ _type: 'zset', entries: Array.from(value._scores.entries()) },
				]);
			} else if (value && typeof value === 'object' && !(value instanceof Map)) {
				serializableData.push([key, { _type: 'hash', data: value }]);
			} else {
				serializableData.push([key, value]);
			}
		}

		const data = {
			data: serializableData,
			expiry: Array.from(expirySnapshot.entries()),
		};

		await writeJSON(this.persistPath!, data);
		logger.debug('Persisted data', { entries: dataSnapshot.size });
	}

	// BullMQ specific compatibility
	async ping(): Promise<'PONG'> {
		return 'PONG';
	}

	async flushdb(): Promise<'OK'> {
		this.data.clear();
		this.expiry.clear();
		return 'OK';
	}

	async keys(pattern: string): Promise<string[]> {
		if (pattern === '*') {
			return Array.from(this.data.keys());
		}

		// Simple pattern matching (only supports * wildcard)
		const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
		return Array.from(this.data.keys()).filter((key) => regex.test(key));
	}

	// Make it compatible with IORedis
	on(event: string, listener: (...args: unknown[]) => void): this {
		super.on(event, listener);
		return this;
	}

	once(event: string, listener: (...args: unknown[]) => void): this {
		super.once(event, listener);
		return this;
	}
}
