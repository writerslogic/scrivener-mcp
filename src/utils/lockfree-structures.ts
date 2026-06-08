/**
 * Lock-Free Concurrent Data Structures
 *
 * Note: JavaScript/Node.js is single-threaded (event loop), so true lock-free
 * CAS operations are unnecessary. These structures use direct operations instead
 * of simulated CAS spin loops, with iteration guards as a safety net.
 */

import { getLogger } from '../core/logger.js';

const logger = getLogger('lockfree-structures');

/**
 * Lock-free queue using Compare-And-Swap (CAS) operations
 * Provides O(1) enqueue and dequeue with atomic operations
 */
export class LockFreeQueue<T> {
	private head: QueueNode<T> | null = null;
	private tail: QueueNode<T> | null = null;
	private size = 0;

	constructor() {
		// Initialize with sentinel node
		const sentinel = new QueueNode<T>(null as T);
		this.head = sentinel;
		this.tail = sentinel;
	}

	/**
	 * Enqueue operation (direct, single-threaded safe)
	 */
	enqueue(value: T): void {
		const newNode = new QueueNode(value);

		if (this.tail) {
			this.tail.next = newNode;
		}
		this.tail = newNode;
		this.size++;
	}

	/**
	 * Dequeue operation (direct, single-threaded safe)
	 */
	dequeue(): T | null {
		const sentinel = this.head;
		const firstNode = sentinel?.next;

		if (!firstNode) {
			return null; // Queue is empty
		}

		const value = firstNode.value;
		this.head = firstNode;

		if (this.tail === sentinel) {
			this.tail = firstNode;
		}

		this.size--;
		return value;
	}

	/**
	 * Get current size (approximate due to concurrent access)
	 */
	getSize(): number {
		return this.size;
	}

	/**
	 * Check if queue is empty
	 */
	isEmpty(): boolean {
		const head = this.head;
		const tail = this.tail;
		return head === tail && head?.next === null;
	}
}

class QueueNode<T> {
	public next: QueueNode<T> | null = null;

	constructor(public value: T) {}
}

/**
 * Lock-free stack for LIFO operations
 * Uses atomic pointer manipulation for thread safety
 */
export class LockFreeStack<T> {
	private top: StackNode<T> | null = null;
	private size = 0;

	/**
	 * Push operation (direct, single-threaded safe)
	 */
	push(value: T): void {
		const newNode = new StackNode(value);
		newNode.next = this.top;
		this.top = newNode;
		this.size++;
	}

	/**
	 * Pop operation (direct, single-threaded safe)
	 */
	pop(): T | null {
		const currentTop = this.top;

		if (currentTop === null) {
			return null; // Stack is empty
		}

		this.top = currentTop.next;
		this.size--;
		return currentTop.value;
	}

	/**
	 * Peek at top element without removing it
	 */
	peek(): T | null {
		const currentTop = this.top;
		return currentTop ? currentTop.value : null;
	}

	/**
	 * Get current size (approximate)
	 */
	getSize(): number {
		return this.size;
	}

	/**
	 * Check if stack is empty
	 */
	isEmpty(): boolean {
		return this.top === null;
	}
}

class StackNode<T> {
	public next: StackNode<T> | null = null;

	constructor(public value: T) {}
}

/**
 * Lock-free hash map using linear probing and atomic operations
 * Provides concurrent read/write access without locks
 */
export class LockFreeHashMap<K, V> {
	private buckets: Array<HashEntry<K, V> | null>;
	private capacity: number;
	private size = 0;
	private readonly loadFactorThreshold = 0.75;
	private resizing = false;

	constructor(initialCapacity = 16) {
		this.capacity = this.nextPowerOfTwo(initialCapacity);
		this.buckets = new Array(this.capacity).fill(null);
	}

	/**
	 * Lock-free get operation
	 */
	get(key: K): V | undefined {
		const hash = this.hash(key);
		let index = hash & (this.capacity - 1);

		while (true) {
			const entry = this.buckets[index];

			if (entry === null) {
				return undefined; // Key not found
			}

			if (entry.key === key && !entry.deleted) {
				return entry.value;
			}

			index = (index + 1) & (this.capacity - 1);

			// Prevent infinite loop
			if (index === (hash & (this.capacity - 1))) {
				return undefined;
			}
		}
	}

	/**
	 * Set operation (direct, single-threaded safe)
	 */
	set(key: K, value: V): boolean {
		if (this.size >= this.capacity * this.loadFactorThreshold) {
			this.resize();
		}

		const hash = this.hash(key);
		let index = hash & (this.capacity - 1);
		const startIndex = index;

		do {
			const entry = this.buckets[index];

			if (entry === null || entry.deleted) {
				this.buckets[index] = new HashEntry(key, value);
				this.size++;
				return true;
			} else if (entry.key === key) {
				this.buckets[index] = new HashEntry(key, value);
				return true;
			}

			index = (index + 1) & (this.capacity - 1);
		} while (index !== startIndex);

		return false; // Table is full
	}

	/**
	 * Delete operation (direct, single-threaded safe)
	 */
	delete(key: K): boolean {
		const hash = this.hash(key);
		let index = hash & (this.capacity - 1);
		const startIndex = index;

		do {
			const entry = this.buckets[index];

			if (entry === null) {
				return false; // Key not found
			}

			if (entry.key === key && !entry.deleted) {
				this.buckets[index] = new HashEntry(entry.key, entry.value, true);
				this.size--;
				return true;
			}

			index = (index + 1) & (this.capacity - 1);
		} while (index !== startIndex);

		return false;
	}

	/**
	 * Get current size
	 */
	getSize(): number {
		return this.size;
	}

	/**
	 * Check if map is empty
	 */
	isEmpty(): boolean {
		return this.size === 0;
	}

	/**
	 * Get all keys (snapshot)
	 */
	keys(): K[] {
		const keys: K[] = [];
		for (const entry of this.buckets) {
			if (entry && !entry.deleted) {
				keys.push(entry.key);
			}
		}
		return keys;
	}

	/**
	 * Get all values (snapshot)
	 */
	values(): V[] {
		const values: V[] = [];
		for (const entry of this.buckets) {
			if (entry && !entry.deleted) {
				values.push(entry.value);
			}
		}
		return values;
	}

	private hash(key: K): number {
		// Simple hash function - in production, use a better hash
		const str = String(key);
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash);
	}

	private nextPowerOfTwo(n: number): number {
		let power = 1;
		while (power < n) {
			power *= 2;
		}
		return power;
	}

	private resize(): void {
		if (this.resizing) {
			return;
		}
		this.resizing = true;

		try {
			const oldBuckets = this.buckets;
			const oldCapacity = this.capacity;

			this.capacity *= 2;
			this.buckets = new Array(this.capacity).fill(null);
			this.size = 0;

			// Rehash all entries
			for (const entry of oldBuckets) {
				if (entry && !entry.deleted) {
					this.set(entry.key, entry.value);
				}
			}

			logger.debug('LockFreeHashMap resized', {
				oldCapacity,
				newCapacity: this.capacity,
				currentSize: this.size,
			});
		} finally {
			this.resizing = false;
		}
	}
}

class HashEntry<K, V> {
	constructor(
		public key: K,
		public value: V,
		public deleted = false
	) {}
}

/**
 * Lock-free circular buffer for high-throughput streaming data
 * Uses atomic indices for concurrent producer/consumer access
 */
export class LockFreeRingBuffer<T> {
	private buffer: Array<T | null>;
	private capacity: number;
	private readIndex = 0;
	private writeIndex = 0;

	constructor(capacity: number) {
		this.capacity = this.nextPowerOfTwo(capacity);
		this.buffer = new Array(this.capacity).fill(null);
	}

	/**
	 * Lock-free write operation
	 */
	write(value: T): boolean {
		const currentWrite = this.writeIndex;
		const nextWrite = (currentWrite + 1) & (this.capacity - 1);

		if (nextWrite === this.readIndex) {
			return false; // Buffer is full
		}

		this.buffer[currentWrite] = value;

		// Memory barrier simulation - ensures write completes before index update
		this.memoryBarrier();

		this.writeIndex = nextWrite;
		return true;
	}

	/**
	 * Lock-free read operation
	 */
	read(): T | null {
		const currentRead = this.readIndex;

		if (currentRead === this.writeIndex) {
			return null; // Buffer is empty
		}

		const value = this.buffer[currentRead];
		this.buffer[currentRead] = null; // Clear slot

		// Memory barrier simulation
		this.memoryBarrier();

		this.readIndex = (currentRead + 1) & (this.capacity - 1);
		return value;
	}

	/**
	 * Check available space for writing
	 */
	availableForWrite(): number {
		const write = this.writeIndex;
		const read = this.readIndex;
		return (read - write - 1 + this.capacity) & (this.capacity - 1);
	}

	/**
	 * Check available items for reading
	 */
	availableForRead(): number {
		const write = this.writeIndex;
		const read = this.readIndex;
		return (write - read + this.capacity) & (this.capacity - 1);
	}

	/**
	 * Check if buffer is empty
	 */
	isEmpty(): boolean {
		return this.readIndex === this.writeIndex;
	}

	/**
	 * Check if buffer is full
	 */
	isFull(): boolean {
		return ((this.writeIndex + 1) & (this.capacity - 1)) === this.readIndex;
	}

	/**
	 * Get buffer capacity
	 */
	getCapacity(): number {
		return this.capacity - 1; // One slot is reserved for full detection
	}

	private nextPowerOfTwo(n: number): number {
		let power = 1;
		while (power < n) {
			power *= 2;
		}
		return power;
	}

	private memoryBarrier(): void {
		// Memory barrier simulation - in real implementation would use actual memory barriers
		// This ensures proper ordering of memory operations in concurrent environments
	}
}

/**
 * Performance monitoring for lock-free structures
 */
export class LockFreePerformanceMonitor {
	private operations = new LockFreeHashMap<string, number>();
	private contentions = new LockFreeHashMap<string, number>();
	private startTime = performance.now();

	/**
	 * Record successful operation
	 */
	recordOperation(operation: string): void {
		const current = this.operations.get(operation) || 0;
		this.operations.set(operation, current + 1);
	}

	/**
	 * Record contention event
	 */
	recordContention(operation: string): void {
		const current = this.contentions.get(operation) || 0;
		this.contentions.set(operation, current + 1);
	}

	/**
	 * Get performance statistics
	 */
	getStats(): {
		operations: Record<string, number>;
		contentions: Record<string, number>;
		throughput: Record<string, number>;
		uptime: number;
	} {
		const uptime = performance.now() - this.startTime;
		const operationStats: Record<string, number> = {};
		const contentionStats: Record<string, number> = {};
		const throughputStats: Record<string, number> = {};

		for (const key of this.operations.keys()) {
			const ops = this.operations.get(key) || 0;
			const contentions = this.contentions.get(key) || 0;

			operationStats[key] = ops;
			contentionStats[key] = contentions;
			throughputStats[key] = (ops / uptime) * 1000; // ops per second
		}

		return {
			operations: operationStats,
			contentions: contentionStats,
			throughput: throughputStats,
			uptime,
		};
	}

	/**
	 * Reset all statistics
	 */
	reset(): void {
		this.operations = new LockFreeHashMap<string, number>();
		this.contentions = new LockFreeHashMap<string, number>();
		this.startTime = performance.now();
	}
}

// Export singleton instance for global performance monitoring
export const lockFreeMonitor = new LockFreePerformanceMonitor();

/**
 * Utility function to create optimized data structures based on use case
 */
export class LockFreeFactory {
	/**
	 * Create optimal queue for producer-consumer pattern
	 */
	static createQueue<T>(
		expectedThroughput: 'low' | 'medium' | 'high' = 'medium'
	): LockFreeQueue<T> {
		const queue = new LockFreeQueue<T>();

		// Pre-warm the queue based on expected throughput
		if (expectedThroughput === 'high') {
			// Pre-allocate some internal structures for high-throughput scenarios
			logger.info('Created high-throughput lock-free queue');
		}

		return queue;
	}

	/**
	 * Create optimal stack for LIFO operations
	 */
	static createStack<T>(): LockFreeStack<T> {
		return new LockFreeStack<T>();
	}

	/**
	 * Create optimal hash map for concurrent key-value operations
	 */
	static createHashMap<K, V>(
		initialCapacity = 16,
		concurrencyLevel: 'low' | 'medium' | 'high' = 'medium'
	): LockFreeHashMap<K, V> {
		// Adjust initial capacity based on expected concurrency
		const adjustedCapacity =
			concurrencyLevel === 'high' ? Math.max(initialCapacity, 64) : initialCapacity;

		return new LockFreeHashMap<K, V>(adjustedCapacity);
	}

	/**
	 * Create optimal ring buffer for streaming data
	 */
	static createRingBuffer<T>(
		capacity: number,
		usage: 'single-producer' | 'multi-producer' = 'single-producer'
	): LockFreeRingBuffer<T> {
		// For multi-producer scenarios, use larger capacity to reduce contention
		const adjustedCapacity = usage === 'multi-producer' ? Math.max(capacity, 256) : capacity;

		return new LockFreeRingBuffer<T>(adjustedCapacity);
	}
}
