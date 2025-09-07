import { validateInput } from '../utils/common.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import { requireProject } from './types.js';
import {
	documentContentSchema,
	documentIdSchema,
	documentMoveSchema,
	documentTitleSchema,
} from './validation-schemas.js';

export const getDocumentInfoHandler: ToolDefinition = {
	name: 'get_document_info',
	description: 'Get detailed information about a document including parent hierarchy',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document',
			},
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentIdSchema);

		const info = await project.getDocumentInfo(args.documentId);
		return {
			content: [
				{
					type: 'text',
					text: `Document info for: ${info.document?.title || 'Unknown'}`,
					data: info,
				},
			],
		};
	},
};

export const readDocumentHandler: ToolDefinition = {
	name: 'read_document',
	description: 'Read the content of a specific document',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document to read',
			},
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentIdSchema);

		const content = await project.readDocument(args.documentId);
		return {
			content: [
				{
					type: 'text',
					text: content,
				},
			],
		};
	},
};

export const writeDocumentHandler: ToolDefinition = {
	name: 'write_document',
	description: 'Write content to a document',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document to write',
			},
			content: {
				type: 'string',
				description: 'Content to write to the document',
			},
		},
		required: ['documentId', 'content'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentContentSchema);

		await project.writeDocument(args.documentId, args.content);
		return {
			content: [
				{
					type: 'text',
					text: 'Document updated successfully',
				},
			],
		};
	},
};

export const createDocumentHandler: ToolDefinition = {
	name: 'create_document',
	description: 'Create a new document in the project',
	inputSchema: {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description: 'Title of the new document',
			},
			content: {
				type: 'string',
				description: 'Initial content for the document',
			},
			parentId: {
				type: 'string',
				description: 'Parent folder UUID (optional, defaults to Draft folder)',
			},
			documentType: {
				type: 'string',
				enum: ['Text', 'Folder'],
				description: 'Type of document to create',
			},
		},
		required: ['title'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, {
			title: { type: 'string' as const, required: true, minLength: 1 },
			content: { type: 'string' as const, required: false },
			parentId: { type: 'string' as const, required: false },
			documentType: { type: 'string' as const, required: false },
		});

		const id = await project.createDocument(
			args.title,
			args.content || '',
			args.parentId,
			args.documentType || 'Text'
		);

		return {
			content: [
				{
					type: 'text',
					text: `Document created with ID: ${id}`,
					data: { documentId: id },
				},
			],
		};
	},
};

export const deleteDocumentHandler: ToolDefinition = {
	name: 'delete_document',
	description: 'Delete a document (move to trash)',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document to delete',
			},
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentIdSchema);

		await project.deleteDocument(args.documentId);
		return {
			content: [
				{
					type: 'text',
					text: 'Document moved to trash',
				},
			],
		};
	},
};

export const renameDocumentHandler: ToolDefinition = {
	name: 'rename_document',
	description: 'Rename a document',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document to rename',
			},
			newTitle: {
				type: 'string',
				description: 'New title for the document',
			},
		},
		required: ['documentId', 'newTitle'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentTitleSchema);

		await project.renameDocument(args.documentId, args.newTitle);
		return {
			content: [
				{
					type: 'text',
					text: 'Document renamed successfully',
				},
			],
		};
	},
};

export const moveDocumentHandler: ToolDefinition = {
	name: 'move_document',
	description: 'Move a document to a different folder',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document to move',
			},
			targetFolderId: {
				type: 'string',
				description: 'UUID of the target folder',
			},
			position: {
				type: 'number',
				description: 'Position in the target folder (optional)',
			},
		},
		required: ['documentId', 'targetFolderId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentMoveSchema);

		await project.moveDocument(args.documentId, args.targetFolderId, args.position);
		return {
			content: [
				{
					type: 'text',
					text: 'Document moved successfully',
				},
			],
		};
	},
};

export const updateMetadataHandler: ToolDefinition = {
	name: 'update_metadata',
	description: 'Update document metadata',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document',
			},
			synopsis: {
				type: 'string',
				description: 'Document synopsis',
			},
			notes: {
				type: 'string',
				description: 'Document notes',
			},
			label: {
				type: 'string',
				description: 'Document label',
			},
			status: {
				type: 'string',
				description: 'Document status',
			},
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentIdSchema);

		await project.updateDocumentMetadata(args.documentId, {
			synopsis: args.synopsis,
			notes: args.notes,
			label: args.label,
			status: args.status,
		});

		return {
			content: [
				{
					type: 'text',
					text: 'Metadata updated successfully',
				},
			],
		};
	},
};

export const getWordCountHandler: ToolDefinition = {
	name: 'get_word_count',
	description: 'Get word count for a document or folder',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document or folder',
			},
			includeChildren: {
				type: 'boolean',
				description: 'Include child documents in count',
			},
		},
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);

		const countResult = args.documentId
			? await project.getWordCount(args.documentId)
			: { words: await project.getTotalWordCount(), characters: 0 };
		const count = countResult.words;

		return {
			content: [
				{
					type: 'text',
					text: `Word count: ${count}`,
					data: { wordCount: count },
				},
			],
		};
	},
};

export const readFormattedHandler: ToolDefinition = {
	name: 'read_document_formatted',
	description: 'Read document with formatting preserved',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document',
			},
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentIdSchema);

		const formatted = await project.readDocumentFormatted(args.documentId);
		return {
			content: [
				{
					type: 'text',
					text: formatted.plainText || '',
					data: {
						styles: formatted.formattedText,
						metadata: formatted,
					},
				},
			],
		};
	},
};

export const documentHandlers = [
	getDocumentInfoHandler,
	readDocumentHandler,
	writeDocumentHandler,
	createDocumentHandler,
	deleteDocumentHandler,
	renameDocumentHandler,
	moveDocumentHandler,
	updateMetadataHandler,
	getWordCountHandler,
	readFormattedHandler,
];
