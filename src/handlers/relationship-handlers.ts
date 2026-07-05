/**
 * Relationship Engine MCP Handlers
 * Tools for entity relationships, character networks, and story graph operations.
 */

import { compact, formatError } from '../core/response-formatter.js';
import type { RelationshipEngine } from '../services/relationship-engine.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from './types.js';
import { getStringArg, getOptionalStringArg, getOptionalNumberArg, getArrayArg } from './types.js';

const ENTITY_TYPES: string[] = ['Character', 'Document', 'Theme', 'PlotThread'];

function requireRelationshipEngine(context: HandlerContext): RelationshipEngine {
	const engine = context.databaseService?.getRelationshipEngine();
	if (!engine) {
		throw new Error(
			'Relationship engine not available. Ensure database service and HMS are initialized.'
		);
	}
	return engine;
}

function ok(data: unknown): HandlerResult {
	return { content: [{ type: 'text', text: compact(data) }] };
}

function fail(error: unknown, op: string): HandlerResult {
	return { content: [{ type: 'text', text: formatError(error, op) }] };
}

export const relationshipHandlers: ToolDefinition[] = [
	{
		name: 'add_relationship',
		title: 'Add Relationship',
		description:
			'Record a typed, directed relationship between two story entities (e.g. a character ' +
			'"mentors" another, or a character "appears in" a document) in the project story graph. ' +
			'Returns the stored edge with its generated id. Use this to build the knowledge graph that ' +
			'find_relationships, character_network, and discover_connections then query. Requires an ' +
			'open project with the relationship engine initialized.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			type: 'object',
			properties: {
				head: {
					type: 'string',
					description: 'Name of the source entity, e.g. a character name like "Elena".',
				},
				headType: {
					type: 'string',
					enum: ENTITY_TYPES,
					description: 'Type of the source entity.',
				},
				relation: {
					type: 'string',
					description:
						'The relationship verb/label from head to tail, e.g. "mentors", "appears_in".',
				},
				tail: {
					type: 'string',
					description: 'Name of the target entity the relationship points to.',
				},
				tailType: {
					type: 'string',
					enum: ENTITY_TYPES,
					description: 'Type of the target entity.',
				},
			},
			required: ['head', 'headType', 'relation', 'tail', 'tailType'],
		},
		handler: async (args, context): Promise<HandlerResult> => {
			try {
				const engine = requireRelationshipEngine(context);
				const head = getStringArg(args, 'head');
				const headType = getStringArg(args, 'headType');
				const relation = getStringArg(args, 'relation');
				const tail = getStringArg(args, 'tail');
				const tailType = getStringArg(args, 'tailType');

				const id = await engine.addRelationship({
					id: '',
					head,
					headType,
					relation,
					tail,
					tailType,
				});

				return ok({ stored: true, id, head, relation, tail });
			} catch (error) {
				return fail(error, 'add_relationship');
			}
		},
	},
	{
		name: 'find_relationships',
		title: 'Find Relationships',
		description:
			'Query the story graph for entities related to a given entity, returning the connected ' +
			'entities and the relationship types that link them. This covers cross-references and ' +
			'discovered connections for a specific entity; use character_network for the whole-cast ' +
			'graph, or discover_connections to surface co-occurring entities project-wide. Requires an ' +
			'open project with the relationship engine initialized.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			type: 'object',
			properties: {
				entity: {
					type: 'string',
					description:
						'Name of the entity to find relationships for, e.g. a character name.',
				},
				relation: {
					type: 'string',
					description:
						'Optional relationship type to filter by (e.g. "mentors"). Omit to return all ' +
						'relationship types.',
				},
				k: {
					type: 'number',
					description:
						'Maximum number of related entities to return. Omit for the engine default.',
				},
			},
			required: ['entity'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				relationships: {
					type: 'array',
					description:
						'Stored relationships in which the queried entity is the head or tail.',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Deterministic relationship id.' },
							head: { type: 'string', description: 'Source entity name.' },
							headType: { type: 'string', description: 'Type of the source entity.' },
							relation: {
								type: 'string',
								description: 'Relationship label from head to tail.',
							},
							tail: { type: 'string', description: 'Target entity name.' },
							tailType: { type: 'string', description: 'Type of the target entity.' },
							properties: {
								type: 'object',
								description: 'Optional edge properties, when present.',
							},
						},
						required: ['id', 'head', 'headType', 'relation', 'tail', 'tailType'],
					},
				},
			},
			required: ['relationships'],
		},
		handler: async (args, context): Promise<HandlerResult> => {
			try {
				const engine = requireRelationshipEngine(context);
				const entity = getStringArg(args, 'entity');
				const relation = getOptionalStringArg(args, 'relation');
				const k = getOptionalNumberArg(args, 'k');

				const results = await engine.findRelated(entity, relation, k);
				return {
					content: [{ type: 'text', text: compact(results) }],
					structuredContent: { relationships: results },
				};
			} catch (error) {
				return fail(error, 'find_relationships');
			}
		},
	},
	{
		name: 'store_chapter_order',
		description: 'Store chapter sequence',
		inputSchema: {
			type: 'object',
			properties: {
				sequenceId: { type: 'string' },
				chapters: { type: 'array', items: { type: 'string' } },
			},
			required: ['sequenceId', 'chapters'],
		},
		handler: async (args, context): Promise<HandlerResult> => {
			try {
				const engine = requireRelationshipEngine(context);
				const sequenceId = getStringArg(args, 'sequenceId');
				const chapters = getArrayArg<string>(args, 'chapters');

				await engine.storeSequence(sequenceId, chapters);
				return ok({ stored: true, sequenceId, count: chapters.length });
			} catch (error) {
				return fail(error, 'store_chapter_order');
			}
		},
	},
	{
		name: 'character_network',
		title: 'Character Network',
		description:
			'Return the full character relationship network for the project: every character and the ' +
			'typed relationships connecting them, suitable for rendering a graph or analyzing the cast ' +
			"structure. Use find_relationships instead when you only need one entity's connections. " +
			'Requires an open project with the relationship engine initialized. Takes no parameters.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			type: 'object',
			properties: {},
		},
		outputSchema: {
			type: 'object',
			properties: {
				network: {
					type: 'object',
					description:
						"Map keyed by source character name; each value is that character's outgoing edges.",
					additionalProperties: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								target: {
									type: 'string',
									description: 'Name of the connected character.',
								},
								relation: {
									type: 'string',
									description:
										'Relationship label from the source to the target.',
								},
								properties: {
									type: 'object',
									description:
										'Optional edge properties (present via the Neo4j backend).',
								},
							},
							required: ['target', 'relation'],
						},
					},
				},
			},
			required: ['network'],
		},
		handler: async (_args, context): Promise<HandlerResult> => {
			try {
				const engine = requireRelationshipEngine(context);
				const network = await engine.getCharacterNetwork();
				return {
					content: [{ type: 'text', text: compact(network) }],
					structuredContent: { network },
				};
			} catch (error) {
				return fail(error, 'character_network');
			}
		},
	},
	{
		name: 'discover_connections',
		title: 'Discover Connections',
		description:
			'Surface previously unrecorded relationships across the project by analyzing entity ' +
			'co-occurrence, returning candidate connections the story graph does not yet contain. Use ' +
			'this to find latent links to confirm with add_relationship; use find_relationships for ' +
			'known connections of a specific entity. Requires an open project with the relationship ' +
			'engine initialized.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			type: 'object',
			properties: {
				k: {
					type: 'number',
					description:
						'Maximum number of candidate connections to return. Omit for the engine default.',
				},
			},
		},
		outputSchema: {
			type: 'object',
			properties: {
				connections: {
					type: 'array',
					description:
						'Candidate connections inferred from entity co-occurrence, not yet in the graph.',
					items: {
						type: 'object',
						properties: {
							entity1: {
								type: 'string',
								description:
									'Name of the first entity in the candidate connection.',
							},
							entity2: {
								type: 'string',
								description:
									'Name of the second entity in the candidate connection.',
							},
							strength: {
								type: 'number',
								description: 'Similarity score for the candidate connection (0-1).',
							},
						},
						required: ['entity1', 'entity2', 'strength'],
					},
				},
			},
			required: ['connections'],
		},
		handler: async (args, context): Promise<HandlerResult> => {
			try {
				const engine = requireRelationshipEngine(context);
				const k = getOptionalNumberArg(args, 'k');

				const discoveries = await engine.discoverRelationships(k);
				return {
					content: [{ type: 'text', text: compact(discoveries) }],
					structuredContent: { connections: discoveries },
				};
			} catch (error) {
				return fail(error, 'discover_connections');
			}
		},
	},
	{
		name: 'sync_to_neo4j',
		description: 'Sync relationships to Neo4j',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		handler: async (_args, context): Promise<HandlerResult> => {
			try {
				const engine = requireRelationshipEngine(context);
				const result = await engine.syncToNeo4j();
				return ok(result);
			} catch (error) {
				return fail(error, 'sync_to_neo4j');
			}
		},
	},
];
