/**
 * GPU Acceleration Module for HHM
 * Provides WebGPU acceleration with automatic CPU fallback
 */

/// <reference types="@webgpu/types" />

import { HyperVector } from './hypervector.js';
import { getLogger } from '../../../core/logger.js';

const logger = getLogger('hhm-gpu-accelerator');

export interface GPUConfig {
	preferredDevice?: 'high-performance' | 'low-power';
	maxBufferSizeMB?: number;
	workgroupSize?: number;
}

export class GPUAccelerator {
	private device: GPUDevice | null = null;
	private adapter: GPUAdapter | null = null;
	private computePipelines: Map<string, GPUComputePipeline> = new Map();
	private bufferPool: Map<string, GPUBuffer> = new Map();
	private isInitialized = false;
	private config: Required<GPUConfig>;

	constructor(config: GPUConfig = {}) {
		this.config = {
			preferredDevice: config.preferredDevice || 'high-performance',
			maxBufferSizeMB: config.maxBufferSizeMB || 256,
			workgroupSize: config.workgroupSize || 64,
		};
	}

	/**
	 * Check WebGPU availability
	 */
	static isSupported(): boolean {
		return (
			typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu !== undefined
		);
	}

	/**
	 * Initialize GPU device
	 */
	async initialize(): Promise<boolean> {
		if (!GPUAccelerator.isSupported()) {
			logger.warn('WebGPU not supported in this environment');
			return false;
		}

		try {
			this.adapter =
				(await navigator.gpu?.requestAdapter({
					powerPreference: this.config.preferredDevice,
				})) || null;

			if (!this.adapter) {
				throw new Error('No GPU adapter available');
			}

			this.device = await this.adapter.requestDevice({
				requiredLimits: {
					maxBufferSize: this.config.maxBufferSizeMB * 1024 * 1024,
					maxComputeWorkgroupSizeX: this.config.workgroupSize,
				},
			});

			// Handle device loss
			this.device.lost.then((info) => {
				logger.error('GPU device lost', { reason: info.reason });
				this.isInitialized = false;
			});

			await this.createComputePipelines();
			this.isInitialized = true;

			const info = this.adapter.info || {};
			logger.info('GPU initialized', {
				vendor: info.vendor,
				architecture: info.architecture,
				device: info.device,
				description: info.description,
			});

			return true;
		} catch (error) {
			logger.error('GPU initialization failed', { error });
			return false;
		}
	}

	/**
	 * Create reusable compute pipelines
	 */
	private async createComputePipelines(): Promise<void> {
		if (!this.device) return;

		// Dot product pipeline for similarity computation
		const dotProductShader = `
			struct Params {
				dimensions: u32,
				num_vectors: u32,
			}
			
			@group(0) @binding(0) var<uniform> params: Params;
			@group(0) @binding(1) var<storage, read> vectors: array<f32>;
			@group(0) @binding(2) var<storage, read> query: array<f32>;
			@group(0) @binding(3) var<storage, read_write> results: array<f32>;
			
			@compute @workgroup_size(${this.config.workgroupSize})
			fn dotProduct(@builtin(global_invocation_id) global_id: vec3<u32>) {
				let idx = global_id.x;
				if (idx >= params.num_vectors) {
					return;
				}
				
				var sum: f32 = 0.0;
				let offset = idx * params.dimensions;
				
				// Unrolled loop for better performance
				let unroll_factor = 4u;
				let main_loop_end = (params.dimensions / unroll_factor) * unroll_factor;
				
				for (var i = 0u; i < main_loop_end; i += unroll_factor) {
					sum += vectors[offset + i] * query[i];
					sum += vectors[offset + i + 1u] * query[i + 1u];
					sum += vectors[offset + i + 2u] * query[i + 2u];
					sum += vectors[offset + i + 3u] * query[i + 3u];
				}
				
				// Handle remaining elements
				for (var i = main_loop_end; i < params.dimensions; i++) {
					sum += vectors[offset + i] * query[i];
				}
				
				// Normalize to [0, 1]
				results[idx] = (sum + f32(params.dimensions)) / (2.0 * f32(params.dimensions));
			}
		`;

		const dotProductModule = this.device.createShaderModule({ code: dotProductShader });
		const dotProductPipeline = this.device.createComputePipeline({
			layout: 'auto',
			compute: {
				module: dotProductModule,
				entryPoint: 'dotProduct',
			},
		});
		this.computePipelines.set('dotProduct', dotProductPipeline);

		// Circular convolution pipeline
		const convolutionShader = `
			struct Params {
				dimensions: u32,
			}
			
			@group(0) @binding(0) var<uniform> params: Params;
			@group(0) @binding(1) var<storage, read> vector_a: array<f32>;
			@group(0) @binding(2) var<storage, read> vector_b: array<f32>;
			@group(0) @binding(3) var<storage, read_write> result: array<f32>;
			
			@compute @workgroup_size(${this.config.workgroupSize})
			fn circularConvolution(@builtin(global_invocation_id) global_id: vec3<u32>) {
				let idx = global_id.x;
				if (idx >= params.dimensions) {
					return;
				}
				
				var sum: f32 = 0.0;
				for (var k = 0u; k < params.dimensions; k++) {
					let b_idx = (idx + params.dimensions - k) % params.dimensions;
					sum += vector_a[k] * vector_b[b_idx];
				}
				
				result[idx] = sign(sum);
			}
		`;

		const convolutionModule = this.device.createShaderModule({ code: convolutionShader });
		const convolutionPipeline = this.device.createComputePipeline({
			layout: 'auto',
			compute: {
				module: convolutionModule,
				entryPoint: 'circularConvolution',
			},
		});
		this.computePipelines.set('convolution', convolutionPipeline);

		// Bundle (majority vote) pipeline
		const bundleShader = `
			struct Params {
				dimensions: u32,
				num_vectors: u32,
			}
			
			@group(0) @binding(0) var<uniform> params: Params;
			@group(0) @binding(1) var<storage, read> vectors: array<f32>;
			@group(0) @binding(2) var<storage, read_write> result: array<f32>;
			
			@compute @workgroup_size(${this.config.workgroupSize})
			fn bundle(@builtin(global_invocation_id) global_id: vec3<u32>) {
				let idx = global_id.x;
				if (idx >= params.dimensions) {
					return;
				}
				
				var sum: f32 = 0.0;
				for (var v = 0u; v < params.num_vectors; v++) {
					sum += vectors[v * params.dimensions + idx];
				}
				
				result[idx] = sign(sum);
			}
		`;

		const bundleModule = this.device.createShaderModule({ code: bundleShader });
		const bundlePipeline = this.device.createComputePipeline({
			layout: 'auto',
			compute: {
				module: bundleModule,
				entryPoint: 'bundle',
			},
		});
		this.computePipelines.set('bundle', bundlePipeline);
	}

	/**
	 * Compute similarities between query and multiple vectors
	 */
	async computeSimilarities(query: HyperVector, vectors: HyperVector[]): Promise<Float32Array> {
		if (!this.isInitialized || !this.device) {
			return this.cpuSimilarities(query, vectors);
		}

		const dimensions = query.getDimensions();
		const numVectors = vectors.length;

		// Prepare data
		const queryArray = query.toFloat32Array();
		const vectorsArray = new Float32Array(numVectors * dimensions);
		for (let i = 0; i < numVectors; i++) {
			vectorsArray.set(vectors[i].toFloat32Array(), i * dimensions);
		}

		// Create or reuse buffers
		const paramsBuffer = this.getOrCreateBuffer(
			'params',
			8,
			GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		);
		const vectorsBuffer = this.getOrCreateBuffer(
			'vectors',
			vectorsArray.byteLength,
			GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		);
		const queryBuffer = this.getOrCreateBuffer(
			'query',
			queryArray.byteLength,
			GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		);
		const resultsBuffer = this.getOrCreateBuffer(
			'results',
			numVectors * 4,
			GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
		);

		// Write data to GPU
		const paramsData = new Uint32Array([dimensions, numVectors]);
		this.device.queue.writeBuffer(paramsBuffer, 0, paramsData);
		this.device.queue.writeBuffer(vectorsBuffer, 0, vectorsArray);
		this.device.queue.writeBuffer(queryBuffer, 0, queryArray.buffer as ArrayBuffer);

		// Create bind group
		const pipeline = this.computePipelines.get('dotProduct')!;
		const bindGroup = this.device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: paramsBuffer } },
				{ binding: 1, resource: { buffer: vectorsBuffer } },
				{ binding: 2, resource: { buffer: queryBuffer } },
				{ binding: 3, resource: { buffer: resultsBuffer } },
			],
		});

		// Execute compute shader
		const commandEncoder = this.device.createCommandEncoder();
		const computePass = commandEncoder.beginComputePass();
		computePass.setPipeline(pipeline);
		computePass.setBindGroup(0, bindGroup);
		computePass.dispatchWorkgroups(Math.ceil(numVectors / this.config.workgroupSize));
		computePass.end();

		// Read results
		const readBuffer = this.device.createBuffer({
			size: numVectors * 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		commandEncoder.copyBufferToBuffer(resultsBuffer, 0, readBuffer, 0, numVectors * 4);
		this.device.queue.submit([commandEncoder.finish()]);

		await readBuffer.mapAsync(GPUMapMode.READ);
		const results = new Float32Array(readBuffer.getMappedRange()).slice();
		readBuffer.unmap();
		readBuffer.destroy();

		return results;
	}

	/**
	 * GPU-accelerated circular convolution
	 */
	async circularConvolution(a: HyperVector, b: HyperVector): Promise<HyperVector> {
		if (!this.isInitialized || !this.device) {
			return a.bind(b); // Fallback to CPU
		}

		const dimensions = a.getDimensions();
		const aArray = a.toFloat32Array();
		const bArray = b.toFloat32Array();

		// Create buffers
		const paramsBuffer = this.getOrCreateBuffer(
			'conv_params',
			4,
			GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		);
		const aBuffer = this.getOrCreateBuffer(
			'conv_a',
			aArray.byteLength,
			GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		);
		const bBuffer = this.getOrCreateBuffer(
			'conv_b',
			bArray.byteLength,
			GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		);
		const resultBuffer = this.getOrCreateBuffer(
			'conv_result',
			aArray.byteLength,
			GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
		);

		// Write data
		this.device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([dimensions]));
		this.device.queue.writeBuffer(aBuffer, 0, aArray.buffer as ArrayBuffer);
		this.device.queue.writeBuffer(bBuffer, 0, bArray.buffer as ArrayBuffer);

		// Execute
		const pipeline = this.computePipelines.get('convolution')!;
		const bindGroup = this.device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: paramsBuffer } },
				{ binding: 1, resource: { buffer: aBuffer } },
				{ binding: 2, resource: { buffer: bBuffer } },
				{ binding: 3, resource: { buffer: resultBuffer } },
			],
		});

		const commandEncoder = this.device.createCommandEncoder();
		const computePass = commandEncoder.beginComputePass();
		computePass.setPipeline(pipeline);
		computePass.setBindGroup(0, bindGroup);
		computePass.dispatchWorkgroups(Math.ceil(dimensions / this.config.workgroupSize));
		computePass.end();

		// Read results
		const readBuffer = this.device.createBuffer({
			size: aArray.byteLength,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		commandEncoder.copyBufferToBuffer(resultBuffer, 0, readBuffer, 0, aArray.byteLength);
		this.device.queue.submit([commandEncoder.finish()]);

		await readBuffer.mapAsync(GPUMapMode.READ);
		const resultArray = new Float32Array(readBuffer.getMappedRange());
		const resultComponents = new Int8Array(dimensions);
		for (let i = 0; i < dimensions; i++) {
			resultComponents[i] = resultArray[i] >= 0 ? 1 : -1;
		}
		readBuffer.unmap();
		readBuffer.destroy();

		return new HyperVector(dimensions, resultComponents);
	}

	/**
	 * GPU-accelerated bundling
	 */
	async bundle(vectors: HyperVector[]): Promise<HyperVector> {
		if (!this.isInitialized || !this.device || vectors.length < 2) {
			return HyperVector.bundle(vectors); // Fallback to CPU
		}

		const dimensions = vectors[0].getDimensions();
		const numVectors = vectors.length;

		// Prepare data
		const vectorsArray = new Float32Array(numVectors * dimensions);
		for (let i = 0; i < numVectors; i++) {
			vectorsArray.set(vectors[i].toFloat32Array(), i * dimensions);
		}

		// Create buffers
		const paramsBuffer = this.getOrCreateBuffer(
			'bundle_params',
			8,
			GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		);
		const vectorsBuffer = this.getOrCreateBuffer(
			'bundle_vectors',
			vectorsArray.byteLength,
			GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		);
		const resultBuffer = this.getOrCreateBuffer(
			'bundle_result',
			dimensions * 4,
			GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
		);

		// Write data
		this.device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([dimensions, numVectors]));
		this.device.queue.writeBuffer(vectorsBuffer, 0, vectorsArray);

		// Execute
		const pipeline = this.computePipelines.get('bundle')!;
		const bindGroup = this.device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: paramsBuffer } },
				{ binding: 1, resource: { buffer: vectorsBuffer } },
				{ binding: 2, resource: { buffer: resultBuffer } },
			],
		});

		const commandEncoder = this.device.createCommandEncoder();
		const computePass = commandEncoder.beginComputePass();
		computePass.setPipeline(pipeline);
		computePass.setBindGroup(0, bindGroup);
		computePass.dispatchWorkgroups(Math.ceil(dimensions / this.config.workgroupSize));
		computePass.end();

		// Read results
		const readBuffer = this.device.createBuffer({
			size: dimensions * 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		commandEncoder.copyBufferToBuffer(resultBuffer, 0, readBuffer, 0, dimensions * 4);
		this.device.queue.submit([commandEncoder.finish()]);

		await readBuffer.mapAsync(GPUMapMode.READ);
		const resultArray = new Float32Array(readBuffer.getMappedRange());
		const resultComponents = new Int8Array(dimensions);
		for (let i = 0; i < dimensions; i++) {
			resultComponents[i] = resultArray[i] >= 0 ? 1 : -1;
		}
		readBuffer.unmap();
		readBuffer.destroy();

		return new HyperVector(dimensions, resultComponents);
	}

	/**
	 * CPU fallback for similarity computation
	 */
	private cpuSimilarities(query: HyperVector, vectors: HyperVector[]): Float32Array {
		const results = new Float32Array(vectors.length);
		for (let i = 0; i < vectors.length; i++) {
			results[i] = query.similarity(vectors[i]);
		}
		return results;
	}

	/**
	 * Get or create a reusable buffer
	 */
	private getOrCreateBuffer(key: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
		if (!this.device) throw new Error('GPU device not initialized');

		const existing = this.bufferPool.get(key);
		if (existing && existing.size >= size) {
			return existing;
		}

		// Destroy old buffer if it exists but is too small
		if (existing) {
			existing.destroy();
		}

		// Create new buffer with some extra space for growth
		const buffer = this.device.createBuffer({
			size: Math.ceil(size * 1.2), // 20% extra space
			usage,
		});

		this.bufferPool.set(key, buffer);
		return buffer;
	}

	/**
	 * Get GPU device information
	 */
	getDeviceInfo(): Record<string, unknown> | null {
		if (!this.adapter) return null;

		const info = this.adapter.info || {};
		const limits = this.adapter.limits || {};

		return {
			vendor: info.vendor,
			architecture: info.architecture,
			device: info.device,
			description: info.description,
			maxBufferSize: limits.maxBufferSize,
			maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
			isInitialized: this.isInitialized,
		};
	}

	/**
	 * Clean up GPU resources
	 */
	destroy(): void {
		// Destroy all pooled buffers
		for (const buffer of this.bufferPool.values()) {
			buffer.destroy();
		}
		this.bufferPool.clear();

		// Clear pipelines
		this.computePipelines.clear();

		// Destroy device
		if (this.device) {
			this.device.destroy();
			this.device = null;
		}

		this.adapter = null;
		this.isInitialized = false;

		logger.info('GPU accelerator destroyed');
	}
}
