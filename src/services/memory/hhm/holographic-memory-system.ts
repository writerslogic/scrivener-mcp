import { getLogger } from '../../../core/logger.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import * as path from 'path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { open } from 'fs/promises';
import type { HolographicMemorySystem as NativeEngine } from 'holographic-memory';
import { loadNativeBinding } from './native-loader.cjs';
import {
	FallbackDocumentIndex,
	validateHMSDocumentBatch,
	validateHMSSearch,
	validateHMSId,
	validateEmbeddingSpace,
	cloneHMSMetadata,
} from './document-index.js';
import type {
	HMSDocumentInput,
	HMSDocumentResult,
	HMSSearchOptions,
	HMSEmbeddingSpace,
} from './document-index.js';

export {
	cloneHMSMetadata,
	validateHMSMetadata,
	validateHMSDocumentBatch,
} from './document-index.js';
export type {
	HMSDocumentInput,
	HMSDocumentResult,
	HMSSearchOptions,
	HMSEmbeddingSpace,
} from './document-index.js';

const logger = getLogger('holographic-memory-system');

export interface HHMConfig {
	dimensions?: number;
	storagePath?: string;
	maxMemories?: number;
	useGPU?: boolean;
	autoEvolve?: boolean;
	similarityThreshold?: number;
	evolution?: Record<string, unknown>;
	engine?: 'auto' | 'native' | 'fallback';
	embeddingSpace?: HMSEmbeddingSpace;
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

const STOP_WORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'but',
	'in',
	'on',
	'at',
	'to',
	'for',
	'of',
	'with',
	'by',
	'from',
	'is',
	'was',
	'are',
	'were',
	'be',
	'been',
	'being',
	'have',
	'has',
	'had',
	'do',
	'does',
	'did',
	'will',
	'would',
	'could',
	'should',
	'may',
	'might',
	'shall',
	'can',
	'need',
	'dare',
	'this',
	'that',
	'these',
	'those',
	'it',
	'its',
	'his',
	'her',
	'he',
	'she',
	'they',
	'them',
	'their',
	'we',
	'us',
	'our',
	'you',
	'your',
	'not',
	'no',
	'nor',
	'as',
	'if',
	'then',
	'than',
	'too',
	'very',
	'just',
	'about',
	'above',
	'after',
	'again',
	'all',
	'also',
	'any',
	'because',
	'before',
	'between',
	'both',
	'each',
	'few',
	'get',
	'got',
	'how',
	'into',
	'more',
	'most',
	'new',
	'now',
	'only',
	'other',
	'out',
	'over',
	'own',
	'same',
	'some',
	'such',
	'there',
	'here',
	'what',
	'when',
	'where',
	'which',
	'while',
	'who',
	'whom',
	'why',
	'much',
	'many',
]);

/**
 * FNV-1a hash. Fast, good distribution, no crypto overhead.
 */
function fnv1a(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = (hash * 0x01000193) | 0;
	}
	return hash >>> 0;
}

/**
 * Pure JS vector engine used when holographic-memory native module not installed.
 * Random-projection TF-IDF with cosine similarity.
 */
class JSVectorEngine {
	private entries = new Map<string, VectorEntry>();
	private idf: Map<string, number> = new Map();
	private idfStale = true;
	private dimensions: number;

	constructor(dimensions: number) {
		this.dimensions = dimensions;
	}

	private tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
	}

	private rebuildIDF(): void {
		if (!this.idfStale) return;
		const docCount = this.entries.size || 1;
		const termDocs = new Map<string, number>();
		for (const entry of this.entries.values()) {
			const seen = new Set(this.tokenize(entry.text));
			for (const term of seen) {
				termDocs.set(term, (termDocs.get(term) || 0) + 1);
			}
		}
		this.idf.clear();
		for (const [term, count] of termDocs) {
			this.idf.set(term, Math.log((docCount + 1) / (count + 1)) + 1);
		}
		for (const entry of this.entries.values()) {
			entry.vector = this.textToVector(entry.text);
		}
		this.idfStale = false;
	}

	private textToVector(text: string): Float64Array {
		const tokens = this.tokenize(text);
		const tf = new Map<string, number>();
		let maxTf = 1;
		for (const token of tokens) {
			const count = (tf.get(token) || 0) + 1;
			tf.set(token, count);
			maxTf = Math.max(maxTf, count);
		}

		const vec = new Float64Array(this.dimensions);
		for (const [term, count] of tf) {
			const idfVal = this.idf.get(term) || 1;
			const weight = (1 + Math.log(count / maxTf + 1)) * idfVal;

			// Project each term into 7 random dimensions (sign-alternating)
			const h = fnv1a(term);
			for (let i = 0; i < 7; i++) {
				const idx = (h + i * 2654435761) % this.dimensions;
				vec[idx] += weight * (i % 2 === 0 ? 1 : -1);
			}
		}

		// L2 normalize
		let norm = 0;
		for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;

		return vec;
	}

	private cosine(a: Float64Array, b: Float64Array): number {
		let dot = 0;
		for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
		return dot; // Both pre-normalized, so dot = cosine
	}

	async memorizeText(id: string, text: string): Promise<void> {
		this.entries.delete(id);
		this.entries.set(id, { id, text, vector: new Float64Array(0) });
		this.idfStale = true;
	}

	async query(text: string, k: number): Promise<Array<{ id: string; similarity: number }>> {
		if (this.entries.size === 0) return [];
		this.rebuildIDF();
		const queryVec = this.textToVector(text);
		const scored = Array.from(this.entries.values(), (e) => ({
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
		this.rebuildIDF();
		const va = this.textToVector(a);
		const vb = this.textToVector(b);
		const vc = this.textToVector(c);
		const vd = new Float64Array(this.dimensions);
		for (let i = 0; i < this.dimensions; i++) vd[i] = vb[i] - va[i] + vc[i];

		let norm = 0;
		for (let i = 0; i < vd.length; i++) norm += vd[i] * vd[i];
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < vd.length; i++) vd[i] /= norm;

		const scored = Array.from(this.entries.values(), (e) => ({
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
		if (this.entries.size < 3) return [];
		this.rebuildIDF();
		const entries = [...this.entries.values()];

		// K-means++ initialization: spread centroids for better clusters
		const k = Math.min(5, Math.ceil(entries.length / 3));
		const centroidIndices: number[] = [Math.floor(Math.random() * entries.length)];

		while (centroidIndices.length < k) {
			const distances = entries.map((e) => {
				let minDist = Infinity;
				for (const ci of centroidIndices) {
					const sim = this.cosine(e.vector, entries[ci].vector);
					const dist = 1 - sim;
					if (dist < minDist) minDist = dist;
				}
				return minDist;
			});
			const totalDist = distances.reduce((a, b) => a + b, 0);
			let r = Math.random() * totalDist;
			for (let i = 0; i < distances.length; i++) {
				r -= distances[i];
				if (r <= 0) {
					centroidIndices.push(i);
					break;
				}
			}
		}

		const clusters: string[][] = centroidIndices.map(() => []);

		// Assign each entry to nearest centroid
		for (const entry of entries) {
			let bestIdx = 0;
			let bestSim = -1;
			for (let i = 0; i < centroidIndices.length; i++) {
				const sim = this.cosine(entry.vector, entries[centroidIndices[i]].vector);
				if (sim > bestSim) {
					bestSim = sim;
					bestIdx = i;
				}
			}
			clusters[bestIdx].push(entry.id);
		}

		return clusters
			.filter((c) => c.length >= 2)
			.map((members) => {
				// Compute average intra-cluster similarity as coherence
				let coherence = 0;
				let pairs = 0;
				for (let i = 0; i < Math.min(members.length, 10); i++) {
					for (let j = i + 1; j < Math.min(members.length, 10); j++) {
						const ei = this.entries.get(members[i]);
						const ej = this.entries.get(members[j]);
						if (ei && ej) {
							coherence += this.cosine(ei.vector, ej.vector);
							pairs++;
						}
					}
				}
				coherence = pairs > 0 ? coherence / pairs : 0;

				return {
					centroidId: members[0],
					coherence,
					memberCount: members.length,
					memberIds: members,
				};
			});
	}

	clear(): void {
		this.entries.clear();
		this.idf.clear();
		this.idfStale = true;
	}
}

interface NativeOwner {
	reference: WeakRef<NativeEngine>;
	configuration: string;
	users: number;
	version: string;
}

const nativeOwners = new Map<string, NativeOwner>();
let binding: ReturnType<typeof loadNativeBinding> | undefined;
let nativeLoadAttempted = false;

function getNativeBinding(): ReturnType<typeof loadNativeBinding> | undefined {
	if (!nativeLoadAttempted) {
		nativeLoadAttempted = true;
		try {
			binding = loadNativeBinding();
		} catch {
			logger.info('HMS native binding unavailable; using local JavaScript retrieval');
		}
	}
	return binding;
}

function defaultStoragePath(): string {
	if (process.env.SCRIVENER_HMS_STORAGE_DIR) return process.env.SCRIVENER_HMS_STORAGE_DIR;
	const legacy = path.join(process.cwd(), '.scrivener-hms.db');
	return existsSync(legacy) ? legacy : path.join(homedir(), '.scrivener-mcp', 'hms-v0.6.4');
}

function validateText(text: string): void {
	if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024)
		throw new RangeError('HMS text must contain at most 8 MiB of UTF-8 data');
}

function validateLimit(k: number): void {
	if (!Number.isSafeInteger(k) || k < 1 || k > 50000)
		throw new RangeError('HMS retrieval limit must be an integer from 1 to 50000');
}

export class HolographicMemorySystem {
	private readonly dimensions: number;
	private native: NativeEngine | null = null;
	private owner?: NativeOwner;
	private jsEngine?: JSVectorEngine;
	private readonly documentIndex = new FallbackDocumentIndex();
	private readonly memoryIndex = new Map<string, MemoryIndexEntry>();
	private readonly triplets = new Map<string, { head: string; relation: string; tail: string }>();
	private readonly inFlight = new Set<Promise<unknown>>();
	private readonly embeddingSpace?: HMSEmbeddingSpace;
	private closing?: Promise<void>;
	private released = false;
	private nativeVersion?: string;
	private fallbackReason?: string;

	constructor(config: HHMConfig = {}) {
		this.dimensions = config.dimensions ?? 10000;
		if (
			!Number.isSafeInteger(this.dimensions) ||
			this.dimensions < 1 ||
			this.dimensions > 1000000
		)
			throw new RangeError('HMS dimensions must be an integer from 1 to 1000000');
		if (config.embeddingSpace) {
			validateEmbeddingSpace(config.embeddingSpace);
			this.embeddingSpace = { ...config.embeddingSpace };
		}
		const selection = config.engine ?? process.env.SCRIVENER_HMS_ENGINE ?? 'auto';
		if (!['auto', 'native', 'fallback'].includes(selection))
			throw new TypeError('HMS engine must be auto, native or fallback');
		const loaded = selection === 'fallback' ? undefined : getNativeBinding();
		if (selection === 'native' && !loaded) throw new Error('HMS native binding is unavailable');
		if (loaded) {
			const requestedPath = config.storagePath ?? defaultStoragePath();
			if (
				typeof requestedPath !== 'string' ||
				!requestedPath ||
				requestedPath.includes('\0') ||
				Buffer.byteLength(requestedPath) > 4096
			)
				throw new TypeError('Invalid HMS storage path');
			mkdirSync(requestedPath, { recursive: true, mode: 0o700 });
			const storagePath = realpathSync(requestedPath);
			const configuration = JSON.stringify([this.dimensions, this.embeddingSpace ?? null]);
			const cached = nativeOwners.get(storagePath);
			const cachedEngine = cached?.reference.deref();
			if (cachedEngine && cached?.configuration !== configuration)
				throw new Error(
					'HMS store is already open with incompatible dimensions or embedding space'
				);
			try {
				const engine =
					cachedEngine ??
					new loaded.module.HolographicMemorySystem(this.dimensions, storagePath, {
						embeddingModel: this.embeddingSpace?.model,
						embeddingRevision: this.embeddingSpace?.revision,
						embeddingDimensions: this.embeddingSpace?.dimensions,
					});
				const owner =
					cachedEngine && cached
						? cached
						: {
								reference: new WeakRef(engine),
								configuration,
								users: 0,
								version: loaded.version,
							};
				owner.users++;
				this.owner = owner;
				this.native = engine;
				this.nativeVersion = owner.version;
				nativeOwners.set(storagePath, owner);
				for (const [key, value] of nativeOwners)
					if (!value.users && !value.reference.deref()) nativeOwners.delete(key);
			} catch (error) {
				if (
					selection !== 'auto' ||
					typeof error !== 'object' ||
					error === null ||
					!('message' in error) ||
					typeof error.message !== 'string' ||
					!error.message.includes('is already open by another engine')
				)
					throw error;
				this.fallbackReason = 'Native store is owned by another server instance';
			}
		}
		if (!this.native) {
			this.jsEngine = new JSVectorEngine(Math.min(this.dimensions, 512));
			this.fallbackReason ??=
				selection === 'fallback'
					? 'Explicit fallback selection'
					: 'Native binding unavailable';
		}
		logger.info('HMS initialized', {
			engine: this.native ? 'native' : 'fallback',
			version: this.nativeVersion,
		});
	}

	private operation<T>(work: () => T | Promise<T>): Promise<T> {
		if (this.closing || this.released)
			return Promise.reject(new Error('HMS instance is closed'));
		const pending = Promise.resolve().then(work);
		this.inFlight.add(pending);
		void pending.then(
			() => this.inFlight.delete(pending),
			() => this.inFlight.delete(pending)
		);
		return pending;
	}

	memorizeDocuments(inputs: readonly HMSDocumentInput[]): Promise<number[]> {
		return this.operation(async () => {
			const prepared = validateHMSDocumentBatch(inputs, this.embeddingSpace);
			return this.native
				? this.native.memorizeDocuments(prepared)
				: this.documentIndex.memorize(prepared);
		});
	}

	searchDocuments(text: string, options: HMSSearchOptions = {}): Promise<HMSDocumentResult[]> {
		return this.operation(async () => {
			const prepared = validateHMSSearch(text, options, this.embeddingSpace);
			if (prepared.documentIds?.length === 0) return [];
			if (!this.native) return this.documentIndex.search(text, prepared);
			const results = await this.native.searchDocuments(text, prepared);
			return results.map((result) => ({
				...result,
				metadata: cloneHMSMetadata(result.metadata ?? {}),
			}));
		});
	}

	deleteDocument(id: string): Promise<boolean> {
		return this.operation(() => {
			validateHMSId(id);
			return this.native ? this.native.deleteDocument(id) : this.documentIndex.delete(id);
		});
	}

	flush(): Promise<void> {
		return this.operation(async () => {
			await this.native?.flush();
		});
	}

	memorizeText(
		text: string,
		id: string = randomUUID(),
		traceId?: string
	): Promise<MemoryFormationResult> {
		return this.operation(async () => {
			validateHMSId(id);
			validateText(text);
			if (this.native) await this.native.memorizeText(id, text, traceId);
			else await this.jsEngine!.memorizeText(id, text);
			this.memoryIndex.set(id, { modality: 'text', originalData: text });
			return { id, modalities: ['text'] };
		});
	}

	memorizeDocument(
		document: ScrivenerDocument,
		traceId?: string
	): Promise<MemoryFormationResult> {
		return this.operation(async () => {
			validateHMSId(document.id);
			const id = `doc_${document.id}`;
			const content = document.content ?? '';
			validateText(content);
			if (this.native) await this.native.memorizeText(id, content, traceId);
			else await this.jsEngine!.memorizeText(id, content);
			this.memoryIndex.set(id, { modality: 'document', originalData: document });
			return { id, modalities: ['document'] };
		});
	}

	memorizeBatch(items: Array<{ id: string; text: string }>, traceId?: string): Promise<void> {
		return this.operation(async () => {
			if (!Array.isArray(items) || items.length > 4096)
				throw new RangeError('HMS text batch exceeds 4096 items');
			let bytes = 0;
			for (const item of items) {
				validateHMSId(item.id);
				validateText(item.text);
				bytes += Buffer.byteLength(item.text);
				if (bytes > 8 * 1024 * 1024) throw new RangeError('HMS text batch exceeds 8 MiB');
			}
			if (this.native) await this.native.memorizeBatch(items, traceId);
			else for (const item of items) await this.jsEngine!.memorizeText(item.id, item.text);
			for (const item of items)
				this.memoryIndex.set(item.id, { modality: 'text', originalData: item.text });
		});
	}

	memorizeTextBuffer(
		id: string,
		buffer: Buffer,
		traceId?: string
	): Promise<MemoryFormationResult> {
		return this.operation(async () => {
			validateHMSId(id);
			if (!Buffer.isBuffer(buffer) || buffer.length > 8 * 1024 * 1024)
				throw new RangeError('HMS text buffer exceeds 8 MiB');
			const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
			if (this.native) await this.native.memorizeTextBuffer(id, buffer, traceId);
			else await this.jsEngine!.memorizeText(id, text);
			this.memoryIndex.set(id, { modality: 'text', originalData: text });
			return { id, modalities: ['text'] };
		});
	}

	memorizeFile(id: string, filePath: string): Promise<MemoryFormationResult> {
		return this.operation(async () => {
			validateHMSId(id);
			const file = await open(filePath, 'r');
			let text: string;
			try {
				if (!(await file.stat()).isFile())
					throw new Error('filePath must name a regular file');
				const chunks: Buffer[] = [];
				let length = 0;
				for await (const chunk of file.createReadStream({ autoClose: false })) {
					length += chunk.length;
					if (length > 8 * 1024 * 1024) throw new RangeError('file exceeds 8 MiB');
					chunks.push(chunk);
				}
				text = new TextDecoder('utf-8', { fatal: true }).decode(
					Buffer.concat(chunks, length)
				);
			} finally {
				await file.close();
			}
			if (this.native) await this.native.memorizeText(id, text);
			else await this.jsEngine!.memorizeText(id, text);
			this.memoryIndex.set(id, { modality: 'file', originalData: text });
			return { id, modalities: ['file'] };
		});
	}

	private mapResults(results: Array<{ id: string; similarity: number }>): QueryResult[] {
		return results.map((result, index) => {
			const entry = this.memoryIndex.get(result.id);
			return {
				...result,
				entry: { id: result.id, metadata: entry },
				rank: index + 1,
				reconstructed: entry?.originalData,
				explanation: `Similarity: ${result.similarity.toFixed(3)} | Type: ${entry?.modality ?? 'unknown'}`,
			};
		});
	}

	queryText(text: string, k: number = 10, traceId?: string): Promise<QueryResult[]> {
		return this.operation(async () => {
			validateText(text);
			validateLimit(k);
			return this.mapResults(
				this.native
					? await this.native.query(text, k, traceId)
					: await this.jsEngine!.query(text, k)
			);
		});
	}

	findAnalogy(a: string, b: string, c: string, traceId?: string): Promise<QueryResult[]> {
		return this.operation(async () => {
			[a, b, c].forEach(validateText);
			return this.mapResults(
				this.native
					? await this.native.findAnalogy(a, b, c, undefined, traceId)
					: await this.jsEngine!.findAnalogy(a, b, c)
			);
		});
	}

	dream(): Promise<ConceptSummary[]> {
		return this.operation(async () => {
			const concepts = this.native
				? await this.native.synthesizeConcepts()
				: await this.jsEngine!.synthesizeConcepts();
			return concepts.map((concept) => ({
				conceptId: concept.centroidId,
				thematicDensity: concept.coherence,
				memberCount: concept.memberCount,
				memberIds: concept.memberIds,
				summary: `Concept: ${concept.centroidId} (coherence: ${concept.coherence.toFixed(3)}, members: ${concept.memberCount})`,
			}));
		});
	}

	discoverAssociations(id: string, threshold: number = 0.6): Promise<QueryResult[]> {
		return this.operation(async () => {
			validateHMSId(id);
			if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1)
				throw new RangeError('Association threshold must be between -1 and 1');
			const value = this.memoryIndex.get(id)?.originalData;
			const text =
				typeof value === 'string'
					? value
					: (value as ScrivenerDocument | undefined)?.content;
			if (!text) return [];
			const results = this.native
				? await this.native.query(text, 20)
				: await this.jsEngine!.query(text, 20);
			return this.mapResults(
				results.filter((result) => result.id !== id && result.similarity >= threshold)
			);
		});
	}

	memorizeTriplet(id: string, head: string, relation: string, tail: string): Promise<void> {
		return this.operation(async () => {
			[id, head, relation, tail].forEach(validateHMSId);
			if (this.native) await this.native.memorizeTriplet(id, head, relation, tail);
			else await this.jsEngine!.memorizeText(id, `${head} ${relation} ${tail}`);
			this.triplets.set(id, { head, relation, tail });
		});
	}

	queryTriplet(head: string, relation: string, k: number = 10): Promise<QueryResult[]> {
		return this.operation(async () => {
			validateText(head);
			validateText(relation);
			validateLimit(k);
			if (this.native)
				return this.mapResults(await this.native.queryTriplet(head, relation, k));
			const merged = new Map<string, { id: string; similarity: number }>();
			for (const [id, triplet] of this.triplets)
				if (
					(!head || head === triplet.head) &&
					(!relation || relation === triplet.relation)
				)
					merged.set(id, { id, similarity: 1 });
			for (const hit of await this.jsEngine!.query(`${head} ${relation}`, k))
				if (!merged.has(hit.id)) merged.set(hit.id, hit);
			return this.mapResults(
				[...merged.values()].sort((a, b) => b.similarity - a.similarity).slice(0, k)
			);
		});
	}

	memorizeSequence(id: string, sequence: string[]): Promise<void> {
		return this.operation(async () => {
			validateHMSId(id);
			if (!Array.isArray(sequence) || sequence.length > 4096)
				throw new RangeError('HMS sequence exceeds 4096 items');
			sequence.forEach(validateHMSId);
			if (this.native) await this.native.memorizeSequence(id, sequence);
			else await this.jsEngine!.memorizeText(id, sequence.join(' -> '));
		});
	}

	queryBatch(texts: string[], k: number): Promise<QueryResult[][]> {
		return this.operation(async () => {
			if (!Array.isArray(texts) || texts.length > 4096)
				throw new RangeError('HMS query batch exceeds 4096 items');
			let bytes = 0;
			for (const text of texts) {
				validateText(text);
				bytes += Buffer.byteLength(text);
				if (bytes > 8 * 1024 * 1024) throw new RangeError('HMS query batch exceeds 8 MiB');
			}
			validateLimit(k);
			if (texts.length * k > 1000000)
				throw new RangeError('HMS query batch result allocation exceeds its limit');
			const results = this.native
				? await this.native.queryBatch(texts, k)
				: await Promise.all(texts.map((text) => this.jsEngine!.query(text, k)));
			return results.map((hits) => this.mapResults(hits));
		});
	}

	getStats(): Record<string, unknown> {
		return {
			dimensions: this.native ? this.dimensions : Math.min(this.dimensions, 512),
			engine: this.nativeVersion ? `Rust Native ${this.nativeVersion}` : 'JS Fallback',
			version: this.nativeVersion,
			totalMemories: this.native?.vectorCount ?? this.memoryIndex.size,
			totalTriplets: this.triplets.size,
			persistentDocuments: !!this.nativeVersion,
			fallbackReason: this.fallbackReason,
			closed: this.released || !!this.closing,
		};
	}

	destroy(): Promise<void> {
		if (this.closing) return this.closing;
		this.closing = (async () => {
			await Promise.allSettled(this.inFlight);
			try {
				await this.native?.flush();
			} finally {
				if (this.owner) this.owner.users--;
				this.owner = undefined;
				this.native = null;
				this.jsEngine?.clear();
				this.documentIndex.clear();
				this.memoryIndex.clear();
				this.triplets.clear();
				this.released = true;
			}
		})();
		return this.closing;
	}
}
