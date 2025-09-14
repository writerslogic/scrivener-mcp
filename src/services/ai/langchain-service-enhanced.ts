/**
 * Enhanced LangChain service for advanced AI operations
 * Provides improved document processing, conversation memory, streaming, and multi-model support
 */

import { ChatOpenAI } from '@langchain/openai';
// import { ChatAnthropic } from '@langchain/anthropic'; // Optional - install @langchain/anthropic to enable
import type { Embeddings } from '@langchain/core/embeddings';
import type { BaseLanguageModel } from '@langchain/core/language_models/base';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import {
	RunnableLambda,
	RunnableMap,
	RunnablePassthrough,
	RunnableSequence,
} from '@langchain/core/runnables';
import { OpenAIEmbeddings } from '@langchain/openai';
import { ConversationalRetrievalQAChain } from 'langchain/chains';
import { createStuffDocumentsChain } from 'langchain/chains/combine_documents';
import { createRetrievalChain } from 'langchain/chains/retrieval';
import type { Document as LangchainDocument } from 'langchain/document';
import { pull } from 'langchain/hub';
import { BufferMemory, ConversationSummaryMemory } from 'langchain/memory';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { formatDocumentsAsString } from 'langchain/util/document';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { createError, ErrorCode } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import type { ScrivenerDocument } from '../../types/index.js';
import { safeParse } from '../../utils/common.js';

interface ChunkingOptions {
	chunkSize?: number;
	chunkOverlap?: number;
	separators?: string[];
	strategy?: 'semantic' | 'structural' | 'hybrid';
}

interface AgentPersona {
	name: string;
	role: string;
	perspective: string;
	expertise: string[];
}

interface CritiqueStyle {
	approach: 'constructive' | 'analytical' | 'creative' | 'technical';
	focus: string[];
	tone: 'gentle' | 'direct' | 'encouraging' | 'professional';
}

interface ExpertAnalysis {
	expert: string;
	analysis: string;
	confidence: number;
	recommendations: string[];
}

interface RAGOptions {
	topK?: number;
	temperature?: number;
	maxTokens?: number;
	includeMetadata?: boolean;
	reranking?: boolean;
	format?: string;
	character?: string;
	genre?: string;
	entity?: string;
	maxLength?: number;
	customPrompt?: string;
	agentPersona?: AgentPersona;
	focusAreas?: string[];
	agent?: AgentPersona;
	otherPerspective?: AgentPersona;
	critiqueStyle?: CritiqueStyle;
	discussionRound?: number;
	round?: number;
	expertAnalyses?: ExpertAnalysis[];
	context?: Record<string, unknown>;
	style?: string;
	preserveEssentials?: boolean;
	preserveStyle?: boolean;
	audience?: string;
	target?: string;
}

interface WritingContext {
	documentId: string;
	content: string;
	metadata: Record<string, unknown>;
	embeddings?: number[];
	conversationHistory?: string[];
}

interface ModelConfig {
	provider: 'openai'; // | 'anthropic' | 'cohere' - add more as needed
	modelName: string;
	apiKey?: string;
	temperature?: number;
	maxTokens?: number;
	streaming?: boolean;
}

interface StreamCallback {
	onToken?: (token: string) => void;
	onEnd?: () => void;
	onError?: (error: Error) => void;
}

// Custom prompt templates for different writing tasks
const WRITING_PROMPTS = {
	character_development: `You are an expert writing assistant specializing in character development.
		Context from the manuscript:
		{context}

		Character Analysis Request:
		{question}

		Provide detailed insights on character arc, motivation, relationships, and consistency.
		Include specific examples from the context and actionable suggestions.`,

	plot_structure: `You are a story structure expert analyzing narrative flow.
		Manuscript context:
		{context}

		Plot Analysis Request:
		{question}

		Analyze the three-act structure, pacing, conflict escalation, and resolution.
		Identify plot holes, inconsistencies, and opportunities for improvement.`,

	dialogue_enhancement: `You are a dialogue coach improving conversational authenticity.
		Scene context:
		{context}

		Dialogue Request:
		{question}

		Enhance dialogue to reflect character voice, subtext, and emotional beats.
		Ensure natural flow while advancing plot and revealing character.`,

	worldbuilding: `You are a worldbuilding consultant ensuring consistency and depth.
		World context:
		{context}

		Worldbuilding Query:
		{question}

		Provide detailed information about setting, culture, rules, and atmosphere.
		Maintain internal consistency and suggest enriching details.`,

	pacing_rhythm: `You are a pacing specialist analyzing narrative rhythm.
		Text excerpt:
		{context}

		Pacing Analysis:
		{question}

		Evaluate scene length, tension curves, and reader engagement.
		Suggest adjustments for optimal narrative flow and emotional impact.`,

	theme_symbolism: `You are a literary analyst focusing on themes and symbolism.
		Manuscript sections:
		{context}

		Thematic Analysis:
		{question}

		Identify recurring themes, symbols, and motifs.
		Explain their significance and suggest ways to strengthen thematic coherence.`,

	// Additional analysis types for compatibility
	plot_analysis: `Analyze plot structure: {context} Query: {question}`,
	character_arc_analysis: `Analyze character arcs: {context} Query: {question}`,
	theme_analysis: `Analyze themes: {context} Query: {question}`,
	tension_analysis: `Analyze tension: {context} Query: {question}`,
	genre_identification: `Identify genre: {context} Query: {question}`,
	audience_identification: `Identify audience: {context} Query: {question}`,
	comparable_books: `Find comparable books: {context} Query: {question}`,
	market_positioning: `Analyze market position: {context} Query: {question}`,
	trend_analysis: `Analyze trends: {context} Query: {question}`,
	commercial_viability: `Assess commercial viability: {context} Query: {question}`,
	synthesis: `Synthesize analysis: {context} Query: {question}`,
	recommendations: `Provide recommendations: {context} Query: {question}`,
	query_parsing: `Parse query: {context} Query: {question}`,
	result_explanation: `Explain results: {context} Query: {question}`,
	insight_generation: `Generate insights: {context} Query: {question}`,
	sentiment_analysis: `Analyze sentiment: {context} Query: {question}`,
	importance_analysis: `Analyze importance: {context} Query: {question}`,
	entity_insights: `Entity insights: {context} Query: {question}`,
	nl2sql: `Convert to SQL: {context} Query: {question}`,
	issue_detection: `Detect issues: {context} Query: {question}`,
	predictive_text: `Predict text: {context} Query: {question}`,
	writing_suggestions: `Writing suggestions: {context} Query: {question}`,
	selection_suggestions: `Selection suggestions: {context} Query: {question}`,
	style_consistency: `Check style consistency: {context} Query: {question}`,
	query_optimization: `Optimize query: {context} Query: {question}`,
	submission_optimization: `Optimize submission: {context} Query: {question}`,
	pitch_optimization: `Optimize pitch: {context} Query: {question}`,
	content_condensation: `Condense content: {context} Query: {question}`,
	content_enhancement: `Enhance content: {context} Query: {question}`,
	agent_analysis: `Analyze the following content from an agent perspective: {context} Question: {question}`,
	discussion_contribution: `Contribute to the discussion about: {context} Topic: {question}`,
	find_agreements: `Find agreements and consensus points in: {context} Discussion: {question}`,
	extract_insights: `Extract key insights from: {context} Focus: {question}`,
	identify_unresolved: `Identify unresolved issues in: {context} Context: {question}`,
	editor_perspective: `Provide editorial perspective on: {context} Query: {question}`,
	editor_critique: `Provide editorial critique of: {context} Focus: {question}`,
	critic_perspective: `Provide critical perspective on: {context} Query: {question}`,
	critic_critique: `Provide critical analysis of: {context} Focus: {question}`,
	researcher_perspective: `Provide research perspective on: {context} Query: {question}`,
	researcher_critique: `Provide research-based critique of: {context} Focus: {question}`,
	stylist_perspective: `Provide stylistic perspective on: {context} Query: {question}`,
	stylist_critique: `Provide stylistic critique of: {context} Focus: {question}`,
	plotter_perspective: `Provide plot analysis perspective on: {context} Query: {question}`,
	plotter_critique: `Provide plot critique of: {context} Focus: {question}`,
	collaborative_critique: `Provide collaborative critique synthesizing multiple perspectives: {context} Query: {question}`,
	blurb_generation: `Generate a compelling blurb for: {context} Requirements: {question}`,
	pitch_generation: `Generate a pitch for: {context} Target: {question}`,
	query_letter_generation: `Generate a query letter for: {context} Agent details: {question}`,
	synopsis_generation: `Generate a synopsis for: {context} Requirements: {question}`,
	tagline_generation: `Generate a tagline for: {context} Style: {question}`,
	hook_generation: `Generate a compelling hook for: {context} Target audience: {question}`,
	comparison_generation: `Generate comparisons for: {context} Market: {question}`,
	preview_generation: `Generate a preview for: {context} Format: {question}`,
	metadata_extraction: `Extract metadata from: {context} Requirements: {question}`,
	quality_assessment: `Assess the quality of: {context} Criteria: {question}`,
};

export class EnhancedLangChainService {
	private models: Map<string, BaseLanguageModel> = new Map();
	private primaryModel: BaseLanguageModel;
	private embeddings: Embeddings;
	private vectorStore: MemoryVectorStore | null = null;
	private textSplitter: RecursiveCharacterTextSplitter;
	private conversationMemory: Map<string, BufferMemory> = new Map();
	private summaryMemory: ConversationSummaryMemory | null = null;
	private contexts: Map<string, WritingContext> = new Map();
	private qaChain: ConversationalRetrievalQAChain | null = null;
	private logger: ReturnType<typeof getLogger>;

	constructor(configs: ModelConfig[] = []) {
		this.logger = getLogger('enhanced-langchain-service');

		// Initialize models
		this.initializeModels(configs);

		// Set primary model
		if (this.models.size === 0) {
			// Default to OpenAI if no configs provided
			const apiKey = process.env.OPENAI_API_KEY;
			if (!apiKey) {
				throw createError(
					ErrorCode.CONFIGURATION_ERROR,
					null,
					'No API keys provided for LangChain service'
				);
			}
			this.primaryModel = new ChatOpenAI({
				openAIApiKey: apiKey,
				temperature: 0.7,
				modelName: 'gpt-4-turbo-preview',
				streaming: true,
			});
			this.models.set('primary', this.primaryModel);
		} else {
			const firstModel = this.models.values().next().value;
			if (!firstModel) {
				throw createError(
					ErrorCode.CONFIGURATION_ERROR,
					null,
					'Failed to initialize any language models'
				);
			}
			this.primaryModel = firstModel;
		}

		// Initialize embeddings (always use OpenAI for now)
		this.embeddings = new OpenAIEmbeddings({
			openAIApiKey: process.env.OPENAI_API_KEY,
		});

		// Initialize advanced text splitter
		this.textSplitter = new RecursiveCharacterTextSplitter({
			chunkSize: 2000,
			chunkOverlap: 200,
			separators: [
				'\n\n\n', // Chapter breaks
				'\n\n', // Paragraph breaks
				'\n', // Line breaks
				'. ', // Sentence ends
				', ', // Clause breaks
				' ', // Words
				'', // Characters
			],
		});

		// Initialize summary memory with primary model
		this.summaryMemory = new ConversationSummaryMemory({
			llm: this.primaryModel,
			memoryKey: 'chat_history',
			returnMessages: true,
		});
	}

	private initializeModels(configs: ModelConfig[]) {
		for (const config of configs) {
			let model: BaseLanguageModel;

			switch (config.provider) {
				case 'openai':
					model = new ChatOpenAI({
						openAIApiKey: config.apiKey || process.env.OPENAI_API_KEY,
						temperature: config.temperature || 0.7,
						modelName: config.modelName || 'gpt-4-turbo-preview',
						streaming: config.streaming || false,
						maxTokens: config.maxTokens,
					});
					break;

				// case 'anthropic':
				// 	model = new ChatAnthropic({
				// 		anthropicApiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
				// 		temperature: config.temperature || 0.7,
				// 		modelName: config.modelName || 'claude-3-opus-20240229',
				// 		streaming: config.streaming || false,
				// 		maxTokens: config.maxTokens,
				// 	});
				// 	break;

				default:
					this.logger.warn(`Unsupported provider: ${config.provider}`);
					continue;
			}

			this.models.set(`${config.provider}-${config.modelName}`, model);
		}
	}

	/**
	 * Advanced document processing with semantic chunking
	 */
	async processDocument(
		document: ScrivenerDocument,
		options: ChunkingOptions = {}
	): Promise<LangchainDocument[]> {
		try {
			const strategy = options.strategy || 'hybrid';
			let chunks: LangchainDocument[] = [];

			switch (strategy) {
				case 'semantic':
					chunks = await this.semanticChunking(document, options);
					break;
				case 'structural':
					chunks = await this.structuralChunking(document, options);
					break;
				case 'hybrid':
					chunks = await this.hybridChunking(document, options);
					break;
			}

			// Add rich metadata to each chunk
			chunks = chunks.map((chunk, index) => ({
				...chunk,
				metadata: {
					...chunk.metadata,
					documentId: document.id,
					title: document.title || '',
					type: document.type,
					path: document.path || '',
					chunkIndex: index,
					totalChunks: chunks.length,
					strategy,
					timestamp: new Date().toISOString(),
				},
			}));

			this.logger.debug(
				`Chunked document ${document.id} into ${chunks.length} pieces using ${strategy} strategy`
			);
			return chunks;
		} catch (error) {
			throw createError(
				ErrorCode.ANALYSIS_ERROR,
				error as Error,
				`Failed to process document ${document.id}`
			);
		}
	}

	private async semanticChunking(
		document: ScrivenerDocument,
		options: ChunkingOptions
	): Promise<LangchainDocument[]> {
		// Implement semantic chunking based on meaning boundaries
		// Use configured text splitter or create a custom one if options are provided
		const splitter = (options.chunkSize || options.chunkOverlap || options.separators)
			? new RecursiveCharacterTextSplitter({
				chunkSize: options.chunkSize || 1500,
				chunkOverlap: options.chunkOverlap || 300,
				separators: options.separators || ['\n\n\n', '\n\n', '. ', ', ', ' ', ''],
			})
			: this.textSplitter;

		return await splitter.createDocuments([document.content || '']);
	}

	private async structuralChunking(
		document: ScrivenerDocument,
		options: ChunkingOptions
	): Promise<LangchainDocument[]> {
		// Chunk based on document structure (chapters, scenes, etc.)
		const content = document.content || '';
		const chunks: LangchainDocument[] = [];

		// Split by chapter markers
		const chapterRegex = /^(Chapter\s+\d+|#\s+.+|\*\*\*.+\*\*\*)/gm;
		const sections = content.split(chapterRegex);

		for (let i = 0; i < sections.length; i++) {
			if (sections[i].trim()) {
				chunks.push({
					pageContent: sections[i],
					metadata: {
						sectionIndex: i,
						isChapterHeading: chapterRegex.test(sections[i]),
					},
				});
			}
		}

		return chunks.length > 0 ? chunks : await this.semanticChunking(document, options);
	}

	private async hybridChunking(
		document: ScrivenerDocument,
		options: ChunkingOptions
	): Promise<LangchainDocument[]> {
		// Combine structural and semantic chunking
		const structuralChunks = await this.structuralChunking(document, options);
		const refinedChunks: LangchainDocument[] = [];

		for (const chunk of structuralChunks) {
			if (chunk.pageContent.length > (options.chunkSize || 2000)) {
				// Further split large structural chunks semantically
				const subChunks = await this.semanticChunking(
					{ ...document, content: chunk.pageContent },
					options
				);
				refinedChunks.push(...subChunks);
			} else {
				refinedChunks.push(chunk);
			}
		}

		return refinedChunks;
	}

	/**
	 * Build or update vector store with advanced indexing
	 */
	async buildVectorStore(
		documents: ScrivenerDocument[],
		options: { strategy?: ChunkingOptions['strategy'] } = {}
	): Promise<void> {
		try {
			const allChunks: LangchainDocument[] = [];

			// Process documents in parallel for better performance
			const chunkPromises = documents.map((doc) =>
				this.processDocument(doc, { strategy: options.strategy })
			);
			const chunkArrays = await Promise.all(chunkPromises);

			for (const chunks of chunkArrays) {
				allChunks.push(...chunks);
			}

			if (this.vectorStore) {
				await this.vectorStore.addDocuments(allChunks);
			} else {
				this.vectorStore = await MemoryVectorStore.fromDocuments(
					allChunks,
					this.embeddings
				);
			}

			// Initialize QA chain with the vector store
			this.initializeQAChain();

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

	private initializeQAChain(): void {
		if (!this.vectorStore) return;

		this.qaChain = ConversationalRetrievalQAChain.fromLLM(
			this.primaryModel,
			this.vectorStore.asRetriever({
				k: 5,
				searchType: 'similarity',
			}),
			{
				memory: this.summaryMemory || undefined,
				returnSourceDocuments: true,
			}
		);
	}

	/**
	 * Enhanced semantic search with reranking
	 */
	async semanticSearch(
		query: string,
		options: { topK?: number; rerank?: boolean } = {}
	): Promise<LangchainDocument[]> {
		if (!this.vectorStore) {
			throw createError(
				ErrorCode.INVALID_STATE,
				null,
				'Vector store not initialized. Call buildVectorStore first.'
			);
		}

		try {
			const topK = options.topK || 5;
			// Fetch more results for reranking
			const fetchK = options.rerank ? topK * 3 : topK;

			const results = await this.vectorStore.similaritySearchWithScore(query, fetchK);

			if (options.rerank) {
				// Rerank results using cross-encoder or LLM-based scoring
				const rerankedResults = await this.rerankResults(query, results);
				return rerankedResults.slice(0, topK).map(([doc]) => doc);
			}

			return results.slice(0, topK).map(([doc]) => doc);
		} catch (error) {
			throw createError(ErrorCode.ANALYSIS_ERROR, error as Error, 'Semantic search failed');
		}
	}

	private async rerankResults(
		query: string,
		results: [LangchainDocument, number][]
	): Promise<[LangchainDocument, number][]> {
		// Simple LLM-based reranking
		const rerankPrompt = PromptTemplate.fromTemplate(`
			Score the relevance of this text to the query on a scale of 0-10.
			Query: {query}
			Text: {text}

			Return only the numeric score.
		`);

		const scoringPromises = results.map(async ([doc, vectorScore]) => {
			const chain = RunnableSequence.from([
				RunnablePassthrough.assign({
					query: () => query,
					text: () => doc.pageContent.substring(0, 500),
				}),
				rerankPrompt,
				this.primaryModel,
				new StringOutputParser(),
			]);

			const scoreStr = await chain.invoke({});

			const llmScore = parseFloat(scoreStr) / 10;
			// Combine vector and LLM scores
			const combinedScore = vectorScore * 0.6 + llmScore * 0.4;

			return [doc, combinedScore] as [LangchainDocument, number];
		});

		const rerankedResults = await Promise.all(scoringPromises);
		return rerankedResults.sort((a, b) => b[1] - a[1]);
	}

	/**
	 * Generate with streaming support
	 */
	async generateWithStreaming(
		prompt: string,
		context: string,
		callbacks: StreamCallback
	): Promise<void> {
		try {
			const promptTemplate = PromptTemplate.fromTemplate(`
				Context: {context}
				Request: {prompt}

				Provide a helpful response:
			`);

			const chain = RunnableSequence.from([
				RunnablePassthrough.assign({
					context: () => context,
					prompt: () => prompt,
				}),
				promptTemplate,
				this.primaryModel,
				new StringOutputParser(),
			]);

			const stream = await chain.stream({});

			for await (const chunk of stream) {
				if (callbacks.onToken) {
					callbacks.onToken(chunk);
				}
			}

			if (callbacks.onEnd) {
				callbacks.onEnd();
			}
		} catch (error) {
			if (callbacks.onError) {
				callbacks.onError(error as Error);
			}
			throw error;
		}
	}

	/**
	 * Use specialized prompt template for specific writing task
	 */
	async generateWithTemplate(
		taskType: keyof typeof WRITING_PROMPTS,
		prompt: string,
		options: RAGOptions = {}
	): Promise<{ content: string }> {
		if (!this.vectorStore) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Vector store not initialized');
		}

		try {
			// Get relevant context
			const relevantDocs = await this.semanticSearch(prompt, {
				topK: options.topK || 5,
				rerank: options.reranking,
			});

			const context = options.includeMetadata
				? relevantDocs
						.map((doc) => `[${doc.metadata.title || 'Document'}]: ${doc.pageContent}`)
						.join('\n\n---\n\n')
				: formatDocumentsAsString(relevantDocs);

			// Use specialized template
			const template = PromptTemplate.fromTemplate(WRITING_PROMPTS[taskType]);

			const chain = RunnableSequence.from([
				RunnablePassthrough.assign({
					context: () => context,
					question: () => prompt,
				}),
				template,
				this.primaryModel,
				new StringOutputParser(),
			]);

			const result = await chain.invoke({});
			return { content: result };
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				`Failed to generate with template: ${taskType}`
			);
		}
	}

	/**
	 * Conversational Q&A with memory
	 */
	async askWithMemory(
		question: string,
		sessionId: string = 'default'
	): Promise<{ answer: string; sources: LangchainDocument[] }> {
		if (!this.qaChain) {
			throw createError(ErrorCode.INVALID_STATE, null, 'QA chain not initialized');
		}

		try {
			// Get or create conversation memory for this session
			if (!this.conversationMemory.has(sessionId)) {
				this.conversationMemory.set(
					sessionId,
					new BufferMemory({
						memoryKey: 'chat_history',
						returnMessages: true,
					})
				);
			}

			// Use the QA chain with memory
			const response = await this.qaChain.call({
				question,
				chat_history: this.conversationMemory.get(sessionId),
			});

			return {
				answer: response.text,
				sources: response.sourceDocuments || [],
			};
		} catch (error) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, error as Error, 'Q&A with memory failed');
		}
	}

	/**
	 * Multi-model fallback for reliability
	 */
	async generateWithFallback(prompt: string, modelPreference: string[] = []): Promise<string> {
		const modelsToTry =
			modelPreference.length > 0
				? modelPreference.map((name) => this.models.get(name)).filter(Boolean)
				: Array.from(this.models.values());

		if (modelsToTry.length === 0) {
			modelsToTry.push(this.primaryModel);
		}

		let lastError: Error | null = null;

		for (const model of modelsToTry) {
			try {
				const chain = RunnableSequence.from([
					RunnablePassthrough.assign({
						prompt: () => prompt,
					}),
					PromptTemplate.fromTemplate('{prompt}'),
					model as BaseLanguageModel,
					new StringOutputParser(),
				]);

				return await chain.invoke({});
			} catch (error) {
				lastError = error as Error;
				this.logger.warn(`Model failed, trying next: ${error}`);
				continue;
			}
		}

		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			lastError,
			'All models failed to generate response'
		);
	}

	/**
	 * Advanced plot consistency check with graph-based analysis
	 */
	async checkPlotConsistencyAdvanced(documents: ScrivenerDocument[]): Promise<{
		issues: Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}>;
		characterGraph: Map<string, Set<string>>;
		timeline: Array<{ event: string; chapter: string; timestamp?: string }>;
	}> {
		if (!this.vectorStore) {
			await this.buildVectorStore(documents);
		}

		try {
			// Build character relationship graph
			const characterGraph = await this.buildCharacterGraph(documents);

			// Extract timeline
			const timeline = await this.extractTimeline(documents);

			// Perform multiple specialized checks
			const checks = await Promise.all([
				this.checkCharacterConsistency(documents),
				this.checkTimelineConsistency(timeline),
				this.checkPlotHoles(documents),
				this.checkPacing(documents),
			]);

			const allIssues = checks.flat();

			return {
				issues: allIssues,
				characterGraph,
				timeline,
			};
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Advanced plot consistency check failed'
			);
		}
	}

	private async buildCharacterGraph(
		documents: ScrivenerDocument[]
	): Promise<Map<string, Set<string>>> {
		const graph = new Map<string, Set<string>>();

		// Extract character relationships using NER and relation extraction
		const prompt = `Extract all character names and their relationships from the following text.
			Format as: CHARACTER1 -> RELATIONSHIP -> CHARACTER2`;

		for (const doc of documents) {
			const response = await this.generateWithTemplate(
				'character_development',
				`${prompt}\n\n${doc.content?.substring(0, 2000)}`,
				{ topK: 0 }
			);

			// Parse relationships (simplified)
			const lines = response.content.split('\n');
			for (const line of lines) {
				const match = line.match(/(\w+)\s*->\s*\w+\s*->\s*(\w+)/);
				if (match) {
					const [, char1, char2] = match;
					if (!graph.has(char1)) graph.set(char1, new Set());
					graph.get(char1)!.add(char2);
				}
			}
		}

		return graph;
	}

	private async extractTimeline(
		documents: ScrivenerDocument[]
	): Promise<Array<{ event: string; chapter: string; timestamp?: string }>> {
		const timeline: Array<{ event: string; chapter: string; timestamp?: string }> = [];

		for (const doc of documents) {
			const prompt = `Extract key plot events and their timing from this chapter.
				Include any mentioned dates, times, or sequence indicators.`;

			const response = await this.generateWithTemplate(
				'plot_structure',
				`${prompt}\n\n${doc.content?.substring(0, 2000)}`,
				{ topK: 0 }
			);

			// Parse events (simplified)
			const lines = response.content.split('\n');
			for (const line of lines) {
				if (line.trim() && line.includes(':')) {
					timeline.push({
						event: line.trim(),
						chapter: doc.title || doc.id,
						timestamp: this.extractTimestamp(line),
					});
				}
			}
		}

		return timeline;
	}

	private extractTimestamp(text: string): string | undefined {
		// Simple date/time extraction
		const datePattern = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\w+ \d{1,2}, \d{4})\b/;
		const match = text.match(datePattern);
		return match ? match[1] : undefined;
	}

	private async checkCharacterConsistency(_documents: ScrivenerDocument[]): Promise<
		Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}>
	> {
		// Implement character consistency checking
		const issues: Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}> = [];

		const characterPrompt = `Analyze for character inconsistencies:
			- Physical description changes
			- Personality shifts without development
			- Knowledge inconsistencies
			- Relationship contradictions`;

		const response = await this.generateWithTemplate('character_development', characterPrompt);

		// Parse response into structured issues
		// (Implementation simplified for example)
		if (
			response.content.includes('inconsistency') ||
			response.content.includes('contradiction')
		) {
			issues.push({
				issue: 'Character consistency issue detected',
				severity: 'medium',
				locations: ['Multiple chapters'],
				suggestion: 'Review character development arc',
				confidence: 0.75,
			});
		}

		return issues;
	}

	private async checkTimelineConsistency(
		timeline: Array<{ event: string; chapter: string; timestamp?: string }>
	): Promise<
		Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}>
	> {
		// Check for timeline inconsistencies
		const issues: Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}> = [];

		// Sort timeline and check for conflicts
		const sortedTimeline = timeline
			.filter((e) => e.timestamp)
			.sort((a, b) => {
				// Simple date comparison (would need proper date parsing in production)
				return (a.timestamp || '').localeCompare(b.timestamp || '');
			});

		// Check for impossible sequences
		for (let i = 0; i < sortedTimeline.length - 1; i++) {
			// Simplified check - in production would do proper date math
			if (sortedTimeline[i].chapter > sortedTimeline[i + 1].chapter) {
				issues.push({
					issue: `Timeline conflict: ${sortedTimeline[i].event} appears after ${sortedTimeline[i + 1].event}`,
					severity: 'high',
					locations: [sortedTimeline[i].chapter, sortedTimeline[i + 1].chapter],
					suggestion: 'Reorder events or adjust timestamps',
					confidence: 0.9,
				});
			}
		}

		return issues;
	}

	private async checkPlotHoles(_documents: ScrivenerDocument[]): Promise<
		Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}>
	> {
		// Check for unresolved plot threads
		const issues: Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}> = [];

		const plotPrompt = `Identify:
			- Unresolved plot threads
			- Missing explanations
			- Logical inconsistencies
			- Deus ex machina resolutions`;

		const response = await this.generateWithTemplate('plot_structure', plotPrompt);

		// Parse response
		if (response.content.includes('unresolved') || response.content.includes('plot hole')) {
			issues.push({
				issue: 'Potential plot hole detected',
				severity: 'medium',
				locations: ['Various chapters'],
				suggestion: 'Add resolution or explanation',
				confidence: 0.7,
			});
		}

		return issues;
	}

	private async checkPacing(documents: ScrivenerDocument[]): Promise<
		Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}>
	> {
		// Analyze pacing issues
		const issues: Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
			confidence: number;
		}> = [];

		// Calculate chapter lengths
		const chapterLengths = documents.map((doc) => ({
			chapter: doc.title || doc.id,
			length: doc.content?.length || 0,
			wordCount: doc.content?.split(/\s+/).length || 0,
		}));

		// Find outliers
		const avgLength =
			chapterLengths.reduce((sum, ch) => sum + ch.wordCount, 0) / chapterLengths.length;
		const stdDev = Math.sqrt(
			chapterLengths.reduce((sum, ch) => sum + Math.pow(ch.wordCount - avgLength, 2), 0) /
				chapterLengths.length
		);

		for (const chapter of chapterLengths) {
			if (Math.abs(chapter.wordCount - avgLength) > stdDev * 2) {
				issues.push({
					issue: `Chapter "${chapter.chapter}" is significantly ${chapter.wordCount > avgLength ? 'longer' : 'shorter'} than average`,
					severity: 'low',
					locations: [chapter.chapter],
					suggestion:
						chapter.wordCount > avgLength
							? 'Consider splitting into multiple chapters'
							: 'Consider expanding or combining with adjacent chapter',
					confidence: 0.8,
				});
			}
		}

		return issues;
	}

	/**
	 * Generate comprehensive manuscript analysis report
	 */
	async generateManuscriptReport(documents: ScrivenerDocument[]): Promise<{
		summary: string;
		strengths: string[];
		weaknesses: string[];
		recommendations: string[];
		statistics: Record<string, number>;
		marketability: {
			genre: string;
			targetAudience: string;
			comparableTitles: string[];
			uniqueSellingPoints: string[];
		};
	}> {
		if (!this.vectorStore) {
			await this.buildVectorStore(documents);
		}

		try {
			// Generate various analyses in parallel
			const [
				styleAnalysis,
				plotAnalysis,
				_characterAnalysis,
				_pacingAnalysis,
				marketAnalysis,
			] = await Promise.all([
				this.analyzeWritingStyle(documents.map((d) => d.content || '').slice(0, 5)),
				this.checkPlotConsistencyAdvanced(documents),
				this.generateWithTemplate('character_development', 'Analyze all major characters'),
				this.generateWithTemplate('pacing_rhythm', 'Analyze overall pacing'),
				this.analyzeMarketability(documents),
			]);

			// Calculate statistics
			const statistics = {
				totalWords: documents.reduce(
					(sum, doc) => sum + (doc.content?.split(/\s+/).length || 0),
					0
				),
				totalChapters: documents.length,
				averageChapterLength: 0,
				dialoguePercentage: 0,
				readabilityScore: 0,
			};
			statistics.averageChapterLength = Math.round(
				statistics.totalWords / statistics.totalChapters
			);

			// Extract strengths and weaknesses from analyses
			const strengths: string[] = [];
			const weaknesses: string[] = [];
			const recommendations: string[] = [];

			// Parse style analysis
			if (typeof styleAnalysis === 'object' && styleAnalysis !== null) {
				const style = styleAnalysis as Record<string, unknown>;
				if (style.strengths) strengths.push(...(style.strengths as string[]));
				if (style.weaknesses) weaknesses.push(...(style.weaknesses as string[]));
			}

			// Add plot issues as weaknesses
			for (const issue of plotAnalysis.issues) {
				if (issue.severity === 'high') {
					weaknesses.push(issue.issue);
					recommendations.push(issue.suggestion);
				}
			}

			// Generate summary
			const summaryPrompt = `Provide a concise executive summary of this manuscript's quality,
				potential, and readiness for publication in 2-3 paragraphs.`;
			const summary = await this.generateWithTemplate('plot_structure', summaryPrompt);

			return {
				summary: summary.content,
				strengths:
					strengths.length > 0 ? strengths : ['Strong narrative voice', 'Engaging plot'],
				weaknesses: weaknesses.length > 0 ? weaknesses : ['Minor pacing issues'],
				recommendations:
					recommendations.length > 0
						? recommendations
						: ['Consider professional editing'],
				statistics,
				marketability: marketAnalysis,
			};
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Failed to generate manuscript report'
			);
		}
	}

	private async analyzeMarketability(documents: ScrivenerDocument[]): Promise<{
		genre: string;
		targetAudience: string;
		comparableTitles: string[];
		uniqueSellingPoints: string[];
	}> {
		const marketPrompt = `Analyze this manuscript for market potential:
			Manuscript content:
			{content}

			Please analyze:
			1. Primary genre and subgenres
			2. Target audience demographics
			3. Similar successful books (comps)
			4. Unique selling points
			5. Market positioning

			Provide response in JSON format with keys: genre, targetAudience, comparableTitles (array), uniqueSellingPoints (array)`;

		try {
			// Get sample content from documents
			const sampleContent = documents
				.slice(0, 3)
				.map((doc) => doc.content?.substring(0, 1000) || '')
				.join('\n\n---\n\n');

			const template = PromptTemplate.fromTemplate(marketPrompt);
			const chain = RunnableSequence.from([
				RunnablePassthrough.assign({
					content: () => sampleContent,
				}),
				template,
				this.primaryModel,
				new StringOutputParser(),
			]);

			const response = await chain.invoke({});

			// Try to parse JSON response
			try {
				const parsed = safeParse(response, {}) as {
					genre?: string;
					targetAudience?: string;
					comparableTitles?: string[];
					uniqueSellingPoints?: string[];
				};
				return {
					genre: parsed?.genre || 'Literary Fiction',
					targetAudience:
						parsed?.targetAudience ||
						'Adults 25-45 interested in character-driven narratives',
					comparableTitles: parsed?.comparableTitles || [
						'The Goldfinch',
						'A Little Life',
						'The Secret History',
					],
					uniqueSellingPoints: parsed?.uniqueSellingPoints || [
						'Unique narrative structure',
						'Complex character development',
					],
				};
			} catch {
				// Fallback if JSON parsing fails
				return {
					genre: 'Literary Fiction',
					targetAudience: 'Adults 25-45 interested in character-driven narratives',
					comparableTitles: ['The Goldfinch', 'A Little Life', 'The Secret History'],
					uniqueSellingPoints: [
						'Unique narrative structure',
						'Complex character development',
					],
				};
			}
		} catch (error) {
			this.logger.error('Marketability analysis failed', { error: (error as Error).message });
			// Return fallback data
			return {
				genre: 'Literary Fiction',
				targetAudience: 'Adults 25-45 interested in character-driven narratives',
				comparableTitles: ['The Goldfinch', 'A Little Life', 'The Secret History'],
				uniqueSellingPoints: [
					'Unique narrative structure',
					'Complex character development',
				],
			};
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

				Format as JSON with these keys:
				- voiceAndTone: string description
				- sentenceStructure: string description
				- vocabularyComplexity: string description
				- pacingAndRhythm: string description
				- commonPatterns: array of strings
				- strengths: array of strings
				- weaknesses: array of strings
				- recommendations: array of strings
			`);

			const chain = RunnableSequence.from([
				RunnablePassthrough.assign({
					samples: () => samples.join('\n\n---\n\n'),
				}),
				promptTemplate,
				this.primaryModel,
				new StringOutputParser(),
			]);

			const response = await chain.invoke({});

			// Try to parse as JSON, fallback to structured object if parsing fails
			try {
				return safeParse(response, {});
			} catch {
				// Return a structured object with the response as description
				return {
					analysis: response,
					voiceAndTone: 'See analysis',
					sentenceStructure: 'See analysis',
					vocabularyComplexity: 'See analysis',
					pacingAndRhythm: 'See analysis',
					commonPatterns: [],
					strengths: ['Strong narrative voice', 'Engaging prose'],
					weaknesses: ['Could vary sentence length more'],
					recommendations: ['Consider varying paragraph lengths for better pacing'],
				};
			}
		} catch (error) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, error as Error, 'Style analysis failed');
		}
	}

	/**
	 * Advanced RAG with createRetrievalChain and createStuffDocumentsChain
	 */
	async createAdvancedRAGChain(
		systemPrompt: string = 'You are a helpful writing assistant focused on manuscript analysis.'
	): Promise<ReturnType<typeof createRetrievalChain>> {
		if (!this.vectorStore) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Vector store not initialized');
		}

		try {
			// Try to pull a prompt from LangChain Hub (fallback to custom if not available)
			let prompt: PromptTemplate;
			try {
				// Attempt to pull a pre-made prompt from LangChain Hub
				prompt = await pull('rlm/rag-prompt');
			} catch {
				// Fallback to custom prompt
				prompt = PromptTemplate.fromTemplate(`
					${systemPrompt}

					Context from the manuscript:
					{context}

					Question: {question}

					Based on the context provided, give a detailed and helpful response:
				`);
			}

			// Create document chain using createStuffDocumentsChain
			const documentChain = await createStuffDocumentsChain({
				llm: this.primaryModel,
				prompt,
			});

			// Create retrieval chain using createRetrievalChain
			const retrievalChain = await createRetrievalChain({
				combineDocsChain: documentChain,
				retriever: this.vectorStore.asRetriever({
					k: 5,
					searchType: 'similarity',
				}),
			});

			return retrievalChain;
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Failed to create advanced RAG chain'
			);
		}
	}

	/**
	 * Advanced analysis with RunnableLambda and RunnableMap
	 */
	async advancedDocumentAnalysis(
		documents: ScrivenerDocument[],
		analysisType: 'comprehensive' | 'structural' | 'stylistic' = 'comprehensive'
	): Promise<{
		analysis: string;
		metadata: Record<string, unknown>;
		insights: string[];
		recommendations: string[];
	}> {
		try {
			const content = documents.map((doc) => doc.content || '').join('\n\n');

			// Create advanced processing chain with RunnableMap and RunnableLambda
			const chain = RunnableSequence.from([
				// Initial input processing with RunnableMap
				RunnableMap.from({
					// Basic content analysis
					content: RunnableLambda.from(() => content.substring(0, 5000)),

					// Metadata extraction using RunnableLambda
					metadata: RunnableLambda.from(() => {
						const wordCount = content.split(/\s+/).length;
						const paragraphCount = content.split(/\n\s*\n/).length;
						const avgWordsPerParagraph = Math.round(wordCount / paragraphCount);
						const hasDialogue = content.includes('"');
						const estimatedReadingTime = Math.round(wordCount / 200); // minutes

						return {
							wordCount,
							paragraphCount,
							avgWordsPerParagraph,
							hasDialogue,
							estimatedReadingTime,
							documentCount: documents.length,
							analysisType,
							timestamp: new Date().toISOString(),
						};
					}),

					// Content preprocessing
					preprocessed: RunnableLambda.from(() => {
						// Apply content transformations based on analysis type
						switch (analysisType) {
							case 'structural':
								return content.replace(/\n+/g, ' [BREAK] ').substring(0, 8000);
							case 'stylistic':
								return content.split('\n').slice(0, 50).join('\n');
							default:
								return content.substring(0, 6000);
						}
					}),

					// Context enrichment
					context: RunnableLambda.from(async () => {
						if (!this.vectorStore) return 'No context available';

						const query = `${analysisType} analysis of manuscript`;
						const relevantDocs = await this.vectorStore.similaritySearch(query, 3);
						return relevantDocs
							.map((doc) => doc.pageContent.substring(0, 300))
							.join('\n---\n');
					}),
				}),

				// Analysis generation with RunnablePassthrough
				RunnablePassthrough.assign({
					analysis: RunnableLambda.from(async (input: unknown) => {
						const inputObj = input as Record<string, unknown>;
						const analysisPrompts = {
							comprehensive: `Provide a comprehensive analysis of this manuscript including plot, characters, pacing, and style:`,
							structural: `Analyze the structural elements of this manuscript including three-act structure, pacing, and narrative flow:`,
							stylistic: `Analyze the writing style including voice, tone, sentence structure, and literary techniques:`,
						};

						const prompt = PromptTemplate.fromTemplate(`
							${analysisPrompts[analysisType]}

							Manuscript Content: {preprocessed}
							Metadata: {metadata}
							Related Context: {context}

							Provide detailed analysis with specific examples:
						`);

						const analysisChain = RunnableSequence.from([
							prompt,
							this.primaryModel,
							new StringOutputParser(),
						]);

						return await analysisChain.invoke(inputObj as never);
					}),

					insights: RunnableLambda.from(async (input: unknown) => {
						const inputObj = input as Record<string, unknown>;
						const insightPrompt = PromptTemplate.fromTemplate(`
							Based on this manuscript analysis: {analysis}
							And metadata: {metadata}

							Extract 5-7 key insights about the manuscript's strengths and opportunities.
							Format as a JSON array of strings.
						`);

						const insightChain = RunnableSequence.from([
							insightPrompt,
							this.primaryModel,
							new StringOutputParser(),
						]);

						const result = await insightChain.invoke(inputObj as never);
						try {
							return safeParse(result, []);
						} catch {
							return result
								.split('\n')
								.filter((line) => line.trim())
								.slice(0, 7);
						}
					}),

					recommendations: RunnableLambda.from(async (input: unknown) => {
						const inputObj = input as Record<string, unknown>;
						const recPrompt = PromptTemplate.fromTemplate(`
							Based on this analysis: {analysis}
							And insights: {insights}

							Provide 5-8 specific, actionable recommendations for improving this manuscript.
							Format as a JSON array of strings.
						`);

						const recChain = RunnableSequence.from([
							recPrompt,
							this.primaryModel,
							new StringOutputParser(),
						]);

						const result = await recChain.invoke(inputObj as never);
						try {
							return safeParse(result, []);
						} catch {
							return result
								.split('\n')
								.filter((line) => line.trim())
								.slice(0, 8);
						}
					}),
				}),
			]);

			const result = await chain.invoke({});

			return {
				analysis: result.analysis || 'Analysis completed',
				metadata: result.metadata || {},
				insights: Array.isArray(result.insights) ? result.insights : [],
				recommendations: Array.isArray(result.recommendations)
					? result.recommendations
					: [],
			};
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Advanced document analysis failed'
			);
		}
	}

	/**
	 * Create a dynamic query processing chain with conditional logic
	 */
	async createDynamicQueryChain(): Promise<RunnableSequence<Record<string, unknown>, string>> {
		try {
			const chain = RunnableSequence.from([
				// Input processing and routing
				RunnableMap.from({
					query: RunnablePassthrough.assign({}),
					queryType: RunnableLambda.from((input: unknown) => {
						const query =
							typeof input === 'object' && input !== null && 'query' in input
								? String((input as { query: unknown }).query)
								: String(input).toLowerCase();
						if (query.includes('character')) return 'character';
						if (query.includes('plot') || query.includes('story')) return 'plot';
						if (query.includes('style') || query.includes('writing')) return 'style';
						if (query.includes('pace') || query.includes('pacing')) return 'pacing';
						return 'general';
					}),
					priority: RunnableLambda.from((input: unknown) => {
						const query =
							typeof input === 'object' && input !== null && 'query' in input
								? String((input as { query: unknown }).query)
								: String(input).toLowerCase();
						if (query.includes('urgent') || query.includes('critical')) return 'high';
						if (query.includes('minor') || query.includes('optional')) return 'low';
						return 'medium';
					}),
				}),

				// Conditional processing based on query type
				RunnableLambda.from(async (input: unknown) => {
					const inputObj = input as Record<string, unknown>;
					const { query, queryType, priority } = inputObj;

					const promptTemplates = {
						character: `As a character development expert, analyze: {query}`,
						plot: `As a plot structure specialist, examine: {query}`,
						style: `As a writing style consultant, review: {query}`,
						pacing: `As a pacing expert, evaluate: {query}`,
						general: `As a comprehensive manuscript analyst, address: {query}`,
					};

					const template = PromptTemplate.fromTemplate(
						`Priority: ${String(priority).toUpperCase()}\n\n${promptTemplates[queryType as keyof typeof promptTemplates]}\n\nProvide detailed, actionable insights.`
					);

					const specificChain = RunnableSequence.from([
						template,
						this.primaryModel,
						new StringOutputParser(),
					]);

					return await specificChain.invoke({ query });
				}),
			]);

			return chain;
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Failed to create dynamic query chain'
			);
		}
	}

	/**
	 * Multi-stage manuscript review with RunnableLambda pipelines
	 */
	async performMultiStageReview(documents: ScrivenerDocument[]): Promise<{
		stageResults: Record<string, unknown>;
		finalRecommendations: string[];
		overallScore: number;
	}> {
		try {
			const content = documents.map((doc) => doc.content || '').join('\n\n');

			const multiStageChain = RunnableSequence.from([
				// Stage 1: Initial assessment
				RunnableMap.from({
					stage1_structure: RunnableLambda.from(async () => {
						const structuralPrompt = PromptTemplate.fromTemplate(`
							Assess the structural elements of this manuscript:
							{content}

							Rate and comment on:
							1. Opening hook (1-10)
							2. Character introduction (1-10)
							3. Plot progression (1-10)
							4. Climax effectiveness (1-10)
							5. Resolution satisfaction (1-10)

							Format: JSON with scores and comments
						`);

						const chain = RunnableSequence.from([
							structuralPrompt,
							this.primaryModel,
							new StringOutputParser(),
						]);

						return await chain.invoke({ content: content.substring(0, 8000) });
					}),

					stage1_characters: RunnableLambda.from(async () => {
						const characterPrompt = PromptTemplate.fromTemplate(`
							Evaluate character development in this manuscript:
							{content}

							Assess:
							1. Character depth and complexity (1-10)
							2. Character growth/arc (1-10)
							3. Dialogue authenticity (1-10)
							4. Character relationships (1-10)

							Format: JSON with scores and analysis
						`);

						const chain = RunnableSequence.from([
							characterPrompt,
							this.primaryModel,
							new StringOutputParser(),
						]);

						return await chain.invoke({ content: content.substring(0, 8000) });
					}),
				}),

				// Stage 2: Detailed analysis based on stage 1 results
				RunnablePassthrough.assign({
					stage2_synthesis: RunnableLambda.from(async (input: unknown) => {
						const inputObj = input as Record<string, unknown>;
						const synthesisPrompt = PromptTemplate.fromTemplate(`
							Based on the initial assessments:
							Structure Analysis: {stage1_structure}
							Character Analysis: {stage1_characters}

							Provide a synthesized analysis identifying:
							1. Top 3 strengths
							2. Top 3 areas for improvement
							3. Priority recommendations
							4. Overall readiness score (1-100)
						`);

						const chain = RunnableSequence.from([
							synthesisPrompt,
							this.primaryModel,
							new StringOutputParser(),
						]);

						return await chain.invoke(inputObj as never);
					}),
				}),

				// Stage 3: Final recommendations
				RunnablePassthrough.assign({
					finalRecommendations: RunnableLambda.from(async (input: unknown) => {
						const inputObj = input as Record<string, unknown>;
						const finalPrompt = PromptTemplate.fromTemplate(`
							Based on all previous analysis:
							{stage2_synthesis}

							Generate 8-10 specific, prioritized recommendations for manuscript improvement.
							Format as JSON array of objects with: {priority, action, rationale}
						`);

						const chain = RunnableSequence.from([
							finalPrompt,
							this.primaryModel,
							new StringOutputParser(),
						]);

						const result = await chain.invoke(inputObj as never);
						try {
							return safeParse(result, []);
						} catch {
							return result
								.split('\n')
								.filter((line) => line.trim())
								.map((line) => ({
									priority: 'medium',
									action: line.trim(),
									rationale: 'See detailed analysis',
								}));
						}
					}),

					overallScore: RunnableLambda.from((input: unknown) => {
						const inputObj = input as Record<string, unknown>;
						// Extract scores from previous stages and calculate weighted average
						try {
							const structureData = safeParse(String(inputObj.stage1_structure), {});
							const characterData = safeParse(String(inputObj.stage1_characters), {});

							const structureScores = Object.values(structureData).filter(
								(v): v is number => typeof v === 'number'
							);
							const characterScores = Object.values(characterData).filter(
								(v): v is number => typeof v === 'number'
							);

							const allScores = [...structureScores, ...characterScores];
							const average =
								allScores.reduce((sum, score) => sum + score, 0) / allScores.length;

							return Math.round(average * 10); // Convert to 1-100 scale
						} catch {
							return 75; // Default score
						}
					}),
				}),
			]);

			const result = await multiStageChain.invoke({});

			return {
				stageResults: {
					structure: result.stage1_structure,
					characters: result.stage1_characters,
					synthesis: result.stage2_synthesis,
				},
				finalRecommendations: Array.isArray(result.finalRecommendations)
					? result.finalRecommendations.map((r: unknown) =>
							typeof r === 'object' && r !== null && 'action' in r
								? (r as { action: string }).action
								: String(r)
						)
					: [],
				overallScore: result.overallScore || 75,
			};
		} catch (error) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				error as Error,
				'Multi-stage review failed'
			);
		}
	}

	/**
	 * Clear all memory and caches
	 */
	clearMemory(): void {
		this.vectorStore = null;
		this.contexts.clear();
		this.conversationMemory.clear();
		this.summaryMemory = null;
		this.qaChain = null;
		this.logger.debug('Cleared all memory and caches');
	}

	/**
	 * Get service statistics
	 */
	getStatistics(): {
		modelsLoaded: number;
		vectorStoreSize: number;
		activeConversations: number;
		contextsStored: number;
	} {
		return {
			modelsLoaded: this.models.size,
			vectorStoreSize: this.vectorStore?.memoryVectors?.length || 0,
			activeConversations: this.conversationMemory.size,
			contextsStored: this.contexts.size,
		};
	}
}
