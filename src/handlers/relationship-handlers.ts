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
	description: 'Recorded entity name; surrounding whitespace is trimmed.',
	minLength: 1,
	maxLength: 128,
	pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$',
};
const headSchema = {
	...nameSchema,
	description: 'Name of the source entity in the directed relationship.',
};
const tailSchema = {
	...nameSchema,
	description: 'Name of the target entity in the directed relationship.',
};
const headTypeSchema = {
	enum: [...ENTITY_TYPES],
	description: 'Entity category of the relationship source.',
};
const tailTypeSchema = {
	enum: [...ENTITY_TYPES],
	description: 'Entity category of the relationship target.',
};
const labelSchema = {
	...nameSchema,
	maxLength: 64,
	description: 'Author-supplied directed relationship label; surrounding whitespace is trimmed.',
};
const limitSchema = {
	type: 'integer',
	minimum: 1,
	maximum: 100,
	default: 10,
	description: 'Maximum relationships or connection candidates to return; defaults to 10.',
};
const relationshipId = {
	type: 'string',
	description:
		'Stable SHA-256 identity derived from both entity names, their types and the relationship label.',
};
const identity = {
	projectId: {
		type: 'string',
		description: 'Stable identity of the open project owning this graph.',
	},
	graphRevision: {
		type: 'string',
		pattern: '^[a-f0-9]{64}$',
		description:
			'SHA-256 revision of the complete relationship snapshot; pass it unchanged when requesting subsequent pages.',
	},
};
const edge = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: relationshipId,
		head: headSchema,
		headType: headTypeSchema,
		relation: labelSchema,
		tail: tailSchema,
		tailType: tailTypeSchema,
		properties: {
			type: 'object',
			description: 'Optional finite JSON author metadata, at most 1024 UTF-8 JSON bytes.',
		},
	},
	required: ['id', 'head', 'headType', 'relation', 'tail', 'tailType'],
};

function output(
	properties: NonNullable<ToolSchema['properties']>,
	required = Object.keys(properties)
): NonNullable<ToolDefinition['outputSchema']> {
	return {
		type: 'object',
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
				head: headSchema,
				headType: headTypeSchema,
				relation: labelSchema,
				tail: tailSchema,
				tailType: tailTypeSchema,
			},
			required: ['head', 'headType', 'relation', 'tail', 'tailType'],
		},
		outputSchema: output({
			stored: {
				const: true,
				description:
					'Confirms that this relationship is durably recorded in the project graph.',
			},
			id: relationshipId,
			head: headSchema,
			relation: labelSchema,
			tail: tailSchema,
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
				entity: {
					...nameSchema,
					description:
						'Entity name to match exactly against either relationship endpoint after trimming.',
				},
				relation: labelSchema,
				k: limitSchema,
				offset: {
					type: 'integer',
					minimum: 0,
					maximum: 10000,
					description:
						'Zero-based starting position in matching relationships; defaults to 0. Positive offsets require graphRevision.',
				},
				graphRevision: {
					...identity.graphRevision,
					description:
						'Revision returned by the preceding page; required for positive offsets and rejected if the graph has changed.',
				},
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
			relationships: {
				type: 'array',
				maxItems: 100,
				items: edge,
				description:
					'Matching directed relationships in this page, ordered by stable identity.',
			},
			total: {
				type: 'integer',
				minimum: 0,
				description:
					'Total relationships matching the entity and optional label before pagination.',
			},
			truncated: {
				type: 'boolean',
				description: 'Whether further matching relationships remain after this page.',
			},
			offset: {
				type: 'integer',
				minimum: 0,
				maximum: 10000,
				description: 'Zero-based position of this page in the matching relationships.',
			},
			nextOffset: {
				type: ['integer', 'null'],
				minimum: 0,
				maximum: 10000,
				description:
					'Starting offset for the next page, or null when all matches have been returned.',
			},
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
				sequenceId: {
					type: 'string',
					pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$',
					description:
						'Project-local planning sequence identifier; reusing it replaces the stored sequence.',
				},
				chapters: {
					type: 'array',
					description: 'Unique chapter identifiers in the intended planning order.',
					minItems: 1,
					maxItems: 4096,
					uniqueItems: true,
					items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' },
				},
			},
			required: ['sequenceId', 'chapters'],
		},
		outputSchema: output({
			stored: {
				const: true,
				description: 'Confirms the planning sequence was durably stored.',
			},
			sequenceId: {
				type: 'string',
				description: 'Identifier of the stored project planning sequence.',
			},
			count: {
				type: 'integer',
				minimum: 1,
				maximum: 4096,
				description: 'Number of chapter identifiers in the stored sequence.',
			},
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
				description:
					'Character names mapped to outgoing character relationships; characters with only incoming edges map to empty arrays.',
				additionalProperties: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							target: {
								...nameSchema,
								description:
									'Target character name for this outgoing relationship.',
							},
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
				description:
					'Unrecorded entity pairs ranked by shared-document strength, with stable identity tie-breaking.',
				maxItems: 100,
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						entity1: {
							...nameSchema,
							description:
								'Recorded name of the first entity in this unrecorded pair.',
						},
						entity1Type: {
							enum: ['character', 'location'],
							description: 'Category of the first entity.',
						},
						entity2: {
							...nameSchema,
							description:
								'Recorded name of the second entity in this unrecorded pair.',
						},
						entity2Type: {
							enum: ['character', 'location'],
							description: 'Category of the second entity.',
						},
						strength: {
							type: 'number',
							minimum: 0,
							maximum: 1,
							description:
								'Documents mentioning both entities divided by documents mentioning either entity.',
						},
						documentIds: {
							type: 'array',
							description:
								'Saved Draft document identifiers containing whole-word mentions of both entities.',
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
			total: {
				type: 'integer',
				minimum: 0,
				description:
					'Number of unrecorded co-occurring entity pairs before applying the result limit.',
			},
			truncated: {
				type: 'boolean',
				description:
					'Whether additional candidate pairs were excluded by the result limit.',
			},
			method: {
				const: 'literal-whole-word-co-occurrence',
				description:
					'Discovery method: literal, case-insensitive whole-word mentions shared across saved documents.',
			},
			graphRevision: identity.graphRevision,
			envelope: {
				...ANALYSIS_ENVELOPE_SCHEMA,
				description:
					'Analysis identity, saved source revisions and policy for this local discovery result.',
			},
			coverage: {
				type: 'object',
				description: 'Actual manuscript and graph scope examined during discovery.',
				additionalProperties: false,
				properties: {
					documents: {
						type: 'integer',
						minimum: 0,
						maximum: 1000,
						description: 'Number of saved Draft documents examined.',
					},
					entities: {
						type: 'integer',
						minimum: 0,
						maximum: 256,
						description:
							'Number of distinct typed character and location names indexed from the graph.',
					},
					sourceCharacters: {
						type: 'integer',
						minimum: 0,
						maximum: 2097152,
						description: 'Total UTF-16 code units across examined document text.',
					},
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
			synced: {
				type: 'integer',
				minimum: 0,
				description: 'Number of relationships confirmed by the Neo4j database.',
			},
			errors: {
				type: 'integer',
				minimum: 0,
				description:
					'Number of relationships whose database write failed or was not confirmed.',
			},
			status: {
				enum: ['complete', 'partial'],
				description:
					'Complete when every relationship was confirmed; partial when any relationship failed.',
			},
		}),
		handler: guarded([], async (_args, context) => {
			const result = await engine(context).syncToNeo4j();
			return ok(result, result.errors > 0);
		}),
	},
];
