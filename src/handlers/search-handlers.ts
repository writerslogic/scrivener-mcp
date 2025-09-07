import { validateInput } from '../utils/common.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import { requireProject } from './types.js';
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

		const results = await project.searchContent(args.query, {
			caseSensitive: args.caseSensitive || false,
			regex: args.regex || false,
			searchMetadata: args.searchIn?.includes('synopsis') || args.searchIn?.includes('notes'),
		});

		return {
			content: [
				{
					type: 'text',
					text: `Found ${results.length} matches`,
					data: results,
				},
			],
		};
	},
};

export const listTrashHandler: ToolDefinition = {
	name: 'list_trash',
	description: 'List all documents in trash',
	inputSchema: {
		type: 'object',
		properties: {},
	},
	handler: async (args, context): Promise<HandlerResult> => {
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

		const results = await project.searchTrash(args.query, args.searchType || 'both');

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

		await project.recoverFromTrash(args.documentId, args.targetFolderId);

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

		const annotations = await project.getDocumentAnnotations(args.documentId);
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

export const searchHandlers = [
	searchContentHandler,
	listTrashHandler,
	searchTrashHandler,
	recoverDocumentHandler,
	getAnnotationsHandler,
];
