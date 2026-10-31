import { formatPayload } from '../core/response-formatter.js';
import {
	buildReferenceIndex,
	referencesForDocument,
	documentsReferencing,
	orphanedEntities,
	suggestConnections,
	referenceSourceOptions,
	MAX_REFERENCE_ENTITIES,
	type RegistryEntity,
	type DocumentReferences,
} from '../services/document-references.js';
import { analysisDigest, analysisEnvelope } from '../services/editorial/analysis-envelope.js';
import { storyText } from '../services/editorial/provenance.js';
import type { SourceDocument } from '../services/editorial/types.js';
import type { HandlerContext, HandlerResult, ToolDefinition, ToolSchema } from './types.js';
import { requireProject } from './types.js';
import { ANALYSIS_ENVELOPE_SCHEMA, RESULT_REFERENCE_SCHEMA } from './shared-schemas.js';
import { AppError, ErrorCode } from '../utils/common.js';

function loadRegistry(context: HandlerContext) {
	const entities: RegistryEntity[] = [];
	const unavailableRegistries: Array<'characters' | 'locations'> = [];
	let sqlite: ReturnType<NonNullable<HandlerContext['databaseService']>['getSQLite']> | undefined;
	try {
		sqlite = context.databaseService?.getSQLite();
	} catch (error) {
		if (!(error instanceof AppError) || error.code !== ErrorCode.DATABASE_ERROR) throw error;
	}
	if (!sqlite) unavailableRegistries.push('characters', 'locations');
	else {
		const database = sqlite.getDatabase();
		database.transaction(() => {
			const tables = new Set(
				(
					database
						.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('characters', 'locations')"
						)
						.all() as Array<{ name: string }>
				).map(({ name }) => name)
			);
			for (const [table, type] of [
				['characters', 'character'],
				['locations', 'location'],
			] as const) {
				if (!tables.has(table)) {
					unavailableRegistries.push(table);
					continue;
				}
				const size = database
					.prepare(
						`SELECT COUNT(*) AS count, MAX(length(CAST(id AS BLOB))) AS idBytes, MAX(length(CAST(name AS BLOB))) AS nameBytes FROM ${table}`
					)
					.get() as { count: number; idBytes: number | null; nameBytes: number | null };
				if (
					size.count + entities.length > MAX_REFERENCE_ENTITIES ||
					(size.idBytes ?? 0) > 512 ||
					(size.nameBytes ?? 0) > 8000
				)
					throw new Error(
						'Entity registry exceeds the bounded reference-analysis input limits'
					);
				const rows = database
					.prepare(`SELECT id, name FROM ${table} ORDER BY id LIMIT 257`)
					.all() as Array<{ id: unknown; name: unknown }>;
				for (const row of rows) {
					const id = storyText(row.id, 'Entity identifier', 128);
					if (id !== row.id)
						throw new Error(
							'Entity identifiers must not contain surrounding whitespace'
						);
					entities.push({
						id,
						name: storyText(row.name, 'Entity name', 2000),
						type,
					});
				}
			}
		})();
	}
	if (new Set(entities.map(({ id }) => id)).size !== entities.length)
		throw new Error('Entity identifiers are ambiguous across the registries');
	const availability = {
		status:
			unavailableRegistries.length === 2
				? 'unavailable'
				: unavailableRegistries.length
					? 'partial'
					: 'available',
		unavailableRegistries,
	};
	return { entities, availability, revision: analysisDigest({ entities, availability }) };
}

const scopeIdentity = (documents: SourceDocument[]) =>
	analysisDigest(
		documents.map(({ documentId, revision, title, path, order }) => ({
			documentId,
			revision,
			title,
			path,
			order,
		}))
	);

async function referenceAnalysis(
	context: HandlerContext,
	operation: string,
	request: Record<string, unknown>,
	select: (
		index: DocumentReferences[],
		entities: RegistryEntity[],
		documents: SourceDocument[]
	) => Record<string, unknown>,
	documentId?: string
): Promise<HandlerResult> {
	const { source } = requireProject(context).getEditorialServices();
	const registry = loadRegistry(context);
	const options = referenceSourceOptions(registry.entities.length, 'all');
	const read = documentId
		? async () => [await source.read(documentId)]
		: () => source.list(options);
	const scope = documentId ? 'selected-document' : 'all-active-text';
	const documents = await read();
	const scopeRevision = scopeIdentity(documents);
	const index = buildReferenceIndex(
		documents.map(({ documentId, title, text }) => ({ id: documentId, title, content: text })),
		registry.entities
	);
	const result = select(index, registry.entities, documents);
	const latest = await read();
	if (
		scopeIdentity(latest) !== scopeRevision ||
		loadRegistry(context).revision !== registry.revision
	)
		throw new Error('Saved documents or the entity registry changed during reference analysis');
	const envelope = analysisEnvelope(
		source.projectId,
		documentId ? 'document' : 'manuscript',
		documents,
		{},
		'local',
		{
			operation,
			...request,
			scope,
			scopeRevision,
			registryRevision: registry.revision,
		}
	);
	envelope.policy.revisionChecked = true;
	const text = formatPayload(
		{
			...result,
			availability: registry.availability,
			registryRevision: registry.revision,
			envelope,
			coverage: {
				scope,
				documents: documents.length,
				entities: registry.entities.length,
				sourceCharacters: documents.reduce(
					(total, document) => total + document.text.length,
					0
				),
			},
		},
		'references'
	);
	return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}

function argumentsFor(args: Record<string, unknown>, keys: string[]) {
	if (Object.keys(args).some((key) => !keys.includes(key)))
		throw new Error('Unsupported reference-analysis argument');
}

function requireDocument(documents: SourceDocument[], id: string) {
	if (!documents.some((document) => document.documentId === id))
		throw new Error('Document is not active text in the selected project');
}

const textInput = {
	type: 'string',
	description: 'Identifier of an active saved text document in the open project.',
	minLength: 1,
	maxLength: 128,
	pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$',
};
const kind = {
	enum: ['character', 'location'],
	description: 'Category of the registered entity.',
};
const documentIdSchema = {
	type: 'string',
	description: 'Identifier of the saved project document.',
};
const entityIdSchema = {
	type: 'string',
	description: 'Unique identifier of the entity in the project registry.',
};
const entityNameSchema = {
	type: 'string',
	description: 'Recorded entity name used for literal whole-word matching.',
};
const entitySchema = {
	type: 'object',
	additionalProperties: false,
	properties: { id: entityIdSchema, name: entityNameSchema, type: kind },
	required: ['id', 'name', 'type'],
};
const availabilitySchema = {
	type: 'object',
	description: 'Availability of the character and location registries used for this result.',
	additionalProperties: false,
	properties: {
		status: {
			enum: ['available', 'partial', 'unavailable'],
			description:
				'Available when both registries were loaded, partial when one was loaded, and unavailable when neither was loaded.',
		},
		unavailableRegistries: {
			type: 'array',
			description:
				'Registries whose database or table is unavailable; their entities are excluded from analysis.',
			uniqueItems: true,
			maxItems: 2,
			items: { enum: ['characters', 'locations'] },
		},
	},
	required: ['status', 'unavailableRegistries'],
};
const reportProperties = {
	availability: availabilitySchema,
	registryRevision: {
		type: 'string',
		pattern: '^[a-f0-9]{64}$',
		description:
			'SHA-256 revision of the entity records and registry availability used by the analysis.',
	},
	envelope: ANALYSIS_ENVELOPE_SCHEMA,
	coverage: {
		type: 'object',
		description: 'Actual saved-text and registry scope examined for this result.',
		additionalProperties: false,
		properties: {
			scope: {
				enum: ['selected-document', 'all-active-text'],
				description:
					'Whether analysis examined the selected document or all active text, including Research and Draft items excluded from Compile.',
			},
			documents: {
				type: 'integer',
				minimum: 0,
				maximum: 1000,
				description:
					'Number of saved text documents examined, including documents with no matches.',
			},
			entities: {
				type: 'integer',
				minimum: 0,
				maximum: 256,
				description:
					'Number of entities loaded from the available registries, including unmatched entities.',
			},
			sourceCharacters: {
				type: 'integer',
				minimum: 0,
				maximum: 2097152,
				description: 'Total UTF-16 code units across examined plain text.',
			},
		},
		required: ['scope', 'documents', 'entities', 'sourceCharacters'],
	},
};
function output(
	properties: NonNullable<ToolSchema['properties']>,
	required = Object.keys(properties),
	variants?: ToolSchema['oneOf']
): ToolSchema {
	return {
		type: 'object',
		oneOf: [
			{
				type: 'object',
				additionalProperties: false,
				properties: { ...properties, ...reportProperties },
				required: [...required, ...Object.keys(reportProperties)],
				...(variants ? { oneOf: variants } : {}),
			},
			RESULT_REFERENCE_SCHEMA,
		],
	};
}
const annotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
const scopeDescription =
	' Uses saved active text, including Research and Draft items excluded from Compile. Reports source revisions and registry availability; changed inputs reject the result. Limits: 256 registry entities, 1000 documents, 2 Mi UTF-16 characters, source characters multiplied by entities at most 134217728, 1000000 match positions and 16 MiB of serialized mention records. Large results use read_result.';

export const getEntityReferencesHandler: ToolDefinition = {
	name: 'get_entity_references',
	title: 'Get Entity References',
	description: `Trace literal, case-insensitive whole-word references between saved documents and registered characters/locations. Provide exactly one of documentId (all entities mentioned, with every UTF-16 offset) or entity (registry ID or name, returning mentioning documents and counts). Exact registry IDs take precedence; ambiguous names require an ID.${scopeDescription}`,
	annotations,
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			documentId: textInput,
			entity: {
				...textInput,
				maxLength: 2000,
				description:
					'Exact registry ID or case-insensitive entity name. IDs take precedence; ambiguous names require an ID. Supply instead of documentId.',
			},
		},
		oneOf: [{ required: ['documentId'] }, { required: ['entity'] }],
	},
	outputSchema: output(
		{
			documentId: documentIdSchema,
			entity: {
				type: 'string',
				description:
					'Caller-supplied registry ID or entity name after trimming, present for entity-based lookup.',
			},
			mentions: {
				type: 'array',
				description:
					'Registered entities mentioned in the selected document, with all literal match positions.',
				maxItems: 256,
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						entityId: entityIdSchema,
						entityName: entityNameSchema,
						type: kind,
						count: {
							type: 'integer',
							minimum: 1,
							description:
								'Number of literal whole-word occurrences of this entity in the document.',
						},
						positions: {
							type: 'array',
							description:
								'Zero-based UTF-16 start offsets of every matching occurrence in the saved plain text.',
							minItems: 1,
							maxItems: 1000000,
							items: { type: 'integer', minimum: 0 },
						},
					},
					required: ['entityId', 'entityName', 'type', 'count', 'positions'],
				},
			},
			documents: {
				type: 'array',
				description:
					'Saved documents mentioning the selected entity, ordered by descending mention count.',
				maxItems: 1000,
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						documentId: documentIdSchema,
						title: {
							type: 'string',
							description: 'Saved title of the referencing document.',
						},
						count: {
							type: 'integer',
							minimum: 1,
							description:
								'Number of literal whole-word mentions of the selected entity in this document.',
						},
					},
					required: ['documentId', 'title', 'count'],
				},
			},
		},
		[],
		[{ required: ['documentId', 'mentions'] }, { required: ['entity', 'documents'] }]
	),
	handler: async (args, context) => {
		argumentsFor(args, ['documentId', 'entity']);
		if ((args.documentId !== undefined) === (args.entity !== undefined))
			throw new Error('Provide exactly one of documentId or entity');
		const documentId =
			args.documentId === undefined
				? undefined
				: storyText(args.documentId, 'Document identifier', 128);
		const entity =
			args.entity === undefined
				? undefined
				: storyText(args.entity, 'Entity identifier or name', 2000);
		return referenceAnalysis(
			context,
			'get_entity_references',
			documentId ? { documentId } : { entity },
			(index, entities, documents) => {
				if (documentId) {
					requireDocument(documents, documentId);
					return { documentId, mentions: referencesForDocument(index, documentId) };
				}
				return { entity, documents: documentsReferencing(index, entity!, entities) };
			},
			documentId
		);
	},
};

export const findOrphanedEntitiesHandler: ToolDefinition = {
	name: 'find_orphaned_entities',
	title: 'Find Orphaned Entities',
	description: `List registered characters and locations with no literal name mentions in the selected saved text.${scopeDescription}`,
	annotations,
	inputSchema: { type: 'object', additionalProperties: false, properties: {} },
	outputSchema: output({
		orphans: {
			type: 'array',
			maxItems: 256,
			items: entitySchema,
			description:
				'Entities from available registries with no literal whole-word name mentions in the examined saved text.',
		},
		registrySize: {
			type: 'integer',
			minimum: 0,
			maximum: 256,
			description:
				'Total entities loaded from the available registries before filtering for missing mentions.',
		},
	}),
	handler: async (args, context) => {
		argumentsFor(args, []);
		return referenceAnalysis(context, 'find_orphaned_entities', {}, (index, entities) => ({
			orphans: orphanedEntities(index, entities),
			registrySize: entities.length,
		}));
	},
};

export const suggestConnectionsHandler: ToolDefinition = {
	name: 'suggest_connections',
	title: 'Suggest Missing Connections',
	description: `Suggest registered characters or locations absent from a document but co-occurring elsewhere with its mentioned entities. The count is the number of distinct registry entities from that document sharing another document with each suggestion; relatedTo preserves their names, including duplicates. This is an association to review.${scopeDescription}`,
	annotations,
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: { documentId: textInput },
		required: ['documentId'],
	},
	outputSchema: output({
		documentId: documentIdSchema,
		suggestions: {
			type: 'array',
			description:
				'Registered entities absent from the selected document but associated with its mentioned entities elsewhere, ordered by descending coOccurrences.',
			maxItems: 256,
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					entityId: entityIdSchema,
					entityName: entityNameSchema,
					type: kind,
					coOccurrences: {
						type: 'integer',
						minimum: 1,
						description:
							'Number of distinct entities from the selected document that share another document with this suggestion.',
					},
					relatedTo: {
						type: 'array',
						maxItems: 256,
						items: { type: 'string' },
						description:
							'Names of those related entities from the selected document; distinct registry IDs may preserve duplicate names.',
					},
				},
				required: ['entityId', 'entityName', 'type', 'coOccurrences', 'relatedTo'],
			},
		},
	}),
	handler: async (args, context) => {
		argumentsFor(args, ['documentId']);
		const documentId = storyText(args.documentId, 'Document identifier', 128);
		return referenceAnalysis(
			context,
			'suggest_connections',
			{ documentId },
			(index, _entities, documents) => {
				requireDocument(documents, documentId);
				return { documentId, suggestions: suggestConnections(index, documentId) };
			}
		);
	},
};

export const documentGraphHandlers = [
	getEntityReferencesHandler,
	findOrphanedEntitiesHandler,
	suggestConnectionsHandler,
];
