import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
	HolographicMemorySystem,
	cloneHMSMetadata,
	validateHMSMetadata,
	validateHMSDocumentBatch,
	type HHMConfig,
	type HMSDocumentInput,
	type HMSDocumentResult,
} from '../memory/hhm/holographic-memory-system.js';

export interface HMSDocument {
	pageContent: string;
	metadata: Record<string, unknown>;
	sourceUri?: string;
	version?: string;
	startByte?: number;
	endByte?: number;
}

export interface HMSVectorStoreArgs {
	/** Borrowed engines remain open when this view closes. */
	hms?: HolographicMemorySystem;
	dimensions?: number;
	storagePath?: string;
	/** Stable namespace for reopening a native store or a borrowed engine. */
	scope?: string;
	engine?: HHMConfig['engine'];
}

const RESERVED_PREFIX = '__scrivener_hms_';
const SCOPE = `${RESERVED_PREFIX}scope`;
const START = `${RESERVED_PREFIX}start_byte`;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_CALL_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;

function boundedString(value: unknown, label: string, maximum: number): asserts value is string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.includes('\0') ||
		Buffer.byteLength(value) > maximum
	) {
		throw new RangeError(`${label} must contain 1 through ${maximum} UTF-8 bytes without NUL`);
	}
}

function offset(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new RangeError(`${label} must be a nonnegative safe integer`);
}

export class HMSVectorStore {
	private readonly hms: HolographicMemorySystem;
	private readonly ownsEngine: boolean;
	private readonly persistentScope: boolean;
	private readonly scope: string;
	private readonly idPrefix: string;
	private readonly indexedIds = new Set<string>();
	private readonly operations = new Set<Promise<unknown>>();
	private closing = false;
	private closed = false;
	private closePromise?: Promise<void>;

	constructor(args: HMSVectorStoreArgs = {}) {
		if (args.storagePath !== undefined)
			boundedString(args.storagePath, 'Store storage path', 8192);
		const scope =
			args.scope ?? (args.storagePath ? `path:${resolve(args.storagePath)}` : randomUUID());
		boundedString(scope, 'Store scope', 4096);
		this.scope = createHash('sha256').update(scope).digest('hex');
		this.idPrefix = `scrivener-vstore:${this.scope}:`;
		this.persistentScope = args.scope !== undefined || args.storagePath !== undefined;
		this.ownsEngine = !args.hms;
		this.hms =
			args.hms ??
			new HolographicMemorySystem({
				dimensions: args.dimensions,
				storagePath: args.storagePath,
				engine: args.engine,
			});
	}

	private id(publicId: string): string {
		return this.idPrefix + createHash('sha256').update(publicId).digest('hex');
	}

	private async operate<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing || this.closed) throw new Error('HMS vector store is closed');
		const pending = operation();
		this.operations.add(pending);
		try {
			return await pending;
		} finally {
			this.operations.delete(pending);
		}
	}

	async addDocuments(documents: HMSDocument[]): Promise<void> {
		return this.operate(async () => {
			if (!Array.isArray(documents) || documents.length > 4096)
				throw new RangeError('Index updates accept at most 4096 documents');
			if (!documents.length) return;
			let sourceBytes = 0;
			let metadataBytes = 0;
			const ids = new Set<string>();
			const prepared = documents.map((document): HMSDocumentInput => {
				if (
					!document ||
					typeof document.pageContent !== 'string' ||
					!document.pageContent.trim() ||
					Buffer.byteLength(document.pageContent) > MAX_DOCUMENT_BYTES
				) {
					throw new RangeError(
						'Indexed documents require nonempty text of at most 8 MiB'
					);
				}
				const metadata = cloneHMSMetadata(document.metadata);
				if (Object.keys(metadata).some((key) => key.startsWith(RESERVED_PREFIX)))
					throw new Error('Index scope metadata keys are reserved');
				for (const key of ['id', 'documentId'])
					if (metadata[key] !== undefined)
						boundedString(metadata[key], `Metadata ${key}`, 4096);
				const publicId = (metadata.id ?? metadata.documentId ?? randomUUID()) as string;
				const id = this.id(publicId);
				if (ids.has(id)) throw new Error('Index update document IDs must be unique');
				ids.add(id);
				const version =
					document.version ??
					metadata.version ??
					metadata.revision ??
					createHash('sha256').update(document.pageContent).digest('hex');
				boundedString(version, 'Document version', 1024);
				const sourceUri = document.sourceUri ?? metadata.sourceUri;
				if (sourceUri !== undefined) boundedString(sourceUri, 'Document source URI', 8192);
				const startByte = document.startByte ?? metadata.startByte ?? 0;
				offset(startByte, 'Source startByte');
				const endByte = document.endByte ?? metadata.endByte;
				const bytes = Buffer.byteLength(document.pageContent);
				if (!Number.isSafeInteger(startByte + bytes))
					throw new RangeError('Source byte range exceeds the supported integer range');
				if (endByte !== undefined) {
					offset(endByte, 'Source endByte');
					if (endByte !== startByte + bytes)
						throw new RangeError('Source byte range must match the indexed text');
				}
				const storedMetadata = {
					...metadata,
					id: publicId,
					documentId: metadata.documentId ?? publicId,
					[SCOPE]: this.scope,
					[START]: startByte,
				};
				validateHMSMetadata(storedMetadata);
				sourceBytes += bytes;
				metadataBytes += Buffer.byteLength(JSON.stringify(storedMetadata));
				if (sourceBytes > MAX_CALL_BYTES || metadataBytes > MAX_METADATA_BYTES)
					throw new RangeError('Index update exceeds 64 MiB text or 8 MiB metadata');
				const input: HMSDocumentInput = {
					id,
					text: document.pageContent,
					version,
					metadata: storedMetadata,
					chunkWords: 512,
					overlapWords: 32,
					storeText: true,
				};
				if (sourceUri !== undefined) input.sourceUri = sourceUri;
				return input;
			});
			const batches: HMSDocumentInput[][] = [];
			let batch: HMSDocumentInput[] = [];
			let batchBytes = 0;
			for (const input of prepared) {
				const bytes =
					Buffer.byteLength(input.text) +
					Buffer.byteLength(input.id) +
					Buffer.byteLength(input.version ?? '') +
					Buffer.byteLength(input.sourceUri ?? '');
				if (batch.length && (batch.length >= 64 || batchBytes + bytes > MAX_BATCH_BYTES)) {
					batches.push(batch);
					batch = [];
					batchBytes = 0;
				}
				batch.push(input);
				batchBytes += bytes;
			}
			if (batch.length) batches.push(batch);
			const checkedBatches = batches.map((inputs) => validateHMSDocumentBatch(inputs));
			for (const inputs of checkedBatches) {
				if (!this.persistentScope)
					for (const input of inputs) this.indexedIds.add(input.id);
				await this.hms.memorizeDocuments(inputs);
			}
		});
	}

	private async search(query: string, k: number): Promise<[HMSDocument, number][]> {
		return this.operate(async () => {
			boundedString(query, 'Search query', 64 * 1024);
			if (!Number.isSafeInteger(k) || k < 1 || k > 1000)
				throw new RangeError('Search k must be an integer from 1 through 1000');
			const results = await this.hms.searchDocuments(query, {
				k,
				filter: { [SCOPE]: this.scope },
			});
			return results.map((result) => this.result(result));
		});
	}

	private result(result: HMSDocumentResult): [HMSDocument, number] {
		const metadata = cloneHMSMetadata(result.metadata);
		const publicId = metadata.id;
		boundedString(publicId, 'Stored document identity', 4096);
		if (metadata[SCOPE] !== this.scope || result.documentId !== this.id(publicId))
			throw new Error('Index result does not belong to this store scope');
		const start = metadata[START];
		offset(start, 'Stored source startByte');
		const startByte = start + result.startByte;
		const endByte = start + result.endByte;
		if (
			!Number.isSafeInteger(startByte) ||
			!Number.isSafeInteger(endByte) ||
			startByte < start ||
			endByte < startByte ||
			typeof result.text !== 'string' ||
			Buffer.byteLength(result.text) !== result.endByte - result.startByte ||
			!Number.isFinite(result.score) ||
			!Number.isFinite(result.lexicalScore) ||
			(result.semanticScore !== undefined && !Number.isFinite(result.semanticScore))
		)
			throw new Error('Invalid indexed passage result');
		for (const key of Object.keys(metadata))
			if (key.startsWith(RESERVED_PREFIX)) delete metadata[key];
		Object.assign(metadata, {
			passageId: result.id,
			version: result.version,
			startByte,
			endByte,
			similarity: result.score,
			lexicalScore: result.lexicalScore,
		});
		if (result.sourceUri !== undefined) metadata.sourceUri = result.sourceUri;
		if (result.semanticScore !== undefined) metadata.semanticScore = result.semanticScore;
		return [
			{
				pageContent: result.text,
				metadata,
				version: result.version,
				...(result.sourceUri === undefined ? {} : { sourceUri: result.sourceUri }),
				startByte,
				endByte,
			},
			result.score,
		];
	}

	async similaritySearch(query: string, k = 4): Promise<HMSDocument[]> {
		return (await this.search(query, k)).map(([document]) => document);
	}

	async similaritySearchWithScore(query: string, k = 4): Promise<[HMSDocument, number][]> {
		return this.search(query, k);
	}

	/** Releases owned wrappers after draining; native lock release remains GC-managed. */
	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.finishClose().catch((error: unknown) => {
			this.closePromise = undefined;
			throw error;
		});
		return this.closePromise;
	}

	private async finishClose(): Promise<void> {
		await Promise.allSettled([...this.operations]);
		if (!this.persistentScope) {
			for (const id of this.indexedIds) {
				await this.hms.deleteDocument(id);
				this.indexedIds.delete(id);
			}
		}
		if (this.ownsEngine) await this.hms.destroy();
		else await this.hms.flush();
		this.indexedIds.clear();
		this.closed = true;
	}

	static async fromDocuments(
		docs: HMSDocument[],
		args?: HMSVectorStoreArgs
	): Promise<HMSVectorStore> {
		const instance = new HMSVectorStore(args);
		try {
			await instance.addDocuments(docs);
			return instance;
		} catch (error) {
			try {
				await instance.close();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					'Index creation and cleanup failed',
					{ cause: cleanupError }
				);
			}
			throw error;
		}
	}
}
