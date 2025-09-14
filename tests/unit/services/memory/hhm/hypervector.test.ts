/**
 * Unit tests for HyperVector implementation
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { HyperVector, SemanticVectors } from '../../../../../src/services/memory/hhm/hypervector.js';

describe('HyperVector', () => {
	const dimensions = 1000;

	beforeEach(() => {
		SemanticVectors.setDimensions(dimensions);
	});

	describe('constructor', () => {
		it('should create random vector when no components provided', () => {
			const v = new HyperVector(dimensions);
			expect(v.getDimensions()).toBe(dimensions);
			const components = v.getComponents();
			expect(components.every(c => c === 1 || c === -1)).toBe(true);
		});

		it('should use provided components', () => {
			const components = new Int8Array(dimensions);
			components.fill(1);
			const v = new HyperVector(dimensions, components);
			expect(v.getComponents().every(c => c === 1)).toBe(true);
		});

		it('should throw error for dimension mismatch', () => {
			const components = new Int8Array(100);
			expect(() => new HyperVector(dimensions, components)).toThrow();
		});
	});

	describe('similarity', () => {
		it('should return 1 for identical vectors', () => {
			const v1 = new HyperVector(dimensions);
			const similarity = v1.similarity(v1);
			expect(similarity).toBeCloseTo(1, 5);
		});

		it('should return near 0 for orthogonal vectors', () => {
			const v1 = new HyperVector(dimensions);
			const v2 = new HyperVector(dimensions);
			const similarity = v1.similarity(v2);
			expect(Math.abs(similarity)).toBeLessThan(0.1);
		});

		it('should return near -1 for opposite vectors', () => {
			const components = new Int8Array(dimensions);
			components.fill(1);
			const v1 = new HyperVector(dimensions, components);
			
			const oppositeComponents = new Int8Array(dimensions);
			oppositeComponents.fill(-1);
			const v2 = new HyperVector(dimensions, oppositeComponents);
			
			const similarity = v1.similarity(v2);
			expect(similarity).toBeCloseTo(0, 5); // Normalized to [0,1]
		});
	});

	describe('bind (circular convolution)', () => {
		it('should be reversible with unbind', () => {
			const v1 = new HyperVector(dimensions);
			const v2 = new HyperVector(dimensions);
			const bound = v1.bind(v2);
			const unbound = bound.unbind(v2);
			
			const similarity = v1.similarity(unbound);
			expect(similarity).toBeGreaterThan(0.9);
		});

		it('should preserve similarity structure', () => {
			const v1 = new HyperVector(dimensions);
			const v2 = new HyperVector(dimensions);
			const v3 = new HyperVector(dimensions);
			
			const bound1 = v1.bind(v3);
			const bound2 = v2.bind(v3);
			
			// Binding with same vector should preserve relative similarities
			const origSim = v1.similarity(v2);
			const boundSim = bound1.similarity(bound2);
			
			expect(Math.abs(origSim - boundSim)).toBeLessThan(0.2);
		});
	});

	describe('bundle', () => {
		it('should create vector similar to all inputs', () => {
			const vectors: HyperVector[] = [];
			for (let i = 0; i < 5; i++) {
				vectors.push(new HyperVector(dimensions));
			}
			
			const bundled = HyperVector.bundle(vectors);
			
			for (const v of vectors) {
				const similarity = bundled.similarity(v);
				expect(similarity).toBeGreaterThan(0.3);
			}
		});

		it('should handle weighted bundling', () => {
			const v1 = new HyperVector(dimensions);
			const v2 = new HyperVector(dimensions);
			
			const bundled = HyperVector.bundle([v1, v2], [0.8, 0.2]);
			
			const sim1 = bundled.similarity(v1);
			const sim2 = bundled.similarity(v2);
			
			// Should be more similar to v1 due to higher weight
			expect(sim1).toBeGreaterThan(sim2);
		});
	});

	describe('permute', () => {
		it('should shift components correctly', () => {
			const components = new Int8Array(dimensions);
			for (let i = 0; i < dimensions; i++) {
				components[i] = i % 2 === 0 ? 1 : -1;
			}
			const v = new HyperVector(dimensions, components);
			
			const permuted = v.permute(1);
			const permComponents = permuted.getComponents();
			
			for (let i = 0; i < dimensions - 1; i++) {
				expect(permComponents[i]).toBe(components[i + 1]);
			}
			expect(permComponents[dimensions - 1]).toBe(components[0]);
		});

		it('should be reversible', () => {
			const v = new HyperVector(dimensions);
			const permuted = v.permute(5);
			const reversed = permuted.permute(-5);
			
			const similarity = v.similarity(reversed);
			expect(similarity).toBeCloseTo(1, 5);
		});
	});

	describe('addNoise', () => {
		it('should reduce similarity based on noise level', () => {
			const v = new HyperVector(dimensions);
			const noisy = v.addNoise(0.1);
			
			const similarity = v.similarity(noisy);
			expect(similarity).toBeGreaterThan(0.7);
			expect(similarity).toBeLessThan(1);
		});

		it('should create orthogonal vector at high noise', () => {
			const v = new HyperVector(dimensions);
			const noisy = v.addNoise(0.5);
			
			const similarity = v.similarity(noisy);
			expect(similarity).toBeLessThan(0.6);
		});
	});

	describe('toFloat32Array', () => {
		it('should convert binary to float correctly', () => {
			const components = new Int8Array(dimensions);
			components.fill(1);
			components[0] = -1;
			
			const v = new HyperVector(dimensions, components);
			const floatArray = v.toFloat32Array();
			
			expect(floatArray[0]).toBe(-1);
			for (let i = 1; i < dimensions; i++) {
				expect(floatArray[i]).toBe(1);
			}
		});
	});

	describe('SemanticVectors', () => {
		it('should generate consistent semantic vectors', () => {
			const v1 = SemanticVectors.get('PERSON');
			const v2 = SemanticVectors.get('PERSON');
			
			const similarity = v1.similarity(v2);
			expect(similarity).toBe(1);
		});

		it('should generate different vectors for different concepts', () => {
			const person = SemanticVectors.get('PERSON');
			const place = SemanticVectors.get('PLACE');
			
			const similarity = person.similarity(place);
			expect(Math.abs(similarity)).toBeLessThan(0.2);
		});

		it('should handle role vectors', () => {
			const subject = SemanticVectors.getRole('SUBJECT');
			const object = SemanticVectors.getRole('OBJECT');
			
			expect(subject.getDimensions()).toBe(dimensions);
			expect(object.getDimensions()).toBe(dimensions);
			
			const similarity = subject.similarity(object);
			expect(Math.abs(similarity)).toBeLessThan(0.2);
		});
	});

	describe('edge cases', () => {
		it('should handle zero dimensions gracefully', () => {
			expect(() => new HyperVector(0)).toThrow();
		});

		it('should handle very large dimensions', () => {
			const largeDims = 100000;
			const v = new HyperVector(largeDims);
			expect(v.getDimensions()).toBe(largeDims);
		});

		it('should handle empty bundle array', () => {
			expect(() => HyperVector.bundle([])).toThrow();
		});
	});
});