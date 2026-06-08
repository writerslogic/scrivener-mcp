import { SemanticDatabaseLayer } from '../handlers/database/langchain-semantic-layer.js';
import { LangChainHMSVectorStore } from '../services/ai/hms-vector-store.js';
import { OpenAIEmbeddings } from '@langchain/openai';
import { Document as LangchainDocument } from '@langchain/core/documents';
import { validateInput } from '../utils/common.js';
import { LangChainContinuousLearningHandler } from './langchain-continuous-learning-handler.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalBooleanArg,
	getOptionalNumberArg,
	getOptionalObjectArg,
	getOptionalStringArg,
	getStringArg,
	requireProject,
} from './types.js';
// Cached singleton instances to avoid re-instantiation per request
let cachedSearchLearningHandler: LangChainContinuousLearningHandler | null = null;
let cachedSemanticLayer: SemanticDatabaseLayer | null = null;
let cachedSemanticLayerDbService: unknown = null;

async function getSearchLearningHandler(): Promise<LangChainContinuousLearningHandler> {
	if (!cachedSearchLearningHandler) {
		cachedSearchLearningHandler = new LangChainContinuousLearningHandler();
		await cachedSearchLearningHandler.initialize();
	}
	return cachedSearchLearningHandler;
}

async function getSemanticLayer(
	databaseService: NonNullable<unknown>
): Promise<SemanticDatabaseLayer> {
	if (!cachedSemanticLayer || cachedSemanticLayerDbService !== databaseService) {
		cachedSemanticLayer = new SemanticDatabaseLayer(
			databaseService as ConstructorParameters<typeof SemanticDatabaseLayer>[0]
		);
		await cachedSemanticLayer.initialize();
		cachedSemanticLayerDbService = databaseService;
	}
	return cachedSemanticLayer;
}

import { compact } from '../core/response-formatter.js';
import { SHARED_DEFS } from './shared-schemas.js';
import {
	documentDetailsSchema,
	moveDocumentSchema,
	searchContentSchema,
	searchTrashSchema,
} from './validation-schemas.js';

export const searchContentHandler: ToolDefinition = {
	name: 'search_content',
	description: 'Search across all documents',
	inputSchema: {
		type: 'object',
		properties: {
			query: SHARED_DEFS.query,
			caseSensitive: { type: 'boolean' },
			regex: { type: 'boolean' },
			includeTrash: SHARED_DEFS.includeTrash,
			searchIn: { type: 'array', items: { type: 'string' }, description: 'Fields to search' },
		},
		required: ['query'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, searchContentSchema);

		const query = getStringArg(args, 'query');
		const caseSensitive = getOptionalBooleanArg(args, 'caseSensitive') || false;
		const regex = getOptionalBooleanArg(args, 'regex') || false;
		const includeTrash = getOptionalBooleanArg(args, 'includeTrash') || false;
		const searchIn = getOptionalObjectArg(args, 'searchIn') as string[];

		try {
			// Try semantic search first for enhanced results
			const learningHandler = await getSearchLearningHandler();

			const sessionId = `search_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// Use semantic database layer for intelligent search if available
			if (!context.databaseService) {
				throw new Error('Database service not available for semantic search');
			}

			const semanticLayer = await getSemanticLayer(context.databaseService!);

			const semanticResults = await semanticLayer.semanticQuery(query, {
				threshold: 0.3,
				maxResults: 20,
				includeEntities: true,
				includeRelationships: true,
			});

			// Collect implicit feedback
			await learningHandler.collectImplicitFeedback(sessionId, 'search_content', {
				timeSpent: 0,
				userActions: ['search_content'],
				documentsCount: semanticResults.documents.length,
				enhancementType: 'search',
				targetOptimization: query,
			});

			// Trim results to compact snippets
			const trimmedResults = (semanticResults.documents || []).map(
				(doc: Record<string, unknown>) => ({
					id: doc.id,
					title: doc.title || 'Untitled',
					snippet:
						typeof doc.content === 'string'
							? doc.content.length > 100
								? doc.content.slice(0, 100) + '...'
								: doc.content
							: typeof doc.text === 'string'
								? doc.text.length > 100
									? doc.text.slice(0, 100) + '...'
									: doc.text
								: '',
					score: doc.score ?? doc.relevance ?? null,
				})
			);

			return {
				content: [
					{
						type: 'text',
						text: `Found ${trimmedResults.length} semantic matches\n${compact({
							results: trimmedResults,
							searchType: 'semantic',
						})}`,
					},
				],
			};
		} catch (error) {
			// Fallback to basic search if semantic search fails
			const results = await project.searchContent(query, {
				caseSensitive,
				regex,
				includeTrash,
				searchMetadata: searchIn?.includes('synopsis') || searchIn?.includes('notes'),
			});

			// Trim fallback results to compact snippets
			const trimmedResults = results.map((r: Record<string, unknown>) => ({
				id: r.id,
				title: r.title || 'Untitled',
				snippet:
					typeof r.content === 'string'
						? r.content.length > 100
							? r.content.slice(0, 100) + '...'
							: r.content
						: typeof r.text === 'string'
							? r.text.length > 100
								? r.text.slice(0, 100) + '...'
								: r.text
							: '',
				score: r.score ?? null,
			}));

			return {
				content: [
					{
						type: 'text',
						text: `Found ${trimmedResults.length} matches (basic search)\n${compact({
							results: trimmedResults,
						})}`,
					},
				],
			};
		}
	},
};

export const listTrashHandler: ToolDefinition = {
	name: 'list_trash',
	description: 'List trashed documents',
	inputSchema: {
		type: 'object',
		properties: {},
	},
	handler: async (_args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const trashItems = await project.getTrashDocuments();

		return {
			content: [
				{
					type: 'text',
					text: `${trashItems.length} items in trash\n${compact(trashItems)}`,
				},
			],
		};
	},
};

export const searchTrashHandler: ToolDefinition = {
	name: 'search_trash',
	description: 'Search trashed documents',
	inputSchema: {
		type: 'object',
		properties: {
			query: SHARED_DEFS.query,
			searchType: { type: 'string', enum: ['title', 'content', 'both'] },
		},
		required: ['query'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, searchTrashSchema);

		const query = getStringArg(args, 'query');
		const caseSensitive = getOptionalBooleanArg(args, 'caseSensitive') || false;
		const regex = getOptionalBooleanArg(args, 'regex') || false;
		const results = await project.searchTrash(query, {
			caseSensitive,
			regex,
		});

		return {
			content: [
				{
					type: 'text',
					text: `Found ${results.length} matches in trash\n${compact(results)}`,
				},
			],
		};
	},
};

export const recoverDocumentHandler: ToolDefinition = {
	name: 'recover_document',
	description: 'Restore from trash',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			targetFolderId: SHARED_DEFS.folderId,
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, moveDocumentSchema);

		const documentId = getStringArg(args, 'documentId');
		const targetFolderId = getOptionalStringArg(args, 'targetFolderId');
		await project.recoverFromTrash(documentId, targetFolderId);

		return {
			content: [
				{
					type: 'text',
					text: 'Document recovered from trash',
				},
			],
		};
	},
};

export const getAnnotationsHandler: ToolDefinition = {
	name: 'get_document_annotations',
	description: 'Get annotations and footnotes',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			includeComments: { type: 'boolean' },
			includeFootnotes: { type: 'boolean' },
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentDetailsSchema);

		const documentId = getStringArg(args, 'documentId');
		const annotations = await project.getDocumentAnnotations(documentId);
		const formattedAnnotations = {
			comments: Array.from(annotations.entries()).filter(([k]) => k.startsWith('comment')),
			footnotes: Array.from(annotations.entries()).filter(([k]) => k.startsWith('footnote')),
		};

		return {
			content: [
				{
					type: 'text',
					text: `Found ${formattedAnnotations.comments?.length || 0} comments and ${formattedAnnotations.footnotes?.length || 0} footnotes\n${compact(formattedAnnotations)}`,
				},
			],
		};
	},
};

// Advanced LangChain search handlers
export const vectorSearchHandler: ToolDefinition = {
	name: 'vector_search',
	description: 'Semantic vector search',
	inputSchema: {
		type: 'object',
		properties: {
			query: SHARED_DEFS.query,
			maxResults: SHARED_DEFS.maxResults,
			threshold: SHARED_DEFS.threshold,
			searchType: { type: 'string', enum: ['semantic', 'hybrid', 'keyword'] },
		},
		required: ['query'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const query = getStringArg(args, 'query');
		const maxResults = getOptionalNumberArg(args, 'maxResults') || 10;
		const threshold = getOptionalNumberArg(args, 'threshold') || 0.5;
		const searchType = (args.searchType as string) || 'semantic';

		try {
			// Initialize HMS-backed vector store
			const embeddings = new OpenAIEmbeddings();
			const vectorStore = new LangChainHMSVectorStore(embeddings);

			// Initialize continuous learning for feedback collection
			const learningHandler = await getSearchLearningHandler();

			const sessionId = `vector_search_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// In HMS context, we should ensure documents are loaded
			// For this tool, we'll load all documents if the store is effectively empty
			const documents = await project.getAllDocuments();
			const langchainDocs = documents
				.filter((doc) => doc.content)
				.map(
					(doc) =>
						new LangchainDocument({
							pageContent: doc.content || '',
							metadata: {
								id: doc.id,
								title: doc.title,
								type: doc.type,
								wordCount: doc.content ? doc.content.split(' ').length : 0,
							},
						})
				);

			await vectorStore.addDocuments(langchainDocs);

			let results;
			if (searchType === 'semantic' || searchType === 'hybrid') {
				// HMS natively handles semantic search
				results = await vectorStore.similaritySearchWithScore(query, maxResults);
			} else {
				// Keyword search fallback - simple filter for now as HMS is semantic-first
				results = (await vectorStore.similaritySearchWithScore(query, maxResults)).filter(
					([doc]) => doc.pageContent.toLowerCase().includes(query.toLowerCase())
				);
			}

			// Format results to match the expected SearchResult interface
			const formattedResults = results
				.filter(([, score]) => score >= threshold)
				.map(([doc, score]) => ({
					id: doc.metadata.id,
					title: doc.metadata.title || 'Untitled',
					snippet:
						doc.pageContent.length > 100
							? doc.pageContent.slice(0, 100) + '...'
							: doc.pageContent,
					score,
				}));

			// Collect implicit feedback
			await learningHandler.collectImplicitFeedback(sessionId, 'vector_search', {
				timeSpent: 0,
				userActions: ['vector_search'],
				documentsCount: formattedResults.length,
				enhancementType: 'vector_search',
				targetOptimization: query,
			});

			return {
				content: [
					{
						type: 'text',
						text: `Found ${formattedResults.length} ${searchType} matches\n${compact({
							results: formattedResults,
							searchType,
						})}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Vector search failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const findMentionsHandler: ToolDefinition = {
	name: 'find_mentions',
	description: 'Find entity mentions',
	inputSchema: {
		type: 'object',
		properties: {
			entity: { type: 'string' },
			contextLength: { type: 'number', description: 'Context chars' },
		},
		required: ['entity'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const entity = getStringArg(args, 'entity');
		const contextLength = getOptionalNumberArg(args, 'contextLength') || 100;

		try {
			// Get all documents
			const documents = await project.getAllDocuments();
			const mentions: Array<{
				documentId: string;
				title: string;
				context: string;
				position: number;
			}> = [];

			const entityLower = entity.toLowerCase();
			const maxResults = 50;

			for (const doc of documents) {
				if (mentions.length >= maxResults) break;

				const content = doc.content || '';
				const title = doc.title || 'Untitled';
				const contentLower = content.toLowerCase();

				let position = 0;
				while ((position = contentLower.indexOf(entityLower, position)) !== -1) {
					// Extract context around the mention
					const contextStart = Math.max(0, position - contextLength);
					const contextEnd = Math.min(
						content.length,
						position + entity.length + contextLength
					);
					const contextSnippet = content.slice(contextStart, contextEnd);

					mentions.push({
						documentId: doc.id,
						title,
						context: contextSnippet,
						position,
					});

					if (mentions.length >= maxResults) break;

					position += entity.length;
				}
			}

			// Initialize continuous learning for feedback collection
			const learningHandler = await getSearchLearningHandler();

			const sessionId = `find_mentions_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// Collect implicit feedback
			await learningHandler.collectImplicitFeedback(sessionId, 'find_mentions', {
				timeSpent: 0,
				userActions: ['find_mentions'],
				documentsCount: mentions.length,
				enhancementType: 'find_mentions',
				targetOptimization: entity,
			});

			const trimmedMentions = mentions.map((m) => ({
				id: m.documentId,
				title: m.title,
				snippet: m.context.length > 100 ? m.context.slice(0, 100) + '...' : m.context,
				score: null,
			}));

			return {
				content: [
					{
						type: 'text',
						text: `Found ${trimmedMentions.length} mentions of "${entity}"\n${compact({
							results: trimmedMentions,
						})}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Mention search failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const crossReferenceHandler: ToolDefinition = {
	name: 'cross_reference_analysis',
	description: 'Cross-reference related content',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			analysisType: {
				type: 'string',
				enum: ['characters', 'themes', 'plot_points', 'locations', 'all'],
			},
			maxConnections: SHARED_DEFS.maxResults,
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const analysisType = (args.analysisType as string) || 'all';
		const maxConnections = getOptionalNumberArg(args, 'maxConnections') || 10;

		const document = await project.getDocument(documentId);
		if (!document) {
			return {
				content: [
					{
						type: 'text',
						text: 'Document not found',
					},
				],
			};
		}

		try {
			// Initialize semantic database layer
			if (!context.databaseService) {
				throw new Error('Database service not available for entity analysis');
			}

			const semanticLayer = await getSemanticLayer(context.databaseService!);

			// Initialize continuous learning for feedback collection
			const learningHandler = await getSearchLearningHandler();

			const sessionId = `cross_reference_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// Perform cross-reference analysis
			const analysis = await semanticLayer.crossReferenceAnalysis(
				document.content || document.title
			);

			// Collect implicit feedback
			await learningHandler.collectImplicitFeedback(sessionId, 'cross_reference_analysis', {
				timeSpent: analysis.processingTime || 0,
				userActions: ['cross_reference_analysis'],
				enhancementType: 'cross_reference_analysis',
				documentsCount: analysis.connections?.length || 0,
			});

			return {
				content: [
					{
						type: 'text',
						text: `Cross-reference analysis complete for ${document.title}\n${compact({
							...analysis,
							enhanced: true,
							analysisType,
							maxConnections,
							sessionId,
						})}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Cross-reference analysis failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const findDocumentHandler: ToolDefinition = {
	name: 'find_document',
	description: 'Find documents by title',
	inputSchema: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'Substring to match against document titles (case-insensitive)',
			},
			type: {
				type: 'string',
				enum: ['Text', 'Folder', 'any'],
				description: 'Filter by document type',
			},
		},
		required: ['pattern'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const pattern = getStringArg(args, 'pattern');
		const typeFilter = getOptionalStringArg(args, 'type') || 'any';

		const documents = await project.getAllDocuments();
		const patternLower = pattern.toLowerCase();

		const matches = documents
			.filter((doc) => {
				if (!doc.title?.toLowerCase().includes(patternLower)) return false;
				if (typeFilter !== 'any' && doc.type !== typeFilter) return false;
				return true;
			})
			.slice(0, 20)
			.map((doc) => ({
				id: doc.id,
				title: doc.title,
				type: doc.type,
				path: doc.path,
			}));

		return {
			content: [
				{
					type: 'text',
					text: `Found ${matches.length} document(s) matching "${pattern}"\n${JSON.stringify(matches, null, 2)}`,
				},
			],
		};
	},
};

export const searchHandlers = [
	searchContentHandler,
	listTrashHandler,
	searchTrashHandler,
	recoverDocumentHandler,
	getAnnotationsHandler,
	// Advanced LangChain search handlers
	vectorSearchHandler,
	findMentionsHandler,
	crossReferenceHandler,
	findDocumentHandler,
];
