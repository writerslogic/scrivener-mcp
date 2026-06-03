import type { RetrievalResult as NativeRetrievalResult, ConceptCandidate } from '@hms/native';
import { HolographicMemorySystem as NativeHMS } from '@hms/native';
import { getLogger } from '../../../core/logger.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import * as path from 'path';

const logger = getLogger('holographic-memory-system');

export interface HHMConfig {
	dimensions?: number;
	storagePath?: string;
	maxMemories?: number;
	useGPU?: boolean;
	autoEvolve?: boolean;
	similarityThreshold?: number;
	evolution?: Record<string, unknown>;
}

export interface MemoryFormationResult {
	id: string;
	modalities: string[];
}

export interface MemoryIndexEntry {
	modality: string;
	originalData?: unknown;
}

export interface QueryResult {
	id: string;
	similarity: number;
	entry: {
		id: string;
		metadata?: MemoryIndexEntry;
	};
	rank: number;
	reconstructed?: unknown;
	explanation?: string;
}

export interface ConceptSummary {
	conceptId: string;
	thematicDensity: number;
	memberCount: number;
	memberIds: string[];
	summary: string;
}

export class HolographicMemorySystem {
	private dimensions: number;
	private native: NativeHMS;
	private memoryIndex: Map<string, MemoryIndexEntry> = new Map();

	constructor(config: HHMConfig = {}) {
		this.dimensions = config.dimensions || 10000;
		const storagePath = config.storagePath || path.join(process.cwd(), '.scrivener-hms.db');
		this.native = new NativeHMS(this.dimensions, storagePath);

		logger.info('HMS initialized', {
			dimensions: this.dimensions,
			persistence: storagePath,
		});
	}

	async memorizeText(
		text: string,
		id?: string,
		traceId?: string
	): Promise<MemoryFormationResult> {
		const memoryId = id || `text_${Date.now()}`;
		await this.native.memorizeText(memoryId, text, traceId);
		this.memoryIndex.set(memoryId, { modality: 'text', originalData: text });
		return { id: memoryId, modalities: ['text'] };
	}

	async memorizeDocument(
		document: ScrivenerDocument,
		traceId?: string
	): Promise<MemoryFormationResult> {
		const memoryId = `doc_${document.id}`;
		await this.native.memorizeText(memoryId, document.content || '', traceId);
		this.memoryIndex.set(memoryId, { modality: 'document', originalData: document });
		return { id: memoryId, modalities: ['document'] };
	}

	async memorizeBatch(
		items: Array<{ id: string; text: string }>,
		traceId?: string
	): Promise<void> {
		await this.native.memorizeBatch(items, traceId);
		for (const item of items) {
			this.memoryIndex.set(item.id, { modality: 'text', originalData: item.text });
		}
	}

	async memorizeTextBuffer(
		id: string,
		buffer: Buffer,
		traceId?: string
	): Promise<MemoryFormationResult> {
		await this.native.memorizeTextBuffer(id, buffer, traceId);
		this.memoryIndex.set(id, { modality: 'text' });
		return { id, modalities: ['text'] };
	}

	async memorizeFile(id: string, filePath: string): Promise<MemoryFormationResult> {
		await this.native.memorizeFile(id, filePath);
		this.memoryIndex.set(id, { modality: 'file', originalData: filePath });
		return { id, modalities: ['file'] };
	}

	private mapResults(results: NativeRetrievalResult[]): QueryResult[] {
		return results.map((r, index) => {
			const indexEntry = this.memoryIndex.get(r.id);
			return {
				id: r.id,
				similarity: r.similarity,
				entry: { id: r.id, metadata: indexEntry },
				rank: index + 1,
				reconstructed: indexEntry?.originalData,
				explanation: `Similarity: ${r.similarity.toFixed(3)} | Type: ${indexEntry?.modality || 'unknown'}`,
			};
		});
	}

	async queryText(text: string, k: number = 10, traceId?: string): Promise<QueryResult[]> {
		const results = await this.native.query(text, k, traceId);
		return this.mapResults(results);
	}

	async findAnalogy(a: string, b: string, c: string, traceId?: string): Promise<QueryResult[]> {
		const results = await this.native.findAnalogy(a, b, c, traceId);
		return this.mapResults(results);
	}

	async dream(): Promise<ConceptSummary[]> {
		logger.info('HMS entering DREAM mode');
		try {
			const concepts = await this.native.synthesizeConcepts();
			return concepts.map((c: ConceptCandidate) => ({
				conceptId: c.centroidId,
				thematicDensity: c.coherence,
				memberCount: c.memberCount,
				memberIds: c.memberIds,
				summary: `Concept: ${c.centroidId} (coherence: ${c.coherence.toFixed(3)}, members: ${c.memberCount})`,
			}));
		} catch (error) {
			logger.warn('HMS Dream mode failed', { error: (error as Error).message });
			return [];
		}
	}

	async discoverAssociations(id: string, threshold: number = 0.6): Promise<QueryResult[]> {
		const indexEntry = this.memoryIndex.get(id);
		if (!indexEntry?.originalData) return [];

		const text =
			typeof indexEntry.originalData === 'string'
				? indexEntry.originalData
				: (indexEntry.originalData as ScrivenerDocument).content || '';
		if (!text) return [];

		const results = await this.native.query(text, 20);
		return this.mapResults(results.filter((r) => r.id !== id && r.similarity >= threshold));
	}

	getStats(): Record<string, unknown> {
		return {
			dimensions: this.dimensions,
			engine: 'Rust Native v2.0',
			totalMemories: this.memoryIndex.size,
		};
	}

	async destroy(): Promise<void> {
		logger.info('Shutting down HMS Engine');
		this.memoryIndex.clear();
	}
}
