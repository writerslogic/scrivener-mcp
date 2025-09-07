import { validateInput } from '../utils/common.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import { requireProject } from './types.js';
import { compileSchema, exportSchema } from './validation-schemas.js';

export const compileDocumentsHandler: ToolDefinition = {
	name: 'compile_documents',
	description: 'Compile documents in reading order',
	inputSchema: {
		type: 'object',
		properties: {
			format: {
				type: 'string',
				enum: ['text', 'markdown', 'html'],
				description: 'Output format',
			},
			rootFolderId: {
				type: 'string',
				description: 'Root folder to compile from',
			},
			includeSynopsis: {
				type: 'boolean',
				description: 'Include document synopsis',
			},
			includeNotes: {
				type: 'boolean',
				description: 'Include document notes',
			},
			separator: {
				type: 'string',
				description: 'Separator between documents',
			},
			hierarchical: {
				type: 'boolean',
				description: 'Maintain folder hierarchy in output',
			},
		},
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, compileSchema);

		// Get documents to compile
		const documents = await project.getAllDocuments();
		let documentIds: string[];

		if (args.rootFolderId) {
			// Filter documents under the specified folder
			documentIds = documents
				.filter((doc) => doc.path && doc.path.startsWith(args.rootFolderId!))
				.map((doc) => doc.id);
		} else {
			// Use all text documents
			documentIds = documents.filter((doc) => doc.type === 'Text').map((doc) => doc.id);
		}

		const compiled = await project.compileDocuments(
			documentIds,
			args.separator || '\n\n---\n\n',
			(args.format as any) || 'text'
		);

		return {
			content: [
				{
					type: 'text',
					text: typeof compiled === 'string' ? compiled : JSON.stringify(compiled),
				},
			],
		};
	},
};

export const exportProjectHandler: ToolDefinition = {
	name: 'export_project',
	description: 'Export project in various formats',
	inputSchema: {
		type: 'object',
		properties: {
			format: {
				type: 'string',
				enum: ['markdown', 'html', 'json', 'epub'],
				description: 'Export format',
			},
			outputPath: {
				type: 'string',
				description: 'Output file path',
			},
			options: {
				type: 'object',
				description: 'Format-specific options',
			},
		},
		required: ['format'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, exportSchema);

		// Export project
		const result = await project.exportProject(
			args.format as any,
			args.outputPath,
			args.options
		);

		return {
			content: [
				{
					type: 'text',
					text: `Project exported as ${args.format}`,
					data: result,
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
			detailed: {
				type: 'boolean',
				description: 'Include detailed breakdown',
			},
		},
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);

		// Get project statistics
		const stats = await project.getStatistics();
		const metadata = await project.getProjectMetadata();

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
					text: 'Project statistics generated',
					data: fullStats,
				},
			],
		};
	},
};

export const compilationHandlers = [
	compileDocumentsHandler,
	exportProjectHandler,
	getStatisticsHandler,
];
