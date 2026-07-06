import { AICompilationService } from '../services/compilation/ai-compiler.js';
import type { ExportOptions } from '../types/index.js';
import { validateInput } from '../utils/common.js';
import { compact, formatPayload } from '../core/response-formatter.js';
import { getLogger } from '../core/logger.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalObjectArg,
	getOptionalStringArg,
	getPersonalization,
	getStringArg,
	requireProject,
} from './types.js';
import { SHARED_DEFS } from './shared-schemas.js';
import { compileSchema, exportSchema } from './validation-schemas.js';

const logger = getLogger('compilation-handlers');

function formatCompileResult(text: string, sectionCount: number, format: string): HandlerResult {
	const charCount = text.length;
	const wordCount = text.split(/\s+/).filter(Boolean).length;

	if (charCount <= 4000) {
		return {
			content: [{ type: 'text', text }],
			structuredContent: {
				format,
				text,
				wordCount,
				charCount,
				sections: sectionCount,
			},
		};
	}

	const spooled = formatPayload({ compiledText: text }, 'compiled');
	const ref = JSON.parse(spooled);
	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify({
					wordCount,
					charCount,
					sections: sectionCount,
					file: ref._file,
				}),
			},
		],
		structuredContent: {
			format,
			file: ref._file,
			wordCount,
			charCount,
			sections: sectionCount,
		},
	};
}

export const compileDocumentsHandler: ToolDefinition = {
	name: 'compile_documents',
	title: 'Compile Documents',
	description:
		"Compile the project's documents into a single continuous manuscript in the requested format " +
		'and return the compiled text (large results are spooled to a file reference). In "standard" ' +
		'mode it joins documents in binder order; in "intelligent" mode it uses AI to optimize the ' +
		'output for a specific target such as an agent query or synopsis. To write a manuscript to ' +
		'disk in a publishing format (EPUB, etc.) use export_project instead. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			mode: {
				type: 'string',
				enum: ['standard', 'intelligent'],
				description:
					'"standard" (default) joins documents in order; "intelligent" applies AI ' +
					'optimization toward targetOptimization.',
			},
			format: {
				type: 'string',
				enum: ['text', 'markdown', 'html'],
				description: 'Output format of the compiled manuscript. Default "text".',
			},
			rootFolderId: {
				...SHARED_DEFS.folderId,
				description:
					'Optional binder folder id to compile only its descendants. Omit to compile all ' +
					'text documents.',
			},
			documentIds: {
				...SHARED_DEFS.documentIds,
				description:
					'Optional explicit list of document ids to compile, in order. Overrides rootFolderId ' +
					'when provided; most useful with mode "intelligent".',
			},
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
				description:
					'For mode "intelligent": what to optimize the compiled output for. Default "general".',
			},
			includeSynopsis: {
				type: 'boolean',
				description: "Include each document's synopsis in the output. Default false.",
			},
			includeNotes: {
				type: 'boolean',
				description: "Include each document's notes in the output. Default false.",
			},
			separator: {
				type: 'string',
				description:
					'Text inserted between documents in the standard-mode fallback. Default "\\n\\n---\\n\\n".',
			},
			hierarchical: {
				type: 'boolean',
				description: 'Preserve the binder folder hierarchy as headings. Default false.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			format: {
				type: 'string',
				description: 'Format the manuscript was compiled to (text, markdown, or html).',
			},
			text: {
				type: 'string',
				description:
					'The compiled manuscript text. Present for small results; large results spool to a file instead.',
			},
			file: {
				type: 'string',
				description:
					'File reference the compiled text was spooled to. Present only when the result was too large to inline.',
			},
			wordCount: {
				type: 'number',
				description: 'Word count of the compiled manuscript.',
			},
			charCount: {
				type: 'number',
				description: 'Character count of the compiled manuscript.',
			},
			sections: {
				type: 'number',
				description: 'Number of documents compiled into the manuscript.',
			},
		},
		required: ['format', 'wordCount', 'charCount', 'sections'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, compileSchema);

		const mode = getOptionalStringArg(args, 'mode') || 'standard';
		const format =
			(getOptionalStringArg(args, 'format') as 'text' | 'markdown' | 'html') || 'text';
		const includeSynopsis = (args.includeSynopsis as boolean) || false;
		const includeNotes = (args.includeNotes as boolean) || false;
		const hierarchical = (args.hierarchical as boolean) || false;
		const explicitIds = args.documentIds as string[] | undefined;

		// Resolve the set of documents to compile.
		const documents = await project.getAllDocuments();
		let documentsToCompile: Array<{ id: string; content: string; title: string }>;
		const rootFolderId = getOptionalStringArg(args, 'rootFolderId');
		if (explicitIds && explicitIds.length > 0) {
			const byId = new Map(documents.map((d) => [d.id, d]));
			documentsToCompile = explicitIds
				.map((id) => byId.get(id))
				.filter((d): d is NonNullable<typeof d> => !!d)
				.map((doc) => ({ id: doc.id, content: doc.content || '', title: doc.title || '' }));
		} else if (rootFolderId) {
			documentsToCompile = documents
				.filter((doc) => doc.path && doc.path.startsWith(rootFolderId))
				.map((doc) => ({ id: doc.id, content: doc.content || '', title: doc.title || '' }));
		} else {
			documentsToCompile = documents
				.filter((doc) => doc.type === 'Text')
				.map((doc) => ({ id: doc.id, content: doc.content || '', title: doc.title || '' }));
		}

		// Intelligent mode: AI-optimized compilation toward a target.
		if (mode === 'intelligent') {
			const targetOptimization =
				getOptionalStringArg(args, 'targetOptimization') || 'general';
			const targetMap: Record<string, string> = {
				agent: 'agent-query',
				query_letter: 'agent-query',
				submission: 'submission',
				pitch_packet: 'pitch-packet',
				synopsis: 'synopsis',
				general: 'general',
			};
			const target = targetMap[targetOptimization];
			try {
				if (documentsToCompile.length === 0) {
					throw new Error('No valid documents found for compilation');
				}
				const aiCompiler = new AICompilationService();
				await aiCompiler.initialize();
				const preferenceDirective = await getPersonalization(context).buildDirective();

				const compiled = await aiCompiler.compileWithAI(documentsToCompile, {
					outputFormat: format,
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
					enhanceContent: true,
					optimizeForTarget: !!target,
					preferenceDirective,
				});

				const text =
					typeof compiled.content === 'string'
						? compiled.content
						: JSON.stringify(compiled.content);
				return formatCompileResult(text, documentsToCompile.length, format);
			} catch (error) {
				logger.error('Intelligent compilation failed', {
					error: (error as Error).message,
				});
				return {
					content: [
						{
							type: 'text',
							text: 'Intelligent compilation failed; details are in the server logs. Try standard mode or check document content.',
						},
					],
				};
			}
		}

		// Standard mode: join documents, with a plain-concatenation fallback.
		try {
			const aiCompiler = new AICompilationService();
			await aiCompiler.initialize();

			const compiled = await aiCompiler.compileWithAI(documentsToCompile, {
				outputFormat: format,
				targetOptimization: 'general',
				includeSynopsis,
				includeNotes,
				hierarchical,
				intelligentFormatting: true,
				enhanceContent: true,
			});

			const text =
				typeof compiled.content === 'string'
					? compiled.content
					: JSON.stringify(compiled.content);
			return formatCompileResult(text, documentsToCompile.length, format);
		} catch {
			const separator = getOptionalStringArg(args, 'separator') || '\n\n---\n\n';
			const documentIds = documentsToCompile.map((doc) => doc.id);
			const compiled = await project.compileDocuments(documentIds, separator, format);

			const text = typeof compiled === 'string' ? compiled : JSON.stringify(compiled);
			return formatCompileResult(text, documentsToCompile.length, format);
		}
	},
};

export const exportProjectHandler: ToolDefinition = {
	name: 'export_project',
	title: 'Export Project To File',
	description:
		'Export the whole project to a publishing/interchange format. Markdown, HTML, and JSON ' +
		'are returned inline; DOCX (agent/editor submission), EPUB (e-readers), and PDF (print/' +
		'review) are written to a file on disk and the path is returned. Use this to produce a ' +
		'deliverable file; use compile_documents when you want the compiled text back in the ' +
		'response rather than written to disk. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			format: {
				type: 'string',
				enum: ['markdown', 'html', 'json', 'docx', 'epub', 'pdf'],
				description:
					'Target file format. Text formats (markdown, html, json) return their content ' +
					'inline; binary formats (docx, epub, pdf) are written to a file and return its path.',
			},
			outputPath: {
				type: 'string',
				description:
					'Absolute or project-relative path to write the exported file. Omit to use a ' +
					'default location (the working directory, named after the project title). ' +
					'Required in effect only if you want a specific location for docx/epub/pdf.',
			},
			options: {
				type: 'object',
				description: 'Optional format-specific export options (e.g. metadata, styling).',
			},
		},
		required: ['format'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			format: {
				type: 'string',
				description:
					'Format the project was exported to (markdown, html, json, docx, epub, or pdf).',
			},
			content: {
				type: 'string',
				description: 'The exported document content (text formats only).',
			},
			path: {
				type: 'string',
				description: 'Path of the written file (binary formats: docx, epub, pdf).',
			},
			bytes: {
				type: 'number',
				description: 'Size of the written file in bytes (binary formats only).',
			},
			metadata: {
				type: 'object',
				description:
					'Export metadata: exportDate, format, and documentCount (number of documents exported).',
			},
		},
		required: ['format', 'metadata'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, exportSchema);

		// Export project
		const format = getStringArg(args, 'format');
		const outputPath = getOptionalStringArg(args, 'outputPath');
		const options = getOptionalObjectArg(args, 'options') as Partial<ExportOptions> | undefined;

		const result = (await project.exportProject(
			format,
			outputPath,
			options as Partial<ExportOptions> | undefined
		)) as {
			format: string;
			content?: string;
			path?: string;
			bytes?: number;
			metadata: Record<string, unknown>;
		};

		return {
			content: [
				{
					type: 'text',
					text: compact(result),
				},
			],
			structuredContent: {
				format: result.format,
				...(result.content !== undefined ? { content: result.content } : {}),
				...(result.path !== undefined ? { path: result.path } : {}),
				...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
				metadata: result.metadata,
			},
		};
	},
};

export const getStatisticsHandler: ToolDefinition = {
	name: 'get_statistics',
	title: 'Get Project Statistics',
	description:
		'Return project-wide statistics: total word and document counts, plus title and author. Use ' +
		'this for a quick project overview; use get_structure for the per-document breakdown or ' +
		'get_document_info for a single document. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			detailed: {
				type: 'boolean',
				description:
					'Include extended per-category statistics when available. Default false.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			totalDocuments: {
				type: 'number',
				description: 'Total number of items in the project.',
			},
			totalFolders: { type: 'number', description: 'Number of folder items.' },
			totalWords: { type: 'number', description: 'Total word count across all documents.' },
			totalCharacters: {
				type: 'number',
				description: 'Total character count across all documents.',
			},
			draftDocuments: { type: 'number', description: 'Number of documents in the Draft.' },
			researchDocuments: {
				type: 'number',
				description: 'Number of documents in Research.',
			},
			trashedDocuments: { type: 'number', description: 'Number of trashed documents.' },
			metadata: { type: 'object', description: 'Project metadata.' },
			documentsByType: {
				type: 'object',
				description: 'Count of documents keyed by type.',
			},
			documentsByStatus: {
				type: 'object',
				description: 'Count of documents keyed by status.',
			},
			documentsByLabel: {
				type: 'object',
				description: 'Count of documents keyed by label.',
			},
			averageDocumentLength: {
				type: 'number',
				description: 'Average word count per text document.',
			},
			longestDocument: {
				type: ['object', 'null'],
				description: 'The longest document, or null if none.',
			},
			shortestDocument: {
				type: ['object', 'null'],
				description: 'The shortest document, or null if none.',
			},
			recentlyModified: {
				type: 'array',
				description: 'Recently modified documents.',
			},
			title: { type: 'string', description: 'Project title (defaults to "Untitled").' },
			author: { type: 'string', description: 'Project author, if set.' },
			lastModified: {
				type: 'string',
				description: 'ISO timestamp of when these statistics were generated.',
			},
		},
		required: [
			'totalDocuments',
			'totalFolders',
			'totalWords',
			'totalCharacters',
			'draftDocuments',
			'researchDocuments',
			'trashedDocuments',
			'metadata',
			'documentsByType',
			'documentsByStatus',
			'documentsByLabel',
			'averageDocumentLength',
			'recentlyModified',
			'title',
			'lastModified',
		],
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
					text: compact(fullStats),
				},
			],
			structuredContent: { ...fullStats },
		};
	},
};

export const generateMarketingMaterialsHandler: ToolDefinition = {
	name: 'generate_marketing_materials',
	title: 'Generate Marketing Materials',
	description:
		'Generate a publishing/marketing artifact from the manuscript — a synopsis, query letter, ' +
		'pitch packet, elevator pitch, or book blurb — using the project content as context, and ' +
		'return the generated text. Use this for submission and pitching materials; use ' +
		'compile_documents to assemble the manuscript itself. Requires an open project with text ' +
		'content. Each call regenerates fresh output (not idempotent).',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			materialType: {
				type: 'string',
				enum: ['synopsis', 'query_letter', 'pitch_packet', 'elevator_pitch', 'book_blurb'],
				description: 'Which marketing artifact to generate.',
			},
			length: {
				type: 'string',
				enum: ['short', 'medium', 'long'],
				description:
					'Target length: short (~500 words), medium (~1000, default), or long (~2000).',
			},
			targetAudience: {
				type: 'string',
				description:
					'Optional description of the intended audience or market (e.g. "YA fantasy readers").',
			},
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

			// Initialize AI compilation service
			const aiCompiler = new AICompilationService();
			await aiCompiler.initialize();

			// Generate marketing materials
			const preferenceDirective = await getPersonalization(context).buildDirective();
			const result = await aiCompiler.generateMarketingMaterials(textDocuments, {
				materialType,
				length,
				targetAudience,
				includeGenreAnalysis: true,
				preferenceDirective,
			});

			return {
				content: [
					{
						type: 'text',
						text: result.content,
					},
				],
			};
		} catch (error) {
			logger.error('Marketing material generation failed', {
				error: (error as Error).message,
			});
			return {
				content: [
					{
						type: 'text',
						text: 'Marketing material generation failed; details are in the server logs.',
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
		properties: {},
	},
	handler: async (_args, context): Promise<HandlerResult> => {
		const project = requireProject(context);

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
			const { HMSVectorStore } = await import('../services/ai/hms-vector-store.js');

			const docs = vectorDocuments.map((doc) => ({
				pageContent: doc.content,
				metadata: { id: doc.id, ...doc.metadata },
			}));

			// The HMS store persists to its shared on-disk index, which semantic_search
			// queries; the returned instance is intentionally not retained here.
			await HMSVectorStore.fromDocuments(docs);

			return {
				content: [
					{
						type: 'text',
						text: compact({
							vectorIndexed: true,
							documentsIndexed: vectorDocuments.length,
							status: 'indexed',
						}),
					},
				],
			};
		} catch (error) {
			logger.error('Vector store build failed', { error: (error as Error).message });
			return {
				content: [
					{
						type: 'text',
						text: 'Vector store build failed. Ensure documents have content; details are in the server logs.',
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
	generateMarketingMaterialsHandler,
	buildVectorStoreHandler,
];
