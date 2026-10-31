import { formatPayload } from '../core/response-formatter.js';
import {
	ENTITY_TYPES,
	relationshipInput,
	relationshipLimit,
} from '../services/relationship-engine.js';
import type { HandlerContext, HandlerResult, ToolDefinition, ToolSchema } from './types.js';
import { getStringArg, requireProject } from './types.js';
import { ANALYSIS_ENVELOPE_SCHEMA, RESULT_REFERENCE_SCHEMA } from './shared-schemas.js';

const nameSchema = {
	type: 'string',
	minLength: 1,
	maxLength: 128,
	pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$',
};
const labelSchema = { ...nameSchema, maxLength: 64 };
const limitSchema = { type: 'integer', minimum: 1, maximum: 100, default: 10 };
const identity = {
	projectId: { type: 'string' },
	graphRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
};
const edge = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string' },
		head: nameSchema,
		headType: { enum: [...ENTITY_TYPES] },
		relation: labelSchema,
		tail: nameSchema,
		tailType: { enum: [...ENTITY_TYPES] },
		properties: {
			type: 'object',
			description: 'Optional finite JSON author metadata, at most 1024 UTF-8 JSON bytes.',
		},
	},
	required: ['id', 'head', 'headType', 'relation', 'tail', 'tailType'],
};

function output(
	properties: ToolSchema['properties'],
	required = Object.keys(properties)
): ToolSchema {
	return {
		type: 'object',
		properties: {},
		oneOf: [
			{ type: 'object', additionalProperties: false, properties, required },
			RESULT_REFERENCE_SCHEMA,
		],
	};
}

function ok(data: unknown, isError = false): HandlerResult {
	const text = formatPayload(data, 'relationships');
	return {
		content: [{ type: 'text', text }],
		structuredContent: JSON.parse(text),
		...(isError ? { isError: true } : {}),
	};
}

function engine(context: HandlerContext) {
	return requireProject(context).getEditorialServices().relationships;
}

function guarded(keys: string[], handler: ToolDefinition['handler']): ToolDefinition['handler'] {
	return async (args, context) => {
		try {
			if (Object.keys(args).some((key) => !keys.includes(key)))
				throw new Error('Unsupported relationship argument');
			return await handler(args, context);
		} catch {
			return {
				isError: true,
				content: [
					{
						type: 'text',
						text: 'Relationship operation failed. Check the documented input bounds and current project state before retrying.',
					},
				],
			};
		}
	};
}

const localRead = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

export const relationshipHandlers: ToolDefinition[] = [
	{
		name: 'add_relationship',
		title: 'Add Relationship',
		description:
			'Record a directed, typed relationship in the open project’s durable local story graph. Repeating the same endpoints and label is idempotent. Supports at most 10000 relationships; names are limited to 128 UTF-16 characters and labels to 64. This records author-supplied relationships for find_relationships and character_network.',
		annotations: { ...localRead, readOnlyHint: false },
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				head: nameSchema,
				headType: { enum: [...ENTITY_TYPES] },
				relation: labelSchema,
				tail: nameSchema,
				tailType: { enum: [...ENTITY_TYPES] },
			},
			required: ['head', 'headType', 'relation', 'tail', 'tailType'],
		},
		outputSchema: output({
			stored: { const: true },
			id: { type: 'string' },
			head: nameSchema,
			relation: labelSchema,
			tail: nameSchema,
		}),
		handler: guarded(
			['head', 'headType', 'relation', 'tail', 'tailType'],
			async (args, context) => {
				const rel = relationshipInput(args);
				const id = engine(context).addRelationship(rel);
				return ok({
					stored: true,
					id,
					head: rel.head,
					relation: rel.relation,
					tail: rel.tail,
				});
			}
		),
	},
	{
		name: 'find_relationships',
		title: 'Find Relationships',
		description:
			'Return recorded relationships whose source or target exactly matches an entity name, optionally filtered by label. Reads the open project’s durable local graph. k selects 1–100 edges per page in stable identity order. Continue with nextOffset and graphRevision; a changed graph rejects further pages. Large pages use read_result.',
		annotations: localRead,
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				entity: nameSchema,
				relation: labelSchema,
				k: limitSchema,
				offset: { type: 'integer', minimum: 0, maximum: 10000 },
				graphRevision: identity.graphRevision,
			},
			allOf: [
				{
					if: { properties: { offset: { minimum: 1 } }, required: ['offset'] },
					then: { required: ['graphRevision'] },
				},
			],
			required: ['entity'],
		},
		outputSchema: output({
			...identity,
			relationships: { type: 'array', maxItems: 100, items: edge },
			total: { type: 'integer', minimum: 0 },
			truncated: { type: 'boolean' },
			offset: { type: 'integer', minimum: 0, maximum: 10000 },
			nextOffset: { type: ['integer', 'null'], minimum: 0, maximum: 10000 },
		}),
		handler: guarded(
			['entity', 'relation', 'k', 'offset', 'graphRevision'],
			async (args, context) => {
				const relation =
					args.relation === undefined ? undefined : getStringArg(args, 'relation');
				return ok(
					engine(context).findRelated(
						getStringArg(args, 'entity'),
						relation,
						relationshipLimit(args.k),
						args.offset as number | undefined,
						args.graphRevision as string | undefined
					)
				);
			}
		),
	},
	{
		name: 'store_chapter_order',
		description:
			'Store a durable project planning sequence of 1–4096 unique chapter identifiers.',
		annotations: { ...localRead, readOnlyHint: false },
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				sequenceId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' },
				chapters: {
					type: 'array',
					minItems: 1,
					maxItems: 4096,
					uniqueItems: true,
					items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' },
				},
			},
			required: ['sequenceId', 'chapters'],
		},
		outputSchema: output({
			stored: { const: true },
			sequenceId: { type: 'string' },
			count: { type: 'integer', minimum: 1, maximum: 4096 },
		}),
		handler: guarded(['sequenceId', 'chapters'], async (args, context) => {
			const sequenceId = getStringArg(args, 'sequenceId');
			engine(context).storeSequence(sequenceId, args.chapters as string[]);
			return ok({ stored: true, sequenceId, count: (args.chapters as string[]).length });
		}),
	},
	{
		name: 'character_network',
		title: 'Character Network',
		description:
			'Return all characters and directed edges in the open project’s recorded character-to-character relationships, including characters with only incoming edges. Reads durable project state, with its graph revision. Large networks use read_result.',
		annotations: localRead,
		inputSchema: { type: 'object', additionalProperties: false, properties: {} },
		outputSchema: output({
			...identity,
			network: {
				type: 'object',
				additionalProperties: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							target: nameSchema,
							relation: labelSchema,
							properties: edge.properties.properties,
						},
						required: ['target', 'relation'],
					},
				},
			},
		}),
		handler: guarded([], async (_args, context) => ok(engine(context).getCharacterNetwork())),
	},
	{
		name: 'discover_connections',
		title: 'Discover Connections',
		description:
			'Find unrecorded pairs of characters and locations already named in the project relationship graph that appear together in saved Draft documents. Uses literal, case-insensitive whole-word matches; strength is shared documents divided by documents mentioning either entity. Returns supporting document IDs, saved revisions and graph revision. Bounds: 256 entities, 1000 documents, 2 Mi UTF-16 source characters, and source characters multiplied by entities at most 134217728. k selects 1–100 strongest candidates; total and truncated disclose remaining candidates. Large output uses read_result.',
		annotations: localRead,
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: { k: limitSchema },
		},
		outputSchema: output({
			connections: {
				type: 'array',
				maxItems: 100,
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						entity1: nameSchema,
						entity1Type: { enum: ['character', 'location'] },
						entity2: nameSchema,
						entity2Type: { enum: ['character', 'location'] },
						strength: { type: 'number', minimum: 0, maximum: 1 },
						documentIds: {
							type: 'array',
							minItems: 1,
							maxItems: 1000,
							uniqueItems: true,
							items: { type: 'string' },
						},
					},
					required: [
						'entity1',
						'entity1Type',
						'entity2',
						'entity2Type',
						'strength',
						'documentIds',
					],
				},
			},
			total: { type: 'integer', minimum: 0 },
			truncated: { type: 'boolean' },
			method: { const: 'literal-whole-word-co-occurrence' },
			graphRevision: identity.graphRevision,
			envelope: ANALYSIS_ENVELOPE_SCHEMA,
			coverage: {
				type: 'object',
				additionalProperties: false,
				properties: {
					documents: { type: 'integer', minimum: 0, maximum: 1000 },
					entities: { type: 'integer', minimum: 0, maximum: 256 },
					sourceCharacters: { type: 'integer', minimum: 0, maximum: 2097152 },
				},
				required: ['documents', 'entities', 'sourceCharacters'],
			},
		}),
		handler: guarded(['k'], async (args, context) =>
			ok(await engine(context).discoverRelationships(relationshipLimit(args.k)))
		),
	},
	{
		name: 'sync_to_neo4j',
		description:
			'Copy the current relationship snapshot into project-scoped StoryEntity and StoryRelationship nodes and edges in an available Neo4j database.',
		annotations: { ...localRead, readOnlyHint: false, openWorldHint: true },
		inputSchema: { type: 'object', additionalProperties: false, properties: {} },
		outputSchema: output({
			...identity,
			synced: { type: 'integer', minimum: 0 },
			errors: { type: 'integer', minimum: 0 },
			status: { enum: ['complete', 'partial'] },
		}),
		handler: guarded([], async (_args, context) => {
			const result = await engine(context).syncToNeo4j();
			return ok(result, result.errors > 0);
		}),
	},
];
