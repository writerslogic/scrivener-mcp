import * as crypto from 'crypto';
import { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { HolographicMemorySystem } from '../memory/hhm/holographic-memory-system.js';

export interface HMSVectorStoreArgs {
	hms?: HolographicMemorySystem;
	dimensions?: number;
	storagePath?: string;
}

/**
 * LangChain VectorStore implementation powered by the Rust-native HMS Engine
 */
export class LangChainHMSVectorStore extends VectorStore {
	private hms: HolographicMemorySystem;

	_vectorstoreType(): string {
		return 'hms_native';
	}

	constructor(embeddings: EmbeddingsInterface, args: HMSVectorStoreArgs = {}) {
		super(embeddings, args);
		this.hms =
			args.hms ||
			new HolographicMemorySystem({
				dimensions: args.dimensions,
				storagePath: args.storagePath,
			});
	}

	async addVectors(_vectors: number[][], _documents: Document[]): Promise<void> {
		// HMS handles its own encoding/vectorization from text
		// We use addDocuments instead to let the Rust engine do the work
		throw new Error(
			'Use addDocuments instead of addVectors for HMSVectorStore to leverage native encoding.'
		);
	}

	async addDocuments(documents: Document[]): Promise<void> {
		const items = documents.map((doc) => ({
			id: (doc.metadata?.id || doc.metadata?.documentId || crypto.randomUUID()) as string,
			text: doc.pageContent,
		}));
		await this.hms.memorizeBatch(items);
	}

	async similaritySearchVectorWithScore(
		_query: number[],
		_k: number
	): Promise<[Document, number][]> {
		throw new Error(
			'HMSVectorStore uses native text-based querying. Use similaritySearch instead.'
		);
	}

	async similaritySearch(query: string, k: number = 4): Promise<Document[]> {
		const results = await this.hms.queryText(query, k);
		return results.map(
			(r) =>
				new Document({
					pageContent: (r.reconstructed as string) || '',
					metadata: {
						id: r.id,
						similarity: r.similarity,
						...(r.entry.metadata || {}),
					},
				})
		);
	}

	async similaritySearchWithScore(query: string, k: number = 4): Promise<[Document, number][]> {
		const results = await this.hms.queryText(query, k);
		return results.map((r) => [
			new Document({
				pageContent: (r.reconstructed as string) || '',
				metadata: {
					id: r.id,
					similarity: r.similarity,
					...(r.entry.metadata || {}),
				},
			}),
			r.similarity,
		]);
	}

	static async fromDocuments(
		docs: Document[],
		embeddings: EmbeddingsInterface,
		dbConfig?: HMSVectorStoreArgs
	): Promise<LangChainHMSVectorStore> {
		const instance = new LangChainHMSVectorStore(embeddings, dbConfig);
		await instance.addDocuments(docs);
		return instance;
	}

	static async fromTexts(
		texts: string[],
		metadatas: object[] | object,
		embeddings: EmbeddingsInterface,
		dbConfig?: HMSVectorStoreArgs
	): Promise<LangChainHMSVectorStore> {
		const docs = texts.map(
			(text, i) =>
				new Document({
					pageContent: text,
					metadata: Array.isArray(metadatas) ? metadatas[i] : metadatas,
				})
		);
		return LangChainHMSVectorStore.fromDocuments(docs, embeddings, dbConfig);
	}
}
