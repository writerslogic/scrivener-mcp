import type { DocumentInput, DocumentResult, SearchOptions } from 'holographic-memory';

export type HMSDocumentInput = Omit<DocumentInput, 'metadata'> & {
	metadata?: Record<string, unknown>;
};
export type HMSDocumentResult = Omit<DocumentResult, 'metadata'> & {
	metadata: Record<string, unknown>;
};
export type HMSSearchOptions = Omit<SearchOptions, 'filter'> & {
	filter?: Record<string, unknown>;
};
export interface HMSEmbeddingSpace {
	model: string;
	revision: string;
	dimensions: number;
}

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_TRANSACTION_BYTES = 32 * 1024 * 1024;

function integer(value: number, min: number, max: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
}

export function validateHMSId(value: unknown): asserts value is string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.includes('\0') ||
		Buffer.byteLength(value) > 4096
	)
		throw new TypeError('HMS identity must contain 1 to 4096 UTF-8 bytes without NUL');
}

export function validateHMSMetadata(value: unknown): asserts value is Record<string, unknown> {
	const ancestors = new Set<object>();
	let nodes = 0;
	function visit(item: unknown, depth: number): void {
		if (++nodes > 32768 || depth > 32) throw new RangeError('HMS metadata is too complex');
		if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
		if (typeof item === 'number' && Number.isFinite(item)) return;
		if (typeof item !== 'object' || ancestors.has(item))
			throw new TypeError('HMS metadata must contain finite JSON values without cycles');
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		)
			throw new TypeError('HMS metadata must contain plain JSON objects');
		ancestors.add(item);
		if (Array.isArray(item) && item.length > 32768)
			throw new RangeError('HMS metadata is too complex');
		for (const key in item)
			if (Object.prototype.hasOwnProperty.call(item, key))
				visit((item as Record<string, unknown>)[key], depth + 1);
		ancestors.delete(item);
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('HMS metadata must be a JSON object');
	visit(value, 0);
	if (Buffer.byteLength(JSON.stringify(value)) > MAX_METADATA_BYTES)
		throw new RangeError('HMS metadata exceeds 64 KiB');
}

export function cloneHMSMetadata(value: unknown): Record<string, unknown> {
	validateHMSMetadata(value);
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function validateEmbeddingSpace(space: HMSEmbeddingSpace): void {
	for (const value of [space.model, space.revision]) {
		if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 1024)
			throw new TypeError('HMS embedding model and revision must be bounded identifiers');
	}
	integer(space.dimensions, 1, 65536, 'Embedding dimensions');
}

function normalize(vector: number[], space?: HMSEmbeddingSpace): number[] {
	if (!space) throw new Error('Document embeddings require an explicit embedding space');
	if (!Array.isArray(vector) || vector.length !== space.dimensions)
		throw new RangeError('HMS embedding dimensions do not match the declared space');
	let maximum = 0;
	for (const value of vector) {
		if (typeof value !== 'number' || !Number.isFinite(value))
			throw new TypeError('HMS embeddings must contain finite numbers');
		maximum = Math.max(maximum, Math.abs(value));
	}
	if (!maximum) throw new RangeError('HMS embeddings must have nonzero length');
	let squared = 0;
	for (const value of vector) squared += (value / maximum) ** 2;
	const norm = Math.sqrt(squared);
	return vector.map((value) => value / maximum / norm);
}

export function validateHMSDocumentBatch(
	inputs: readonly HMSDocumentInput[],
	space?: HMSEmbeddingSpace
): HMSDocumentInput[] {
	if (!Array.isArray(inputs)) throw new TypeError('HMS documents must be an array');
	integer(inputs.length, 1, 4096, 'Document batch size');
	const ids = new Set<string>();
	let sourceBytes = 0;
	let metadataBytes = 0;
	let embeddingValues = 0;
	let totalChunks = 0;
	let chunkBytes = 0;
	const documents = inputs.map((input: HMSDocumentInput) => {
		if (!input || typeof input !== 'object') throw new TypeError('Invalid HMS document');
		validateHMSId(input.id);
		if (ids.has(input.id)) throw new Error('HMS document batch contains duplicate identities');
		ids.add(input.id);
		if (typeof input.text !== 'string')
			throw new TypeError('HMS document text must be a string');
		sourceBytes += Buffer.byteLength(input.text) + Buffer.byteLength(input.id);
		if (sourceBytes > MAX_SOURCE_BYTES) throw new RangeError('HMS source batch exceeds 8 MiB');
		for (const value of [input.sourceUri, input.version])
			if (
				value !== undefined &&
				(typeof value !== 'string' ||
					value.includes('\0') ||
					Buffer.byteLength(value) > 4096)
			)
				throw new TypeError('HMS source URI and version must be bounded strings');
		sourceBytes +=
			Buffer.byteLength(input.sourceUri ?? '') + Buffer.byteLength(input.version ?? '');
		if (sourceBytes > MAX_SOURCE_BYTES) throw new RangeError('HMS source batch exceeds 8 MiB');
		const chunkWords = input.chunkWords ?? 256;
		const overlapWords = input.overlapWords ?? Math.min(32, chunkWords - 1);
		integer(chunkWords, 1, 4096, 'Chunk words');
		integer(overlapWords, 0, chunkWords - 1, 'Overlap words');
		if (input.storeText !== undefined && typeof input.storeText !== 'boolean')
			throw new TypeError('HMS storeText must be a boolean');
		if (input.titleWeight !== undefined) integer(input.titleWeight, 1, 100, 'Title weight');
		const metadata = cloneHMSMetadata(input.metadata ?? {});
		metadataBytes += Buffer.byteLength(JSON.stringify(metadata));
		if (metadataBytes > MAX_SOURCE_BYTES)
			throw new RangeError('HMS metadata batch exceeds 8 MiB');
		let documentChunks = 0;
		for (const range of chunkRanges({ ...input, chunkWords, overlapWords })) {
			documentChunks++;
			totalChunks++;
			chunkBytes += range.endByte - range.startByte;
			if (totalChunks > 4096 || chunkBytes > MAX_TRANSACTION_BYTES)
				throw new RangeError('HMS document batch exceeds its chunk allocation limit');
		}
		let embeddings: number[][] | undefined;
		if (input.embeddings !== undefined) {
			if (!Array.isArray(input.embeddings) || input.embeddings.length > 4096)
				throw new RangeError('HMS document has too many embedding rows');
			if (input.embeddings.length !== documentChunks)
				throw new RangeError('HMS requires one embedding for each document chunk');
			embeddings = input.embeddings.map((row) => {
				embeddingValues += row?.length ?? 0;
				if (embeddingValues > 1048576)
					throw new RangeError('HMS batch exceeds 1048576 embedding values');
				return normalize(row, space);
			});
		}
		return {
			id: input.id,
			text: input.text,
			sourceUri: input.sourceUri,
			version: input.version,
			storeText: input.storeText,
			titleWeight: input.titleWeight,
			metadata,
			chunkWords,
			overlapWords,
			embeddings,
		};
	});
	if (Buffer.byteLength(JSON.stringify(documents)) > MAX_TRANSACTION_BYTES)
		throw new RangeError('HMS document transaction exceeds 32 MiB');
	return documents;
}

export function validateHMSSearch(
	text: string,
	options: HMSSearchOptions,
	space?: HMSEmbeddingSpace
): HMSSearchOptions {
	if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536)
		throw new TypeError('HMS query must contain 1 to 65536 UTF-8 bytes');
	const k = options.k ?? 10;
	const candidateLimit = options.candidateLimit ?? Math.max(k, 100);
	integer(k, 1, 1000, 'Search limit');
	integer(candidateLimit, k, 4096, 'Candidate limit');
	if (options.documentIds !== undefined) {
		if (!Array.isArray(options.documentIds) || options.documentIds.length > 50000)
			throw new RangeError('HMS document scope exceeds 50000 identities');
		options.documentIds.forEach(validateHMSId);
	}
	for (const field of ['lexicalWeight', 'semanticWeight'] as const) {
		const value = options[field];
		if (
			value !== undefined &&
			(typeof value !== 'number' || !Number.isFinite(value) || value < 0)
		)
			throw new RangeError('HMS search weights must be finite and nonnegative');
	}
	const totalWeight = (options.lexicalWeight ?? 1) + (options.semanticWeight ?? 1);
	if (!Number.isFinite(totalWeight) || totalWeight <= 0)
		throw new RangeError('HMS search weights must have a finite positive sum');
	if (
		options.minSemanticScore !== undefined &&
		(!Number.isFinite(options.minSemanticScore) ||
			options.minSemanticScore < -1 ||
			options.minSemanticScore > 1)
	)
		throw new RangeError('HMS minimum semantic score must be between -1 and 1');
	if (options.fusion !== undefined && !['blend', 'rrf'].includes(options.fusion))
		throw new TypeError('Unknown HMS fusion method');
	if (options.bm25K1 !== undefined && (!Number.isFinite(options.bm25K1) || options.bm25K1 < 0))
		throw new RangeError('HMS BM25 k1 must be finite and nonnegative');
	if (
		options.bm25B !== undefined &&
		(!Number.isFinite(options.bm25B) || options.bm25B < 0 || options.bm25B > 1)
	)
		throw new RangeError('HMS BM25 b must be between zero and one');
	const filter = options.filter === undefined ? undefined : cloneHMSMetadata(options.filter);
	return {
		...options,
		k,
		candidateLimit,
		filter,
		documentIds: options.documentIds?.slice(),
		embedding:
			options.embedding === undefined ? undefined : normalize(options.embedding, space),
	};
}

interface Chunk {
	text: string;
	startByte: number;
	endByte: number;
	embedding?: number[];
}
interface StoredDocument {
	input: HMSDocumentInput;
	chunks: Chunk[];
}

interface ChunkRange {
	start: number;
	end: number;
	startByte: number;
	endByte: number;
}

function* chunkRanges(input: HMSDocumentInput): Generator<ChunkRange> {
	const size = input.chunkWords!;
	const overlap = input.overlapWords!;
	let window: ChunkRange[] = [];
	let byteOffset = 0;
	let previousEnd = 0;
	let pendingWords = 0;
	let count = 0;
	const emit = (): ChunkRange => {
		const first = window[0];
		const last = window[window.length - 1];
		if (++count > 4096 || last.endByte - first.startByte > 64 * 1024)
			throw new RangeError('HMS document exceeds 4096 chunks or 64 KiB per chunk');
		return {
			start: first.start,
			end: last.end,
			startByte: first.startByte,
			endByte: last.endByte,
		};
	};
	for (const match of input.text.matchAll(/\P{White_Space}+/gu)) {
		byteOffset += Buffer.byteLength(input.text.slice(previousEnd, match.index));
		const startByte = byteOffset;
		byteOffset += Buffer.byteLength(match[0]);
		previousEnd = match.index + match[0].length;
		window.push({ start: match.index, end: previousEnd, startByte, endByte: byteOffset });
		pendingWords++;
		if (window.length === size) {
			yield emit();
			window = overlap ? window.slice(size - overlap) : [];
			pendingWords = 0;
		}
	}
	if (pendingWords) yield emit();
}

function chunk(input: HMSDocumentInput): Chunk[] {
	const chunks = Array.from(chunkRanges(input), (range) => ({
		text: input.text.slice(range.start, range.end),
		startByte: range.startByte,
		endByte: range.endByte,
		embedding: undefined as number[] | undefined,
	}));
	if (input.embeddings && input.embeddings.length !== chunks.length)
		throw new RangeError('HMS requires one embedding for each document chunk');
	for (let index = 0; index < chunks.length; index++)
		chunks[index].embedding = input.embeddings?.[index];
	return chunks;
}

function terms(text: string): string[] {
	return (
		text
			.normalize('NFKC')
			.toLocaleLowerCase('en')
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

export class FallbackDocumentIndex {
	private documents = new Map<string, StoredDocument>();

	memorize(inputs: HMSDocumentInput[]): number[] {
		const prepared = inputs.map((input) => ({ input, chunks: chunk(input) }));
		if (prepared.reduce((sum, doc) => sum + doc.chunks.length, 0) > 4096)
			throw new RangeError('HMS batch exceeds 4096 chunks');
		for (const document of prepared) this.documents.set(document.input.id, document);
		return prepared.map((document) => document.chunks.length);
	}

	delete(id: string): boolean {
		return this.documents.delete(id);
	}

	search(text: string, options: HMSSearchOptions): HMSDocumentResult[] {
		const scope = options.documentIds ? new Set(options.documentIds) : undefined;
		const query = [...new Set(terms(text))];
		const queryTerms = new Set(query);
		const frequency = new Map<string, number>();
		const candidates: Array<{
			document: StoredDocument;
			chunk: Chunk;
			index: number;
			length: number;
			counts: Map<string, number>;
		}> = [];
		let totalLength = 0;
		for (const document of this.documents.values()) {
			const input = document.input;
			if (scope && !scope.has(input.id)) continue;
			if (options.sourceUri !== undefined && input.sourceUri !== options.sourceUri) continue;
			if (
				options.filter &&
				!Object.entries(options.filter).every(
					([key, value]) =>
						JSON.stringify(input.metadata?.[key]) === JSON.stringify(value)
				)
			)
				continue;
			for (const [index, item] of document.chunks.entries()) {
				const tokens = terms(item.text);
				const counts = new Map<string, number>();
				for (const term of tokens)
					if (queryTerms.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
				for (const term of counts.keys())
					frequency.set(term, (frequency.get(term) ?? 0) + 1);
				totalLength += tokens.length;
				candidates.push({ document, chunk: item, index, length: tokens.length, counts });
			}
		}
		const averageLength = totalLength / Math.max(1, candidates.length);
		const k1 = options.bm25K1 ?? 1.2;
		const b = options.bm25B ?? 0.75;
		const scored = candidates.map((candidate) => {
			let lexicalScore = 0;
			for (const [term, count] of candidate.counts) {
				const df = frequency.get(term) ?? 0;
				lexicalScore +=
					(Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5)) * count * (k1 + 1)) /
					(count + k1 * (1 - b + (b * candidate.length) / Math.max(1, averageLength)));
			}
			let semanticScore: number | undefined;
			if (options.embedding && candidate.chunk.embedding) {
				semanticScore = 0;
				for (let index = 0; index < options.embedding.length; index++)
					semanticScore += options.embedding[index] * candidate.chunk.embedding[index];
				semanticScore = Math.max(-1, Math.min(1, semanticScore));
			}
			return { ...candidate, lexicalScore, semanticScore, score: 0 };
		});
		const lexical = scored
			.filter((hit) => hit.lexicalScore > 0)
			.sort((a, b) => b.lexicalScore - a.lexicalScore)
			.slice(0, options.candidateLimit);
		const semantic = scored
			.filter(
				(hit) =>
					hit.semanticScore !== undefined &&
					hit.semanticScore > 0 &&
					hit.semanticScore >= (options.minSemanticScore ?? 0)
			)
			.sort((a, b) => b.semanticScore! - a.semanticScore!)
			.slice(0, options.candidateLimit);
		const eligible = new Set<(typeof scored)[number]>();
		for (const [list, field, weight] of [
			[lexical, 'lexicalScore', options.lexicalWeight ?? 1],
			[semantic, 'semanticScore', options.semanticWeight ?? 1],
		] as const) {
			if (!weight) continue;
			const maximum = list[0]?.[field] ?? 0;
			const minimum = list[list.length - 1]?.[field] ?? 0;
			for (const [rank, hit] of list.entries()) {
				eligible.add(hit);
				hit.score +=
					weight *
					(options.fusion === 'rrf'
						? 1 / (60 + rank + 1)
						: maximum === minimum
							? 1
							: (hit[field]! - minimum) / (maximum - minimum));
			}
		}
		return scored
			.filter((hit) => eligible.has(hit))
			.sort(
				(a, b) =>
					b.score - a.score ||
					a.document.input.id.localeCompare(b.document.input.id) ||
					a.index - b.index
			)
			.slice(0, options.k)
			.map((hit) => ({
				id: `${hit.document.input.id}#${hit.index}`,
				documentId: hit.document.input.id,
				sourceUri: hit.document.input.sourceUri,
				version: hit.document.input.version ?? '1',
				metadata: cloneHMSMetadata(hit.document.input.metadata ?? {}),
				text: hit.document.input.storeText === false ? undefined : hit.chunk.text,
				startByte: hit.chunk.startByte,
				endByte: hit.chunk.endByte,
				score: hit.score,
				lexicalScore: hit.lexicalScore,
				semanticScore: hit.semanticScore,
			}));
	}

	get size(): number {
		return this.documents.size;
	}

	clear(): void {
		this.documents.clear();
	}
}
