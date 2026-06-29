import * as crypto from 'crypto';
import { HolographicMemorySystem } from '../memory/hhm/holographic-memory-system.js';

export interface HMSDocument {
	pageContent: string;
	metadata: Record<string, unknown>;
}

export interface HMSVectorStoreArgs {
	hms?: HolographicMemorySystem;
	dimensions?: number;
	storagePath?: string;
}

/**
 * Text-native vector store backed by the Rust HMS engine. Retrieval is
 * HolographicMemorySystem.queryText (no embeddings): the engine encodes and
 * queries from text directly. The previous LangChain VectorStore wrapper only
 * ever used this text path -- its addVectors / similaritySearchVectorWithScore
 * methods always threw -- so dropping the embeddings dependency loses nothing.
 */
export class HMSVectorStore {
	private hms: HolographicMemorySystem;

	constructor(args: HMSVectorStoreArgs = {}) {
		this.hms =
			args.hms ||
			new HolographicMemorySystem({
				dimensions: args.dimensions,
				storagePath: args.storagePath,
			});
	}

	async addDocuments(documents: HMSDocument[]): Promise<void> {
		const items = documents.map((doc) => ({
			id: (doc.metadata?.id || doc.metadata?.documentId || crypto.randomUUID()) as string,
			text: doc.pageContent,
		}));
		await this.hms.memorizeBatch(items);
	}

	async similaritySearch(query: string, k: number = 4): Promise<HMSDocument[]> {
		const results = await this.hms.queryText(query, k);
		return results.map((r) => ({
			pageContent: (r.reconstructed as string) || '',
			metadata: {
				id: r.id,
				similarity: r.similarity,
				...(r.entry.metadata || {}),
			},
		}));
	}

	async similaritySearchWithScore(
		query: string,
		k: number = 4
	): Promise<[HMSDocument, number][]> {
		const results = await this.hms.queryText(query, k);
		return results.map((r) => [
			{
				pageContent: (r.reconstructed as string) || '',
				metadata: {
					id: r.id,
					similarity: r.similarity,
					...(r.entry.metadata || {}),
				},
			},
			r.similarity,
		]);
	}

	static async fromDocuments(
		docs: HMSDocument[],
		args?: HMSVectorStoreArgs
	): Promise<HMSVectorStore> {
		const instance = new HMSVectorStore(args);
		await instance.addDocuments(docs);
		return instance;
	}
}
