/**
 * LangChain Optimization Layer
 * Provides caching, rate limiting, and performance optimizations
 */

import crypto from 'crypto';
import type { Document as LangchainDocument } from 'langchain/document';
import type { ScrivenerDocument } from '../../types/index.js';
import { getLogger } from '../../core/logger.js';
import { createError, ErrorCode } from '../../core/errors.js';

interface CacheOptions {
	maxSize?: number; // Maximum number of items
	ttl?: number; // Time to live in milliseconds
	updateAgeOnGet?: boolean; // Refresh TTL on access
}

interface RateLimitOptions {
	maxRequests: number;
	windowMs: number;
	strategy?: 'sliding' | 'fixed';
}

interface QueryCache {
	query: string;
	results: LangchainDocument[];
	timestamp: number;
	hits: number;
}

interface GenerationCache {
	prompt: string;
	context?: string;
	response: string;
	timestamp: number;
	hits: number;
}

interface VectorStoreCache {
	documentIds: string[];
	checksum: string;
	timestamp: number;
	size: number;
}

/**
 * Simple LRU Cache implementation
 */
class SimpleLRUCache<K, V> {
	private cache: Map<K, { value: V; timestamp: number }> = new Map();
	private accessOrder: K[] = [];
	private maxSize: number;
	private ttl: number;
	private disposeFn?: () => void;

	constructor(options: { max: number; ttl?: number; dispose?: () => void }) {
		this.maxSize = options.max;
		this.ttl = options.ttl || Infinity;
		this.disposeFn = options.dispose;
	}

	set(key: K, value: V): void {
		// Remove old entry if exists
		if (this.cache.has(key)) {
			const index = this.accessOrder.indexOf(key);
			if (index > -1) {
				this.accessOrder.splice(index, 1);
			}
		}

		// Add to end (most recently used)
		this.accessOrder.push(key);
		this.cache.set(key, { value, timestamp: Date.now() });

		// Evict oldest if over size limit
		while (this.accessOrder.length > this.maxSize) {
			const oldestKey = this.accessOrder.shift();
			if (oldestKey) {
				this.cache.delete(oldestKey);
				if (this.disposeFn) this.disposeFn();
			}
		}
	}

	get(key: K): V | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;

		// Check TTL
		if (Date.now() - entry.timestamp > this.ttl) {
			this.delete(key);
			return undefined;
		}

		// Move to end (most recently used)
		const index = this.accessOrder.indexOf(key);
		if (index > -1) {
			this.accessOrder.splice(index, 1);
			this.accessOrder.push(key);
		}

		return entry.value;
	}

	delete(key: K): void {
		this.cache.delete(key);
		const index = this.accessOrder.indexOf(key);
		if (index > -1) {
			this.accessOrder.splice(index, 1);
		}
	}

	clear(): void {
		this.cache.clear();
		this.accessOrder = [];
	}

	get size(): number {
		return this.cache.size;
	}

	forEach(callback: (value: V, key: K) => void): void {
		this.cache.forEach((entry, key) => {
			if (Date.now() - entry.timestamp <= this.ttl) {
				callback(entry.value, key);
			}
		});
	}
}

/**
 * Caching layer for LangChain operations
 */
export class LangChainCache {
	private queryCache: SimpleLRUCache<string, QueryCache>;
	private generationCache: SimpleLRUCache<string, GenerationCache>;
	private vectorStoreCache: SimpleLRUCache<string, VectorStoreCache>;
	private embeddingCache: SimpleLRUCache<string, number[]>;
	private logger: ReturnType<typeof getLogger>;
	private stats = {
		hits: 0,
		misses: 0,
		evictions: 0,
		totalSaved: 0, // Estimated tokens saved
	};

	constructor(options: CacheOptions = {}) {
		this.logger = getLogger('langchain-cache');

		const defaultOptions = {
			max: options.maxSize || 500,
			ttl: options.ttl || 1000 * 60 * 30, // 30 minutes default
			updateAgeOnGet: options.updateAgeOnGet ?? true,
		};

		// Initialize different caches with appropriate sizes
		this.queryCache = new SimpleLRUCache<string, QueryCache>({
			...defaultOptions,
			max: Math.floor(defaultOptions.max * 0.3), // 30% for queries
			dispose: () => this.stats.evictions++,
		});

		this.generationCache = new SimpleLRUCache<string, GenerationCache>({
			...defaultOptions,
			max: Math.floor(defaultOptions.max * 0.4), // 40% for generations
			dispose: () => this.stats.evictions++,
		});

		this.vectorStoreCache = new SimpleLRUCache<string, VectorStoreCache>({
			...defaultOptions,
			max: 10, // Limited vector store versions
			ttl: defaultOptions.ttl * 2, // Longer TTL for vector stores
		});

		this.embeddingCache = new SimpleLRUCache<string, number[]>({
			...defaultOptions,
			max: Math.floor(defaultOptions.max * 0.3), // 30% for embeddings
		});
	}

	/**
	 * Generate cache key from input
	 */
	private generateKey(...args: unknown[]): string {
		const hash = crypto.createHash('sha256');
		hash.update(JSON.stringify(args));
		return hash.digest('hex').substring(0, 16);
	}

	/**
	 * Cache semantic search results
	 */
	cacheQuery(query: string, results: LangchainDocument[]): void {
		const key = this.generateKey('query', query);
		const existing = this.queryCache.get(key);
		
		this.queryCache.set(key, {
			query,
			results,
			timestamp: Date.now(),
			hits: existing ? existing.hits + 1 : 0,
		});
	}

	/**
	 * Get cached query results
	 */
	getCachedQuery(query: string): LangchainDocument[] | null {
		const key = this.generateKey('query', query);
		const cached = this.queryCache.get(key);
		
		if (cached) {
			this.stats.hits++;
			cached.hits++;
			this.logger.debug(`Cache hit for query: ${query.substring(0, 50)}...`);
			return cached.results;
		}
		
		this.stats.misses++;
		return null;
	}

	/**
	 * Cache generation results
	 */
	cacheGeneration(prompt: string, response: string, context?: string): void {
		const key = this.generateKey('generation', prompt, context);
		const existing = this.generationCache.get(key);
		
		this.generationCache.set(key, {
			prompt,
			context,
			response,
			timestamp: Date.now(),
			hits: existing ? existing.hits + 1 : 0,
		});

		// Estimate tokens saved (rough approximation)
		if (existing) {
			this.stats.totalSaved += Math.ceil(prompt.length / 4) + Math.ceil(response.length / 4);
		}
	}

	/**
	 * Get cached generation
	 */
	getCachedGeneration(prompt: string, context?: string): string | null {
		const key = this.generateKey('generation', prompt, context);
		const cached = this.generationCache.get(key);
		
		if (cached) {
			this.stats.hits++;
			cached.hits++;
			this.logger.debug(`Cache hit for generation prompt: ${prompt.substring(0, 50)}...`);
			return cached.response;
		}
		
		this.stats.misses++;
		return null;
	}

	/**
	 * Cache embeddings
	 */
	cacheEmbedding(text: string, embedding: number[]): void {
		const key = this.generateKey('embedding', text);
		this.embeddingCache.set(key, embedding);
	}

	/**
	 * Get cached embedding
	 */
	getCachedEmbedding(text: string): number[] | null {
		const key = this.generateKey('embedding', text);
		return this.embeddingCache.get(key) || null;
	}

	/**
	 * Check if vector store needs rebuild
	 */
	shouldRebuildVectorStore(documents: ScrivenerDocument[]): boolean {
		const documentIds = documents.map(d => d.id).sort();
		const checksum = this.generateKey(...documentIds, ...documents.map(d => d.content?.length || 0));
		const key = 'current';
		
		const cached = this.vectorStoreCache.get(key);
		if (!cached) {
			// No cache, should build
			this.vectorStoreCache.set(key, {
				documentIds,
				checksum,
				timestamp: Date.now(),
				size: documents.length,
			});
			return true;
		}

		// Check if documents changed
		if (cached.checksum !== checksum) {
			this.vectorStoreCache.set(key, {
				documentIds,
				checksum,
				timestamp: Date.now(),
				size: documents.length,
			});
			return true;
		}

		return false; // No rebuild needed
	}

	/**
	 * Clear all caches
	 */
	clear(): void {
		this.queryCache.clear();
		this.generationCache.clear();
		this.vectorStoreCache.clear();
		this.embeddingCache.clear();
		this.logger.info('All caches cleared');
	}

	/**
	 * Get cache statistics
	 */
	getStatistics(): {
		hits: number;
		misses: number;
		hitRate: number;
		evictions: number;
		totalSaved: number;
		sizes: {
			queries: number;
			generations: number;
			embeddings: number;
			vectorStores: number;
		};
	} {
		const total = this.stats.hits + this.stats.misses;
		return {
			...this.stats,
			hitRate: total > 0 ? this.stats.hits / total : 0,
			sizes: {
				queries: this.queryCache.size,
				generations: this.generationCache.size,
				embeddings: this.embeddingCache.size,
				vectorStores: this.vectorStoreCache.size,
			},
		};
	}

	/**
	 * Prune old entries
	 */
	prune(): void {
		const pruned = {
			queries: 0,
			generations: 0,
		};

		// Prune queries with low hit count
		this.queryCache.forEach((value, key) => {
			if (value.hits === 0 && Date.now() - value.timestamp > 1000 * 60 * 10) {
				this.queryCache.delete(key);
				pruned.queries++;
			}
		});

		// Prune generations with low hit count
		this.generationCache.forEach((value, key) => {
			if (value.hits === 0 && Date.now() - value.timestamp > 1000 * 60 * 10) {
				this.generationCache.delete(key);
				pruned.generations++;
			}
		});

		if (pruned.queries > 0 || pruned.generations > 0) {
			this.logger.debug(`Pruned ${pruned.queries} queries and ${pruned.generations} generations`);
		}
	}
}

/**
 * Rate limiter for API calls
 */
export class LangChainRateLimiter {
	private requests: Map<string, number[]> = new Map();
	private blocked: Set<string> = new Set();
	private logger: ReturnType<typeof getLogger>;
	private options: Required<RateLimitOptions>;

	constructor(options: RateLimitOptions) {
		this.logger = getLogger('langchain-rate-limiter');
		this.options = {
			...options,
			strategy: options.strategy || 'sliding',
		};

		// Clean up old entries periodically
		setInterval(() => this.cleanup(), this.options.windowMs);
	}

	/**
	 * Check if request is allowed
	 */
	async checkLimit(identifier: string = 'global'): Promise<boolean> {
		if (this.blocked.has(identifier)) {
			const requests = this.requests.get(identifier) || [];
			const oldestAllowed = Date.now() - this.options.windowMs;
			const recentRequests = requests.filter(time => time > oldestAllowed);
			
			if (recentRequests.length < this.options.maxRequests) {
				this.blocked.delete(identifier);
			} else {
				return false;
			}
		}

		const now = Date.now();
		const requests = this.requests.get(identifier) || [];
		
		if (this.options.strategy === 'sliding') {
			// Sliding window
			const oldestAllowed = now - this.options.windowMs;
			const recentRequests = requests.filter(time => time > oldestAllowed);
			
			if (recentRequests.length >= this.options.maxRequests) {
				this.blocked.add(identifier);
				this.logger.warn(`Rate limit exceeded for ${identifier}`);
				return false;
			}
			
			recentRequests.push(now);
			this.requests.set(identifier, recentRequests);
		} else {
			// Fixed window
			const windowStart = Math.floor(now / this.options.windowMs) * this.options.windowMs;
			const windowRequests = requests.filter(time => time >= windowStart);
			
			if (windowRequests.length >= this.options.maxRequests) {
				this.blocked.add(identifier);
				this.logger.warn(`Rate limit exceeded for ${identifier}`);
				return false;
			}
			
			windowRequests.push(now);
			this.requests.set(identifier, windowRequests);
		}

		return true;
	}

	/**
	 * Wait until rate limit allows request
	 */
	async waitForLimit(identifier: string = 'global'): Promise<void> {
		while (!(await this.checkLimit(identifier))) {
			// Calculate wait time
			const requests = this.requests.get(identifier) || [];
			const oldestRequest = Math.min(...requests);
			const waitTime = Math.max(100, this.options.windowMs - (Date.now() - oldestRequest));
			
			this.logger.debug(`Waiting ${waitTime}ms for rate limit`);
			await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 1000)));
		}
	}

	/**
	 * Clean up old request records
	 */
	private cleanup(): void {
		const now = Date.now();
		const oldestAllowed = now - this.options.windowMs * 2;

		this.requests.forEach((times, identifier) => {
			const filtered = times.filter(time => time > oldestAllowed);
			if (filtered.length === 0) {
				this.requests.delete(identifier);
				this.blocked.delete(identifier);
			} else {
				this.requests.set(identifier, filtered);
			}
		});
	}

	/**
	 * Get current usage statistics
	 */
	getStatistics(): Record<string, { requests: number; blocked: boolean }> {
		const stats: Record<string, { requests: number; blocked: boolean }> = {};
		const now = Date.now();
		const oldestAllowed = now - this.options.windowMs;

		this.requests.forEach((times, identifier) => {
			const recentRequests = times.filter(time => time > oldestAllowed);
			stats[identifier] = {
				requests: recentRequests.length,
				blocked: this.blocked.has(identifier),
			};
		});

		return stats;
	}

	/**
	 * Reset rate limits
	 */
	reset(identifier?: string): void {
		if (identifier) {
			this.requests.delete(identifier);
			this.blocked.delete(identifier);
		} else {
			this.requests.clear();
			this.blocked.clear();
		}
		this.logger.info(`Rate limits reset${identifier ? ` for ${identifier}` : ''}`);
	}
}

/**
 * Performance monitor for LangChain operations
 */
export class LangChainPerformanceMonitor {
	private metrics: Map<string, {
		count: number;
		totalTime: number;
		minTime: number;
		maxTime: number;
		errors: number;
	}> = new Map();
	private logger: ReturnType<typeof getLogger>;

	constructor() {
		this.logger = getLogger('langchain-performance');
	}

	/**
	 * Start timing an operation
	 */
	startOperation(operation: string): () => void {
		const startTime = Date.now();
		
		return () => {
			const duration = Date.now() - startTime;
			this.recordMetric(operation, duration);
		};
	}

	/**
	 * Record a metric
	 */
	private recordMetric(operation: string, duration: number, error: boolean = false): void {
		const existing = this.metrics.get(operation) || {
			count: 0,
			totalTime: 0,
			minTime: Infinity,
			maxTime: 0,
			errors: 0,
		};

		this.metrics.set(operation, {
			count: existing.count + 1,
			totalTime: existing.totalTime + duration,
			minTime: Math.min(existing.minTime, duration),
			maxTime: Math.max(existing.maxTime, duration),
			errors: existing.errors + (error ? 1 : 0),
		});
	}

	/**
	 * Record an error
	 */
	recordError(operation: string): void {
		const existing = this.metrics.get(operation);
		if (existing) {
			existing.errors++;
		} else {
			this.metrics.set(operation, {
				count: 0,
				totalTime: 0,
				minTime: Infinity,
				maxTime: 0,
				errors: 1,
			});
		}
	}

	/**
	 * Get performance statistics
	 */
	getStatistics(): Record<string, {
		count: number;
		averageTime: number;
		minTime: number;
		maxTime: number;
		errorRate: number;
	}> {
		const stats: Record<string, {
			count: number;
			averageTime: number;
			minTime: number;
			maxTime: number;
			errorRate: number;
		}> = {};

		this.metrics.forEach((metric, operation) => {
			stats[operation] = {
				count: metric.count,
				averageTime: metric.count > 0 ? metric.totalTime / metric.count : 0,
				minTime: metric.minTime === Infinity ? 0 : metric.minTime,
				maxTime: metric.maxTime,
				errorRate: metric.count > 0 ? metric.errors / metric.count : 0,
			};
		});

		return stats;
	}

	/**
	 * Get slow operations
	 */
	getSlowOperations(thresholdMs: number = 5000): Array<{
		operation: string;
		averageTime: number;
		count: number;
	}> {
		const slow: Array<{
			operation: string;
			averageTime: number;
			count: number;
		}> = [];

		this.metrics.forEach((metric, operation) => {
			const avgTime = metric.count > 0 ? metric.totalTime / metric.count : 0;
			if (avgTime > thresholdMs) {
				slow.push({
					operation,
					averageTime: avgTime,
					count: metric.count,
				});
			}
		});

		return slow.sort((a, b) => b.averageTime - a.averageTime);
	}

	/**
	 * Reset metrics
	 */
	reset(): void {
		this.metrics.clear();
		this.logger.info('Performance metrics reset');
	}
}

/**
 * Batch processor for efficient API usage
 */
export class LangChainBatchProcessor {
	private queue: Map<string, {
		items: Array<{ id: string; data: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }>;
		timer?: NodeJS.Timeout;
	}> = new Map();
	private logger: ReturnType<typeof getLogger>;
	private options: {
		maxBatchSize: number;
		maxWaitTime: number;
		processor: (batch: unknown[]) => Promise<unknown[]>;
	};

	constructor(options: {
		maxBatchSize?: number;
		maxWaitTime?: number;
		processor: (batch: unknown[]) => Promise<unknown[]>;
	}) {
		this.logger = getLogger('langchain-batch');
		this.options = {
			maxBatchSize: options.maxBatchSize || 10,
			maxWaitTime: options.maxWaitTime || 100,
			processor: options.processor,
		};
	}

	/**
	 * Add item to batch queue
	 */
	async add<T>(type: string, data: T): Promise<T> {
		return new Promise((resolve, reject) => {
			const queue = this.queue.get(type) || { items: [] };
			
			queue.items.push({
				id: crypto.randomUUID(),
				data,
				resolve: resolve as (value: unknown) => void,
				reject,
			});

			// Process immediately if batch is full
			if (queue.items.length >= this.options.maxBatchSize) {
				this.processBatch(type);
			} else {
				// Set timer for max wait time
				if (!queue.timer) {
					queue.timer = setTimeout(() => {
						this.processBatch(type);
					}, this.options.maxWaitTime);
				}
			}

			this.queue.set(type, queue);
		});
	}

	/**
	 * Process a batch
	 */
	private async processBatch(type: string): Promise<void> {
		const queue = this.queue.get(type);
		if (!queue || queue.items.length === 0) return;

		// Clear timer
		if (queue.timer) {
			clearTimeout(queue.timer);
			queue.timer = undefined;
		}

		// Get items to process
		const items = queue.items.splice(0, this.options.maxBatchSize);
		const batchData = items.map(item => item.data);

		try {
			this.logger.debug(`Processing batch of ${items.length} items for ${type}`);
			const results = await this.options.processor(batchData);

			// Resolve individual promises
			items.forEach((item, index) => {
				item.resolve(results[index]);
			});
		} catch (error) {
			// Reject all promises in batch
			items.forEach(item => {
				item.reject(error as Error);
			});
		}

		// Process next batch if items remain
		if (queue.items.length > 0) {
			setImmediate(() => this.processBatch(type));
		}
	}

	/**
	 * Flush all pending batches
	 */
	async flush(): Promise<void> {
		const promises: Promise<void>[] = [];
		
		this.queue.forEach((_, type) => {
			promises.push(this.processBatch(type));
		});

		await Promise.all(promises);
	}
}

// Export optimization utilities
export const optimizations = {
	cache: LangChainCache,
	rateLimiter: LangChainRateLimiter,
	performanceMonitor: LangChainPerformanceMonitor,
	batchProcessor: LangChainBatchProcessor,
};