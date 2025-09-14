/**
 * Holographic Hyperdimensional Memory (HHM) System
 * Core Hypervector Implementation
 *
 * Implements high-dimensional binary vectors for distributed representation
 * of concepts, memories, and relationships in a holographic memory substrate.
 */

import { randomBytes } from 'crypto';
import { SIMDOperations } from './simd-operations.js';
import { CacheManager } from './vector-cache.js';

export class HyperVector {
	private readonly dimensions: number;
	private readonly components: Int8Array; // -1 or +1 values

	constructor(dimensions: number = 10000, components?: Int8Array) {
		if (dimensions < 1000) {
			throw new Error(
				'Hypervectors require at least 1000 dimensions for proper distribution'
			);
		}
		this.dimensions = dimensions;
		this.components = components || this.generateRandomVector(dimensions);
	}

	/**
	 * Generate a random binary hypervector using SIMD operations
	 */
	private generateRandomVector(dimensions: number): Int8Array {
		return SIMDOperations.generateRandomVector(dimensions);
	}

	/**
	 * Circular convolution for binding two hypervectors using SIMD
	 * Z = X ⊗ Y
	 */
	bind(other: HyperVector): HyperVector {
		if (this.dimensions !== other.dimensions) {
			throw new Error('Cannot bind vectors of different dimensions');
		}

		// Use SIMD-optimized circular convolution
		const result = SIMDOperations.circularConvolution(this.components, other.components);
		return new HyperVector(this.dimensions, result);
	}

	/**
	 * Unbind operation using inverse circular convolution
	 * X' = Y'⁻¹ ⊗ Z
	 */
	unbind(other: HyperVector): HyperVector {
		const inverse = other.inverse();
		return this.bind(inverse);
	}

	/**
	 * Compute inverse of hypervector for unbinding
	 * For binary vectors, the inverse reverses the order
	 */
	inverse(): HyperVector {
		const inverted = new Int8Array(this.dimensions);
		inverted[0] = this.components[0];

		for (let i = 1; i < this.dimensions; i++) {
			inverted[i] = this.components[this.dimensions - i];
		}

		return new HyperVector(this.dimensions, inverted);
	}

	/**
	 * Bundle multiple hypervectors using SIMD operations
	 * Used for representing "A AND B" relationships
	 */
	static bundle(vectors: HyperVector[]): HyperVector {
		if (vectors.length === 0) {
			throw new Error('Cannot bundle empty vector array');
		}

		const dimensions = vectors[0].dimensions;

		// Verify all vectors have same dimensions
		for (const vector of vectors) {
			if (vector.dimensions !== dimensions) {
				throw new Error('All vectors must have same dimensions for bundling');
			}
		}

		// Use SIMD-optimized bundling
		const componentArrays = vectors.map((v) => v.components);
		const result = SIMDOperations.bundle(componentArrays);
		return new HyperVector(dimensions, result);
	}

	/**
	 * Compute similarity using SIMD-optimized dot product
	 * High dot product indicates high similarity
	 */
	similarity(other: HyperVector): number {
		if (this.dimensions !== other.dimensions) {
			throw new Error('Cannot compute similarity of vectors with different dimensions');
		}

		const dotProduct = SIMDOperations.dotProduct(this.components, other.components);

		// Normalize to [0, 1] range
		return (dotProduct + this.dimensions) / (2 * this.dimensions);
	}

	/**
	 * Permute vector components using SIMD operations
	 * Used for representing sequence and order
	 */
	permute(shift: number): HyperVector {
		const result = SIMDOperations.permute(this.components, shift);
		return new HyperVector(this.dimensions, result);
	}

	/**
	 * Add noise to vector for memory consolidation/decay
	 */
	addNoise(noiseLevel: number): HyperVector {
		const noisy = new Int8Array(this.dimensions);
		const flipProbability = noiseLevel;

		for (let i = 0; i < this.dimensions; i++) {
			if (Math.random() < flipProbability) {
				noisy[i] = -this.components[i] as -1 | 1;
			} else {
				noisy[i] = this.components[i];
			}
		}

		return new HyperVector(this.dimensions, noisy);
	}

	/**
	 * Get raw components for GPU operations
	 */
	getComponents(): Int8Array {
		return this.components;
	}

	/**
	 * Get dimensionality
	 */
	getDimensions(): number {
		return this.dimensions;
	}

	/**
	 * Clone the hypervector
	 */
	clone(): HyperVector {
		return new HyperVector(this.dimensions, new Int8Array(this.components));
	}

	/**
	 * Convert to Float32Array for GPU operations
	 */
	toFloat32Array(): Float32Array {
		const float32 = new Float32Array(this.dimensions);
		for (let i = 0; i < this.dimensions; i++) {
			float32[i] = this.components[i];
		}
		return float32;
	}

	/**
	 * Create from Float32Array (from GPU operations)
	 */
	static fromFloat32Array(array: Float32Array): HyperVector {
		const components = new Int8Array(array.length);
		for (let i = 0; i < array.length; i++) {
			components[i] = array[i] >= 0 ? 1 : -1;
		}
		return new HyperVector(array.length, components);
	}
}

// Predefined semantic role vectors
export class SemanticVectors {
	private static cache = new Map<string, HyperVector>();
	private static dimensions = 10000;

	static setDimensions(dims: number): void {
		this.dimensions = dims;
		this.cache.clear();
	}

	static get(role: string): HyperVector {
		if (!this.cache.has(role)) {
			// Use deterministic seed for consistent vectors
			const seed = this.hashString(role);
			const vector = this.generateSeededVector(seed);
			this.cache.set(role, vector);
		}
		return this.cache.get(role)!;
	}

	private static hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash);
	}

	private static generateSeededVector(seed: number): HyperVector {
		const components = new Int8Array(this.dimensions);
		let rand = seed;

		for (let i = 0; i < this.dimensions; i++) {
			// Simple linear congruential generator
			rand = (rand * 1664525 + 1013904223) & 0xffffffff;
			components[i] = rand & 1 ? 1 : -1;
		}

		return new HyperVector(this.dimensions, components);
	}

	// Common semantic roles
	static readonly NEGATION = () => this.get('NOT');
	static readonly CAUSALITY = () => this.get('CAUSES');
	static readonly TEMPORAL_BEFORE = () => this.get('BEFORE');
	static readonly TEMPORAL_AFTER = () => this.get('AFTER');
	static readonly LOCATION = () => this.get('AT');
	static readonly POSSESSION = () => this.get('HAS');
	static readonly IDENTITY = () => this.get('IS');
	static readonly SIMILARITY = () => this.get('LIKE');

	// Additional semantic roles
	static getRole(role: string): HyperVector {
		return this.get(role);
	}
}
