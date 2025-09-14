/**
 * HHM Memory Substrate
 * GPU-accelerated storage and retrieval system for hypervectors
 */

/// <reference types="@webgpu/types" />

import { HyperVector } from './hypervector.js';
import { getLogger } from '../../../core/logger.js';

const logger = getLogger('hhm-memory-substrate');

export interface MemoryEntry {
	id: string;
	vector: HyperVector;
	metadata: {
		timestamp: number;
		accessCount: number;
		lastAccessed: number;
		strength: number;
		context?: Record<string, unknown>;
		modality?: string;
		tags?: string[];
	};
}

export interface RetrievalResult {
	entry: MemoryEntry;
	similarity: number;
	rank: number;
}

export class HolographicMemorySubstrate {
	private memories: Map<string, MemoryEntry>;
	private vectorMatrix: Float32Array | null = null;
	private dimensions: number;
	private maxMemories: number;
	private useGPU: boolean;
	private gpuDevice: GPUDevice | null = null;
	private gpuBuffer: GPUBuffer | null = null;

	constructor(
		dimensions: number = 10000,
		maxMemories: number = 1000000,
		useGPU: boolean = false
	) {
		this.dimensions = dimensions;
		this.maxMemories = maxMemories;
		this.memories = new Map();
		this.useGPU = useGPU && this.checkWebGPUSupport();

		if (this.useGPU) {
			this.initializeGPU().catch((err) => {
				logger.warn('GPU initialization failed, falling back to CPU', { error: err });
				this.useGPU = false;
			});
		}
	}

	/**
	 * Check if WebGPU is available
	 */
	private checkWebGPUSupport(): boolean {
		if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
			return true;
		}
		return false;
	}

	/**
	 * Initialize WebGPU for accelerated operations
	 */
	private async initializeGPU(): Promise<void> {
		if (!this.checkWebGPUSupport()) {
			throw new Error('WebGPU not supported');
		}

		const adapter = await navigator.gpu?.requestAdapter();
		if (!adapter) {
			throw new Error('No GPU adapter found');
		}

		this.gpuDevice = await adapter.requestDevice();

		// Allocate GPU buffer for vector storage
		const bufferSize = this.maxMemories * this.dimensions * 4; // Float32
		this.gpuBuffer = this.gpuDevice.createBuffer({
			size: bufferSize,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
		});

		logger.info('GPU initialized successfully', {
			maxMemories: this.maxMemories,
			dimensions: this.dimensions,
			bufferSizeMB: bufferSize / (1024 * 1024),
		});
	}

	/**
	 * Store a memory in the substrate
	 */
	async store(
		id: string,
		vector: HyperVector,
		metadata?: Partial<MemoryEntry['metadata']>
	): Promise<void> {
		if (vector.getDimensions() !== this.dimensions) {
			throw new Error(
				`Vector dimensions (${vector.getDimensions()}) don't match substrate (${this.dimensions})`
			);
		}

		const entry: MemoryEntry = {
			id,
			vector,
			metadata: {
				timestamp: Date.now(),
				accessCount: 0,
				lastAccessed: Date.now(),
				strength: 1.0,
				...metadata,
			},
		};

		this.memories.set(id, entry);

		// Update GPU buffer if enabled
		if (this.useGPU && this.gpuDevice) {
			await this.updateGPUBuffer();
		}

		logger.debug('Memory stored', { id, dimensions: this.dimensions });
	}

	/**
	 * Retrieve memories similar to query vector
	 */
	async retrieve(
		query: HyperVector,
		k: number = 10,
		threshold: number = 0.3
	): Promise<RetrievalResult[]> {
		if (this.memories.size === 0) {
			return [];
		}

		let similarities: Array<{ id: string; similarity: number }>;

		if (this.useGPU && this.gpuDevice) {
			similarities = await this.gpuSimilaritySearch(query, k);
		} else {
			similarities = this.cpuSimilaritySearch(query);
		}

		// Filter by threshold and get top k
		const filtered = similarities
			.filter((s) => s.similarity >= threshold)
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, k);

		// Build results with full memory entries
		const results: RetrievalResult[] = filtered.map((item, index) => {
			const entry = this.memories.get(item.id)!;

			// Update access metadata
			entry.metadata.accessCount++;
			entry.metadata.lastAccessed = Date.now();

			return {
				entry,
				similarity: item.similarity,
				rank: index + 1,
			};
		});

		logger.debug('Memories retrieved', {
			queryDims: query.getDimensions(),
			resultsCount: results.length,
			topSimilarity: results[0]?.similarity,
		});

		return results;
	}

	/**
	 * CPU-based similarity search
	 */
	private cpuSimilaritySearch(query: HyperVector): Array<{ id: string; similarity: number }> {
		const similarities: Array<{ id: string; similarity: number }> = [];

		for (const [id, entry] of this.memories) {
			const similarity = query.similarity(entry.vector);
			similarities.push({ id, similarity });
		}

		return similarities;
	}

	/**
	 * GPU-accelerated similarity search using WebGPU
	 */
	private async gpuSimilaritySearch(
		query: HyperVector,
		k: number
	): Promise<Array<{ id: string; similarity: number }>> {
		if (!this.gpuDevice || !this.gpuBuffer) {
			return this.cpuSimilaritySearch(query);
		}

		// Create compute shader for dot product
		const shaderModule = this.gpuDevice.createShaderModule({
			code: `
				@group(0) @binding(0) var<storage, read> memories: array<f32>;
				@group(0) @binding(1) var<storage, read> query: array<f32>;
				@group(0) @binding(2) var<storage, read_write> results: array<f32>;
				
				@compute @workgroup_size(64)
				fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
					let memory_index = global_id.x;
					let dimensions = ${this.dimensions}u;
					let num_memories = ${this.memories.size}u;
					
					if (memory_index >= num_memories) {
						return;
					}
					
					var dot_product = 0.0;
					let memory_offset = memory_index * dimensions;
					
					for (var i = 0u; i < dimensions; i = i + 1u) {
						dot_product += memories[memory_offset + i] * query[i];
					}
					
					// Normalize to [0, 1]
					results[memory_index] = (dot_product + f32(dimensions)) / (2.0 * f32(dimensions));
				}
			`,
		});

		// Create pipeline
		const pipeline = this.gpuDevice.createComputePipeline({
			layout: 'auto',
			compute: {
				module: shaderModule,
				entryPoint: 'main',
			},
		});

		// Create query buffer
		const queryArray = query.toFloat32Array();
		const queryBuffer = this.gpuDevice.createBuffer({
			size: queryArray.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.gpuDevice.queue.writeBuffer(queryBuffer, 0, queryArray.buffer as ArrayBuffer);

		// Create results buffer
		const resultsBuffer = this.gpuDevice.createBuffer({
			size: this.memories.size * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		});

		// Create bind group
		const bindGroup = this.gpuDevice.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.gpuBuffer } },
				{ binding: 1, resource: { buffer: queryBuffer } },
				{ binding: 2, resource: { buffer: resultsBuffer } },
			],
		});

		// Execute compute shader
		const commandEncoder = this.gpuDevice.createCommandEncoder();
		const computePass = commandEncoder.beginComputePass();
		computePass.setPipeline(pipeline);
		computePass.setBindGroup(0, bindGroup);
		computePass.dispatchWorkgroups(Math.ceil(this.memories.size / 64));
		computePass.end();

		// Read back results
		const readBuffer = this.gpuDevice.createBuffer({
			size: this.memories.size * 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		commandEncoder.copyBufferToBuffer(resultsBuffer, 0, readBuffer, 0, this.memories.size * 4);

		this.gpuDevice.queue.submit([commandEncoder.finish()]);

		await readBuffer.mapAsync(GPUMapMode.READ);
		const resultArray = new Float32Array(readBuffer.getMappedRange());

		// Convert to id-similarity pairs
		const similarities: Array<{ id: string; similarity: number }> = [];
		let index = 0;
		for (const id of this.memories.keys()) {
			similarities.push({ id, similarity: resultArray[index++] });
		}

		readBuffer.unmap();

		return similarities;
	}

	/**
	 * Update GPU buffer with current memories
	 */
	private async updateGPUBuffer(): Promise<void> {
		if (!this.gpuDevice || !this.gpuBuffer) return;

		// Flatten all vectors into a single Float32Array
		const flatArray = new Float32Array(this.memories.size * this.dimensions);
		let offset = 0;

		for (const entry of this.memories.values()) {
			const vectorArray = entry.vector.toFloat32Array();
			flatArray.set(vectorArray, offset);
			offset += this.dimensions;
		}

		// Write to GPU buffer
		this.gpuDevice.queue.writeBuffer(this.gpuBuffer, 0, flatArray.buffer as ArrayBuffer);
	}

	/**
	 * Consolidate memory by strengthening frequently accessed memories
	 */
	async consolidate(strengthThreshold: number = 10): Promise<void> {
		for (const entry of this.memories.values()) {
			if (entry.metadata.accessCount >= strengthThreshold) {
				// Strengthen by re-binding with a fresh random vector
				const strengthVector = new HyperVector(this.dimensions);
				entry.vector = entry.vector.bind(strengthVector);
				entry.metadata.strength *= 1.1;
				entry.metadata.accessCount = 0; // Reset counter
			}
		}

		if (this.useGPU) {
			await this.updateGPUBuffer();
		}

		logger.info('Memory consolidation complete', {
			totalMemories: this.memories.size,
			threshold: strengthThreshold,
		});
	}

	/**
	 * Decay old memories
	 */
	async decay(
		decayRate: number = 0.01,
		maxAge: number = 30 * 24 * 60 * 60 * 1000
	): Promise<void> {
		const now = Date.now();
		const toDelete: string[] = [];

		for (const [id, entry] of this.memories) {
			const age = now - entry.metadata.lastAccessed;

			if (age > maxAge) {
				// Very old memories are deleted
				toDelete.push(id);
			} else {
				// Apply gradual decay based on age
				const ageRatio = age / maxAge;
				const noiseLevel = decayRate * ageRatio * (1 / entry.metadata.strength);

				if (noiseLevel > 0.01) {
					entry.vector = entry.vector.addNoise(noiseLevel);
					entry.metadata.strength *= 1 - noiseLevel;
				}
			}
		}

		// Delete very old memories
		for (const id of toDelete) {
			this.memories.delete(id);
		}

		if (this.useGPU && (toDelete.length > 0 || this.memories.size > 0)) {
			await this.updateGPUBuffer();
		}

		logger.info('Memory decay complete', {
			deleted: toDelete.length,
			remaining: this.memories.size,
		});
	}

	/**
	 * Get memory by ID
	 */
	get(id: string): MemoryEntry | undefined {
		return this.memories.get(id);
	}

	/**
	 * Delete memory by ID
	 */
	async delete(id: string): Promise<boolean> {
		const deleted = this.memories.delete(id);

		if (deleted && this.useGPU) {
			await this.updateGPUBuffer();
		}

		return deleted;
	}

	/**
	 * Clear all memories
	 */
	async clear(): Promise<void> {
		this.memories.clear();

		if (this.useGPU && this.gpuBuffer) {
			// Clear GPU buffer
			this.gpuDevice?.queue.writeBuffer(
				this.gpuBuffer,
				0,
				new Float32Array(this.maxMemories * this.dimensions)
			);
		}
	}

	/**
	 * Get statistics about the memory substrate
	 */
	getStats(): Record<string, unknown> {
		const now = Date.now();
		let totalStrength = 0;
		let totalAccess = 0;
		let oldestAccess = now;
		let newestAccess = 0;

		for (const entry of this.memories.values()) {
			totalStrength += entry.metadata.strength;
			totalAccess += entry.metadata.accessCount;
			oldestAccess = Math.min(oldestAccess, entry.metadata.lastAccessed);
			newestAccess = Math.max(newestAccess, entry.metadata.lastAccessed);
		}

		return {
			totalMemories: this.memories.size,
			dimensions: this.dimensions,
			maxCapacity: this.maxMemories,
			utilizationPercent: (this.memories.size / this.maxMemories) * 100,
			averageStrength: totalStrength / this.memories.size || 0,
			averageAccessCount: totalAccess / this.memories.size || 0,
			oldestAccessAge: now - oldestAccess,
			newestAccessAge: now - newestAccess,
			gpuEnabled: this.useGPU,
			memorySizeMB: (this.memories.size * this.dimensions * 4) / (1024 * 1024),
		};
	}

	/**
	 * Cleanup GPU resources
	 */
	async destroy(): Promise<void> {
		if (this.gpuBuffer) {
			this.gpuBuffer.destroy();
		}
		if (this.gpuDevice) {
			this.gpuDevice.destroy();
		}
		this.memories.clear();
	}
}
