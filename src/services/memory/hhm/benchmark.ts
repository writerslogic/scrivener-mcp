/**
 * Performance benchmarking utilities for HHM
 */

import { HyperVector } from './hypervector.js';
import { SIMDOperations } from './simd-operations.js';
import { GPUAccelerator } from './gpu-accelerator.js';
import { HolographicMemorySubstrate } from './memory-substrate.js';
import { getLogger } from '../../../core/logger.js';

const logger = getLogger('hhm-benchmark');

export interface BenchmarkResult {
	operation: string;
	iterations: number;
	totalTimeMs: number;
	avgTimeMs: number;
	opsPerSecond: number;
	memoryUsedMB: number;
}

export class HHMBenchmark {
	private results: BenchmarkResult[] = [];
	private gpuAccelerator: GPUAccelerator | null = null;

	/**
	 * Run complete benchmark suite
	 */
	async runFullBenchmark(dimensions: number = 10000): Promise<BenchmarkResult[]> {
		logger.info('Starting HHM benchmark suite', { dimensions });

		// Initialize GPU if available
		if (GPUAccelerator.isSupported()) {
			this.gpuAccelerator = new GPUAccelerator();
			await this.gpuAccelerator.initialize();
		}

		// Run benchmarks
		await this.benchmarkVectorOperations(dimensions);
		await this.benchmarkSIMDOperations(dimensions);
		await this.benchmarkMemorySubstrate(dimensions);

		if (this.gpuAccelerator) {
			await this.benchmarkGPUOperations(dimensions);
		}

		// Cleanup
		if (this.gpuAccelerator) {
			this.gpuAccelerator.destroy();
		}

		return this.results;
	}

	/**
	 * Benchmark basic vector operations
	 */
	async benchmarkVectorOperations(dimensions: number): Promise<void> {
		const iterations = 1000;

		// Vector creation
		const createStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			new HyperVector(dimensions);
		}
		const createTime = performance.now() - createStart;
		this.addResult('Vector Creation', iterations, createTime);

		// Prepare vectors for operations
		const vectors: HyperVector[] = [];
		for (let i = 0; i < 100; i++) {
			vectors.push(new HyperVector(dimensions));
		}

		// Similarity computation
		const simStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			const v1 = vectors[i % 100];
			const v2 = vectors[(i + 1) % 100];
			v1.similarity(v2);
		}
		const simTime = performance.now() - simStart;
		this.addResult('Similarity Computation', iterations, simTime);

		// Binding (circular convolution)
		const bindStart = performance.now();
		for (let i = 0; i < iterations / 10; i++) {
			// Fewer iterations as this is expensive
			const v1 = vectors[i % 100];
			const v2 = vectors[(i + 1) % 100];
			v1.bind(v2);
		}
		const bindTime = performance.now() - bindStart;
		this.addResult('Binding (Convolution)', iterations / 10, bindTime);

		// Bundling
		const bundleStart = performance.now();
		for (let i = 0; i < iterations / 10; i++) {
			const toBundle = vectors.slice(0, 5);
			HyperVector.bundle(toBundle);
		}
		const bundleTime = performance.now() - bundleStart;
		this.addResult('Bundling (5 vectors)', iterations / 10, bundleTime);

		// Permutation
		const permuteStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			const v = vectors[i % 100];
			v.permute(i % 10);
		}
		const permuteTime = performance.now() - permuteStart;
		this.addResult('Permutation', iterations, permuteTime);
	}

	/**
	 * Benchmark SIMD operations
	 */
	async benchmarkSIMDOperations(dimensions: number): Promise<void> {
		const iterations = 10000;

		// Generate test arrays
		const arrays: Int8Array[] = [];
		for (let i = 0; i < 100; i++) {
			arrays.push(SIMDOperations.generateRandomVector(dimensions));
		}

		// SIMD dot product
		const dotStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			const a = arrays[i % 100];
			const b = arrays[(i + 1) % 100];
			SIMDOperations.dotProduct(a, b);
		}
		const dotTime = performance.now() - dotStart;
		this.addResult('SIMD Dot Product', iterations, dotTime);

		// SIMD circular convolution
		const convStart = performance.now();
		for (let i = 0; i < iterations / 100; i++) {
			// Expensive operation
			const a = arrays[i % 100];
			const b = arrays[(i + 1) % 100];
			SIMDOperations.circularConvolution(a, b);
		}
		const convTime = performance.now() - convStart;
		this.addResult('SIMD Convolution', iterations / 100, convTime);

		// SIMD bundling
		const bundleStart = performance.now();
		for (let i = 0; i < iterations / 10; i++) {
			const toBundle = arrays.slice(0, 5);
			SIMDOperations.bundle(toBundle);
		}
		const bundleTime = performance.now() - bundleStart;
		this.addResult('SIMD Bundle', iterations / 10, bundleTime);

		// Batch similarity
		const batchSimStart = performance.now();
		const query = arrays[0];
		const targets = arrays.slice(1, 51);
		for (let i = 0; i < iterations / 100; i++) {
			SIMDOperations.batchSimilarity(query, targets);
		}
		const batchSimTime = performance.now() - batchSimStart;
		this.addResult('SIMD Batch Similarity (50)', iterations / 100, batchSimTime);

		// XOR operation
		const xorStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			const a = arrays[i % 100];
			const b = arrays[(i + 1) % 100];
			SIMDOperations.xor(a, b);
		}
		const xorTime = performance.now() - xorStart;
		this.addResult('SIMD XOR', iterations, xorTime);
	}

	/**
	 * Benchmark GPU operations
	 */
	async benchmarkGPUOperations(dimensions: number): Promise<void> {
		if (!this.gpuAccelerator) return;

		const iterations = 100;

		// Generate test vectors
		const vectors: HyperVector[] = [];
		for (let i = 0; i < 100; i++) {
			vectors.push(new HyperVector(dimensions));
		}

		// GPU similarity computation
		const query = vectors[0];
		const targets = vectors.slice(1, 51);

		const gpuSimStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			await this.gpuAccelerator.computeSimilarities(query, targets);
		}
		const gpuSimTime = performance.now() - gpuSimStart;
		this.addResult('GPU Similarities (50)', iterations, gpuSimTime);

		// GPU convolution
		const gpuConvStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			const v1 = vectors[i % 100];
			const v2 = vectors[(i + 1) % 100];
			await this.gpuAccelerator.circularConvolution(v1, v2);
		}
		const gpuConvTime = performance.now() - gpuConvStart;
		this.addResult('GPU Convolution', iterations, gpuConvTime);

		// GPU bundling
		const gpuBundleStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			const toBundle = vectors.slice(0, 10);
			await this.gpuAccelerator.bundle(toBundle);
		}
		const gpuBundleTime = performance.now() - gpuBundleStart;
		this.addResult('GPU Bundle (10)', iterations, gpuBundleTime);
	}

	/**
	 * Benchmark memory substrate operations
	 */
	async benchmarkMemorySubstrate(dimensions: number): Promise<void> {
		const substrate = new HolographicMemorySubstrate(dimensions, 10000, false);
		const iterations = 1000;

		// Generate test vectors
		const vectors: HyperVector[] = [];
		for (let i = 0; i < iterations; i++) {
			vectors.push(new HyperVector(dimensions));
		}

		// Storage
		const storeStart = performance.now();
		for (let i = 0; i < iterations; i++) {
			await substrate.store(`mem_${i}`, vectors[i], {
				modality: 'test',
				timestamp: Date.now(),
			});
		}
		const storeTime = performance.now() - storeStart;
		this.addResult('Memory Storage', iterations, storeTime);

		// Retrieval
		const query = new HyperVector(dimensions);
		const retrieveStart = performance.now();
		for (let i = 0; i < 100; i++) {
			await substrate.retrieve(query, 10);
		}
		const retrieveTime = performance.now() - retrieveStart;
		this.addResult('Memory Retrieval (k=10)', 100, retrieveTime);

		// Consolidation
		const consolidateStart = performance.now();
		await substrate.consolidate();
		const consolidateTime = performance.now() - consolidateStart;
		this.addResult('Memory Consolidation', 1, consolidateTime);

		// Cleanup
		await substrate.destroy();
	}

	/**
	 * Add benchmark result
	 */
	private addResult(operation: string, iterations: number, totalTimeMs: number): void {
		const avgTimeMs = totalTimeMs / iterations;
		const opsPerSecond = (iterations / totalTimeMs) * 1000;
		const memoryUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;

		const result: BenchmarkResult = {
			operation,
			iterations,
			totalTimeMs,
			avgTimeMs,
			opsPerSecond,
			memoryUsedMB,
		};

		this.results.push(result);

		logger.info('Benchmark completed', {
			operation,
			avgTimeMs: avgTimeMs.toFixed(3),
			opsPerSecond: opsPerSecond.toFixed(0),
		});
	}

	/**
	 * Get benchmark results summary
	 */
	getSummary(): string {
		let summary = '\n=== HHM Benchmark Results ===\n';
		summary += '------------------------------\n';

		for (const result of this.results) {
			summary += `${result.operation}:\n`;
			summary += `  Iterations: ${result.iterations}\n`;
			summary += `  Avg Time: ${result.avgTimeMs.toFixed(3)} ms\n`;
			summary += `  Ops/Sec: ${result.opsPerSecond.toFixed(0)}\n`;
			summary += `  Memory: ${result.memoryUsedMB.toFixed(1)} MB\n`;
			summary += '------------------------------\n';
		}

		return summary;
	}

	/**
	 * Compare CPU vs GPU performance
	 */
	comparePerformance(): Record<string, unknown> {
		const cpuOps = this.results.filter((r) => !r.operation.includes('GPU'));
		const gpuOps = this.results.filter((r) => r.operation.includes('GPU'));

		if (gpuOps.length === 0) {
			return { gpuAvailable: false };
		}

		const comparisons: Record<string, unknown> = {
			gpuAvailable: true,
			operations: {} as Record<string, unknown>,
		};

		// Find matching operations
		for (const gpuOp of gpuOps) {
			const opType = gpuOp.operation.replace('GPU ', '');
			const cpuOp = cpuOps.find((c) => c.operation.includes(opType));

			if (cpuOp) {
				(comparisons.operations as Record<string, unknown>)[opType] = {
					cpuOpsPerSec: cpuOp.opsPerSecond,
					gpuOpsPerSec: gpuOp.opsPerSecond,
					speedup: gpuOp.opsPerSecond / cpuOp.opsPerSecond,
				};
			}
		}

		return comparisons;
	}

	/**
	 * Export results to JSON
	 */
	exportResults(): string {
		return JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				results: this.results,
				comparison: this.comparePerformance(),
				systemInfo: {
					platform: process.platform,
					nodeVersion: process.version,
					memoryMB: process.memoryUsage().heapTotal / 1024 / 1024,
					gpuAvailable: GPUAccelerator.isSupported(),
				},
			},
			null,
			2
		);
	}
}

/**
 * Run quick benchmark
 */
export async function quickBenchmark(dimensions: number = 10000): Promise<void> {
	const benchmark = new HHMBenchmark();
	await benchmark.runFullBenchmark(dimensions);

	console.log(benchmark.getSummary());

	const comparison = benchmark.comparePerformance();
	if (comparison.gpuAvailable) {
		console.log('\n=== CPU vs GPU Comparison ===');
		console.log(JSON.stringify(comparison, null, 2));
	}
}
