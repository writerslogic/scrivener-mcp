import { HolographicMemorySystem as NativeHMS } from 'hms-native';
import { getLogger } from '../../../core/logger.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import * as path from 'path';

const logger = getLogger('holographic-memory-system');

export interface HHMConfig {
	dimensions?: number;
	storagePath?: string;
}

export interface MemoryFormationResult {
	id: string;
	modalities: string[];
}

export interface QueryResult {
	id: string;
	similarity: number;
	reconstructed?: unknown;
	explanation?: string;
}

/**
 * High-Performance Native Semantic Memory System
 * All compute-heavy vector math and encoding is offloaded to the Rust HMS Engine
 */
export class HolographicMemorySystem {
	private dimensions: number;
	private native: NativeHMS;
	private memoryIndex: Map<string, { modality: string; originalData?: unknown }> = new Map();

	constructor(config: HHMConfig = {}) {
		this.dimensions = config.dimensions || 10000;
		
		// Use project-specific persistence path if available
		const storagePath = config.storagePath || path.join(process.cwd(), '.scrivener-hms.db');

		// Initialize the Rust-Native engine
		this.native = new NativeHMS(this.dimensions, storagePath);

		logger.info('Holographic Memory System initialized with Native Rust v2.0 Engine', {
			dimensions: this.dimensions,
			persistence: storagePath,
			acceleration: 'Rayon/Native-SIMD'
		});
	}

	async memorizeText(text: string, id?: string): Promise<MemoryFormationResult> {
		const memoryId = id || `text_${Date.now()}`;
		
		// Pure native call - text goes in, memory is formed in Rust
		this.native.memorize_text(memoryId, text);

		this.memoryIndex.set(memoryId, {
			modality: 'text',
			originalData: text
		});

		return {
			id: memoryId,
			modalities: ['text']
		};
	}

	async memorizeDocument(document: ScrivenerDocument): Promise<MemoryFormationResult> {
		const memoryId = `doc_${document.id}`;
		const content = document.content || '';

		this.native.memorize_text(memoryId, content);

		this.memoryIndex.set(memoryId, {
			modality: 'document',
			originalData: document
		});

		return {
			id: memoryId,
			modalities: ['document']
		};
	}

	async queryText(text: string, k: number = 10): Promise<QueryResult[]> {
		// Pure native search
		const results = this.native.query(text, k);

		return results.map(r => {
			const indexEntry = this.memoryIndex.get(r.id);
			return {
				id: r.id,
				similarity: r.similarity,
				reconstructed: indexEntry?.originalData,
				explanation: `Native Rust Engine | Type: ${indexEntry?.modality || 'unknown'} | Similarity: ${r.similarity.toFixed(3)}`
			};
		});
	}

	getStats(): Record<string, unknown> {
		return {
			dimensions: this.dimensions,
			engine: 'Rust Native v2.0',
			totalMemories: this.memoryIndex.size,
			acceleration: 'True Multi-threading (Rayon)'
		};
	}

	async destroy(): Promise<void> {
		logger.info('Shutting down HMS Engine');
		this.memoryIndex.clear();
	}
}
