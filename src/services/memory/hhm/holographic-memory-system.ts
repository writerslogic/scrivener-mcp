import { getLogger } from '../../../core/logger.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import * as path from 'path';
import * as crypto from 'crypto';

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

interface VectorEntry {
	id: string;
	vector: Float64Array;
	text: string;
}

/**
 * Pure JS vector engine used when @hms/native is not installed.
 * Uses TF-IDF-style term vectors with cosine similarity.
 */
class JSVectorEngine {
	private entries: VectorEntry[] = [];
	private vocabulary: Map<string, number> = new Map();
	private idf: Map<string, number> = new Map();
	private dimensions: number;

	constructor(dimensions: number) {
		this.dimensions = dimensions;
	}

	private tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter((w) => w.length > 2);
	}

	private textToVector(text: string): Float64Array {
		const tokens = this.tokenize(text);
		const tf = new Map<string, number>();
		for (const token of tokens) {
			tf.set(token, (tf.get(token) || 0) + 1);
		}

		// Hash-based projection into fixed dimensions
		const vec = new Float64Array(this.dimensions);
		for (const [term, count] of tf) {
			const idfVal = this.idf.get(term) || 1;
			const weight = count * idfVal;
			// Deterministic hash to map term to dimension indices
			const hash = this.hashTerm(term);
			for (let i = 0; i < 3; i++) {
				const idx = Math.abs((hash + i * 7919) % this.dimensions);
				vec[idx] += weight * (i % 2 === 0 ? 1 : -1);
			}
		}

		// Normalize
		let norm = 0;
		for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;

		return vec;
	}

	private hashTerm(term: string): number {
		const hash = crypto.createHash('md5').update(term).digest();
		return hash.readUInt32LE(0);
	}

	private cosine(a: Float64Array, b: Float64Array): number {
		let dot = 0;
		for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
		return dot;
	}

	private rebuildIDF(): void {
		const docCount = this.entries.length || 1;
		const termDocs = new Map<string, number>();
		for (const entry of this.entries) {
			const seen = new Set(this.tokenize(entry.text));
			for (const term of seen) {
				termDocs.set(term, (termDocs.get(term) || 0) + 1);
			}
		}
		for (const [term, count] of termDocs) {
			this.idf.set(term, Math.log(docCount / count) + 1);
		}
	}

	async memorizeText(id: string, text: string): Promise<void> {
		// Remove existing entry with same id
		this.entries = this.entries.filter((e) => e.id !== id);
		const vector = this.textToVector(text);
		this.entries.push({ id, vector, text });
		// Rebuild IDF periodically
		if (this.entries.length % 10 === 0) this.rebuildIDF();
	}

	async query(text: string, k: number): Promise<Array<{ id: string; similarity: number }>> {
		if (this.entries.length === 0) return [];
		const queryVec = this.textToVector(text);
		const scored = this.entries.map((e) => ({
			id: e.id,
			similarity: this.cosine(queryVec, e.vector),
		}));
		scored.sort((a, b) => b.similarity - a.similarity);
		return scored.slice(0, k);
	}

	async findAnalogy(
		a: string,
		b: string,
		c: string
	): Promise<Array<{ id: string; similarity: number }>> {
		// d = b - a + c
		const va = this.textToVector(a);
		const vb = this.textToVector(b);
		const vc = this.textToVector(c);
		const vd = new Float64Array(this.dimensions);
		for (let i = 0; i < this.dimensions; i++) vd[i] = vb[i] - va[i] + vc[i];

		// Normalize
		let norm = 0;
		for (let i = 0; i < vd.length; i++) norm += vd[i] * vd[i];
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < vd.length; i++) vd[i] /= norm;

		const scored = this.entries.map((e) => ({
			id: e.id,
			similarity: this.cosine(vd, e.vector),
		}));
		scored.sort((a, b) => b.similarity - a.similarity);
		return scored.slice(0, 10);
	}

	async synthesizeConcepts(): Promise<
		Array<{
			centroidId: string;
			coherence: number;
			memberCount: number;
			memberIds: string[];
		}>
	> {
		if (this.entries.length < 3) return [];

		// Simple k-means-style clustering
		const k = Math.min(5, Math.ceil(this.entries.length / 3));
		const centroids = this.entries.slice(0, k).map((e) => ({
			vector: Float64Array.from(e.vector),
			members: [] as string[],
		}));

		// Single pass assignment
		for (const entry of this.entries) {
			let bestIdx = 0;
			let bestSim = -1;
			for (let i = 0; i < centroids.length; i++) {
				const sim = this.cosine(entry.vector, centroids[i].vector);
				if (sim > bestSim) {
					bestSim = sim;
					bestIdx = i;
				}
			}
			centroids[bestIdx].members.push(entry.id);
		}

		return centroids
			.filter((c) => c.members.length >= 2)
			.map((c) => ({
				centroidId: c.members[0],
				coherence: c.members.length / this.entries.length,
				memberCount: c.members.length,
				memberIds: c.members,
			}));
	}

	clear(): void {
		this.entries = [];
		this.vocabulary.clear();
		this.idf.clear();
	}
}

// Try loading native HMS, fall back to JS engine
let NativeHMS: any = null;
try {
	const native = require('@hms/native');
	NativeHMS = native.HolographicMemorySystem;
	logger.info('HMS using native Rust engine');
} catch {
	logger.info('HMS using JS fallback engine (@hms/native not installed)');
}

export class HolographicMemorySystem {
	private dimensions: number;
	private native: any | null = null;
	private jsEngine: JSVectorEngine | null = null;
	private memoryIndex: Map<string, MemoryIndexEntry> = new Map();
	private engineType: 'native' | 'js';

	constructor(config: HHMConfig = {}) {
		this.dimensions = config.dimensions || 10000;
		const storagePath = config.storagePath || path.join(process.cwd(), '.scrivener-hms.db');

		if (NativeHMS) {
			this.native = new NativeHMS(this.dimensions, storagePath);
			this.engineType = 'native';
		} else {
			this.jsEngine = new JSVectorEngine(Math.min(this.dimensions, 512));
			this.engineType = 'js';
		}

		logger.info('HMS initialized', {
			engine: this.engineType,
			dimensions: this.dimensions,
		});
	}

	async memorizeText(
		text: string,
		id?: string,
		traceId?: string
	): Promise<MemoryFormationResult> {
		const memoryId = id || `text_${Date.now()}`;
		if (this.native) {
			await this.native.memorizeText(memoryId, text, traceId);
		} else {
			await this.jsEngine!.memorizeText(memoryId, text);
		}
		this.memoryIndex.set(memoryId, { modality: 'text', originalData: text });
		return { id: memoryId, modalities: ['text'] };
	}

	async memorizeDocument(
		document: ScrivenerDocument,
		traceId?: string
	): Promise<MemoryFormationResult> {
		const memoryId = `doc_${document.id}`;
		const content = document.content || '';
		if (this.native) {
			await this.native.memorizeText(memoryId, content, traceId);
		} else {
			await this.jsEngine!.memorizeText(memoryId, content);
		}
		this.memoryIndex.set(memoryId, { modality: 'document', originalData: document });
		return { id: memoryId, modalities: ['document'] };
	}

	async memorizeBatch(
		items: Array<{ id: string; text: string }>,
		traceId?: string
	): Promise<void> {
		if (this.native) {
			await this.native.memorizeBatch(items, traceId);
		} else {
			for (const item of items) {
				await this.jsEngine!.memorizeText(item.id, item.text);
			}
		}
		for (const item of items) {
			this.memoryIndex.set(item.id, { modality: 'text', originalData: item.text });
		}
	}

	async memorizeTextBuffer(
		id: string,
		buffer: Buffer,
		traceId?: string
	): Promise<MemoryFormationResult> {
		const text = buffer.toString('utf-8');
		if (this.native) {
			await this.native.memorizeTextBuffer(id, buffer, traceId);
		} else {
			await this.jsEngine!.memorizeText(id, text);
		}
		this.memoryIndex.set(id, { modality: 'text' });
		return { id, modalities: ['text'] };
	}

	async memorizeFile(id: string, filePath: string): Promise<MemoryFormationResult> {
		if (this.native) {
			await this.native.memorizeFile(id, filePath);
		} else {
			const fs = await import('fs');
			const text = fs.readFileSync(filePath, 'utf-8');
			await this.jsEngine!.memorizeText(id, text);
		}
		this.memoryIndex.set(id, { modality: 'file', originalData: filePath });
		return { id, modalities: ['file'] };
	}

	private mapResults(results: Array<{ id: string; similarity: number }>): QueryResult[] {
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
		const results = this.native
			? await this.native.query(text, k, traceId)
			: await this.jsEngine!.query(text, k);
		return this.mapResults(results);
	}

	async findAnalogy(a: string, b: string, c: string, traceId?: string): Promise<QueryResult[]> {
		const results = this.native
			? await this.native.findAnalogy(a, b, c, traceId)
			: await this.jsEngine!.findAnalogy(a, b, c);
		return this.mapResults(results);
	}

	async dream(): Promise<ConceptSummary[]> {
		logger.info('HMS entering DREAM mode');
		try {
			const concepts = this.native
				? await this.native.synthesizeConcepts()
				: await this.jsEngine!.synthesizeConcepts();
			return concepts.map(
				(c: {
					centroidId: string;
					coherence: number;
					memberCount: number;
					memberIds: string[];
				}) => ({
					conceptId: c.centroidId,
					thematicDensity: c.coherence,
					memberCount: c.memberCount,
					memberIds: c.memberIds,
					summary: `Concept: ${c.centroidId} (coherence: ${c.coherence.toFixed(3)}, members: ${c.memberCount})`,
				})
			);
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

		const results = this.native
			? await this.native.query(text, 20)
			: await this.jsEngine!.query(text, 20);
		return this.mapResults(
			results.filter(
				(r: { id: string; similarity: number }) => r.id !== id && r.similarity >= threshold
			)
		);
	}

	getStats(): Record<string, unknown> {
		return {
			dimensions: this.dimensions,
			engine: this.engineType === 'native' ? 'Rust Native v2.0' : 'JS Fallback',
			totalMemories: this.memoryIndex.size,
		};
	}

	async destroy(): Promise<void> {
		logger.info('Shutting down HMS Engine');
		if (this.jsEngine) this.jsEngine.clear();
		this.memoryIndex.clear();
	}
}
