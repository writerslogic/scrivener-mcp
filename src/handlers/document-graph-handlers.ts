/**
 * Document cross-reference graph handlers (issue #27). These tools compute how
 * documents reference the project's registered entities (characters, locations)
 * directly from the SQLite registry and document text — deterministically, with
 * no Neo4j or AI dependency — so they work for every user. Neo4j persistence and
 * AI-assisted implicit-reference detection are deferred follow-ups.
 */

import { compact } from '../core/response-formatter.js';
import {
	buildReferenceIndex,
	referencesForDocument,
	documentsReferencing,
	orphanedEntities,
	suggestConnections,
	type RegistryEntity,
	type DocumentText,
} from '../services/document-references.js';
import type { ScrivenerProject } from '../scrivener-project.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from './types.js';
import { requireProject, getStringArg } from './types.js';

/**
 * Read the project's character and location registries from SQLite. Returns []
 * (rather than throwing) when the database or a table is unavailable, so the
 * graph tools degrade to "no known entities" instead of failing.
 */
function loadRegistryEntities(context: HandlerContext): RegistryEntity[] {
	const service = context.databaseService;
	if (!service) return [];

	const entities: RegistryEntity[] = [];
	let database: ReturnType<ReturnType<typeof service.getSQLite>['getDatabase']>;
	try {
		database = service.getSQLite().getDatabase();
	} catch {
		return [];
	}
	const sources: Array<{ table: string; type: 'character' | 'location' }> = [
		{ table: 'characters', type: 'character' },
		{ table: 'locations', type: 'location' },
	];
	for (const { table, type } of sources) {
		try {
			const rows = database.prepare(`SELECT id, name FROM ${table}`).all() as Array<{
				id?: string;
				name?: string;
			}>;
			for (const row of rows) {
				if (row.id && row.name) entities.push({ id: row.id, name: row.name, type });
			}
		} catch {
			// Table absent (migrations not run) — skip this source.
		}
	}
	return entities;
}

/** Load documents with text as the reference detector expects them. */
async function loadDocuments(project: ScrivenerProject): Promise<DocumentText[]> {
	const docs = await project.getAllDocuments();
	return docs.map((doc) => ({
		id: doc.id,
		title: doc.title || 'Untitled',
		content: doc.content || '',
	}));
}

export const getDocumentReferencesHandler: ToolDefinition = {
	name: 'get_document_references',
	title: 'Get Document References',
	description:
		'List the registered characters and locations that a given document mentions, with how many ' +
		'times each appears and where. Uses exact whole-word, case-insensitive matching against the ' +
		"project's character and location registries — no AI. Use this to see a scene's cast and " +
		'settings at a glance. Returns empty when the document mentions no known entities or the ' +
		'registries are empty. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document to inspect (from get_structure).',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'The inspected document id.' },
			mentions: {
				type: 'array',
				description: 'Registered entities this document references.',
				items: {
					type: 'object',
					properties: {
						entityId: { type: 'string', description: 'Registry id of the entity.' },
						entityName: { type: 'string', description: 'Entity name as registered.' },
						type: {
							type: 'string',
							description: 'Entity kind: "character" or "location".',
						},
						count: { type: 'number', description: 'Number of occurrences.' },
						positions: {
							type: 'array',
							description: 'Character offsets of matches (capped at 100).',
							items: { type: 'number', description: 'Offset of one match.' },
						},
					},
				},
			},
		},
		required: ['documentId', 'mentions'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const entities = loadRegistryEntities(context);
		const index = buildReferenceIndex(await loadDocuments(project), entities);
		const mentions = referencesForDocument(index, documentId);
		const result = { documentId, mentions };
		return {
			content: [{ type: 'text', text: compact(result) }],
			structuredContent: result as unknown as Record<string, unknown>,
		};
	},
};

export const getReferencingDocumentsHandler: ToolDefinition = {
	name: 'get_referencing_documents',
	title: 'Get Referencing Documents',
	description:
		'Find every document that mentions a given character or location, ranked by mention count. ' +
		'Accepts the entity by exact registry id or by name (case-insensitive). Use this to trace ' +
		"an entity's footprint across the manuscript. Returns empty when nothing references it or " +
		'the entity is unknown. Requires an open project.',
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
				description: 'Registry id or name of the character/location, e.g. "Elena".',
			},
		},
		required: ['entity'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			entity: { type: 'string', description: 'The queried id or name.' },
			documents: {
				type: 'array',
				description: 'Documents referencing the entity, most mentions first.',
				items: {
					type: 'object',
					properties: {
						documentId: { type: 'string', description: 'Referencing document id.' },
						title: { type: 'string', description: 'Document title.' },
						count: { type: 'number', description: 'Mentions in that document.' },
					},
				},
			},
		},
		required: ['entity', 'documents'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const entity = getStringArg(args, 'entity');
		const entities = loadRegistryEntities(context);
		const index = buildReferenceIndex(await loadDocuments(project), entities);
		const documents = documentsReferencing(index, entity);
		const result = { entity, documents };
		return {
			content: [{ type: 'text', text: compact(result) }],
			structuredContent: result as unknown as Record<string, unknown>,
		};
	},
};

export const findOrphanedEntitiesHandler: ToolDefinition = {
	name: 'find_orphaned_entities',
	title: 'Find Orphaned Entities',
	description:
		'List registered characters and locations that no document actually mentions — entities added ' +
		'to the registry but with no textual presence, which are candidates for removal or for prose ' +
		'that still needs writing. Uses exact whole-word matching, no AI. Requires an open project.',
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
	outputSchema: {
		type: 'object',
		properties: {
			orphans: {
				type: 'array',
				description: 'Registered entities with zero mentions across all documents.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Registry id of the entity.' },
						name: { type: 'string', description: 'Entity name.' },
						type: {
							type: 'string',
							description: 'Entity kind: "character" or "location".',
						},
					},
				},
			},
			registrySize: {
				type: 'number',
				description: 'Total number of registered entities considered.',
			},
		},
		required: ['orphans', 'registrySize'],
	},
	handler: async (_args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const entities = loadRegistryEntities(context);
		const index = buildReferenceIndex(await loadDocuments(project), entities);
		const orphans = orphanedEntities(index, entities).map((e) => ({
			id: e.id,
			name: e.name,
			type: e.type,
		}));
		const result = { orphans, registrySize: entities.length };
		return {
			content: [{ type: 'text', text: compact(result) }],
			structuredContent: result as unknown as Record<string, unknown>,
		};
	},
};

export const suggestConnectionsHandler: ToolDefinition = {
	name: 'suggest_connections',
	title: 'Suggest Missing Connections',
	description:
		'Suggest characters or locations a document might be missing: entities it does not mention ' +
		'but that frequently co-occur — in other documents — with the entities it does mention. ' +
		'Deterministic co-occurrence inference (no AI), ranked by how many of the document’s ' +
		'entities each suggestion travels with. Use this to spot a scene that omits a character who ' +
		'usually appears with its cast. Returns empty when the document has no known entities. ' +
		'Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document to suggest connections for.',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'The document suggestions are for.' },
			suggestions: {
				type: 'array',
				description: 'Candidate entities to consider adding, strongest first.',
				items: {
					type: 'object',
					properties: {
						entityId: { type: 'string', description: 'Registry id of the suggestion.' },
						entityName: { type: 'string', description: 'Suggested entity name.' },
						type: {
							type: 'string',
							description: 'Entity kind: "character" or "location".',
						},
						coOccurrences: {
							type: 'number',
							description: "How many of the document's entities it co-occurs with.",
						},
						relatedTo: {
							type: 'array',
							description: "The document's entities it usually appears alongside.",
							items: { type: 'string', description: 'A related entity name.' },
						},
					},
				},
			},
		},
		required: ['documentId', 'suggestions'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const entities = loadRegistryEntities(context);
		const index = buildReferenceIndex(await loadDocuments(project), entities);
		const suggestions = suggestConnections(index, documentId);
		const result = { documentId, suggestions };
		return {
			content: [{ type: 'text', text: compact(result) }],
			structuredContent: result as unknown as Record<string, unknown>,
		};
	},
};

export const documentGraphHandlers: ToolDefinition[] = [
	getDocumentReferencesHandler,
	getReferencingDocumentsHandler,
	findOrphanedEntitiesHandler,
	suggestConnectionsHandler,
];
