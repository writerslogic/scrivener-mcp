import {
	validateInput,
	isValidUUID,
	truncate,
	measureExecution,
	createError,
	ErrorCode,
	handleError,
} from '../utils/common.js';
import { compact } from '../core/response-formatter.js';
import { getHHMSystem } from './memory-handlers.js';
import { getLogger } from '../core/logger.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalBooleanArg,
	getOptionalNumberArg,
	getOptionalStringArg,
	getStringArg,
	requireProject,
} from './types.js';
import { SHARED_DEFS } from './shared-schemas.js';
import {
	documentContentSchema,
	documentIdSchema,
	documentMoveSchema,
	documentTitleSchema,
} from './validation-schemas.js';

function assertValidDocumentId(documentId: string): void {
	if (!isValidUUID(documentId)) {
		throw createError(
			ErrorCode.INVALID_INPUT,
			{ documentId },
			`Invalid document ID format: "${documentId}". Use get_structure to find a valid Scrivener UUID.`
		);
	}
}

async function requireExistingDocument(
	project: ReturnType<typeof requireProject>,
	documentId: string
) {
	const info = await project.getDocumentInfo(documentId);
	if (!info.document) {
		throw createError(
			ErrorCode.DOCUMENT_NOT_FOUND,
			{ documentId },
			`Document "${documentId}" was not found in the open project. Use get_structure to choose a valid document ID.`
		);
	}
	return info;
}

export const getDocumentInfoHandler: ToolDefinition = {
	name: 'get_document_info',
	title: 'Get Document Info',
	description:
		'Return metadata for a single document without its body text: title, type, word count, ' +
		'synopsis, label, status, parent, and custom metadata. Use this to inspect a document or to ' +
		'read its word count cheaply; call read_document when you need the actual prose, or ' +
		'get_structure for the whole binder. Requires an open project and a valid document id.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
		},
		required: ['documentId'],
	},
	handler: async (args, _context): Promise<HandlerResult> => {
		try {
			const project = requireProject(_context);
			const documentId = getStringArg(args, 'documentId');
			assertValidDocumentId(documentId);
			const info = await measureExecution(() => requireExistingDocument(project, documentId));

			return {
				content: [
					{
						type: 'text',
						text: compact(info.result),
					},
				],
			};
		} catch (error) {
			const appError = handleError(error, 'getDocumentInfo');
			throw appError;
		}
	},
};

export const readDocumentHandler: ToolDefinition = {
	name: 'read_document',
	title: 'Read Document',
	description:
		'Read the text of a single document. By default returns plain text; set format to "formatted" ' +
		'to get rich text with styling and structure preserved. Use offset and limit to page through ' +
		'long documents by word range instead of returning the whole thing. Use get_document_info ' +
		'when you only need metadata, or search/semantic_search to find content across many documents. ' +
		'Requires an open project and a valid document id.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			format: {
				type: 'string',
				enum: ['plain', 'formatted'],
				description:
					'"plain" (default) returns unstyled text and supports offset/limit paging. ' +
					'"formatted" returns rich text with styling and structure preserved (paged ' +
					'reading does not apply).',
			},
			offset: {
				type: 'number',
				description:
					'Zero-based word index to start reading from. Default 0. Plain format only.',
			},
			limit: {
				type: 'number',
				description:
					'Maximum number of words to return from offset. Omit to read to the end.',
			},
		},
		required: ['documentId'],
	},
	handler: async (args, _context): Promise<HandlerResult> => {
		try {
			const project = requireProject(_context);
			const documentId = getStringArg(args, 'documentId');
			const format = getOptionalStringArg(args, 'format') || 'plain';
			const offset = getOptionalNumberArg(args, 'offset') || 0;
			const limit = getOptionalNumberArg(args, 'limit');
			assertValidDocumentId(documentId);
			const docInfo = await requireExistingDocument(project, documentId);

			if (format === 'formatted') {
				const formatted = await project.readDocumentFormatted(documentId);
				return {
					content: [{ type: 'text', text: compact(formatted) }],
				};
			}

			const result = await measureExecution(() => project.readDocument(documentId));

			// Optionally memorize document content in HHM
			try {
				const hhmSystem = getHHMSystem();
				if (docInfo.document && result.result.trim()) {
					await hhmSystem.memorizeDocument({
						id: docInfo.document.id,
						title: docInfo.document.title || 'Untitled',
						path: docInfo.document.path,
						content: result.result,
						type: docInfo.document.type || 'Text',
						wordCount: docInfo.document.wordCount || 0,
						customMetadata: docInfo.document.customMetadata || {},
					});
					getLogger('document-handlers').debug('Document memorized in HHM', {
						documentId,
					});
				}
			} catch (error) {
				// HHM integration is optional - don't fail the main operation
				getLogger('document-handlers').debug('Failed to memorize in HHM', { error });
			}

			let text = result.result;
			const words = text.split(/\s+/);
			const totalWords = words.length;

			if (offset > 0 || limit) {
				const end = limit ? offset + limit : undefined;
				text = words.slice(offset, end).join(' ');
			}

			const meta =
				offset > 0 || limit
					? ` [words ${offset}-${offset + text.split(/\s+/).length}/${totalWords}]`
					: '';

			return {
				content: [
					{
						type: 'text',
						text: text + meta,
					},
				],
			};
		} catch (error) {
			const appError = handleError(error, 'readDocument');
			throw appError;
		}
	},
};

export const writeDocumentHandler: ToolDefinition = {
	name: 'write_document',
	title: 'Write Document',
	description:
		'Replace the entire text of an existing document with new content. This overwrites the body; ' +
		'a backup of the previous version is taken first and the write is atomic. To change only the ' +
		'title or metadata use update_document; to add a new document use create_document. Requires an ' +
		'open project and a valid document id.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			content: SHARED_DEFS.content,
		},
		required: ['documentId', 'content'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		try {
			const project = requireProject(context);
			validateInput(args, documentContentSchema);

			const documentId = getStringArg(args, 'documentId');
			const content = getStringArg(args, 'content');

			// Validate UUID format
			if (!isValidUUID(documentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Invalid document ID format'
				);
			}

			const result = await measureExecution(() => project.writeDocument(documentId, content));

			// Update HHM memory with new content
			try {
				const hhmSystem = getHHMSystem();
				const docInfo = await project.getDocumentInfo(documentId);
				if (docInfo.document && content.trim()) {
					const memoryId = `doc_${docInfo.document.id}`;
					if (content.length > 10_000) {
						await hhmSystem.memorizeTextBuffer(memoryId, Buffer.from(content));
					} else {
						await hhmSystem.memorizeText(content, memoryId);
					}
					getLogger('document-handlers').debug('Document updated in HHM', { documentId });
				}
			} catch (error) {
				// HHM integration is optional - don't fail the main operation
				getLogger('document-handlers').debug('Failed to update HHM memory', { error });
			}

			return {
				content: [
					{
						type: 'text',
						text: 'Document updated successfully',
					},
				],
			};
		} catch (error) {
			const appError = handleError(error, 'writeDocument');
			throw appError;
		}
	},
};

export const createDocumentHandler: ToolDefinition = {
	name: 'create_document',
	title: 'Create Document',
	description:
		'Create a new text document or folder in the binder and return its new id. Optionally set the ' +
		'initial body content and the parent folder; if no parent is given the item is added at the ' +
		'top level. Each call creates a distinct item (not idempotent). Use write_document to change ' +
		'content afterward. Requires an open project.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description: 'Title for the new document or folder. Truncated to 255 characters.',
			},
			content: SHARED_DEFS.content,
			parentId: SHARED_DEFS.folderId,
			documentType: {
				type: 'string',
				enum: ['Text', 'Folder'],
				description: 'Whether to create a "Text" document (default) or a "Folder".',
			},
		},
		required: ['title'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		try {
			const project = requireProject(context);
			validateInput(args, {
				title: { type: 'string' as const, required: true, minLength: 1, maxLength: 255 },
				content: { type: 'string' as const, required: false, maxLength: 10000000 },
				parentId: { type: 'string' as const, required: false },
				documentType: { type: 'string' as const, required: false },
			});

			const title = truncate(getStringArg(args, 'title'), 255);
			const content = getOptionalStringArg(args, 'content') || '';
			const parentId = getOptionalStringArg(args, 'parentId');
			const documentType = (getOptionalStringArg(args, 'documentType') || 'Text') as
				| 'Text'
				| 'Folder';

			// Validate parent ID if provided
			if (parentId && !isValidUUID(parentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ parentId },
					'Invalid parent ID format'
				);
			}

			const result = await measureExecution(() =>
				project.createDocument(title, content, parentId, documentType)
			);

			// Memorize new document in HHM
			try {
				const hhmSystem = getHHMSystem();
				if (content.trim() && documentType === 'Text') {
					await hhmSystem.memorizeDocument({
						id: result.result,
						title,
						content,
						type: documentType as 'Text' | 'Folder' | 'Other',
						path: '/', // Default path
						wordCount: content.split(/\s+/).length,
						customMetadata: {
							created: Date.now().toString(),
							parentId: parentId || '',
						},
					});
					getLogger('document-handlers').debug('New document memorized in HHM', {
						documentId: result.result,
					});
				}
			} catch (error) {
				// HHM integration is optional - don't fail the main operation
				getLogger('document-handlers').debug('Failed to memorize new document in HHM', {
					error,
				});
			}

			return {
				content: [
					{
						type: 'text',
						text: `Document created with ID: ${result.result}`,
					},
				],
			};
		} catch (error) {
			const appError = handleError(error, 'createDocument');
			throw appError;
		}
	},
};

export const deleteDocumentHandler: ToolDefinition = {
	name: 'delete_document',
	title: 'Delete Document',
	description:
		'Move a document to the project trash. This is reversible: the document can be listed with ' +
		'list_trash and brought back with restore_document until the trash is emptied in Scrivener. ' +
		'Deleting an already-trashed document is a no-op. Requires an open project and a valid ' +
		'document id.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		try {
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
		} catch (error) {
			const appError = handleError(error, 'deleteDocument');
			throw appError;
		}
	},
};

export const moveDocumentHandler: ToolDefinition = {
	name: 'move_document',
	title: 'Move Document',
	description:
		'Move a document or folder to a different parent folder in the binder, optionally at a specific ' +
		"position among the target folder's children. Changes only the location, not the content. " +
		'Requires an open project, a valid document id, and a valid target folder id.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			targetFolderId: SHARED_DEFS.folderId,
			position: {
				type: 'number',
				description:
					"Zero-based index at which to insert the item among the target folder's children. " +
					'Omit to append at the end.',
			},
		},
		required: ['documentId', 'targetFolderId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		try {
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
		} catch (error) {
			const appError = handleError(error, 'moveDocument');
			throw appError;
		}
	},
};

export const updateDocumentHandler: ToolDefinition = {
	name: 'update_document',
	title: 'Update Document Title & Metadata',
	description:
		"Update a document's title and/or its metadata (synopsis, notes, label, status, and custom " +
		'fields) in a single call. Pass only the fields you want to change; omitted fields are left ' +
		'untouched. To change the body text use write_document; to move it use move_document. Requires ' +
		'an open project and a valid document id.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			title: {
				type: 'string',
				description: 'New title for the document. Omit to leave the title unchanged.',
			},
			synopsis: {
				type: 'string',
				description: 'Synopsis / index-card text shown in the Scrivener outliner.',
			},
			notes: { type: 'string', description: 'Document notes (the inspector Notes pane).' },
			label: {
				type: 'string',
				description: 'Label name (e.g. a POV character or chapter color label).',
			},
			status: {
				type: 'string',
				description: 'Status name (e.g. "To Do", "First Draft", "Done").',
			},
			customMetadata: {
				type: 'object',
				additionalProperties: { type: 'string' },
				description: 'Map of custom metadata field names to string values.',
			},
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, documentIdSchema);

		const documentId = getStringArg(args, 'documentId');
		const title = getOptionalStringArg(args, 'title');
		const synopsis = getOptionalStringArg(args, 'synopsis');
		const notes = getOptionalStringArg(args, 'notes');
		const label = getOptionalStringArg(args, 'label');
		const status = getOptionalStringArg(args, 'status');
		const customMetadata = args.customMetadata as Record<string, string> | undefined;

		if (title !== undefined) {
			await project.renameDocument(documentId, title);
		}
		if (
			synopsis !== undefined ||
			notes !== undefined ||
			label !== undefined ||
			status !== undefined ||
			customMetadata !== undefined
		) {
			await project.updateDocumentMetadata(documentId, {
				synopsis,
				notes,
				label,
				status,
				customMetadata,
			});
		}

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

export const documentHandlers = [
	getDocumentInfoHandler,
	readDocumentHandler,
	writeDocumentHandler,
	createDocumentHandler,
	deleteDocumentHandler,
	moveDocumentHandler,
	updateDocumentHandler,
];
