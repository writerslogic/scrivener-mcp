/**
 * LangChain service for advanced AI operations
 * Provides document chunking, vector storage, and RAG capabilities
 */

import { ChatOpenAI } from '@langchain/openai';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import type { Document as LangchainDocument } from 'langchain/document';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { OpenAIEmbeddings } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import type { ScrivenerDocument } from '../../types/index.js';
import { getLogger } from '../../core/logger.js';
import { createError, ErrorCode } from '../../core/errors.js';

interface ChunkingOptions {
	chunkSize?: number;
	chunkOverlap?: number;
	separators?: string[];
}

interface RAGOptions {
	topK?: number;
	temperature?: number;
	maxTokens?: number;
}

interface WritingContext {
	documentId: string;
	content: string;
	metadata: Record<string, unknown>;
	embeddings?: number[];
}

export class LangChainService {
	private llm: ChatOpenAI;
	private embeddings: OpenAIEmbeddings;
	private vectorStore: MemoryVectorStore | null = null;
	private textSplitter: RecursiveCharacterTextSplitter;
	private contexts: Map<string, WritingContext> = new Map();
	private logger: ReturnType<typeof getLogger>;

	constructor(apiKey?: string) {
		this.logger = getLogger('langchain-service');

		if (!apiKey && !process.env.OPENAI_API_KEY) {
			throw createError(
				ErrorCode.CONFIGURATION_ERROR,
				null,
				'OpenAI API key required for LangChain service'
			);
		}

		// Initialize OpenAI Chat LLM
		this.llm = new ChatOpenAI({
			openAIApiKey: apiKey || process.env.OPENAI_API_KEY,
			temperature: 0.7,
			modelName: 'gpt-4-turbo-preview',
		});

		// Initialize embeddings
		this.embeddings = new OpenAIEmbeddings({
			openAIApiKey: apiKey || process.env.OPENAI_API_KEY,
		});

		// Initialize text splitter with manuscript-optimized settings
		this.textSplitter = new RecursiveCharacterTextSplitter({
			chunkSize: 2000,
			chunkOverlap: 200,
			separators: ['\n\n\n', '\n\n', '\n', '. ', ' ', ''],
		});
	}

	/**
	 * Process and chunk a document for vector storage
	 */
	async processDocument(
		document: ScrivenerDocument,
		options: ChunkingOptions = {}
	): Promise<LangchainDocument[]> {
		try {
			const splitter = new RecursiveCharacterTextSplitter({
				chunkSize: options.chunkSize || 2000,
				chunkOverlap: options.chunkOverlap || 200,
				separators: options.separators || ['\n\n\n', '\n\n', '\n', '. ', ' ', ''],
			});

			const chunks = await splitter.createDocuments(
				[document.content || ''],
				[
					{
						documentId: document.id,
						title: document.title || '',
						type: document.type,
						path: document.path || '',
					},
				]
			);

			this.logger.debug(`Chunked document ${document.id} into ${chunks.length} pieces`);
			return chunks;
		} catch (error) {
			throw createError(
				ErrorCode.ANALYSIS_ERROR,
				error as Error,
				`Failed to process document ${document.id}`
			);
		}
	}

	/**
	 * Build or update vector store with documents
	 */
	async buildVectorStore(documents: ScrivenerDocument[]): Promise<void> {
		try {
			const allChunks: LangchainDocument[] = [];

			for (const doc of documents) {
				const chunks = await this.processDocument(doc);
				allChunks.push(...chunks);
			}

			if (this.vectorStore) {
				// Add to existing store
				await this.vectorStore.addDocuments(allChunks);
			} else {
				// Create new store
				this.vectorStore = await MemoryVectorStore.fromDocuments(
					allChunks,
					this.embeddings
				);
			}

			this.logger.info(
				`Vector store updated with ${allChunks.length} chunks from ${documents.length} documents`
			);
		} catch (error) {
			throw createError(
				ErrorCode.ANALYSIS_ERROR,
				error as Error,
				'Failed to build vector store'
			);
		}
	}

	/**
	 * Perform semantic search across documents
	 */
	async semanticSearch(query: string, topK: number = 5): Promise<LangchainDocument[]> {
		if (!this.vectorStore) {
			throw createError(
				ErrorCode.INVALID_STATE,
				null,
				'Vector store not initialized. Call buildVectorStore first.'
			);
		}

		try {
			const results = await this.vectorStore.similaritySearch(query, topK);
			this.logger.debug(
				`Found ${results.length} similar documents for query: ${query.substring(0, 50)}...`
			);
			return results;
		} catch (error) {
			throw createError(ErrorCode.ANALYSIS_ERROR, error as Error, 'Semantic search failed');
		}
	}

	/**
	 * Generate writing suggestions using RAG
	 */
	async generateWithContext(prompt: string, options: RAGOptions = {}): Promise<string> {
		if (!this.vectorStore) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Vector store not initialized');
		}

		try {
			// Find relevant context
			const relevantDocs = await this.semanticSearch(prompt, options.topK || 3);

			// Build context string
			const context = relevantDocs.map((doc) => doc.pageContent).join('\n\n---\n\n');

			// Create prompt template
			const promptTemplate = PromptTemplate.fromTemplate(`
				You are a professional writing assistant helping with a manuscript.
				Use the following context from the manuscript to provide accurate and consistent suggestions:

				Context:
				{context}

				Question/Request:
				{question}

				Provide a helpful, creative response that maintains consistency with the existing manuscript:
			`);

			// Create chain
			const chain = RunnableSequence.from([
				promptTemplate,
				this.llm,
				new StringOutputParser(),
			]);

			// Generate response
			const response = await chain.invoke({
				context,
				question: prompt,
			});

			return response;
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Failed to generate with context'
			);
		}
	}

	/**
	 * Analyze writing style from samples
	 */
	async analyzeWritingStyle(samples: string[]): Promise<Record<string, unknown>> {
		try {
			const promptTemplate = PromptTemplate.fromTemplate(`
				Analyze the following writing samples and provide a detailed style analysis:

				Samples:
				{samples}

				Provide analysis of:
				1. Voice and tone
				2. Sentence structure patterns
				3. Vocabulary complexity
				4. Pacing and rhythm
				5. Common phrases or patterns
				6. Strengths and areas for improvement

				Format as JSON.
			`);

			const chain = RunnableSequence.from([
				promptTemplate,
				this.llm,
				new StringOutputParser(),
			]);

			const response = await chain.invoke({
				samples: samples.join('\n\n---\n\n'),
			});

			return JSON.parse(response);
		} catch (error) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, error as Error, 'Style analysis failed');
		}
	}

	/**
	 * Generate chapter summaries
	 */
	async summarizeChapter(content: string, maxLength: number = 200): Promise<string> {
		try {
			const promptTemplate = PromptTemplate.fromTemplate(`
				Summarize the following chapter content in approximately {maxLength} words:

				{content}

				Focus on key plot points, character developments, and important themes.
			`);

			const chain = RunnableSequence.from([
				promptTemplate,
				this.llm,
				new StringOutputParser(),
			]);

			const summary = await chain.invoke({
				content,
				maxLength,
			});

			return summary;
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Chapter summarization failed'
			);
		}
	}

	/**
	 * Check plot consistency across documents
	 */
	async checkPlotConsistency(documents: ScrivenerDocument[]): Promise<
		Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
		}>
	> {
		if (!this.vectorStore) {
			await this.buildVectorStore(documents);
		}

		try {
			const issues: Array<{
				issue: string;
				severity: 'low' | 'medium' | 'high';
				locations: string[];
				suggestion: string;
			}> = [];

			// Check for character consistency
			const characterPrompt = `
				Analyze the manuscript for character inconsistencies:
				- Changes in character traits or behavior
				- Contradictory character descriptions
				- Timeline issues with character ages or events
			`;

			const characterContext = await this.generateWithContext(characterPrompt);

			// Parse and structure the response with sophisticated analysis
			const lines = characterContext.split('\n').filter((line) => line.trim());

			for (const line of lines) {
				// Look for specific patterns indicating issues
				const severityPatterns = {
					high: /critical|major|severe|significant/i,
					medium: /moderate|notable|important/i,
					low: /minor|small|slight/i,
				};

				const issuePatterns = [
					/inconsistency|contradiction|conflict/i,
					/timeline\s+issue|age\s+problem/i,
					/character\s+trait\s+change/i,
					/behavior\s+mismatch/i,
				];

				// Check if this line describes an issue
				const hasIssue = issuePatterns.some((pattern) => pattern.test(line));

				if (hasIssue) {
					// Determine severity
					let severity: 'low' | 'medium' | 'high' = 'medium';
					for (const [level, pattern] of Object.entries(severityPatterns)) {
						if (pattern.test(line)) {
							severity = level as 'low' | 'medium' | 'high';
							break;
						}
					}

					// Extract chapter references if mentioned
					const chapterMatch = line.match(/chapter[s]?\s+(\d+(?:\s*(?:and|,)\s*\d+)*)/gi);
					const locations = chapterMatch
						? chapterMatch.map((m) => m.replace(/chapter[s]?\s+/i, 'Chapter '))
						: ['Multiple chapters'];

					// Generate contextual suggestion
					let suggestion = 'Review character descriptions for consistency';
					if (line.toLowerCase().includes('timeline')) {
						suggestion = 'Verify character ages and timeline events';
					} else if (line.toLowerCase().includes('trait')) {
						suggestion =
							'Ensure character traits remain consistent or show clear development';
					} else if (line.toLowerCase().includes('behavior')) {
						suggestion =
							'Check that character behaviors align with established personality';
					}

					issues.push({
						issue: line.trim(),
						severity,
						locations,
						suggestion,
					});
				}
			}

			return issues;
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Plot consistency check failed'
			);
		}
	}

	/**
	 * Clear vector store and contexts
	 */
	clearMemory(): void {
		this.vectorStore = null;
		this.contexts.clear();
		this.logger.debug('Cleared vector store and contexts');
	}
}
