/**
 * Advanced Object Pool Manager
 * Sophisticated object pooling system for high-frequency allocations
 * with automatic sizing, memory pressure response, and performance monitoring
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { ApplicationError as AppError, ErrorCode } from '../core/errors.js';
import { globalProfiler } from './advanced-performance.js';

const logger = getLogger('object-pool');

export interface PoolConfig {
	name: string;
	initialSize: number;
	maxSize: number;
	minSize: number;
	factory: () => unknown;
	reset?: (obj: unknown) => void;
	validate?: (obj: unknown) => boolean;
	destroy?: (obj: unknown) => void;
	maxAge?: number; // ms
	idleTimeout?: number; // ms
	shrinkOnMemoryPressure?: boolean;
	warmupOnCreate?: boolean;
}

export interface PoolStatistics {
	name: string;
	totalCreated: number;
	totalDestroyed: number;
	totalBorrowed: number;
	totalReturned: number;
	currentSize: number;
	availableCount: number;
	borrowedCount: number;
	hitRate: number;
	averageCreateTime: number;
	averageResetTime: number;
	memoryUsage: number;
	peakSize: number;
	lastMaintenance: number;
}

interface PooledObject<T> {
	object: T;
	createdAt: number;
	lastUsed: number;
	borrowCount: number;
	isValid: boolean;
}

export interface PoolManagerConfig {
	globalMaxObjects: number;
	memoryPressureThreshold: number;
	maintenanceInterval: number;
	enablePerformanceMonitoring: boolean;
	enableAutoSizing: boolean;
	autoSizingInterval: number;
}

export class ObjectPool<T> extends EventEmitter {
	private config: PoolConfig;
	private pool: PooledObject<T>[] = [];
	private borrowed = new Set<PooledObject<T>>();
	private stats: PoolStatistics;
	private createTimes: number[] = [];
	private resetTimes: number[] = [];
	private lastMaintenance: number = Date.now();

	constructor(config: PoolConfig) {
		super();
		this.config = { ...config };

		this.stats = {
			name: config.name,
			totalCreated: 0,
			totalDestroyed: 0,
			totalBorrowed: 0,
			totalReturned: 0,
			currentSize: 0,
			availableCount: 0,
			borrowedCount: 0,
			hitRate: 0,
			averageCreateTime: 0,
			averageResetTime: 0,
			memoryUsage: 0,
			peakSize: 0,
			lastMaintenance: Date.now(),
		};

		if (config.warmupOnCreate) {
			this.warmUp();
		}
	}

	/**
	 * Borrow an object from the pool
	 */
	async borrow(): Promise<T> {
		return globalProfiler.profileOperation(`pool_${this.config.name}_borrow`, async () => {
			this.stats.totalBorrowed++;

			// Try to get an available object
			let pooledObj = this.getAvailableObject();

			if (!pooledObj) {
				// No available objects, try to create new one
				if (this.pool.length + this.borrowed.size < this.config.maxSize) {
					pooledObj = await this.createObject();
				} else {
					// Pool is at max capacity, wait or throw
					throw new AppError(
						`Pool ${this.config.name} is at maximum capacity (${this.config.maxSize})`,
						ErrorCode.RESOURCE_EXHAUSTED
					);
				}
			}

			// Mark as borrowed
			this.borrowed.add(pooledObj);
			pooledObj.lastUsed = Date.now();
			pooledObj.borrowCount++;

			this.updateStatistics();

			this.emit('objectBorrowed', {
				pool: this.config.name,
				objectId: pooledObj.createdAt,
				currentBorrowed: this.borrowed.size,
			});

			return pooledObj.object;
		});
	}

	/**
	 * Return an object to the pool
	 */
	async return(obj: T): Promise<void> {
		return globalProfiler.profileOperation(`pool_${this.config.name}_return`, async () => {
			// Find the pooled object wrapper
			const pooledObj = Array.from(this.borrowed).find((p) => p.object === obj);

			if (!pooledObj) {
				logger.warn(`Attempted to return object not from pool ${this.config.name}`);
				return;
			}

			this.borrowed.delete(pooledObj);
			this.stats.totalReturned++;

			// Validate the object if validator is provided
			if (this.config.validate && !this.config.validate(obj)) {
				logger.debug(`Object failed validation in pool ${this.config.name}, destroying`);
				await this.destroyObject(pooledObj);
				this.updateStatistics();
				return;
			}

			// Reset the object if reset function is provided
			if (this.config.reset) {
				const startTime = Date.now();
				try {
					this.config.reset(obj);
					const resetTime = Date.now() - startTime;
					this.resetTimes.push(resetTime);
					if (this.resetTimes.length > 100) {
						this.resetTimes = this.resetTimes.slice(-50);
					}
				} catch (error) {
					logger.warn(`Object reset failed in pool ${this.config.name}`, { error });
					await this.destroyObject(pooledObj);
					this.updateStatistics();
					return;
				}
			}

			// Check if object is too old
			const maxAge = this.config.maxAge || Infinity;
			if (Date.now() - pooledObj.createdAt > maxAge) {
				logger.debug(`Object expired in pool ${this.config.name}, destroying`);
				await this.destroyObject(pooledObj);
				this.updateStatistics();
				return;
			}

			// Return to pool
			pooledObj.isValid = true;
			this.pool.push(pooledObj);

			this.updateStatistics();

			this.emit('objectReturned', {
				pool: this.config.name,
				objectId: pooledObj.createdAt,
				currentAvailable: this.pool.length,
			});
		});
	}

	/**
	 * Perform pool maintenance
	 */
	async performMaintenance(): Promise<void> {
		return globalProfiler.profileOperation(`pool_${this.config.name}_maintenance`, async () => {
			const now = Date.now();
			const idleTimeout = this.config.idleTimeout || 300000; // 5 minutes default

			// Remove idle objects
			const toRemove: PooledObject<T>[] = [];
			for (const pooledObj of this.pool) {
				if (now - pooledObj.lastUsed > idleTimeout) {
					toRemove.push(pooledObj);
				}
			}

			for (const obj of toRemove) {
				await this.destroyObject(obj);
			}

			// Ensure minimum size
			while (this.pool.length + this.borrowed.size < this.config.minSize) {
				await this.createObject();
			}

			// Handle memory pressure
			if (this.config.shrinkOnMemoryPressure) {
				const memoryPressure = globalProfiler.getMemoryPressure();
				if (memoryPressure.level === 'high' || memoryPressure.level === 'critical') {
					const targetSize = Math.max(
						this.config.minSize,
						Math.floor(this.pool.length * 0.5)
					);
					while (this.pool.length > targetSize) {
						const obj = this.pool.pop();
						if (obj) {
							await this.destroyObject(obj);
						}
					}
					logger.info(`Pool ${this.config.name} shrunk due to memory pressure`);
				}
			}

			this.lastMaintenance = now;
			this.stats.lastMaintenance = now;
			this.updateStatistics();

			this.emit('maintenanceCompleted', {
				pool: this.config.name,
				objectsRemoved: toRemove.length,
				currentSize: this.pool.length + this.borrowed.size,
			});
		});
	}

	/**
	 * Get pool statistics
	 */
	getStatistics(): PoolStatistics {
		this.updateStatistics();
		return { ...this.stats };
	}

	/**
	 * Drain the pool (destroy all objects)
	 */
	async drain(): Promise<void> {
		// Wait for all borrowed objects to be returned or force cleanup
		const timeout = 10000; // 10 seconds
		const startTime = Date.now();

		while (this.borrowed.size > 0 && Date.now() - startTime < timeout) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		// Force cleanup of any remaining borrowed objects
		for (const pooledObj of this.borrowed) {
			await this.destroyObject(pooledObj);
		}
		this.borrowed.clear();

		// Destroy all available objects
		while (this.pool.length > 0) {
			const obj = this.pool.pop();
			if (obj) {
				await this.destroyObject(obj);
			}
		}

		this.updateStatistics();
		logger.info(`Pool ${this.config.name} drained`);
	}

	/**
	 * Resize the pool
	 */
	async resize(newMinSize: number, newMaxSize: number): Promise<void> {
		this.config.minSize = newMinSize;
		this.config.maxSize = newMaxSize;

		// Adjust current size if needed
		if (this.pool.length + this.borrowed.size > newMaxSize) {
			const excess = this.pool.length + this.borrowed.size - newMaxSize;
			for (let i = 0; i < excess && this.pool.length > 0; i++) {
				const obj = this.pool.pop();
				if (obj) {
					await this.destroyObject(obj);
				}
			}
		} else if (this.pool.length + this.borrowed.size < newMinSize) {
			const needed = newMinSize - (this.pool.length + this.borrowed.size);
			for (let i = 0; i < needed; i++) {
				await this.createObject();
			}
		}

		this.updateStatistics();
		logger.info(`Pool ${this.config.name} resized`, { newMinSize, newMaxSize });
	}

	/**
	 * Warm up the pool to initial size
	 */
	private async warmUp(): Promise<void> {
		const targetSize = this.config.initialSize;
		const promises: Promise<PooledObject<T>>[] = [];

		for (let i = 0; i < targetSize; i++) {
			promises.push(this.createObject());
		}

		await Promise.all(promises);
		this.updateStatistics();
		logger.info(`Pool ${this.config.name} warmed up with ${targetSize} objects`);
	}

	private getAvailableObject(): PooledObject<T> | null {
		// Get the most recently used object (stack behavior for better cache locality)
		return this.pool.pop() || null;
	}

	private async createObject(): Promise<PooledObject<T>> {
		const startTime = Date.now();

		try {
			const obj = this.config.factory() as T;
			const createTime = Date.now() - startTime;

			this.createTimes.push(createTime);
			if (this.createTimes.length > 100) {
				this.createTimes = this.createTimes.slice(-50);
			}

			const pooledObj: PooledObject<T> = {
				object: obj,
				createdAt: Date.now(),
				lastUsed: Date.now(),
				borrowCount: 0,
				isValid: true,
			};

			this.pool.push(pooledObj);
			this.stats.totalCreated++;
			this.stats.peakSize = Math.max(
				this.stats.peakSize,
				this.pool.length + this.borrowed.size
			);

			this.emit('objectCreated', {
				pool: this.config.name,
				createTime,
				currentSize: this.pool.length + this.borrowed.size,
			});

			return pooledObj;
		} catch (error) {
			logger.error(`Failed to create object in pool ${this.config.name}`, { error });
			throw new AppError(
				`Object creation failed in pool ${this.config.name}`,
				ErrorCode.UNKNOWN_ERROR,
				{ originalError: (error as Error).message }
			);
		}
	}

	private async destroyObject(pooledObj: PooledObject<T>): Promise<void> {
		try {
			// Remove from pool if present
			const index = this.pool.indexOf(pooledObj);
			if (index !== -1) {
				this.pool.splice(index, 1);
			}

			// Remove from borrowed if present
			this.borrowed.delete(pooledObj);

			// Call destroy function if provided
			if (this.config.destroy) {
				this.config.destroy(pooledObj.object);
			}

			this.stats.totalDestroyed++;

			this.emit('objectDestroyed', {
				pool: this.config.name,
				objectAge: Date.now() - pooledObj.createdAt,
				borrowCount: pooledObj.borrowCount,
			});
		} catch (error) {
			logger.warn(`Error destroying object in pool ${this.config.name}`, { error });
		}
	}

	private updateStatistics(): void {
		this.stats.currentSize = this.pool.length + this.borrowed.size;
		this.stats.availableCount = this.pool.length;
		this.stats.borrowedCount = this.borrowed.size;

		if (this.stats.totalBorrowed > 0) {
			this.stats.hitRate =
				(this.stats.totalBorrowed - this.stats.totalCreated) / this.stats.totalBorrowed;
		}

		if (this.createTimes.length > 0) {
			this.stats.averageCreateTime =
				this.createTimes.reduce((a, b) => a + b, 0) / this.createTimes.length;
		}

		if (this.resetTimes.length > 0) {
			this.stats.averageResetTime =
				this.resetTimes.reduce((a, b) => a + b, 0) / this.resetTimes.length;
		}

		// Estimate memory usage (rough)
		this.stats.memoryUsage = this.stats.currentSize * 1024; // 1KB per object estimation
	}
}

export class PoolManager extends EventEmitter {
	private pools = new Map<string, ObjectPool<unknown>>();
	private config: PoolManagerConfig;
	private maintenanceInterval: NodeJS.Timeout | null = null;
	private autoSizingInterval: NodeJS.Timeout | null = null;
	private performanceHistory = new Map<string, number[]>();

	constructor(config: Partial<PoolManagerConfig> = {}) {
		super();

		this.config = {
			globalMaxObjects: config.globalMaxObjects ?? 10000,
			memoryPressureThreshold: config.memoryPressureThreshold ?? 0.8,
			maintenanceInterval: config.maintenanceInterval ?? 60000,
			enablePerformanceMonitoring: config.enablePerformanceMonitoring ?? true,
			enableAutoSizing: config.enableAutoSizing ?? true,
			autoSizingInterval: config.autoSizingInterval ?? 300000,
		};

		this.startMaintenance();

		if (this.config.enableAutoSizing) {
			this.startAutoSizing();
		}

		// Listen to memory pressure events
		globalProfiler.on('memoryPressure', (pressure) => {
			if (pressure.level === 'high' || pressure.level === 'critical') {
				this.handleMemoryPressure();
			}
		});
	}

	/**
	 * Create a new object pool
	 */
	createPool<T>(config: PoolConfig): ObjectPool<T> {
		if (this.pools.has(config.name)) {
			throw new AppError(`Pool ${config.name} already exists`, ErrorCode.INVALID_INPUT);
		}

		const pool = new ObjectPool<T>(config);
		this.pools.set(config.name, pool as ObjectPool<unknown>);

		// Set up event forwarding and monitoring
		pool.on('objectBorrowed', (event) => this.emit('objectBorrowed', event));
		pool.on('objectReturned', (event) => this.emit('objectReturned', event));
		pool.on('objectCreated', (event) => this.emit('objectCreated', event));
		pool.on('objectDestroyed', (event) => this.emit('objectDestroyed', event));

		if (this.config.enablePerformanceMonitoring) {
			this.setupPoolMonitoring(pool);
		}

		logger.info(`Created pool: ${config.name}`, {
			initialSize: config.initialSize,
			maxSize: config.maxSize,
		});

		return pool;
	}

	/**
	 * Get a pool by name
	 */
	getPool<T>(name: string): ObjectPool<T> | undefined {
		return this.pools.get(name) as ObjectPool<T>;
	}

	/**
	 * Remove and drain a pool
	 */
	async removePool(name: string): Promise<void> {
		const pool = this.pools.get(name);
		if (!pool) {
			return;
		}

		await pool.drain();
		this.pools.delete(name);
		this.performanceHistory.delete(name);

		logger.info(`Removed pool: ${name}`);
	}

	/**
	 * Get statistics for all pools
	 */
	getAllStatistics(): Map<string, PoolStatistics> {
		const stats = new Map<string, PoolStatistics>();

		for (const [name, pool] of this.pools) {
			stats.set(name, pool.getStatistics());
		}

		return stats;
	}

	/**
	 * Get global pool manager statistics
	 */
	getGlobalStatistics(): {
		totalPools: number;
		totalObjects: number;
		totalMemoryUsage: number;
		averageHitRate: number;
		poolSummary: Array<{ name: string; size: number; hitRate: number }>;
	} {
		const stats = this.getAllStatistics();
		let totalObjects = 0;
		let totalMemoryUsage = 0;
		let totalHitRate = 0;
		const poolSummary: Array<{ name: string; size: number; hitRate: number }> = [];

		for (const [name, poolStats] of stats) {
			totalObjects += poolStats.currentSize;
			totalMemoryUsage += poolStats.memoryUsage;
			totalHitRate += poolStats.hitRate;

			poolSummary.push({
				name,
				size: poolStats.currentSize,
				hitRate: poolStats.hitRate,
			});
		}

		return {
			totalPools: this.pools.size,
			totalObjects,
			totalMemoryUsage,
			averageHitRate: this.pools.size > 0 ? totalHitRate / this.pools.size : 0,
			poolSummary,
		};
	}

	/**
	 * Drain all pools
	 */
	async drainAll(): Promise<void> {
		const drainPromises: Promise<void>[] = [];

		for (const pool of this.pools.values()) {
			drainPromises.push(pool.drain());
		}

		await Promise.all(drainPromises);
		logger.info('All pools drained');
	}

	/**
	 * Shutdown the pool manager
	 */
	async shutdown(): Promise<void> {
		if (this.maintenanceInterval) {
			clearInterval(this.maintenanceInterval);
		}

		if (this.autoSizingInterval) {
			clearInterval(this.autoSizingInterval);
		}

		await this.drainAll();
		this.pools.clear();
		this.performanceHistory.clear();

		logger.info('Pool manager shutdown completed');
	}

	// Private methods

	private startMaintenance(): void {
		this.maintenanceInterval = setInterval(async () => {
			await this.performMaintenance();
		}, this.config.maintenanceInterval);
	}

	private startAutoSizing(): void {
		this.autoSizingInterval = setInterval(() => {
			this.performAutoSizing();
		}, this.config.autoSizingInterval);
	}

	private async performMaintenance(): Promise<void> {
		const maintenancePromises: Promise<void>[] = [];

		for (const pool of this.pools.values()) {
			maintenancePromises.push(pool.performMaintenance());
		}

		await Promise.all(maintenancePromises);

		this.emit('maintenanceCompleted', {
			poolCount: this.pools.size,
			timestamp: Date.now(),
		});
	}

	private handleMemoryPressure(): void {
		logger.warn('Handling memory pressure across all pools');

		// Sort pools by hit rate (lower hit rate = less important)
		const poolStats = Array.from(this.getAllStatistics().entries()).sort(
			([, a], [, b]) => a.hitRate - b.hitRate
		);

		// Shrink pools starting with lowest hit rate
		for (const [name, stats] of poolStats) {
			const pool = this.pools.get(name);
			if (pool && stats.currentSize > 1) {
				const newSize = Math.max(1, Math.floor(stats.currentSize * 0.5));
				pool.resize(1, newSize);
			}
		}
	}

	private performAutoSizing(): void {
		for (const [name, pool] of this.pools) {
			const stats = pool.getStatistics();
			const history = this.performanceHistory.get(name) || [];

			// Track hit rate over time
			history.push(stats.hitRate);
			if (history.length > 20) {
				history.splice(0, history.length - 20);
			}
			this.performanceHistory.set(name, history);

			// Auto-sizing logic
			if (history.length >= 5) {
				const recentAvg = history.slice(-5).reduce((a, b) => a + b, 0) / 5;
				const config = pool['config']; // Access private config

				if (recentAvg > 0.9 && stats.currentSize < config.maxSize) {
					// High hit rate, consider growing
					const newMax = Math.min(config.maxSize, Math.floor(config.maxSize * 1.2));
					pool.resize(config.minSize, newMax);
					logger.debug(`Auto-sized pool ${name} up`, { newMax });
				} else if (recentAvg < 0.3 && stats.currentSize > config.minSize) {
					// Low hit rate, consider shrinking
					const newMax = Math.max(config.minSize, Math.floor(config.maxSize * 0.8));
					pool.resize(config.minSize, newMax);
					logger.debug(`Auto-sized pool ${name} down`, { newMax });
				}
			}
		}
	}

	private setupPoolMonitoring(pool: ObjectPool<unknown>): void {
		// Monitor pool performance and emit alerts
		pool.on('objectCreated', (event) => {
			if (event.createTime > 1000) {
				// 1 second
				this.emit('slowCreation', {
					pool: event.pool,
					createTime: event.createTime,
				});
			}
		});

		pool.on('objectBorrowed', (event) => {
			const stats = pool.getStatistics();
			if (stats.availableCount === 0) {
				this.emit('poolExhausted', {
					pool: event.pool,
					currentBorrowed: event.currentBorrowed,
				});
			}
		});
	}
}

// Global pool manager instance
export const globalPoolManager = new PoolManager();

// Convenience functions for common object types
export function createStringPool(
	name: string,
	initialSize = 10,
	maxSize = 100
): ObjectPool<string> {
	return globalPoolManager.createPool<string>({
		name,
		initialSize,
		maxSize,
		minSize: 1,
		factory: () => '',
		reset: () => {}, // Strings are immutable, no reset needed
	});
}

export function createArrayPool<T>(name: string, initialSize = 10, maxSize = 100): ObjectPool<T[]> {
	return globalPoolManager.createPool<T[]>({
		name,
		initialSize,
		maxSize,
		minSize: 1,
		factory: () => [],
		reset: (obj) => {
			const arr = obj as T[];
			arr.length = 0; // Clear array
		},
	});
}

export function createObjectPool<T extends object>(
	name: string,
	factory: () => T,
	reset?: (obj: T) => void,
	initialSize = 10,
	maxSize = 100
): ObjectPool<T> {
	return globalPoolManager.createPool<T>({
		name,
		initialSize,
		maxSize,
		minSize: 1,
		factory,
		reset: reset as ((obj: unknown) => void) | undefined,
	});
}
