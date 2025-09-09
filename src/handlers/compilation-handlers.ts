import { validateInput } from '../utils/common.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalObjectArg,
	getOptionalStringArg,
	getStringArg,
	requireProject,
} from './types.js';
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

		const rootFolderId = getOptionalStringArg(args, 'rootFolderId');
		if (rootFolderId) {
			// Filter documents under the specified folder
			documentIds = documents
				.filter((doc) => doc.path && doc.path.startsWith(rootFolderId))
				.map((doc) => doc.id);
		} else {
			// Use all text documents
			documentIds = documents.filter((doc) => doc.type === 'Text').map((doc) => doc.id);
		}

		const separator = getOptionalStringArg(args, 'separator') || '\n\n---\n\n';
		const format =
			(getOptionalStringArg(args, 'format') as 'text' | 'markdown' | 'html') || 'text';

		const compiled = await project.compileDocuments(documentIds, separator, format);

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
		const format = getStringArg(args, 'format');
		const outputPath = getOptionalStringArg(args, 'outputPath');
		const options = getOptionalObjectArg(args, 'options');

		const result = await project.exportProject(format, outputPath, options);

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
