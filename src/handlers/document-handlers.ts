import { validateInput } from '../utils/common.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalBooleanArg,
	getOptionalNumberArg,
	getOptionalStringArg,
	getStringArg,
	requireProject,
} from './types.js';
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

		const documentId = getStringArg(args, 'documentId');
		const info = await project.getDocumentInfo(documentId);
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

		const documentId = getStringArg(args, 'documentId');
		const content = await project.readDocument(documentId);
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

		const documentId = getStringArg(args, 'documentId');
		const content = getStringArg(args, 'content');
		await project.writeDocument(documentId, content);
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

		const title = getStringArg(args, 'title');
		const content = getOptionalStringArg(args, 'content') || '';
		const parentId = getOptionalStringArg(args, 'parentId');
		const documentType = (getOptionalStringArg(args, 'documentType') || 'Text') as
			| 'Text'
			| 'Folder';

		const id = await project.createDocument(title, content, parentId, documentType);

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

		const documentId = getStringArg(args, 'documentId');
		await project.deleteDocument(documentId);
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

		const documentId = getStringArg(args, 'documentId');
		const newTitle = getStringArg(args, 'newTitle');
		await project.renameDocument(documentId, newTitle);
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

		const documentId = getStringArg(args, 'documentId');
		const targetFolderId = getStringArg(args, 'targetFolderId');
		const position = getOptionalNumberArg(args, 'position');
		await project.moveDocument(documentId, targetFolderId, position);
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

		const documentId = getStringArg(args, 'documentId');
		const synopsis = getOptionalStringArg(args, 'synopsis');
		const notes = getOptionalStringArg(args, 'notes');
		const label = getOptionalStringArg(args, 'label');
		const status = getOptionalStringArg(args, 'status');

		await project.updateDocumentMetadata(documentId, {
			synopsis,
			notes,
			label,
			status,
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

		const documentId = getOptionalStringArg(args, 'documentId');
		const includeChildren = getOptionalBooleanArg(args, 'includeChildren') ?? false;

		let count = 0;

		if (documentId) {
			// Get word count for the specific document
			const docCount = await project.getWordCount(documentId);
			count = docCount.words;

			// If includeChildren is true, also count all child documents
			if (includeChildren) {
				const allDocs = await project.getAllDocuments();
				// Find all documents that are children of this document
				for (const doc of allDocs) {
					// Check if this document is a child by checking if its path starts with the parent's ID
					if (doc.path && doc.path.includes(documentId) && doc.id !== documentId) {
						const childCount = await project.getWordCount(doc.id);
						count += childCount.words;
					}
				}
			}
		} else {
			// No documentId provided, count all documents
			count = await project.getTotalWordCount();
		}

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

		const documentId = getStringArg(args, 'documentId');
		const formatted = await project.readDocumentFormatted(documentId);
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
