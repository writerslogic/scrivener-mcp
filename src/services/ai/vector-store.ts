import { getLogger } from '../../core/logger.js';
import { ApplicationError as AppError, ErrorCode } from '../../core/errors.js';
import { handleError } from '../../utils/common.js';

export interface VectorDocument {
	id: string;
	content: string;
	metadata: {
		title?: string;
		type?: string;
		wordCount?: number;
		synopsis?: string;
		[key: string]: unknown;
	};
	embedding?: number[];
}

export interface SearchResult {
	id: string;
	title: string;
	content: string;
	score: number;
	metadata: Record<string, unknown>;
}

export interface MentionResult {
	documentId: string;
	title: string;
	context: string;
	position: number;
}

export class VectorStore {
	private documents: Map<string, VectorDocument>;
	private embeddings: Map<string, number[]>;
	private logger: ReturnType<typeof getLogger>;
	private initialized: boolean = false;

	constructor() {
		this.documents = new Map();
		this.embeddings = new Map();
		this.logger = getLogger('VectorStore');
	}

	async initialize(): Promise<void> {
		try {
			// In a real implementation, this would initialize the vector database
			// For now, we'll use in-memory storage as a placeholder
			this.initialized = true;
			this.logger.info('Vector store initialized (in-memory)');
		} catch (error) {
			handleError(error, 'VectorStore.initialize');
			throw new AppError(
				'Vector store initialization failed',
				ErrorCode.INITIALIZATION_ERROR
			);
		}
	}

	async addDocuments(documents: Array<Omit<VectorDocument, 'embedding'>>): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
		}

		for (const doc of documents) {
			try {
				// Generate embedding (placeholder - in real implementation would use actual embeddings)
				const embedding = await this.generateEmbedding(doc.content);

				const vectorDoc: VectorDocument = {
					...doc,
					embedding,
				};

				this.documents.set(doc.id, vectorDoc);
				this.embeddings.set(doc.id, embedding);
			} catch (error) {
				handleError(error, 'VectorStore.addDocuments');
			}
		}

		this.logger.info(`Added ${documents.length} documents to vector store`);
	}

	async similaritySearch(query: string, limit: number = 10): Promise<SearchResult[]> {
		if (!this.initialized) {
			throw new AppError('Vector store not initialized', ErrorCode.INITIALIZATION_ERROR);
		}

		try {
			// Generate embedding for query
			const queryEmbedding = await this.generateEmbedding(query);

			// Calculate similarities
			const similarities: Array<{ id: string; score: number }> = [];

			for (const [docId, docEmbedding] of this.embeddings.entries()) {
				const similarity = this.cosineSimilarity(queryEmbedding, docEmbedding);
				similarities.push({ id: docId, score: similarity });
			}

			// Sort by similarity and take top results
			similarities.sort((a, b) => b.score - a.score);
			const topResults = similarities.slice(0, limit);

			// Return formatted results
			const results: SearchResult[] = [];
			for (const { id, score } of topResults) {
				const doc = this.documents.get(id);
				if (doc) {
					results.push({
						id: doc.id,
						title: (doc.metadata.title as string) || 'Untitled',
						content: doc.content,
						score,
						metadata: doc.metadata,
					});
				}
			}

			return results;
		} catch (error) {
			handleError(error, 'VectorStore.similaritySearch');
			return [];
		}
	}

	async findMentions(entity: string): Promise<MentionResult[]> {
		if (!this.initialized) {
			throw new AppError('Vector store not initialized', ErrorCode.INITIALIZATION_ERROR);
		}

		const mentions: MentionResult[] = [];
		const entityLower = entity.toLowerCase();

		for (const [docId, doc] of this.documents.entries()) {
			const content = doc.content.toLowerCase();
			const title = (doc.metadata.title as string) || 'Untitled';

			let position = 0;
			while ((position = content.indexOf(entityLower, position)) !== -1) {
				// Extract context around the mention
				const contextStart = Math.max(0, position - 100);
				const contextEnd = Math.min(content.length, position + entity.length + 100);
				const context = doc.content.slice(contextStart, contextEnd);

				mentions.push({
					documentId: docId,
					title,
					context,
					position,
				});

				position += entity.length;
			}
		}

		return mentions.sort((a, b) => a.documentId.localeCompare(b.documentId));
	}

	async updateDocument(
		id: string,
		updates: Partial<Omit<VectorDocument, 'id' | 'embedding'>>
	): Promise<void> {
		try {
			const existingDoc = this.documents.get(id);
			if (!existingDoc) {
				this.logger.warn(`Document ${id} not found for update`);
				return;
			}

			const updatedContent = updates.content || existingDoc.content;
			const embedding = await this.generateEmbedding(updatedContent);

			const updatedDoc: VectorDocument = {
				...existingDoc,
				...updates,
				id,
				content: updatedContent,
				embedding,
			};

			this.documents.set(id, updatedDoc);
			this.embeddings.set(id, embedding);

			this.logger.debug(`Updated document ${id} in vector store`);
		} catch (error) {
			handleError(error, 'VectorStore.updateDocument');
			throw error; // Re-throw to maintain error propagation
		}
	}

	async deleteDocument(id: string): Promise<void> {
		const deleted = this.documents.delete(id);
		this.embeddings.delete(id);

		if (deleted) {
			this.logger.debug(`Deleted document ${id} from vector store`);
		} else {
			this.logger.warn(`Document ${id} not found for deletion`);
		}
	}

	async getDocument(id: string): Promise<VectorDocument | null> {
		return this.documents.get(id) || null;
	}

	getStats(): {
		totalDocuments: number;
		totalSize: number;
		initialized: boolean;
	} {
		const totalSize = Array.from(this.documents.values()).reduce(
			(sum, doc) => sum + doc.content.length,
			0
		);

		return {
			totalDocuments: this.documents.size,
			totalSize,
			initialized: this.initialized,
		};
	}

	async clear(): Promise<void> {
		this.documents.clear();
		this.embeddings.clear();
		this.logger.info('Vector store cleared');
	}

	async close(): Promise<void> {
		this.documents.clear();
		this.embeddings.clear();
		this.initialized = false;
		this.logger.info('Vector store closed');
	}

	private async generateEmbedding(text: string): Promise<number[]> {
		// Placeholder implementation - in a real system this would use
		// OpenAI embeddings, Sentence Transformers, or similar

		// Simple hash-based embedding for demonstration
		const words = text.toLowerCase().split(/\s+/);
		const embedding = new Array(384).fill(0); // Common embedding dimension

		for (const word of words) {
			const hash = this.simpleHash(word);
			const index = Math.abs(hash) % embedding.length;
			embedding[index] += 1;
		}

		// Normalize to unit vector
		const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
		if (magnitude > 0) {
			for (let i = 0; i < embedding.length; i++) {
				embedding[i] /= magnitude;
			}
		}

		return embedding;
	}

	private simpleHash(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return hash;
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) {
			throw new AppError('Vectors must have same length', ErrorCode.VALIDATION_ERROR);
		}

		let dotProduct = 0;
		let magnitudeA = 0;
		let magnitudeB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			magnitudeA += a[i] * a[i];
			magnitudeB += b[i] * b[i];
		}

		magnitudeA = Math.sqrt(magnitudeA);
		magnitudeB = Math.sqrt(magnitudeB);

		if (magnitudeA === 0 || magnitudeB === 0) {
			return 0;
		}

		return dotProduct / (magnitudeA * magnitudeB);
	}

	// Advanced search methods
	async semanticSearch(
		query: string,
		options?: {
			threshold?: number;
			maxResults?: number;
			includeMetadata?: boolean;
		}
	): Promise<SearchResult[]> {
		const { threshold = 0.5, maxResults = 10, includeMetadata = true } = options || {};

		const results = await this.similaritySearch(query, maxResults * 2);

		return results
			.filter((result) => result.score >= threshold)
			.slice(0, maxResults)
			.map((result) => ({
				...result,
				metadata: includeMetadata ? result.metadata : {},
			}));
	}

	async hybridSearch(
		query: string,
		options?: {
			semanticWeight?: number;
			keywordWeight?: number;
			maxResults?: number;
		}
	): Promise<SearchResult[]> {
		const { semanticWeight = 0.7, keywordWeight = 0.3, maxResults = 10 } = options || {};

		// Get semantic results
		const semanticResults = await this.similaritySearch(query, maxResults * 2);

		// Get keyword results (simple text matching)
		const keywordResults = this.keywordSearch(query, maxResults * 2);

		// Combine and rerank results
		const combinedResults = this.combineSearchResults(
			semanticResults,
			keywordResults,
			semanticWeight,
			keywordWeight
		);

		return combinedResults.slice(0, maxResults);
	}

	private keywordSearch(query: string, limit: number): SearchResult[] {
		const queryTerms = query.toLowerCase().split(/\s+/);
		const results: Array<{ doc: VectorDocument; score: number }> = [];

		for (const [_docId, doc] of this.documents.entries()) {
			const content = doc.content.toLowerCase();
			let score = 0;

			for (const term of queryTerms) {
				const matches = (content.match(new RegExp(term, 'g')) || []).length;
				score += (matches / content.length) * 1000; // Normalize by document length
			}

			if (score > 0) {
				results.push({ doc, score });
			}
		}

		return results
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(({ doc, score }) => ({
				id: doc.id,
				title: (doc.metadata.title as string) || 'Untitled',
				content: doc.content,
				score,
				metadata: doc.metadata,
			}));
	}

	private combineSearchResults(
		semanticResults: SearchResult[],
		keywordResults: SearchResult[],
		semanticWeight: number,
		keywordWeight: number
	): SearchResult[] {
		const resultMap = new Map<string, SearchResult>();

		// Add semantic results
		for (const result of semanticResults) {
			resultMap.set(result.id, {
				...result,
				score: result.score * semanticWeight,
			});
		}

		// Combine with keyword results
		for (const result of keywordResults) {
			const existing = resultMap.get(result.id);
			if (existing) {
				existing.score += result.score * keywordWeight;
			} else {
				resultMap.set(result.id, {
					...result,
					score: result.score * keywordWeight,
				});
			}
		}

		return Array.from(resultMap.values()).sort((a, b) => b.score - a.score);
	}
}
