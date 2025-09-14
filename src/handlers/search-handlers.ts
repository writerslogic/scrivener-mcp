import { SemanticDatabaseLayer } from '../handlers/database/langchain-semantic-layer.js';
import { VectorStore } from '../services/ai/vector-store.js';
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
import {
	documentDetailsSchema,
	moveDocumentSchema,
	searchContentSchema,
	searchTrashSchema,
} from './validation-schemas.js';

export const searchContentHandler: ToolDefinition = {
	name: 'search_content',
	description: 'Search for content across all documents',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Search query',
			},
			caseSensitive: {
				type: 'boolean',
				description: 'Case sensitive search',
			},
			regex: {
				type: 'boolean',
				description: 'Use regular expression',
			},
			includeTrash: {
				type: 'boolean',
				description: 'Include trash in search',
			},
			searchIn: {
				type: 'array',
				items: { type: 'string' },
				description: 'Search in specific fields: content, synopsis, notes, title',
			},
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
			const learningHandler = new LangChainContinuousLearningHandler();
			await learningHandler.initialize();

			const sessionId = `search_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// Use semantic database layer for intelligent search if available
			if (!context.databaseService) {
				throw new Error('Database service not available for semantic search');
			}

			const semanticLayer = new SemanticDatabaseLayer(context.databaseService!);
			await semanticLayer.initialize();

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

			return {
				content: [
					{
						type: 'text',
						text: `Found ${semanticResults.documents.length} semantic matches`,
						data: {
							...semanticResults,
							enhanced: true,
							searchType: 'semantic',
							sessionId,
						},
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

			return {
				content: [
					{
						type: 'text',
						text: `Found ${results.length} matches (basic search)`,
						data: {
							results,
							enhanced: false,
							fallbackReason: (error as Error).message,
						},
					},
				],
			};
		}
	},
};

export const listTrashHandler: ToolDefinition = {
	name: 'list_trash',
	description: 'List all documents in trash',
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
					text: `${trashItems.length} items in trash`,
					data: trashItems,
				},
			],
		};
	},
};

export const searchTrashHandler: ToolDefinition = {
	name: 'search_trash',
	description: 'Search for documents in trash',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Search query for title or content',
			},
			searchType: {
				type: 'string',
				enum: ['title', 'content', 'both'],
				description: 'What to search in',
			},
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
					text: `Found ${results.length} matches in trash`,
					data: results,
				},
			],
		};
	},
};

export const recoverDocumentHandler: ToolDefinition = {
	name: 'recover_document',
	description: 'Recover a document from trash',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of document to recover',
			},
			targetFolderId: {
				type: 'string',
				description: 'Target folder (optional, defaults to Draft)',
			},
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
	description: 'Get all annotations for a document',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document',
			},
			includeComments: {
				type: 'boolean',
				description: 'Include inline comments',
			},
			includeFootnotes: {
				type: 'boolean',
				description: 'Include footnotes',
			},
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
					text: `Found ${formattedAnnotations.comments?.length || 0} comments and ${formattedAnnotations.footnotes?.length || 0} footnotes`,
					data: formattedAnnotations,
				},
			],
		};
	},
};

// Advanced LangChain search handlers
export const vectorSearchHandler: ToolDefinition = {
	name: 'vector_search',
	description: 'Semantic vector search across project documents',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Search query in natural language',
			},
			maxResults: {
				type: 'number',
				description: 'Maximum number of results (default: 10)',
			},
			threshold: {
				type: 'number',
				description: 'Minimum similarity threshold 0-1 (default: 0.5)',
			},
			searchType: {
				type: 'string',
				enum: ['semantic', 'hybrid', 'keyword'],
				description: 'Type of search to perform',
			},
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
			// Initialize vector store
			const vectorStore = new VectorStore();
			await vectorStore.initialize();

			// Initialize continuous learning for feedback collection
			const learningHandler = new LangChainContinuousLearningHandler();
			await learningHandler.initialize();

			const sessionId = `vector_search_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			let results;
			if (searchType === 'hybrid') {
				results = await vectorStore.hybridSearch(query, {
					semanticWeight: 0.7,
					keywordWeight: 0.3,
					maxResults,
				});
			} else if (searchType === 'semantic') {
				results = await vectorStore.semanticSearch(query, {
					threshold,
					maxResults,
					includeMetadata: true,
				});
			} else {
				// Keyword search fallback
				const documents = await project.getAllDocuments();
				const vectorDocuments = documents
					.filter((doc) => doc.content)
					.map((doc) => ({
						id: doc.id,
						content: doc.content || '',
						metadata: {
							title: doc.title,
							type: doc.type,
							wordCount: doc.content ? doc.content.split(' ').length : 0,
						},
					}));

				await vectorStore.addDocuments(vectorDocuments);
				results = await vectorStore.similaritySearch(query, maxResults);
			}

			// Collect implicit feedback
			await learningHandler.collectImplicitFeedback(sessionId, 'vector_search', {
				timeSpent: 0,
				userActions: ['vector_search'],
				documentsCount: results.length,
				enhancementType: 'vector_search',
				targetOptimization: query,
			});

			return {
				content: [
					{
						type: 'text',
						text: `Found ${results.length} ${searchType} matches`,
						data: {
							results,
							enhanced: true,
							searchType,
							query,
							maxResults,
							threshold,
							sessionId,
						},
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Vector search failed: ${(error as Error).message}`,
						data: { error: true, enhanced: false },
					},
				],
			};
		}
	},
};

export const findMentionsHandler: ToolDefinition = {
	name: 'find_mentions',
	description: 'Find all mentions of a character, location, or entity across documents',
	inputSchema: {
		type: 'object',
		properties: {
			entity: {
				type: 'string',
				description: 'Entity to search for (character name, location, etc.)',
			},
			contextLength: {
				type: 'number',
				description: 'Length of context around each mention (default: 100)',
			},
		},
		required: ['entity'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const entity = getStringArg(args, 'entity');
		const contextLength = getOptionalNumberArg(args, 'contextLength') || 100;

		try {
			// Initialize vector store for mention finding
			const vectorStore = new VectorStore();
			await vectorStore.initialize();

			// Get all documents and add them to vector store
			const documents = await project.getAllDocuments();
			const vectorDocuments = documents
				.filter((doc) => doc.content)
				.map((doc) => ({
					id: doc.id,
					content: doc.content || '',
					metadata: {
						title: doc.title,
						type: doc.type,
					},
				}));

			if (vectorDocuments.length === 0) {
				throw new Error('No documents with content found');
			}

			await vectorStore.addDocuments(vectorDocuments);

			// Find mentions using vector store
			const mentions = await vectorStore.findMentions(entity);

			// Initialize continuous learning for feedback collection
			const learningHandler = new LangChainContinuousLearningHandler();
			await learningHandler.initialize();

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

			return {
				content: [
					{
						type: 'text',
						text: `Found ${mentions.length} mentions of "${entity}"`,
						data: {
							mentions,
							entity,
							enhanced: true,
							contextLength,
							sessionId,
						},
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Mention search failed: ${(error as Error).message}`,
						data: { error: true, enhanced: false },
					},
				],
			};
		}
	},
};

export const crossReferenceHandler: ToolDefinition = {
	name: 'cross_reference_analysis',
	description: 'AI-powered cross-reference analysis to find related content and connections',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'Source document for cross-reference analysis',
			},
			analysisType: {
				type: 'string',
				enum: ['characters', 'themes', 'plot_points', 'locations', 'all'],
				description: 'Type of cross-reference analysis',
			},
			maxConnections: {
				type: 'number',
				description: 'Maximum number of connections to find (default: 10)',
			},
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
						data: { error: true },
					},
				],
			};
		}

		try {
			// Initialize semantic database layer
			if (!context.databaseService) {
				throw new Error('Database service not available for entity analysis');
			}

			const semanticLayer = new SemanticDatabaseLayer(context.databaseService!);
			await semanticLayer.initialize();

			// Initialize continuous learning for feedback collection
			const learningHandler = new LangChainContinuousLearningHandler();
			await learningHandler.initialize();

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
						text: `Cross-reference analysis complete for ${document.title}`,
						data: {
							...analysis,
							enhanced: true,
							analysisType,
							maxConnections,
							sessionId,
						},
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Cross-reference analysis failed: ${(error as Error).message}`,
						data: { error: true, enhanced: false },
					},
				],
			};
		}
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
];
