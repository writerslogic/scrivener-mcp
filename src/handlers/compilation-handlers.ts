import { LangChainCompilationService } from '../services/compilation/langchain-compiler.js';
import type { ExportOptions } from '../types/index.js';
import { validateInput } from '../utils/common.js';
import { LangChainContinuousLearningHandler } from './langchain-continuous-learning-handler.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalObjectArg,
	getOptionalStringArg,
	getStringArg,
	requireProject,
} from './types.js';
import { SHARED_DEFS } from './shared-schemas.js';
import { compileSchema, exportSchema } from './validation-schemas.js';

export const compileDocumentsHandler: ToolDefinition = {
	name: 'compile_documents',
	description: 'Compile documents in order',
	inputSchema: {
		type: 'object',
		properties: {
			format: { type: 'string', enum: ['text', 'markdown', 'html'] },
			rootFolderId: SHARED_DEFS.folderId,
			includeSynopsis: { type: 'boolean' },
			includeNotes: { type: 'boolean' },
			separator: { type: 'string' },
			hierarchical: { type: 'boolean' },
		},
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, compileSchema);

		// Get documents to compile
		const documents = await project.getAllDocuments();
		let documentsToCompile: Array<{ id: string; content: string; title: string }>;

		const rootFolderId = getOptionalStringArg(args, 'rootFolderId');
		if (rootFolderId) {
			// Filter documents under the specified folder
			documentsToCompile = documents
				.filter((doc) => doc.path && doc.path.startsWith(rootFolderId))
				.map((doc) => ({ id: doc.id, content: doc.content || '', title: doc.title || '' }));
		} else {
			// Use all text documents
			documentsToCompile = documents
				.filter((doc) => doc.type === 'Text')
				.map((doc) => ({ id: doc.id, content: doc.content || '', title: doc.title || '' }));
		}

		const format =
			(getOptionalStringArg(args, 'format') as 'text' | 'markdown' | 'html') || 'text';
		const includeSynopsis = (args.includeSynopsis as boolean) || false;
		const includeNotes = (args.includeNotes as boolean) || false;
		const hierarchical = (args.hierarchical as boolean) || false;

		try {
			// Use LangChain compilation service for enhanced compilation
			const langChainCompiler = new LangChainCompilationService();
			await langChainCompiler.initialize();

			// Initialize continuous learning for feedback collection
			const learningHandler = new LangChainContinuousLearningHandler();
			await learningHandler.initialize();

			const sessionId = `compile_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// Perform intelligent compilation using LangChain
			const compiled = await langChainCompiler.compileWithAI(documentsToCompile, {
				outputFormat: format,
				targetOptimization: 'general',
				includeSynopsis,
				includeNotes,
				hierarchical,
				intelligentFormatting: true,
				enhanceContent: true,
			});

			// Collect implicit feedback based on compilation success
			await learningHandler.collectImplicitFeedback(sessionId, 'compile_documents', {
				timeSpent: compiled.metadata?.processingTime || 0,
				userActions: ['compile_documents'],
				documentsCount: documentsToCompile.length,
			});

			return {
				content: [
					{
						type: 'text',
						text:
							typeof compiled.content === 'string'
								? compiled.content
								: JSON.stringify(compiled.content),
					},
				],
			};
		} catch (error) {
			// Fallback to basic compilation if LangChain fails
			const separator = getOptionalStringArg(args, 'separator') || '\n\n---\n\n';
			const documentIds = documentsToCompile.map((doc) => doc.id);
			const compiled = await project.compileDocuments(documentIds, separator, format);

			return {
				content: [
					{
						type: 'text',
						text: typeof compiled === 'string' ? compiled : JSON.stringify(compiled),
					},
				],
			};
		}
	},
};

export const exportProjectHandler: ToolDefinition = {
	name: 'export_project',
	description: 'Export project to file',
	inputSchema: {
		type: 'object',
		properties: {
			format: { type: 'string', enum: ['markdown', 'html', 'json', 'epub'] },
			outputPath: { type: 'string' },
			options: { type: 'object' },
		},
		required: ['format'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, exportSchema);

		// Export project
		const format = getStringArg(args, 'format');
		const outputPath = getOptionalStringArg(args, 'outputPath');
		const options = getOptionalObjectArg(args, 'options') as Partial<ExportOptions> | undefined;

		const result = await project.exportProject(
			format,
			outputPath,
			options as Partial<ExportOptions> | undefined
		);

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(result, null, 2),
				},
			],
		};
	},
};

export const getStatisticsHandler: ToolDefinition = {
	name: 'get_statistics',
	description: 'Get project statistics',
	inputSchema: {
		type: 'object',
		properties: {
			detailed: { type: 'boolean' },
		},
	},
	handler: async (_args, context): Promise<HandlerResult> => {
		const project = requireProject(context);

		const metadata = await project.getProjectMetadata();
		const stats = await project.getStatistics();

		const fullStats = {
			...stats,
			title: metadata.title || 'Untitled',
			author: metadata.author,
			lastModified: new Date().toISOString(),
		};

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(fullStats, null, 2),
				},
			],
		};
	},
};

// Advanced LangChain compilation handlers
export const intelligentCompilationHandler: ToolDefinition = {
	name: 'intelligent_compilation',
	description: 'AI-optimized compilation',
	inputSchema: {
		type: 'object',
		properties: {
			documentsIds: SHARED_DEFS.documentIds,
			targetOptimization: {
				type: 'string',
				enum: [
					'agent',
					'submission',
					'pitch_packet',
					'synopsis',
					'query_letter',
					'general',
				],
			},
			outputFormat: { type: 'string', enum: ['text', 'markdown', 'html', 'rtf'] },
			contentOptimization: { description: 'Enable AI optimization' },
		},
		required: ['documentsIds', 'targetOptimization'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentIds = args.documentsIds as string[];
		const targetOptimization = getStringArg(args, 'targetOptimization');
		const outputFormat =
			(args.outputFormat as 'html' | 'text' | 'json' | 'markdown' | 'latex') || 'text';
		const contentOptimization = (args.contentOptimization as boolean) || true;

		// Map targetOptimization to LangChain target types
		const getTargetType = (optimization: string): string | undefined => {
			const targetMap: Record<string, string> = {
				'agent-query': 'agent-query',
				submission: 'submission',
				'beta-readers': 'beta-readers',
				publication: 'publication',
				'pitch-packet': 'pitch-packet',
				synopsis: 'synopsis',
				general: 'general', // No specific target optimization
			};
			return targetMap[optimization];
		};

		const target = getTargetType(targetOptimization);

		try {
			// Get documents for compilation
			const documents = await Promise.all(
				documentIds.map(async (id) => {
					const doc = await project.getDocument(id);
					return doc
						? { id: doc.id, content: doc.content || '', title: doc.title || '' }
						: null;
				})
			);

			const validDocuments = documents.filter((doc) => doc !== null) as Array<{
				id: string;
				content: string;
				title: string;
			}>;

			if (validDocuments.length === 0) {
				throw new Error('No valid documents found for compilation');
			}

			// Initialize LangChain compilation service
			const langChainCompiler = new LangChainCompilationService();
			await langChainCompiler.initialize();

			// Initialize continuous learning for feedback collection
			const learningHandler = new LangChainContinuousLearningHandler();
			await learningHandler.initialize();

			const sessionId = `intelligent_compile_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// Perform intelligent compilation using LangChain
			const compiled = await langChainCompiler.compileWithAI(validDocuments, {
				outputFormat,
				targetOptimization,
				target: target as
					| 'agent-query'
					| 'submission'
					| 'beta-readers'
					| 'publication'
					| 'pitch-packet'
					| 'synopsis',
				intelligentFormatting: true,
				generateMarketingMaterials: targetOptimization !== 'general',
				enhanceContent: contentOptimization,
				optimizeForTarget: contentOptimization && !!target,
			});

			// Collect implicit feedback
			await learningHandler.collectImplicitFeedback(sessionId, 'intelligent_compilation', {
				timeSpent: compiled.metadata?.processingTime || 0,
				userActions: ['intelligent_compilation'],
				targetOptimization,
				documentsCount: validDocuments.length,
			});

			return {
				content: [
					{
						type: 'text',
						text:
							typeof compiled.content === 'string'
								? compiled.content
								: JSON.stringify(compiled.content),
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Intelligent compilation failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const generateMarketingMaterialsHandler: ToolDefinition = {
	name: 'generate_marketing_materials',
	description: 'Generate marketing materials',
	inputSchema: {
		type: 'object',
		properties: {
			materialType: {
				type: 'string',
				enum: ['synopsis', 'query_letter', 'pitch_packet', 'elevator_pitch', 'book_blurb'],
			},
			length: { type: 'string', enum: ['short', 'medium', 'long'] },
			targetAudience: { type: 'string' },
		},
		required: ['materialType'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const materialType = getStringArg(args, 'materialType');
		const lengthStr = (args.length as string) || 'medium';
		const length = lengthStr === 'short' ? 500 : lengthStr === 'long' ? 2000 : 1000; // medium = 1000
		const targetAudience = args.targetAudience as string;

		try {
			// Get all project documents for context
			const documents = await project.getAllDocuments();
			const textDocuments = documents
				.filter((doc) => doc.type === 'Text' && doc.content)
				.map((doc) => ({ id: doc.id, content: doc.content || '', title: doc.title || '' }));

			if (textDocuments.length === 0) {
				throw new Error('No text documents found in project');
			}

			// Initialize LangChain compilation service
			const langChainCompiler = new LangChainCompilationService();
			await langChainCompiler.initialize();

			// Initialize continuous learning for feedback collection
			const learningHandler = new LangChainContinuousLearningHandler();
			await learningHandler.initialize();

			const sessionId = `marketing_${materialType}_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// Generate marketing materials
			const result = await langChainCompiler.generateMarketingMaterials(textDocuments, {
				materialType,
				length,
				targetAudience,
				includeGenreAnalysis: true,
			});

			// Collect implicit feedback
			await learningHandler.collectImplicitFeedback(
				sessionId,
				'generate_marketing_materials',
				{
					timeSpent: result.processingTime || 0,
					userActions: ['generate_marketing_materials'],
					materialType,
				}
			);

			return {
				content: [
					{
						type: 'text',
						text: result.content,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Marketing material generation failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const buildVectorStoreHandler: ToolDefinition = {
	name: 'build_vector_store',
	description: 'Build search index',
	inputSchema: {
		type: 'object',
		properties: {
			rebuild: { type: 'boolean' },
		},
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const rebuild = (args.rebuild as boolean) || false;

		try {
			// Get all project documents
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
						synopsis: doc.synopsis,
					},
				}));

			if (vectorDocuments.length === 0) {
				throw new Error('No documents with content found for indexing');
			}

			// Initialize HMS-backed vector store
			const { LangChainHMSVectorStore } = await import('../services/ai/hms-vector-store.js');
			const { OpenAIEmbeddings } = await import('@langchain/openai');
			const { Document } = await import('@langchain/core/documents');

			const docs = vectorDocuments.map(
				(doc) =>
					new Document({
						pageContent: doc.content,
						metadata: { id: doc.id, ...doc.metadata },
					})
			);

			const embeddings = new OpenAIEmbeddings();
			await LangChainHMSVectorStore.fromDocuments(docs, embeddings);

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								vectorIndexed: true,
								documentsIndexed: vectorDocuments.length,
								status: rebuild ? 'rebuilt' : 'updated',
							},
							null,
							2
						),
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Vector store build failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const compilationHandlers = [
	compileDocumentsHandler,
	exportProjectHandler,
	getStatisticsHandler,
	// Advanced LangChain compilation handlers
	intelligentCompilationHandler,
	generateMarketingMaterialsHandler,
	buildVectorStoreHandler,
];
