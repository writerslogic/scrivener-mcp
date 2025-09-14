/**
 * WebGPU Type Definitions
 * Provides typing for WebGPU APIs used in GPU acceleration
 */

declare global {
	// GPU Buffer Usage Flags
	const GPUBufferUsage: {
		MAP_READ: number;
		MAP_WRITE: number;
		COPY_SRC: number;
		COPY_DST: number;
		INDEX: number;
		VERTEX: number;
		UNIFORM: number;
		STORAGE: number;
		INDIRECT: number;
		QUERY_RESOLVE: number;
	};

	// GPU Map Mode Flags
	const GPUMapMode: {
		READ: number;
		WRITE: number;
	};

	// GPU Shader Stage Flags
	const GPUShaderStage: {
		VERTEX: number;
		FRAGMENT: number;
		COMPUTE: number;
	};

	// GPU Texture Usage Flags
	const GPUTextureUsage: {
		COPY_SRC: number;
		COPY_DST: number;
		TEXTURE_BINDING: number;
		STORAGE_BINDING: number;
		RENDER_ATTACHMENT: number;
	};

	interface GPU {
		requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
		getPreferredCanvasFormat(): GPUTextureFormat;
	}

	interface GPUAdapter {
		readonly features: GPUSupportedFeatures;
		readonly limits: GPUSupportedLimits;
		readonly isFallbackAdapter: boolean;
		requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
		requestAdapterInfo(): Promise<GPUAdapterInfo>;
	}

	interface GPUAdapterInfo {
		readonly vendor: string;
		readonly architecture: string;
		readonly device: string;
		readonly description: string;
	}

	interface GPUDevice extends EventTarget {
		readonly features: GPUSupportedFeatures;
		readonly limits: GPUSupportedLimits;
		readonly queue: GPUQueue;
		destroy(): void;
		createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
		createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
		createSampler(descriptor?: GPUSamplerDescriptor): GPUSampler;
		createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
		createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
		createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
		createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
		createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
		createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
		createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder;
		createRenderBundleEncoder(
			descriptor: GPURenderBundleEncoderDescriptor
		): GPURenderBundleEncoder;
		createQuerySet(descriptor: GPUQuerySetDescriptor): GPUQuerySet;
		readonly lost: Promise<GPUDeviceLostInfo>;
		pushErrorScope(filter: GPUErrorFilter): void;
		popErrorScope(): Promise<GPUError | null>;
		onuncapturederror: ((event: GPUUncapturedErrorEvent) => void) | null;
	}

	interface GPUBuffer {
		readonly size: number;
		readonly usage: GPUFlagsConstant;
		readonly mapState: GPUBufferMapState;
		mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number): Promise<void>;
		getMappedRange(offset?: number, size?: number): ArrayBuffer;
		unmap(): void;
		destroy(): void;
		readonly label: string;
	}

	interface GPUQueue {
		submit(commandBuffers: Iterable<GPUCommandBuffer>): void;
		onSubmittedWorkDone(): Promise<void>;
		writeBuffer(
			buffer: GPUBuffer,
			bufferOffset: number,
			data: BufferSource | SharedArrayBuffer,
			dataOffset?: number,
			size?: number
		): void;
		writeTexture(
			destination: GPUImageCopyTexture,
			data: BufferSource | SharedArrayBuffer,
			dataLayout: GPUImageDataLayout,
			size: GPUExtent3D
		): void;
		copyExternalImageToTexture(
			source: GPUImageCopyExternalImage,
			destination: GPUImageCopyTextureTagged,
			copySize: GPUExtent3D
		): void;
		readonly label: string;
	}

	interface GPUCommandEncoder {
		beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
		beginComputePass(descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder;
		copyBufferToBuffer(
			source: GPUBuffer,
			sourceOffset: number,
			destination: GPUBuffer,
			destinationOffset: number,
			size: number
		): void;
		copyBufferToTexture(
			source: GPUImageCopyBuffer,
			destination: GPUImageCopyTexture,
			copySize: GPUExtent3D
		): void;
		copyTextureToBuffer(
			source: GPUImageCopyTexture,
			destination: GPUImageCopyBuffer,
			copySize: GPUExtent3D
		): void;
		copyTextureToTexture(
			source: GPUImageCopyTexture,
			destination: GPUImageCopyTexture,
			copySize: GPUExtent3D
		): void;
		clearBuffer(buffer: GPUBuffer, offset?: number, size?: number): void;
		resolveQuerySet(
			querySet: GPUQuerySet,
			firstQuery: number,
			queryCount: number,
			destination: GPUBuffer,
			destinationOffset: number
		): void;
		finish(descriptor?: GPUCommandBufferDescriptor): GPUCommandBuffer;
		readonly label: string;
		pushDebugGroup(groupLabel: string): void;
		popDebugGroup(): void;
		insertDebugMarker(markerLabel: string): void;
	}

	interface GPUComputePassEncoder {
		setPipeline(pipeline: GPUComputePipeline): void;
		setBindGroup(
			index: number,
			bindGroup: GPUBindGroup | null,
			dynamicOffsets?: Iterable<number>
		): void;
		dispatchWorkgroups(
			workgroupCountX: number,
			workgroupCountY?: number,
			workgroupCountZ?: number
		): void;
		dispatchWorkgroupsIndirect(indirectBuffer: GPUBuffer, indirectOffset: number): void;
		end(): void;
		readonly label: string;
		pushDebugGroup(groupLabel: string): void;
		popDebugGroup(): void;
		insertDebugMarker(markerLabel: string): void;
	}

	// Type aliases for commonly used types
	type GPUFlagsConstant = number;
	type GPUMapModeFlags = number;
	type GPUBufferMapState = 'unmapped' | 'pending' | 'mapped';
	type GPUTextureFormat = string;
	type GPUErrorFilter = 'validation' | 'out-of-memory' | 'internal';

	// Descriptor interfaces
	interface GPUBufferDescriptor extends GPUObjectDescriptorBase {
		size: number;
		usage: GPUBufferUsageFlags;
		mappedAtCreation?: boolean;
	}

	interface GPUObjectDescriptorBase {
		label?: string;
	}

	interface GPURequestAdapterOptions {
		powerPreference?: 'low-power' | 'high-performance';
		forceFallbackAdapter?: boolean;
	}

	interface GPUDeviceDescriptor extends GPUObjectDescriptorBase {
		requiredFeatures?: Iterable<GPUFeatureName>;
		requiredLimits?: Record<string, number>;
		defaultQueue?: GPUQueueDescriptor;
	}

	interface GPUQueueDescriptor extends GPUObjectDescriptorBase {}

	// Supporting interfaces
	interface GPUSupportedFeatures {
		readonly size: number;
		has(value: string): boolean;
		values(): IterableIterator<string>;
		keys(): IterableIterator<string>;
		entries(): IterableIterator<[string, string]>;
		forEach(
			callbackfn: (value: string, value2: string, set: GPUSupportedFeatures) => void,
			// Note: Using 'any' here for compatibility with DOM Set interface specification
			// This represents the 'this' context and must remain as 'any' for WebGPU spec compliance
			thisArg?: any
		): void;
	}

	interface GPUSupportedLimits {
		readonly maxTextureDimension1D: number;
		readonly maxTextureDimension2D: number;
		readonly maxTextureDimension3D: number;
		readonly maxTextureArrayLayers: number;
		readonly maxBindGroups: number;
		readonly maxBindGroupsPlusVertexBuffers: number;
		readonly maxBindingsPerBindGroup: number;
		readonly maxDynamicUniformBuffersPerPipelineLayout: number;
		readonly maxDynamicStorageBuffersPerPipelineLayout: number;
		readonly maxSampledTexturesPerShaderStage: number;
		readonly maxSamplersPerShaderStage: number;
		readonly maxStorageBuffersPerShaderStage: number;
		readonly maxStorageTexturesPerShaderStage: number;
		readonly maxUniformBuffersPerShaderStage: number;
		readonly maxUniformBufferBindingSize: number;
		readonly maxStorageBufferBindingSize: number;
		readonly minUniformBufferOffsetAlignment: number;
		readonly minStorageBufferOffsetAlignment: number;
		readonly maxVertexBuffers: number;
		readonly maxBufferSize: number;
		readonly maxVertexAttributes: number;
		readonly maxVertexBufferArrayStride: number;
		readonly maxInterStageShaderVariables: number;
		readonly maxColorAttachments: number;
		readonly maxColorAttachmentBytesPerSample: number;
		readonly maxComputeWorkgroupStorageSize: number;
		readonly maxComputeInvocationsPerWorkgroup: number;
		readonly maxComputeWorkgroupSizeX: number;
		readonly maxComputeWorkgroupSizeY: number;
		readonly maxComputeWorkgroupSizeZ: number;
		readonly maxComputeWorkgroupsPerDimension: number;
	}

	interface GPUDeviceLostInfo {
		readonly reason: GPUDeviceLostReason;
		readonly message: string;
	}

	type GPUDeviceLostReason = 'unknown' | 'destroyed';
	type GPUFeatureName = string;
	type GPUBufferUsageFlags = number;

	// Additional required types (stubs for completeness)
	interface GPUTexture {}
	interface GPUSampler {}
	interface GPUBindGroupLayout {}
	interface GPUPipelineLayout {}
	interface GPUBindGroup {}
	interface GPUShaderModule {}
	interface GPUComputePipeline {}
	interface GPURenderPipeline {}
	interface GPUCommandBuffer {}
	interface GPURenderPassEncoder {}
	interface GPURenderBundleEncoder {}
	interface GPUQuerySet {}
	interface GPUError {}
	interface GPUUncapturedErrorEvent extends Event {}
	interface GPUTextureDescriptor extends GPUObjectDescriptorBase {}
	interface GPUSamplerDescriptor extends GPUObjectDescriptorBase {}
	interface GPUBindGroupLayoutDescriptor extends GPUObjectDescriptorBase {}
	interface GPUPipelineLayoutDescriptor extends GPUObjectDescriptorBase {}
	interface GPUBindGroupDescriptor extends GPUObjectDescriptorBase {}
	interface GPUShaderModuleDescriptor extends GPUObjectDescriptorBase {}
	interface GPUComputePipelineDescriptor extends GPUObjectDescriptorBase {}
	interface GPURenderPipelineDescriptor extends GPUObjectDescriptorBase {}
	interface GPUCommandEncoderDescriptor extends GPUObjectDescriptorBase {}
	interface GPURenderBundleEncoderDescriptor extends GPUObjectDescriptorBase {}
	interface GPUQuerySetDescriptor extends GPUObjectDescriptorBase {}
	interface GPURenderPassDescriptor extends GPUObjectDescriptorBase {}
	interface GPUComputePassDescriptor extends GPUObjectDescriptorBase {}
	interface GPUCommandBufferDescriptor extends GPUObjectDescriptorBase {}
	interface GPUImageCopyTexture {}
	interface GPUImageDataLayout {}
	interface GPUExtent3D {}
	interface GPUImageCopyExternalImage {}
	interface GPUImageCopyTextureTagged {}
	interface GPUImageCopyBuffer {}

	// Global navigator extension
	interface Navigator {
		readonly gpu?: GPU;
	}
}

export {};
