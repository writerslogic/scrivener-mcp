/**
 * Relationship Engine MCP Handlers
 * Tools for entity relationships, character networks, and story graph operations.
 */

import { compact } from '../core/response-formatter.js';
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

export const relationshipHandlers: ToolDefinition[] = [
	{
		name: 'add_relationship',
		description: 'Store entity relationship',
		inputSchema: {
			type: 'object',
			properties: {
				head: { type: 'string' },
				headType: { type: 'string', enum: ENTITY_TYPES },
				relation: { type: 'string' },
				tail: { type: 'string' },
				tailType: { type: 'string', enum: ENTITY_TYPES },
			},
			required: ['head', 'headType', 'relation', 'tail', 'tailType'],
		},
		handler: async (args, context): Promise<HandlerResult> => {
			const engine = requireRelationshipEngine(context);
			const head = getStringArg(args, 'head');
			const headType = getStringArg(args, 'headType');
			const relation = getStringArg(args, 'relation');
			const tail = getStringArg(args, 'tail');
			const tailType = getStringArg(args, 'tailType');

			await engine.addRelationship({
				id: '',
				head,
				headType,
				relation,
				tail,
				tailType,
			});

			return ok({ stored: true, head, relation, tail });
		},
	},
	{
		name: 'find_relationships',
		description: 'Find related entities',
		inputSchema: {
			type: 'object',
			properties: {
				entity: { type: 'string' },
				relation: { type: 'string' },
				k: { type: 'number' },
			},
			required: ['entity'],
		},
		handler: async (args, context): Promise<HandlerResult> => {
			const engine = requireRelationshipEngine(context);
			const entity = getStringArg(args, 'entity');
			const relation = getOptionalStringArg(args, 'relation');
			const k = getOptionalNumberArg(args, 'k');

			const results = await engine.findRelated(entity, relation, k);
			return ok(results);
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
			const engine = requireRelationshipEngine(context);
			const sequenceId = getStringArg(args, 'sequenceId');
			const chapters = getArrayArg<string>(args, 'chapters');

			await engine.storeSequence(sequenceId, chapters);
			return ok({ stored: true, sequenceId, count: chapters.length });
		},
	},
	{
		name: 'character_network',
		description: 'Analyze character relationships',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		handler: async (_args, context): Promise<HandlerResult> => {
			const engine = requireRelationshipEngine(context);
			const network = await engine.getCharacterNetwork();
			return ok(network);
		},
	},
	{
		name: 'discover_connections',
		description: 'Discover entity co-occurrences',
		inputSchema: {
			type: 'object',
			properties: {
				k: { type: 'number' },
			},
		},
		handler: async (args, context): Promise<HandlerResult> => {
			const engine = requireRelationshipEngine(context);
			const k = getOptionalNumberArg(args, 'k');

			const discoveries = await engine.discoverRelationships(k);
			return ok(discoveries);
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
			const engine = requireRelationshipEngine(context);
			const result = await engine.syncToNeo4j();
			return ok(result);
		},
	},
];
