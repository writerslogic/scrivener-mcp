import {
	validateInput,
	isValidUUID,
	truncate,
	measureExecution,
	createError,
	ErrorCode,
	handleError,
} from '../utils/common.js';
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
			`Invalid document ID format: "${documentId}". Use get_structure or get_all_documents to find a valid Scrivener UUID.`
		);
	}
}

async function requireExistingDocument(project: ReturnType<typeof requireProject>, documentId: string) {
	const info = await project.getDocumentInfo(documentId);
	if (!info.document) {
		throw createError(
			ErrorCode.DOCUMENT_NOT_FOUND,
			{ documentId },
			`Document "${documentId}" was not found in the open project. Use get_structure or get_all_documents to choose a valid document ID.`
		);
	}
	return info;
}

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
						text: JSON.stringify(info.result, null, 2),
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
	handler: async (args, _context): Promise<HandlerResult> => {
		try {
			const project = requireProject(_context);
			const documentId = getStringArg(args, 'documentId');
			assertValidDocumentId(documentId);
			const docInfo = await requireExistingDocument(project, documentId);

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

			return {
				content: [
					{
						type: 'text',
						text: result.result,
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
		try {
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
		} catch (error) {
			const appError = handleError(error, 'renameDocument');
			throw appError;
		}
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
			customMetadata: {
				type: 'object',
				description: 'Custom metadata key-value pairs',
				additionalProperties: { type: 'string' },
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
		const customMetadata = args.customMetadata as Record<string, string> | undefined;

		await project.updateDocumentMetadata(documentId, {
			synopsis,
			notes,
			label,
			status,
			customMetadata,
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
				const childDocs = allDocs.filter(
					(doc) => doc.path && doc.path.includes(documentId) && doc.id !== documentId
				);

				// Parallelize all child document reads
				const childCounts = await Promise.all(
					childDocs.map(async (doc) => {
						const childCount = await project.getWordCount(doc.id);
						return childCount.words;
					})
				);
				count += childCounts.reduce((sum, words) => sum + words, 0);
			}
		} else {
			// No documentId provided, count all documents
			count = await project.getTotalWordCount();
		}

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({ wordCount: count }),
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
					text: JSON.stringify(formatted, null, 2),
				},
			],
		};
	},
};

export const semanticSearchHandler: ToolDefinition = {
	name: 'semantic_search',
	description: 'Search documents using semantic similarity with HHM',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Text query to search for semantically similar documents',
			},
			k: {
				type: 'number',
				description: 'Number of results to return (default: 10)',
				default: 10,
			},
			threshold: {
				type: 'number',
				description: 'Minimum similarity threshold (0-1, default: 0.3)',
				default: 0.3,
			},
		},
		required: ['query'],
	},
	handler: async (args, _context): Promise<HandlerResult> => {
		try {
			const query = getStringArg(args, 'query');
			const k = getOptionalNumberArg(args, 'k') || 10;
			const threshold = getOptionalNumberArg(args, 'threshold') || 0.3;

			const hhmSystem = getHHMSystem();
			const results = await hhmSystem.queryText(query, k);

			// Filter by threshold
			const filtered = results.filter((r) => r.similarity >= threshold);

			if (filtered.length === 0) {
				return {
					content: [
						{
							type: 'text',
							text: `No documents found with similarity >= ${threshold}`,
						},
					],
				};
			}

			const resultsText = filtered
				.map(
					(result, index) =>
						`${index + 1}. ${result.entry.id} (similarity: ${result.similarity.toFixed(3)})
` + `   ${result.explanation || 'No explanation available'}`
				)
				.join('\n\n');

			return {
				content: [
					{
						type: 'text',
						text: `Found ${filtered.length} semantically similar documents:\n\n${resultsText}`,
					},
				],
			};
		} catch (error) {
			if ((error as Error).message.includes('HHM system not initialized')) {
				return {
					content: [
						{
							type: 'text',
							text: 'Semantic search not available - HHM system not initialized',
						},
					],
				};
			}
			const appError = handleError(error);
			return {
				content: [
					{
						type: 'error',
						text: appError.message,
					},
				],
				isError: true,
			};
		}
	},
};

export const findAnalogiesHandler: ToolDefinition = {
	name: 'find_analogies',
	description: 'Find analogical relationships using HHM (A:B :: C:?)',
	inputSchema: {
		type: 'object',
		properties: {
			a: {
				type: 'string',
				description: 'First term in analogy',
			},
			b: {
				type: 'string',
				description: 'Second term in analogy',
			},
			c: {
				type: 'string',
				description: 'Third term in analogy',
			},
		},
		required: ['a', 'b', 'c'],
	},
	handler: async (args, _context): Promise<HandlerResult> => {
		try {
			const a = getStringArg(args, 'a');
			const b = getStringArg(args, 'b');
			const c = getStringArg(args, 'c');

			const hhmSystem = getHHMSystem();
			const results = await hhmSystem.findAnalogy(a, b, c);

			if (results.length === 0) {
				return {
					content: [
						{
							type: 'text',
							text: `No analogical matches found for ${a}:${b} :: ${c}:?`,
						},
					],
				};
			}

			const analogiesText = results
				.map(
					(result, index) =>
						`${index + 1}. ${a}:${b} :: ${c}:${result.entry.id} (confidence: ${result.similarity.toFixed(3)})`
				)
				.join('\n');

			return {
				content: [
					{
						type: 'text',
						text: `Analogical relationships found:\n\n${analogiesText}`,
					},
				],
			};
		} catch (error) {
			if ((error as Error).message.includes('HHM system not initialized')) {
				return {
					content: [
						{
							type: 'text',
							text: 'Analogical reasoning not available - HHM system not initialized',
						},
					],
				};
			}
			const appError = handleError(error);
			return {
				content: [
					{
						type: 'error',
						text: appError.message,
					},
				],
				isError: true,
			};
		}
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
	semanticSearchHandler,
	findAnalogiesHandler,
];
