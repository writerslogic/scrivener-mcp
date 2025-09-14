/**
 * Enterprise Performance Optimizer - Advanced caching, memory management, and optimization
 * Multi-layer caching with intelligent eviction, compression, and performance monitoring
 */

// @ts-expect-error - LRU cache version compatibility
import LRUCache from 'lru-cache';
import { EventEmitter } from 'events';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { generateHash, handleError } from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';
import type { TraceContext } from './observability.js';

const logger = getLogger('performance-optimizer');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Advanced Cache Interfaces
export interface CacheEntry<T> {
	value: T;
	compressed: boolean;
	size: number;
	createdAt: number;
	lastAccessed: number;
	accessCount: number;
	tags: string[];
	ttl?: number;
}

export interface CacheMetrics {
	hits: number;
	misses: number;
	hitRate: number;
	totalSize: number;
	entryCount: number;
	avgEntrySize: number;
	evictions: number;
	compressionRatio: number;
}

export interface PerformanceProfile {
	operationName: string;
	totalCalls: number;
	totalTime: number;
	avgTime: number;
	minTime: number;
	maxTime: number;
	p50: number;
	p95: number;
	p99: number;
	errorRate: number;
	lastCall: number;
}

// Multi-Level Cache with Intelligent Management
export class IntelligentCache<T = any> extends EventEmitter {
	private l1Cache: LRUCache<string, CacheEntry<T>>; // Memory cache
	private l2Cache = new Map<string, CacheEntry<Buffer>>(); // Compressed cache
	private accessPattern = new Map<string, number[]>(); // Track access patterns
	private compressionThreshold: number;
	private metrics: CacheMetrics;
	private cleanupInterval?: NodeJS.Timeout;

	constructor(options: {
		maxSize: number;
		maxAge?: number;
		compressionThreshold?: number;
		cleanupInterval?: number;
	}) {
		super();

		this.compressionThreshold = options.compressionThreshold || 1024; // 1KB

		this.l1Cache = new LRUCache<string, CacheEntry<T>>({
			max: options.maxSize,
			maxAge: options.maxAge || 1000 * 60 * 30, // 30 minutes default
			sizeCalculation: (entry: CacheEntry<T>) => entry.size,
			dispose: (value: CacheEntry<T>, key: string) => this.onEviction(key, value, 'l1'),
		});

		this.metrics = {
			hits: 0,
			misses: 0,
			hitRate: 0,
			totalSize: 0,
			entryCount: 0,
			avgEntrySize: 0,
			evictions: 0,
			compressionRatio: 0,
		};

		this.startCleanupProcess(options.cleanupInterval || 60000); // 1 minute
	}

	async get(key: string, context?: TraceContext): Promise<T | undefined> {
		const span = this.createSpan('cache-get', context);

		try {
			// Record access pattern
			this.recordAccess(key);

			// Try L1 cache first
			const l1Entry = this.l1Cache.get(key);
			if (l1Entry) {
				l1Entry.lastAccessed = Date.now();
				l1Entry.accessCount++;
				this.metrics.hits++;
				this.updateMetrics();
				this.finishSpan(span, { hit: true, level: 'l1', size: l1Entry.size });
				return l1Entry.value;
			}

			// Try L2 cache (compressed)
			const l2Entry = this.l2Cache.get(key);
			if (l2Entry) {
				const decompressed = await this.decompress(l2Entry.value);
				const value = JSON.parse(decompressed.toString());

				// Promote to L1
				const entry: CacheEntry<T> = {
					value,
					compressed: false,
					size: decompressed.length,
					createdAt: l2Entry.createdAt,
					lastAccessed: Date.now(),
					accessCount: l2Entry.accessCount + 1,
					tags: l2Entry.tags,
					ttl: l2Entry.ttl,
				};

				this.l1Cache.set(key, entry);
				this.l2Cache.delete(key);

				this.metrics.hits++;
				this.updateMetrics();
				this.finishSpan(span, { hit: true, level: 'l2', size: entry.size });
				return value;
			}

			this.metrics.misses++;
			this.updateMetrics();
			this.finishSpan(span, { hit: false });
			return undefined;
		} catch (error) {
			this.finishSpan(span, { error: (error as Error).message });
			throw handleError(error, 'cache-get');
		}
	}

	async set(
		key: string,
		value: T,
		options: {
			ttl?: number;
			tags?: string[];
			forceCompress?: boolean;
		} = {},
		context?: TraceContext
	): Promise<void> {
		const span = this.createSpan('cache-set', context);

		try {
			const serialized = JSON.stringify(value);
			const size = Buffer.byteLength(serialized);

			const entry: CacheEntry<T> = {
				value,
				compressed: false,
				size,
				createdAt: Date.now(),
				lastAccessed: Date.now(),
				accessCount: 0,
				tags: options.tags || [],
				ttl: options.ttl,
			};

			// Decide whether to compress based on size or force flag
			if (size > this.compressionThreshold || options.forceCompress) {
				await this.setCompressed(key, entry, context);
			} else {
				this.l1Cache.set(key, entry);
			}

			this.updateMetrics();
			this.finishSpan(span, { size, compressed: entry.compressed });
			this.emit('entry-set', { key, size, compressed: entry.compressed });
		} catch (error) {
			this.finishSpan(span, { error: (error as Error).message });
			throw handleError(error, 'cache-set');
		}
	}

	async setCompressed(key: string, entry: CacheEntry<T>, _context?: TraceContext): Promise<void> {
		const serialized = JSON.stringify(entry.value);
		const compressed = await this.compress(Buffer.from(serialized));

		const compressedEntry: CacheEntry<Buffer> = {
			value: compressed,
			compressed: true,
			size: compressed.length,
			createdAt: entry.createdAt,
			lastAccessed: entry.lastAccessed,
			accessCount: entry.accessCount,
			tags: entry.tags,
			ttl: entry.ttl,
		};

		this.l2Cache.set(key, compressedEntry);

		// Update compression ratio metric
		const originalSize = Buffer.byteLength(serialized);
		const ratio = compressed.length / originalSize;
		this.metrics.compressionRatio = (this.metrics.compressionRatio + ratio) / 2;
	}

	delete(key: string): boolean {
		const l1Deleted = this.l1Cache.delete(key);
		const l2Deleted = this.l2Cache.delete(key);

		if (l1Deleted || l2Deleted) {
			this.updateMetrics();
			this.emit('entry-deleted', { key });
			return true;
		}
		return false;
	}

	clear(): void {
		this.l1Cache.clear();
		this.l2Cache.clear();
		this.accessPattern.clear();
		this.resetMetrics();
		this.emit('cache-cleared');
	}

	// Tag-based cache invalidation
	invalidateByTag(tag: string): number {
		let invalidated = 0;

		// L1 cache
		for (const [key, entry] of this.l1Cache.entries()) {
			if (entry.tags.includes(tag)) {
				this.l1Cache.delete(key);
				invalidated++;
			}
		}

		// L2 cache
		for (const [key, entry] of this.l2Cache.entries()) {
			if (entry.tags.includes(tag)) {
				this.l2Cache.delete(key);
				invalidated++;
			}
		}

		this.updateMetrics();
		this.emit('tag-invalidation', { tag, count: invalidated });
		return invalidated;
	}

	// Batch operations for performance
	async mget(keys: string[], context?: TraceContext): Promise<Map<string, T>> {
		const span = this.createSpan('cache-mget', context);
		const results = new Map<string, T>();

		try {
			const promises = keys.map(async (key) => {
				const value = await this.get(key, context);
				if (value !== undefined) {
					results.set(key, value);
				}
			});

			await Promise.all(promises);
			this.finishSpan(span, { requestedKeys: keys.length, foundKeys: results.size });
			return results;
		} catch (error) {
			this.finishSpan(span, { error: (error as Error).message });
			throw handleError(error, 'cache-mget');
		}
	}

	async mset(
		entries: Array<{ key: string; value: T; options?: Record<string, unknown> }>,
		context?: TraceContext
	): Promise<void> {
		const span = this.createSpan('cache-mset', context);

		try {
			const promises = entries.map(({ key, value, options }) =>
				this.set(key, value, options, context)
			);

			await Promise.all(promises);
			this.finishSpan(span, { entryCount: entries.length });
		} catch (error) {
			this.finishSpan(span, { error: (error as Error).message });
			throw handleError(error, 'cache-mset');
		}
	}

	// Intelligent prefetching based on access patterns
	getPrefetchCandidates(limit: number = 10): string[] {
		const patterns = Array.from(this.accessPattern.entries())
			.map(([key, times]) => ({
				key,
				frequency: times.length,
				lastAccess: Math.max(...times),
				pattern: this.analyzeAccessPattern(times),
			}))
			.filter((item) => item.pattern.predictable && !this.l1Cache.has(item.key))
			.sort((a, b) => b.frequency - a.frequency)
			.slice(0, limit)
			.map((item) => item.key);

		return patterns;
	}

	private analyzeAccessPattern(times: number[]): { predictable: boolean; interval?: number } {
		if (times.length < 3) return { predictable: false };

		const intervals = [];
		for (let i = 1; i < times.length; i++) {
			intervals.push(times[i] - times[i - 1]);
		}

		const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
		const variance =
			intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) /
			intervals.length;
		const stdDev = Math.sqrt(variance);

		// Consider predictable if standard deviation is less than 20% of average
		const predictable = stdDev < avgInterval * 0.2;

		return { predictable, interval: predictable ? avgInterval : undefined };
	}

	private recordAccess(key: string): void {
		const times = this.accessPattern.get(key) || [];
		times.push(Date.now());

		// Keep only recent accesses (last 100)
		if (times.length > 100) {
			times.splice(0, times.length - 50);
		}

		this.accessPattern.set(key, times);
	}

	private async compress(data: Buffer): Promise<Buffer> {
		return await gzip(data);
	}

	private async decompress(data: Buffer): Promise<Buffer> {
		return await gunzip(data);
	}

	private onEviction(key: string, entry: CacheEntry<T>, level: 'l1' | 'l2'): void {
		this.metrics.evictions++;
		this.emit('entry-evicted', { key, level, size: entry.size });

		// If evicted from L1 and entry is frequently accessed, move to L2
		if (level === 'l1' && entry.accessCount > 5) {
			this.setCompressed(key, entry).catch((error) => {
				logger.warn('Failed to compress evicted entry', { key, error: error.message });
			});
		}
	}

	private updateMetrics(): void {
		this.metrics.entryCount = this.l1Cache.size + this.l2Cache.size;
		this.metrics.totalSize = this.calculateTotalSize();
		this.metrics.avgEntrySize =
			this.metrics.entryCount > 0 ? this.metrics.totalSize / this.metrics.entryCount : 0;
		this.metrics.hitRate = this.metrics.hits / (this.metrics.hits + this.metrics.misses) || 0;
	}

	private calculateTotalSize(): number {
		let size = 0;

		for (const entry of this.l1Cache.values()) {
			size += entry.size;
		}

		for (const entry of this.l2Cache.values()) {
			size += entry.size;
		}

		return size;
	}

	private resetMetrics(): void {
		this.metrics = {
			hits: 0,
			misses: 0,
			hitRate: 0,
			totalSize: 0,
			entryCount: 0,
			avgEntrySize: 0,
			evictions: 0,
			compressionRatio: 0,
		};
	}

	private startCleanupProcess(interval: number): void {
		this.cleanupInterval = setInterval(() => {
			this.runCleanup();
		}, interval);
	}

	private runCleanup(): void {
		const now = Date.now();
		let cleaned = 0;

		// Clean expired L2 entries
		for (const [key, entry] of this.l2Cache.entries()) {
			if (entry.ttl && now - entry.createdAt > entry.ttl) {
				this.l2Cache.delete(key);
				cleaned++;
			}
		}

		// Clean old access patterns
		for (const [key, times] of this.accessPattern.entries()) {
			const recentTimes = times.filter((time) => now - time < 24 * 60 * 60 * 1000); // 24 hours
			if (recentTimes.length === 0) {
				this.accessPattern.delete(key);
			} else if (recentTimes.length !== times.length) {
				this.accessPattern.set(key, recentTimes);
			}
		}

		if (cleaned > 0) {
			this.updateMetrics();
			this.emit('cleanup-completed', { entriesRemoved: cleaned });
		}
	}

	private createSpan(operation: string, parentContext?: TraceContext): TraceContext {
		return {
			traceId: parentContext?.traceId || generateHash(`trace-${Date.now()}-${Math.random()}`),
			spanId: generateHash(`span-${Date.now()}-${Math.random()}`),
			baggage: { ...parentContext?.baggage, cacheOperation: operation },
		};
	}

	private finishSpan(span: TraceContext, data: Record<string, any>): void {
		// Emit span data for observability
		this.emit('span-finished', { ...span, ...data });
	}

	getMetrics(): CacheMetrics {
		this.updateMetrics();
		return { ...this.metrics };
	}

	destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}
		this.clear();
		this.removeAllListeners();
	}
}

// Performance Profiler for Operation Monitoring
export class PerformanceProfiler {
	private profiles = new Map<string, PerformanceProfile>();
	private responseTimes = new Map<string, number[]>();

	async profile<T>(
		operationName: string,
		operation: () => Promise<T>,
		_context?: TraceContext
	): Promise<T> {
		const startTime = Date.now();

		try {
			const result = await operation();
			this.recordSuccess(operationName, Date.now() - startTime);
			return result;
		} catch (error) {
			this.recordError(operationName, Date.now() - startTime);
			throw error;
		}
	}

	private recordSuccess(operationName: string, duration: number): void {
		this.updateProfile(operationName, duration, false);
	}

	private recordError(operationName: string, duration: number): void {
		this.updateProfile(operationName, duration, true);
	}

	private updateProfile(operationName: string, duration: number, isError: boolean): void {
		const profile = this.profiles.get(operationName) || {
			operationName,
			totalCalls: 0,
			totalTime: 0,
			avgTime: 0,
			minTime: Infinity,
			maxTime: 0,
			p50: 0,
			p95: 0,
			p99: 0,
			errorRate: 0,
			lastCall: 0,
		};

		profile.totalCalls++;
		profile.totalTime += duration;
		profile.avgTime = profile.totalTime / profile.totalCalls;
		profile.minTime = Math.min(profile.minTime, duration);
		profile.maxTime = Math.max(profile.maxTime, duration);
		profile.lastCall = Date.now();

		if (isError) {
			profile.errorRate =
				(profile.errorRate * (profile.totalCalls - 1) + 1) / profile.totalCalls;
		} else {
			profile.errorRate = (profile.errorRate * (profile.totalCalls - 1)) / profile.totalCalls;
		}

		// Track response times for percentile calculation
		const times = this.responseTimes.get(operationName) || [];
		times.push(duration);

		// Keep only recent measurements
		if (times.length > 1000) {
			times.splice(0, 500);
		}

		this.responseTimes.set(operationName, times);

		// Calculate percentiles
		const sortedTimes = times.slice().sort((a, b) => a - b);
		profile.p50 = sortedTimes[Math.floor(sortedTimes.length * 0.5)] || 0;
		profile.p95 = sortedTimes[Math.floor(sortedTimes.length * 0.95)] || 0;
		profile.p99 = sortedTimes[Math.floor(sortedTimes.length * 0.99)] || 0;

		this.profiles.set(operationName, profile);
	}

	getProfile(operationName: string): PerformanceProfile | undefined {
		return this.profiles.get(operationName);
	}

	getAllProfiles(): PerformanceProfile[] {
		return Array.from(this.profiles.values());
	}

	getTopSlowestOperations(limit: number = 10): PerformanceProfile[] {
		return Array.from(this.profiles.values())
			.sort((a, b) => b.avgTime - a.avgTime)
			.slice(0, limit);
	}

	getHighErrorRateOperations(threshold: number = 0.05): PerformanceProfile[] {
		return Array.from(this.profiles.values())
			.filter((profile) => profile.errorRate > threshold)
			.sort((a, b) => b.errorRate - a.errorRate);
	}

	reset(): void {
		this.profiles.clear();
		this.responseTimes.clear();
	}
}
