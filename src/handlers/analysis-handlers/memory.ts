import { formatPayload } from '../../core/response-formatter.js';
import {
	MEMORY_INPUT_SCHEMA,
	MEMORY_TYPES,
	memoryType,
} from '../../services/memory/project-memory-contract.js';
import { RESULT_REFERENCE_SCHEMA } from '../shared-schemas.js';
import {
	requireMemoryManager,
	requireProject,
	type HandlerResult,
	type ToolDefinition,
} from '../types.js';

const revision = {
	type: 'string',
	pattern: '^[a-f0-9]{64}$',
	description: 'Canonical SHA-256 of the decoded memory snapshot, including document contexts.',
};

export const updateMemoryHandler: ToolDefinition = {
	name: 'remember',
	title: 'Remember Project Facts',
	description:
		'Persist a character, world-building element, plot thread, style-guide patch or custom context in the open project. Records require a name on creation; include an existing id to update. Missing fields remain absent. Identical creations return the same id; unknown update IDs fail. styleGuide and all merge supplied fields by key. The complete request is limited to 64 KiB of JSON, depth 32; project memory is limited to 16 MiB. Acknowledges only durable writes; no manuscript text is changed. Use recall for stored records and IDs.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: MEMORY_INPUT_SCHEMA,
	outputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			memoryType: {
				enum: [...MEMORY_TYPES],
				description: 'Category written; all records a patch to customContext.',
			},
			id: {
				type: ['string', 'null'],
				description:
					'Created or updated record identifier; null for styleGuide and customContext patches.',
			},
			revision,
			persisted: {
				const: true,
				description: 'Confirms the resulting memory snapshot is durably saved.',
			},
			projectId: {
				type: 'string',
				description: 'Stable identity of the open project owning this memory.',
			},
		},
		required: ['memoryType', 'id', 'revision', 'persisted', 'projectId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const memory = requireMemoryManager(context);
		const projectId = project.getEditorialServices().source.projectId;
		const result = { ...(await memory.remember(args)), projectId };
		return {
			content: [{ type: 'text', text: JSON.stringify(result) }],
			structuredContent: result,
		};
	},
};

export const getMemoryHandler: ToolDefinition = {
	name: 'recall',
	title: 'Recall Project Facts',
	description:
		'Read stored project facts with a snapshot revision. characters, worldBuilding and plotThreads return record arrays; styleGuide returns supplied preferences; all returns complete memory including customContext and documentContexts keyed by document ID. Omitted fields are unrecorded. Use remember to persist changes. Requires an open project; large results use read_result.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			memoryType: {
				enum: [...MEMORY_TYPES],
				description:
					'Category to read; omit or use all for the complete project memory snapshot.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		oneOf: [
			{
				type: 'object',
				additionalProperties: false,
				properties: {
					memoryType: {
						enum: [...MEMORY_TYPES],
						description: 'Selected memory category, or all for the complete snapshot.',
					},
					memory: {
						description:
							'Selected stored records or the complete project-memory JSON snapshot; legacy and custom fields are retained.',
					},
					revision,
					projectId: {
						type: 'string',
						description: 'Stable identity of the open project owning this memory.',
					},
				},
				required: ['memoryType', 'memory', 'revision', 'projectId'],
			},
			RESULT_REFERENCE_SCHEMA,
		],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		if (Object.keys(args).some((key) => key !== 'memoryType'))
			throw new Error('Unsupported recall argument');
		const type = memoryType(args.memoryType);
		const project = requireProject(context);
		const manager = requireMemoryManager(context);
		const snapshot = manager.getMemorySnapshot();
		const memory =
			type === 'all'
				? { ...snapshot, documentContexts: Object.fromEntries(snapshot.documentContexts) }
				: snapshot[type];
		const text = formatPayload(
			{
				memoryType: type,
				memory,
				revision: manager.memoryRevision(snapshot),
				projectId: project.getEditorialServices().source.projectId,
			},
			'memory'
		);
		return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
	},
};
