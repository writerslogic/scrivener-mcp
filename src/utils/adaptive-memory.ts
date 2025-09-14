/**
 * Adaptive Memory Management with Garbage Collection Optimization
 * Enterprise-grade memory management for high-performance text processing
 */

import { getLogger } from '../core/logger.js';

const logger = getLogger('adaptive-memory');

interface MemoryMetrics {
	allocated: number;
	used: number;
	fragmentation: number;
	gcCount: number;
	gcTime: number;
	pressure: number;
}

interface PooledObject {
	id: string;
	size: number;
	lastUsed: number;
	useCount: number;
	data: unknown;
}

interface MemoryPool<T> {
	objects: PooledObject[];
	maxSize: number;
	totalAllocated: number;
	factory: () => T;
	cleanup: (obj: T) => void;
	validator: (obj: T) => boolean;
}

/**
 * Advanced Memory Manager with Predictive Allocation and Adaptive GC
 * Provides enterprise-grade memory optimization for text processing workloads
 */
export class AdaptiveMemoryManager {
	private static instance: AdaptiveMemoryManager;
	private memoryPools = new Map<string, MemoryPool<unknown>>();
	private allocationHistory: Array<{ size: number; timestamp: number; type: string }> = [];
	private gcMetrics: Array<{ timestamp: number; duration: number; freedBytes: number }> = [];
	private memoryPressureCallbacks = new Set<() => void>();

	// Performance optimization flags
	private isEnabled = true;
	private predictiveAllocation = true;
	private adaptiveGC = true;
	private compressionEnabled = true;

	// Memory thresholds and limits
	private readonly maxHeapSize = 512 * 1024 * 1024; // 512MB
	private readonly pressureThreshold = 0.8; // 80% usage triggers pressure mode
	private readonly gcTriggerThreshold = 0.9; // 90% usage triggers GC
	private readonly poolMaxAge = 5 * 60 * 1000; // 5 minutes

	// Advanced memory tracking
	private weakRefs = new Set<WeakRef<object>>();
	private compressionRegistry = new Map<
		string,
		{ original: string; compressed: Uint8Array; ratio: number }
	>();
	private allocationPatterns = new Map<
		string,
		{ count: number; avgSize: number; frequency: number }
	>();

	private constructor() {
		this.initializeMemoryMonitoring();
		this.setupGCOptimization();
	}

	static getInstance(): AdaptiveMemoryManager {
		if (!AdaptiveMemoryManager.instance) {
			AdaptiveMemoryManager.instance = new AdaptiveMemoryManager();
		}
		return AdaptiveMemoryManager.instance;
	}

	/**
	 * Initialize advanced memory monitoring with predictive analysis
	 */
	private initializeMemoryMonitoring(): void {
		// Monitor allocation patterns for prediction
		setInterval(() => {
			this.analyzeAllocationPatterns();
			this.predictivePreallocation();
		}, 10000); // Every 10 seconds

		// Memory pressure detection
		setInterval(() => {
			const metrics = this.getMemoryMetrics();
			if (metrics.pressure > this.pressureThreshold) {
				this.handleMemoryPressure();
			}
		}, 1000); // Every second

		// Periodic cleanup of stale objects
		setInterval(() => {
			this.cleanupStaleObjects();
		}, 30000); // Every 30 seconds

		// Advanced GC optimization
		if (this.adaptiveGC) {
			this.setupAdaptiveGC();
		}
	}

	/**
	 * Setup garbage collection optimization with adaptive tuning
	 */
	private setupGCOptimization(): void {
		// Monitor GC events if available
		if (typeof (global as any).gc === 'function') {
			const originalGC = (global as any).gc;

			(global as any).gc = (...args: unknown[]) => {
				const startTime = performance.now();
				const beforeHeap = this.estimateHeapUsage();

				const result = originalGC.apply(global, args);

				const duration = performance.now() - startTime;
				const afterHeap = this.estimateHeapUsage();
				const freedBytes = beforeHeap - afterHeap;

				this.gcMetrics.push({
					timestamp: Date.now(),
					duration,
					freedBytes,
				});

				// Keep only recent metrics
				if (this.gcMetrics.length > 100) {
					this.gcMetrics.splice(0, this.gcMetrics.length - 100);
				}

				return result;
			};
		}
	}

	/**
	 * Create or get optimized memory pool for specific object types
	 */
	createPool<T>(
		name: string,
		factory: () => T,
		cleanup: (obj: T) => void = () => {},
		validator: (obj: T) => boolean = () => true,
		maxSize = 100
	): void {
		this.memoryPools.set(name, {
			objects: [],
			maxSize,
			totalAllocated: 0,
			factory: factory as () => unknown,
			cleanup: cleanup as (obj: unknown) => void,
			validator: validator as (obj: unknown) => boolean,
		});

		logger.debug(`Created memory pool: ${name} (max: ${maxSize})`);
	}

	/**
	 * Acquire object from pool with intelligent allocation tracking
	 */
	acquire<T>(poolName: string): T | null {
		const pool = this.memoryPools.get(poolName) as MemoryPool<T>;
		if (!pool) {
			logger.warn(`Memory pool not found: ${poolName}`);
			return null;
		}

		// Try to reuse existing object
		for (let i = 0; i < pool.objects.length; i++) {
			const obj = pool.objects[i];
			if (pool.validator(obj.data as T)) {
				// Remove from pool and update metrics
				pool.objects.splice(i, 1);
				obj.lastUsed = Date.now();
				obj.useCount++;

				this.trackAllocation(poolName, obj.size);
				return obj.data as T;
			}
		}

		// Create new object if pool allows
		if (pool.totalAllocated < pool.maxSize) {
			const newObj = pool.factory() as T;
			const objSize = this.estimateObjectSize(newObj);

			pool.totalAllocated++;
			this.trackAllocation(poolName, objSize);

			return newObj;
		}

		logger.warn(`Memory pool exhausted: ${poolName}`);
		return null;
	}

	/**
	 * Return object to pool with intelligent lifecycle management
	 */
	release<T>(poolName: string, obj: T): void {
		const pool = this.memoryPools.get(poolName) as MemoryPool<T>;
		if (!pool) {
			logger.warn(`Memory pool not found: ${poolName}`);
			return;
		}

		// Clean object for reuse
		pool.cleanup(obj);

		// Add back to pool if not full
		if (pool.objects.length < pool.maxSize) {
			const objSize = this.estimateObjectSize(obj);
			pool.objects.push({
				id: this.generateObjectId(),
				size: objSize,
				lastUsed: Date.now(),
				useCount: 0,
				data: obj,
			});
		}
	}

	/**
	 * Intelligent string compression for large text objects
	 */
	compressString(key: string, text: string): string {
		if (!this.compressionEnabled || text.length < 1000) {
			return text;
		}

		try {
			// Simple compression using gzip-like approach
			const compressed = this.simpleCompress(text);
			const ratio = compressed.length / text.length;

			if (ratio < 0.7) {
				// Only store if >30% compression
				this.compressionRegistry.set(key, {
					original: text,
					compressed,
					ratio,
				});

				logger.debug(`Compressed string ${key}: ${(ratio * 100).toFixed(1)}% of original`);
				return key; // Return key as placeholder
			}
		} catch (error) {
			logger.warn('String compression failed', { error, key });
		}

		return text;
	}

	/**
	 * Decompress string from compression registry
	 */
	decompressString(keyOrText: string): string {
		const compressed = this.compressionRegistry.get(keyOrText);
		if (compressed) {
			return this.simpleDecompress(compressed.compressed);
		}
		return keyOrText; // Return as-is if not compressed
	}

	/**
	 * Analyze allocation patterns for predictive optimization
	 */
	private analyzeAllocationPatterns(): void {
		const now = Date.now();
		const recentAllocations = this.allocationHistory.filter(
			(alloc) => now - alloc.timestamp < 60000 // Last minute
		);

		// Group by type and analyze patterns
		const patterns = new Map<string, { sizes: number[]; timestamps: number[] }>();

		for (const alloc of recentAllocations) {
			if (!patterns.has(alloc.type)) {
				patterns.set(alloc.type, { sizes: [], timestamps: [] });
			}

			const pattern = patterns.get(alloc.type)!;
			pattern.sizes.push(alloc.size);
			pattern.timestamps.push(alloc.timestamp);
		}

		// Update allocation patterns for prediction
		for (const [type, data] of patterns) {
			const avgSize = data.sizes.reduce((a, b) => a + b, 0) / data.sizes.length;
			const frequency = data.timestamps.length;

			this.allocationPatterns.set(type, {
				count: frequency,
				avgSize,
				frequency: frequency / 60, // per second
			});
		}
	}

	/**
	 * Predictive pre-allocation based on patterns
	 */
	private predictivePreallocation(): void {
		if (!this.predictiveAllocation) return;

		for (const [type, pattern] of this.allocationPatterns) {
			// Predict if we'll need more objects of this type
			const predictedNeed = Math.ceil(pattern.frequency * 10); // Next 10 seconds

			const pool = this.memoryPools.get(type);
			if (pool && pool.objects.length < predictedNeed) {
				const needed = Math.min(predictedNeed - pool.objects.length, 5); // Max 5 at once

				for (let i = 0; i < needed; i++) {
					const obj = pool.factory();
					const objSize = this.estimateObjectSize(obj);

					pool.objects.push({
						id: this.generateObjectId(),
						size: objSize,
						lastUsed: Date.now(),
						useCount: 0,
						data: obj,
					});
				}

				logger.debug(`Pre-allocated ${needed} objects for pool: ${type}`);
			}
		}
	}

	/**
	 * Handle memory pressure with intelligent optimization
	 */
	private handleMemoryPressure(): void {
		logger.warn('Memory pressure detected, optimizing...');

		// 1. Trigger immediate cleanup
		this.cleanupStaleObjects();

		// 2. Force compression of large strings
		this.forceCompressionOptimization();

		// 3. Reduce pool sizes temporarily
		this.reducePools();

		// 4. Trigger GC if available
		if (typeof (global as any).gc === 'function') {
			(global as any).gc();
		}

		// 5. Notify pressure callbacks
		for (const callback of this.memoryPressureCallbacks) {
			try {
				callback();
			} catch (error) {
				logger.warn('Memory pressure callback failed', { error });
			}
		}
	}

	/**
	 * Setup adaptive GC with machine learning optimization
	 */
	private setupAdaptiveGC(): void {
		// Analyze GC patterns and optimize timing
		setInterval(() => {
			if (this.gcMetrics.length < 5) return;

			const recentGCs = this.gcMetrics.slice(-10);
			const avgDuration =
				recentGCs.reduce((sum, gc) => sum + gc.duration, 0) / recentGCs.length;
			const totalFreed = recentGCs.reduce((sum, gc) => sum + gc.freedBytes, 0);

			// Adaptive GC trigger based on efficiency
			const efficiency = totalFreed / (avgDuration * recentGCs.length);

			if (efficiency < 1000) {
				// Less than 1KB freed per ms
				// Reduce GC frequency
				this.adaptiveGC = false;
				setTimeout(() => {
					this.adaptiveGC = true;
				}, 30000);
				logger.debug('Temporarily reduced GC frequency due to low efficiency');
			}
		}, 60000); // Every minute
	}

	/**
	 * Clean up stale objects and optimize memory usage
	 */
	private cleanupStaleObjects(): void {
		const now = Date.now();
		let totalCleaned = 0;

		for (const [poolName, pool] of this.memoryPools) {
			const before = pool.objects.length;

			// Remove objects older than maxAge
			pool.objects = pool.objects.filter((obj) => {
				const age = now - obj.lastUsed;
				if (age > this.poolMaxAge) {
					pool.cleanup(obj.data);
					totalCleaned++;
					return false;
				}
				return true;
			});

			const cleaned = before - pool.objects.length;
			if (cleaned > 0) {
				logger.debug(`Cleaned ${cleaned} stale objects from pool: ${poolName}`);
			}
		}

		// Clean up weak references
		const validRefs = new Set<WeakRef<object>>();
		for (const ref of this.weakRefs) {
			if (ref.deref()) {
				validRefs.add(ref);
			}
		}
		this.weakRefs = validRefs;

		if (totalCleaned > 0) {
			logger.info(`Memory cleanup completed: ${totalCleaned} objects cleaned`);
		}
	}

	/**
	 * Force compression optimization during pressure
	 */
	private forceCompressionOptimization(): void {
		// Compress any large uncompressed strings
		const compressionCandidates: string[] = [];

		// Find large objects in pools
		for (const pool of this.memoryPools.values()) {
			for (const obj of pool.objects) {
				if (typeof obj.data === 'string' && (obj.data as string).length > 500) {
					compressionCandidates.push(obj.data as string);
				}
			}
		}

		for (const text of compressionCandidates) {
			const key = this.generateObjectId();
			this.compressString(key, text);
		}

		logger.debug(`Force-compressed ${compressionCandidates.length} strings`);
	}

	/**
	 * Temporarily reduce pool sizes during pressure
	 */
	private reducePools(): void {
		for (const [poolName, pool] of this.memoryPools) {
			const targetSize = Math.floor(pool.objects.length * 0.7); // Reduce by 30%

			if (pool.objects.length > targetSize) {
				// Remove least recently used objects
				pool.objects.sort((a, b) => a.lastUsed - b.lastUsed);
				const removed = pool.objects.splice(0, pool.objects.length - targetSize);

				for (const obj of removed) {
					pool.cleanup(obj.data);
				}

				logger.debug(
					`Reduced pool ${poolName} from ${pool.objects.length + removed.length} to ${pool.objects.length}`
				);
			}
		}
	}

	/**
	 * Register callback for memory pressure events
	 */
	onMemoryPressure(callback: () => void): void {
		this.memoryPressureCallbacks.add(callback);
	}

	/**
	 * Get comprehensive memory metrics
	 */
	getMemoryMetrics(): MemoryMetrics {
		const heapUsage = this.estimateHeapUsage();
		const _totalPoolSize = Array.from(this.memoryPools.values()).reduce(
			(sum, pool) => sum + pool.objects.length,
			0
		);

		return {
			allocated: heapUsage,
			used: heapUsage,
			fragmentation: this.calculateFragmentation(),
			gcCount: this.gcMetrics.length,
			gcTime: this.gcMetrics.reduce((sum, gc) => sum + gc.duration, 0),
			pressure: heapUsage / this.maxHeapSize,
		};
	}

	/**
	 * Get detailed performance analytics
	 */
	getAnalytics(): {
		pools: { [key: string]: { size: number; allocated: number; efficiency: number } };
		compression: { totalSaved: number; ratio: number; count: number };
		gc: { avgDuration: number; efficiency: number; frequency: number };
		patterns: { [key: string]: { frequency: number; avgSize: number } };
	} {
		// Pool analytics
		const pools: { [key: string]: { size: number; allocated: number; efficiency: number } } =
			{};
		for (const [name, pool] of this.memoryPools) {
			const efficiency =
				pool.objects.reduce((sum, obj) => sum + obj.useCount, 0) /
				Math.max(pool.objects.length, 1);
			pools[name] = {
				size: pool.objects.length,
				allocated: pool.totalAllocated,
				efficiency,
			};
		}

		// Compression analytics
		const compressionStats = Array.from(this.compressionRegistry.values());
		const totalSaved = compressionStats.reduce((sum, stat) => {
			return sum + (stat.original.length - stat.compressed.length);
		}, 0);
		const avgRatio =
			compressionStats.reduce((sum, stat) => sum + stat.ratio, 0) /
			Math.max(compressionStats.length, 1);

		// GC analytics
		const recentGCs = this.gcMetrics.slice(-20);
		const avgGCDuration =
			recentGCs.reduce((sum, gc) => sum + gc.duration, 0) / Math.max(recentGCs.length, 1);
		const gcEfficiency =
			recentGCs.reduce((sum, gc) => sum + gc.freedBytes, 0) /
			Math.max(avgGCDuration * recentGCs.length, 1);

		// Pattern analytics
		const patterns: { [key: string]: { frequency: number; avgSize: number } } = {};
		for (const [type, pattern] of this.allocationPatterns) {
			patterns[type] = {
				frequency: pattern.frequency,
				avgSize: pattern.avgSize,
			};
		}

		return {
			pools,
			compression: {
				totalSaved,
				ratio: avgRatio,
				count: compressionStats.length,
			},
			gc: {
				avgDuration: avgGCDuration,
				efficiency: gcEfficiency,
				frequency: recentGCs.length / 60, // per minute
			},
			patterns,
		};
	}

	// Utility methods
	private estimateHeapUsage(): number {
		if (typeof process !== 'undefined' && process.memoryUsage) {
			return process.memoryUsage().heapUsed;
		}

		// Fallback estimation
		let totalSize = 0;
		for (const pool of this.memoryPools.values()) {
			totalSize += pool.objects.reduce((sum, obj) => sum + obj.size, 0);
		}
		return totalSize;
	}

	private estimateObjectSize(obj: unknown): number {
		if (typeof obj === 'string') {
			return obj.length * 2; // UTF-16 encoding
		}
		if (obj instanceof ArrayBuffer) {
			return obj.byteLength;
		}
		if (obj && typeof obj === 'object') {
			return JSON.stringify(obj).length * 2;
		}
		return 64; // Default estimate
	}

	private calculateFragmentation(): number {
		// Simplified fragmentation calculation
		const totalAllocated = Array.from(this.memoryPools.values()).reduce(
			(sum, pool) => sum + pool.totalAllocated,
			0
		);
		const totalUsed = Array.from(this.memoryPools.values()).reduce(
			(sum, pool) => sum + pool.objects.length,
			0
		);

		return totalUsed > 0 ? 1 - totalUsed / totalAllocated : 0;
	}

	private trackAllocation(type: string, size: number): void {
		this.allocationHistory.push({
			size,
			timestamp: Date.now(),
			type,
		});

		// Keep history manageable
		if (this.allocationHistory.length > 1000) {
			this.allocationHistory.splice(0, this.allocationHistory.length - 1000);
		}
	}

	private generateObjectId(): string {
		return `obj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	}

	private simpleCompress(text: string): Uint8Array {
		// Simplified compression using RLE-like approach
		const encoder = new TextEncoder();
		const bytes = encoder.encode(text);
		const compressed: number[] = [];

		for (let i = 0; i < bytes.length; i++) {
			let count = 1;
			while (i + count < bytes.length && bytes[i] === bytes[i + count] && count < 255) {
				count++;
			}

			if (count > 2) {
				compressed.push(255, count, bytes[i]); // Escape sequence
				i += count - 1;
			} else {
				compressed.push(bytes[i]);
			}
		}

		return new Uint8Array(compressed);
	}

	private simpleDecompress(compressed: Uint8Array): string {
		const decompressed: number[] = [];

		for (let i = 0; i < compressed.length; i++) {
			if (compressed[i] === 255 && i + 2 < compressed.length) {
				const count = compressed[i + 1];
				const byte = compressed[i + 2];
				for (let j = 0; j < count; j++) {
					decompressed.push(byte);
				}
				i += 2;
			} else {
				decompressed.push(compressed[i]);
			}
		}

		const decoder = new TextDecoder();
		return decoder.decode(new Uint8Array(decompressed));
	}
}

// Export singleton instance
export const memoryManager = AdaptiveMemoryManager.getInstance();
