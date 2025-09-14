/**
 * SIMD-optimized operations for hypervectors
 * Uses typed arrays and batch operations for performance
 */

import { getLogger } from '../../../core/logger.js';

const logger = getLogger('hhm-simd-operations');

export class SIMDOperations {
	private static readonly CHUNK_SIZE = 16; // Process 16 elements at a time
	private static readonly CACHE_SIZE = 100; // Cache frequently used vectors

	/**
	 * Optimized dot product using unrolled loops
	 */
	static dotProduct(a: Int8Array, b: Int8Array): number {
		const length = a.length;
		let sum = 0;
		let i = 0;

		// Main unrolled loop - process 16 elements at a time
		const mainLoopEnd = length - (length % 16);
		for (; i < mainLoopEnd; i += 16) {
			sum += a[i] * b[i];
			sum += a[i + 1] * b[i + 1];
			sum += a[i + 2] * b[i + 2];
			sum += a[i + 3] * b[i + 3];
			sum += a[i + 4] * b[i + 4];
			sum += a[i + 5] * b[i + 5];
			sum += a[i + 6] * b[i + 6];
			sum += a[i + 7] * b[i + 7];
			sum += a[i + 8] * b[i + 8];
			sum += a[i + 9] * b[i + 9];
			sum += a[i + 10] * b[i + 10];
			sum += a[i + 11] * b[i + 11];
			sum += a[i + 12] * b[i + 12];
			sum += a[i + 13] * b[i + 13];
			sum += a[i + 14] * b[i + 14];
			sum += a[i + 15] * b[i + 15];
		}

		// Handle remaining elements
		for (; i < length; i++) {
			sum += a[i] * b[i];
		}

		return sum;
	}

	/**
	 * Optimized circular convolution using cache-friendly access patterns
	 */
	static circularConvolution(a: Int8Array, b: Int8Array): Int8Array {
		const n = a.length;
		const result = new Int8Array(n);

		// Pre-compute reversed b for better cache locality
		const bReversed = new Int8Array(n);
		for (let i = 0; i < n; i++) {
			bReversed[i] = b[n - 1 - i];
		}

		// Block-wise computation for better cache usage
		const blockSize = 64;
		for (let blockStart = 0; blockStart < n; blockStart += blockSize) {
			const blockEnd = Math.min(blockStart + blockSize, n);

			for (let i = blockStart; i < blockEnd; i++) {
				let sum = 0;

				// First part: from 0 to i
				for (let k = 0; k <= i; k++) {
					sum += a[k] * b[i - k];
				}

				// Second part: from i+1 to n-1
				for (let k = i + 1; k < n; k++) {
					sum += a[k] * b[n + i - k];
				}

				result[i] = sum >= 0 ? 1 : -1;
			}
		}

		return result;
	}

	/**
	 * Optimized bundling using parallel accumulation
	 */
	static bundle(vectors: Int8Array[]): Int8Array {
		if (vectors.length === 0) {
			throw new Error('Cannot bundle empty array');
		}

		const dimensions = vectors[0].length;
		const sums = new Int32Array(dimensions); // Use Int32 to avoid overflow

		// Process vectors in chunks for better cache usage
		const chunkSize = 8;
		const numChunks = Math.ceil(vectors.length / chunkSize);

		for (let chunk = 0; chunk < numChunks; chunk++) {
			const start = chunk * chunkSize;
			const end = Math.min(start + chunkSize, vectors.length);

			// Accumulate chunk
			for (let v = start; v < end; v++) {
				const vector = vectors[v];
				// Unrolled addition
				let i = 0;
				const unrollEnd = dimensions - (dimensions % 8);

				for (; i < unrollEnd; i += 8) {
					sums[i] += vector[i];
					sums[i + 1] += vector[i + 1];
					sums[i + 2] += vector[i + 2];
					sums[i + 3] += vector[i + 3];
					sums[i + 4] += vector[i + 4];
					sums[i + 5] += vector[i + 5];
					sums[i + 6] += vector[i + 6];
					sums[i + 7] += vector[i + 7];
				}

				// Handle remainder
				for (; i < dimensions; i++) {
					sums[i] += vector[i];
				}
			}
		}

		// Convert sums to binary
		const result = new Int8Array(dimensions);
		for (let i = 0; i < dimensions; i++) {
			result[i] = sums[i] >= 0 ? 1 : -1;
		}

		return result;
	}

	/**
	 * Batch similarity computation
	 */
	static batchSimilarity(
		query: Int8Array,
		vectors: Int8Array[],
		threshold?: number
	): Float32Array {
		const numVectors = vectors.length;
		const similarities = new Float32Array(numVectors);
		const dimensions = query.length;
		const normalizer = 1.0 / dimensions;

		// Process in batches for better cache usage
		const batchSize = 32;
		for (let batch = 0; batch < numVectors; batch += batchSize) {
			const batchEnd = Math.min(batch + batchSize, numVectors);

			for (let i = batch; i < batchEnd; i++) {
				const dotProd = SIMDOperations.dotProduct(query, vectors[i]);
				const similarity = (dotProd * normalizer + 1) / 2;

				// Early exit if threshold is specified and not met
				if (threshold !== undefined && similarity < threshold) {
					similarities[i] = 0;
				} else {
					similarities[i] = similarity;
				}
			}
		}

		return similarities;
	}

	/**
	 * Optimized XOR for binding operations
	 */
	static xor(a: Int8Array, b: Int8Array): Int8Array {
		const length = a.length;
		const result = new Int8Array(length);

		// Process 16 elements at a time
		let i = 0;
		const mainLoopEnd = length - (length % 16);

		for (; i < mainLoopEnd; i += 16) {
			result[i] = a[i] * b[i] > 0 ? 1 : -1;
			result[i + 1] = a[i + 1] * b[i + 1] > 0 ? 1 : -1;
			result[i + 2] = a[i + 2] * b[i + 2] > 0 ? 1 : -1;
			result[i + 3] = a[i + 3] * b[i + 3] > 0 ? 1 : -1;
			result[i + 4] = a[i + 4] * b[i + 4] > 0 ? 1 : -1;
			result[i + 5] = a[i + 5] * b[i + 5] > 0 ? 1 : -1;
			result[i + 6] = a[i + 6] * b[i + 6] > 0 ? 1 : -1;
			result[i + 7] = a[i + 7] * b[i + 7] > 0 ? 1 : -1;
			result[i + 8] = a[i + 8] * b[i + 8] > 0 ? 1 : -1;
			result[i + 9] = a[i + 9] * b[i + 9] > 0 ? 1 : -1;
			result[i + 10] = a[i + 10] * b[i + 10] > 0 ? 1 : -1;
			result[i + 11] = a[i + 11] * b[i + 11] > 0 ? 1 : -1;
			result[i + 12] = a[i + 12] * b[i + 12] > 0 ? 1 : -1;
			result[i + 13] = a[i + 13] * b[i + 13] > 0 ? 1 : -1;
			result[i + 14] = a[i + 14] * b[i + 14] > 0 ? 1 : -1;
			result[i + 15] = a[i + 15] * b[i + 15] > 0 ? 1 : -1;
		}

		// Handle remainder
		for (; i < length; i++) {
			result[i] = a[i] * b[i] > 0 ? 1 : -1;
		}

		return result;
	}

	/**
	 * Optimized permutation for sequential encoding
	 */
	static permute(vector: Int8Array, shift: number): Int8Array {
		const n = vector.length;
		const result = new Int8Array(n);
		const normalizedShift = ((shift % n) + n) % n;

		// Copy in two parts for efficiency
		const firstPartLength = n - normalizedShift;

		// Use typed array set for bulk copy
		result.set(vector.subarray(normalizedShift), 0);
		result.set(vector.subarray(0, normalizedShift), firstPartLength);

		return result;
	}

	/**
	 * Fast random vector generation using pre-computed random pool
	 */
	private static randomPool: Int8Array | null = null;
	private static randomPoolIndex = 0;
	private static readonly RANDOM_POOL_SIZE = 1000000;

	static generateRandomVector(dimensions: number): Int8Array {
		// Initialize random pool if needed
		if (!SIMDOperations.randomPool) {
			SIMDOperations.randomPool = new Int8Array(SIMDOperations.RANDOM_POOL_SIZE);
			for (let i = 0; i < SIMDOperations.RANDOM_POOL_SIZE; i++) {
				SIMDOperations.randomPool[i] = Math.random() < 0.5 ? -1 : 1;
			}
		}

		const result = new Int8Array(dimensions);

		// Use pool for fast generation
		if (SIMDOperations.randomPoolIndex + dimensions <= SIMDOperations.RANDOM_POOL_SIZE) {
			result.set(
				SIMDOperations.randomPool.subarray(
					SIMDOperations.randomPoolIndex,
					SIMDOperations.randomPoolIndex + dimensions
				)
			);
			SIMDOperations.randomPoolIndex += dimensions;
		} else {
			// Refill from pool with wrapping
			let remaining = dimensions;
			let targetIndex = 0;

			while (remaining > 0) {
				if (SIMDOperations.randomPoolIndex >= SIMDOperations.RANDOM_POOL_SIZE) {
					SIMDOperations.randomPoolIndex = 0;
				}

				const available = Math.min(
					remaining,
					SIMDOperations.RANDOM_POOL_SIZE - SIMDOperations.randomPoolIndex
				);

				result.set(
					SIMDOperations.randomPool.subarray(
						SIMDOperations.randomPoolIndex,
						SIMDOperations.randomPoolIndex + available
					),
					targetIndex
				);

				SIMDOperations.randomPoolIndex += available;
				targetIndex += available;
				remaining -= available;
			}
		}

		return result;
	}

	/**
	 * Batch encode multiple values efficiently
	 */
	static batchEncode(values: number[], dimensions: number, bits: number = 32): Int8Array[] {
		const numValues = values.length;
		const vectors: Int8Array[] = [];

		// Pre-generate all random vectors for efficiency
		const randomVectors: Int8Array[] = [];
		for (let b = 0; b < bits; b++) {
			randomVectors.push(SIMDOperations.generateRandomVector(dimensions));
		}

		// Encode each value
		for (const value of values) {
			const components = new Int32Array(dimensions);

			// Process each bit
			for (let b = 0; b < bits; b++) {
				if ((value >> b) & 1) {
					const randomVector = randomVectors[b];
					// Add to components
					for (let i = 0; i < dimensions; i++) {
						components[i] += randomVector[i];
					}
				}
			}

			// Convert to binary
			const vector = new Int8Array(dimensions);
			for (let i = 0; i < dimensions; i++) {
				vector[i] = components[i] >= 0 ? 1 : -1;
			}

			vectors.push(vector);
		}

		return vectors;
	}

	/**
	 * Compute Hamming distance between vectors
	 */
	static hammingDistance(a: Int8Array, b: Int8Array): number {
		let distance = 0;
		const length = a.length;

		// Unrolled loop for efficiency
		let i = 0;
		const mainLoopEnd = length - (length % 8);

		for (; i < mainLoopEnd; i += 8) {
			distance += a[i] !== b[i] ? 1 : 0;
			distance += a[i + 1] !== b[i + 1] ? 1 : 0;
			distance += a[i + 2] !== b[i + 2] ? 1 : 0;
			distance += a[i + 3] !== b[i + 3] ? 1 : 0;
			distance += a[i + 4] !== b[i + 4] ? 1 : 0;
			distance += a[i + 5] !== b[i + 5] ? 1 : 0;
			distance += a[i + 6] !== b[i + 6] ? 1 : 0;
			distance += a[i + 7] !== b[i + 7] ? 1 : 0;
		}

		// Handle remainder
		for (; i < length; i++) {
			if (a[i] !== b[i]) distance++;
		}

		return distance;
	}

	/**
	 * Get performance statistics
	 */
	static getStats(): Record<string, unknown> {
		return {
			chunkSize: SIMDOperations.CHUNK_SIZE,
			cacheSize: SIMDOperations.CACHE_SIZE,
			randomPoolSize: SIMDOperations.RANDOM_POOL_SIZE,
			randomPoolIndex: SIMDOperations.randomPoolIndex,
		};
	}
}
