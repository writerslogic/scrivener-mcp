import { SemanticDatabaseLayer } from '../handlers/database/semantic-database-layer.js';
import { validateInput } from '../utils/common.js';
import { getLogger } from '../core/logger.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalBooleanArg,
	getOptionalNumberArg,
	getOptionalArrayArg,
	getOptionalStringArg,
	getStringArg,
	requireProject,
} from './types.js';
const logger = getLogger('search-handlers');

// Cached singleton instances to avoid re-instantiation per request
let cachedSemanticLayer: SemanticDatabaseLayer | null = null;
let cachedSemanticLayerDbService: unknown = null;

async function getSemanticLayer(
	databaseService: NonNullable<unknown>
): Promise<SemanticDatabaseLayer> {
	if (!cachedSemanticLayer || cachedSemanticLayerDbService !== databaseService) {
		cachedSemanticLayer = new SemanticDatabaseLayer(
			databaseService as ConstructorParameters<typeof SemanticDatabaseLayer>[0]
		);
		await cachedSemanticLayer.initialize();
		cachedSemanticLayerDbService = databaseService;
	}
	return cachedSemanticLayer;
}

import { compact } from '../core/response-formatter.js';
import { SHARED_DEFS } from './shared-schemas.js';
import {
	documentDetailsSchema,
	moveDocumentSchema,
	searchContentSchema,
} from './validation-schemas.js';

export const searchContentHandler: ToolDefinition = {
	name: 'search',
	title: 'Search Documents',
	description:
		'Search the open project and return matching documents with relevance-ranked snippets. By ' +
		'default performs an intelligent full-text/semantic search of document content; set field to ' +
		'"title" for a fast case-insensitive title lookup, or scope to "trash" to search only trashed ' +
		'documents. For meaning-based "find passages about X" queries use semantic_search; to find ' +
		'every occurrence of a specific name or term use find_mentions. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			query: SHARED_DEFS.query,
			field: {
				type: 'string',
				enum: ['content', 'title'],
				description:
					'"content" (default) searches document body text; "title" matches document titles ' +
					'only (fast, case-insensitive substring).',
			},
			scope: {
				type: 'string',
				enum: ['active', 'trash'],
				description:
					'"active" (default) searches the live binder; "trash" searches only trashed documents.',
			},
			caseSensitive: {
				type: 'boolean',
				description: 'Match case exactly. Default false. Applies to content search.',
			},
			regex: {
				type: 'boolean',
				description:
					'Treat the query as a regular expression. Default false. Content search only.',
			},
			searchIn: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Additional metadata fields to include in content search, e.g. "synopsis", "notes".',
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
		const searchIn = getOptionalArrayArg<string>(args, 'searchIn');
		const field = getOptionalStringArg(args, 'field') || 'content';
		const scope = getOptionalStringArg(args, 'scope') || 'active';

		// Trash scope: search only trashed documents.
		if (scope === 'trash') {
			const trashResults = await project.searchTrash(query, { caseSensitive, regex });
			return {
				content: [
					{
						type: 'text',
						text: `Found ${trashResults.length} matches in trash\n${compact(trashResults)}`,
					},
				],
			};
		}

		// Title field: fast case-insensitive title lookup.
		if (field === 'title') {
			const documents = await project.getAllDocuments();
			const patternLower = query.toLowerCase();
			const matches = documents
				.filter((doc) => doc.title?.toLowerCase().includes(patternLower))
				.slice(0, 20)
				.map((doc) => ({ id: doc.id, title: doc.title, type: doc.type, path: doc.path }));
			return {
				content: [
					{
						type: 'text',
						text: `Found ${matches.length} document(s) with title matching "${query}"\n${JSON.stringify(matches, null, 2)}`,
					},
				],
			};
		}

		try {
			// Use semantic database layer for intelligent search if available
			if (!context.databaseService) {
				throw new Error('Database service not available for semantic search');
			}

			const semanticLayer = await getSemanticLayer(context.databaseService!);

			const semanticResults = await semanticLayer.semanticQuery(query, {
				threshold: 0.3,
				maxResults: 20,
				includeEntities: true,
				includeRelationships: true,
			});

			// Trim results to compact snippets
			const trimmedResults = (semanticResults.documents || []).map(
				(doc: Record<string, unknown>) => ({
					id: doc.id,
					title: doc.title || 'Untitled',
					snippet:
						typeof doc.content === 'string'
							? doc.content.length > 100
								? `${doc.content.slice(0, 100)}...`
								: doc.content
							: typeof doc.text === 'string'
								? doc.text.length > 100
									? `${doc.text.slice(0, 100)}...`
									: doc.text
								: '',
					score: doc.score ?? doc.relevance ?? null,
				})
			);

			return {
				content: [
					{
						type: 'text',
						text: `Found ${trimmedResults.length} semantic matches\n${compact({
							results: trimmedResults,
							searchType: 'semantic',
						})}`,
					},
				],
			};
		} catch (error) {
			logger.warn('Semantic search failed, falling back to basic search', { error });
			const results = await project.searchContent(query, {
				caseSensitive,
				regex,
				includeTrash,
				searchMetadata: searchIn?.includes('synopsis') || searchIn?.includes('notes'),
			});

			// Trim fallback results to compact snippets
			const trimmedResults = results.map((r: Record<string, unknown>) => ({
				id: (r.id as string) || 'unknown',
				title: (r.title as string) || 'Untitled',
				snippet:
					typeof r.content === 'string'
						? r.content.length > 100
							? `${r.content.slice(0, 100)}...`
							: r.content
						: typeof r.text === 'string'
							? r.text.length > 100
								? `${r.text.slice(0, 100)}...`
								: r.text
							: '',
				score: r.score ?? null,
			}));

			return {
				content: [
					{
						type: 'text',
						text: `Found ${trimmedResults.length} matches (basic search)\n${compact({
							results: trimmedResults,
						})}`,
					},
				],
			};
		}
	},
};

export const listTrashHandler: ToolDefinition = {
	name: 'list_trash',
	title: 'List Trash',
	description:
		'List all documents currently in the project trash, with their ids and titles. Use this to ' +
		'see what can be brought back with restore_document, or to confirm a delete_document call. ' +
		'Requires an open project. Takes no parameters.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
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
					text: `${trashItems.length} items in trash\n${compact(trashItems)}`,
				},
			],
		};
	},
};

export const recoverDocumentHandler: ToolDefinition = {
	name: 'restore_document',
	title: 'Restore Document From Trash',
	description:
		'Restore a trashed document back into the binder, optionally into a specific target folder ' +
		'(otherwise it returns to a default location). Use list_trash to find the document id first. ' +
		'This is the inverse of delete_document. Requires an open project and a valid document id.',
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
			targetFolderId: {
				...SHARED_DEFS.folderId,
				description:
					'Optional id of the folder to restore into. Omit to restore to a default location.',
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
	name: 'read_annotations',
	title: 'Read Document Annotations',
	description:
		'Return the inline comments and footnotes attached to a document, grouped by type. Use this ' +
		'to review editorial notes and references without reading the full body; use read_document ' +
		'for the prose itself. Requires an open project and a valid document id.',
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
			includeComments: {
				type: 'boolean',
				description: 'Include inline comments. Default true.',
			},
			includeFootnotes: {
				type: 'boolean',
				description: 'Include footnotes. Default true.',
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
					text: `Found ${formattedAnnotations.comments?.length || 0} comments and ${formattedAnnotations.footnotes?.length || 0} footnotes\n${compact(formattedAnnotations)}`,
				},
			],
		};
	},
};

// Advanced search handlers
export const findMentionsHandler: ToolDefinition = {
	name: 'find_mentions',
	title: 'Find Entity Mentions',
	description:
		'Find every occurrence of a specific name or term (a character, place, or keyword) across all ' +
		'documents, returning each hit with surrounding context and its document. Use this for exact ' +
		'"where does X appear" lookups; use search for relevance-ranked results or semantic_search for ' +
		'meaning-based matches. Returns up to 50 mentions. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			entity: {
				type: 'string',
				description:
					'The exact name or term to locate, e.g. a character name like "Elena".',
			},
			contextLength: {
				type: 'number',
				description:
					'Number of characters of surrounding context to include on each side of a match. ' +
					'Default 100.',
			},
		},
		required: ['entity'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const entity = getStringArg(args, 'entity');
		const contextLength = getOptionalNumberArg(args, 'contextLength') || 100;

		try {
			// Get all documents
			const documents = await project.getAllDocuments();
			const mentions: Array<{
				documentId: string;
				title: string;
				context: string;
				position: number;
			}> = [];

			const entityLower = entity.toLowerCase();
			const maxResults = 50;

			for (const doc of documents) {
				if (mentions.length >= maxResults) break;

				const content = doc.content || '';
				const title = doc.title || 'Untitled';
				const contentLower = content.toLowerCase();

				let position = 0;
				while ((position = contentLower.indexOf(entityLower, position)) !== -1) {
					// Extract context around the mention
					const contextStart = Math.max(0, position - contextLength);
					const contextEnd = Math.min(
						content.length,
						position + entity.length + contextLength
					);
					const contextSnippet = content.slice(contextStart, contextEnd);

					mentions.push({
						documentId: doc.id,
						title,
						context: contextSnippet,
						position,
					});

					if (mentions.length >= maxResults) break;

					position += entity.length;
				}
			}

			const trimmedMentions = mentions.map((m) => ({
				id: m.documentId,
				title: m.title,
				snippet: m.context.length > 100 ? `${m.context.slice(0, 100)}...` : m.context,
				score: null,
			}));

			return {
				content: [
					{
						type: 'text',
						text: `Found ${trimmedMentions.length} mentions of "${entity}"\n${compact({
							results: trimmedMentions,
						})}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Mention search failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const searchHandlers = [
	searchContentHandler,
	listTrashHandler,
	recoverDocumentHandler,
	getAnnotationsHandler,
	findMentionsHandler,
];
