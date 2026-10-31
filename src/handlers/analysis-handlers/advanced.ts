import { formatPayload } from '../../core/response-formatter.js';
import {
	AICollaboration,
	COLLABORATION_MODES,
	COLLABORATION_ROLES,
	collaborationRoles,
} from '../../services/agents/ai-collaboration.js';
import { analysisEnvelope } from '../../services/editorial/analysis-envelope.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { getOptionalNumberArg, getStringArg, requireProject } from '../types.js';
import {
	ANALYSIS_ENVELOPE_SCHEMA,
	RESULT_REFERENCE_SCHEMA,
	SHARED_DEFS,
} from '../shared-schemas.js';

const rolesSchema = {
	type: 'array',
	items: { type: 'string', enum: [...COLLABORATION_ROLES] },
	maxItems: COLLABORATION_ROLES.length,
	uniqueItems: true,
};

export const multiAgentAnalysisHandler: ToolDefinition = {
	name: 'multi_agent_analysis',
	title: 'Multi-Perspective Critique',
	description:
		'Critique saved document text from selected perspectives in one provider response. ' +
		'Collaborative mode compares perspectives; workshop proposes revision exercises; review ' +
		'prioritizes strengths and weaknesses. Reports exact coverage of at most 12000 UTF-16 ' +
		'characters, missing feedback and source revisions; rejects changes during analysis. ' +
		'Large results are retrieved with read_result.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			documentId: { ...SHARED_DEFS.docId, minLength: 1, maxLength: 128, pattern: '\\S' },
			agents: {
				oneOf: [{ const: ['all'] }, { ...rolesSchema, minItems: 1 }],
				description: 'Selected perspectives, or all by itself. Defaults to all five.',
			},
			collaborationMode: { type: 'string', enum: [...COLLABORATION_MODES] },
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {},
		oneOf: [
			{
				type: 'object',
				additionalProperties: false,
				properties: {
					method: { const: 'single-provider-perspectives' },
					agents: { ...rolesSchema, minItems: 1 },
					collaborationMode: { enum: [...COLLABORATION_MODES] },
					perspectives: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								role: { enum: [...COLLABORATION_ROLES] },
								feedback: { type: 'string', minLength: 1 },
							},
							required: ['role', 'feedback'],
						},
					},
					synthesis: { type: ['string', 'null'] },
					consensus: { type: ['string', 'null'] },
					availability: {
						type: 'object',
						additionalProperties: false,
						properties: {
							status: { enum: ['available', 'partial', 'unavailable'] },
							unavailableFields: {
								type: 'array',
								items: { enum: ['perspectives', 'synthesis', 'consensus'] },
								uniqueItems: true,
							},
							unavailableRoles: rolesSchema,
							partialFields: {
								type: 'array',
								items: { const: 'perspectives' },
								maxItems: 1,
							},
							reason: { enum: ['no_text', 'invalid_response'] },
						},
						required: [
							'status',
							'unavailableFields',
							'unavailableRoles',
							'partialFields',
						],
					},
					coverage: {
						type: 'object',
						additionalProperties: false,
						properties: {
							start: { const: 0 },
							end: { type: 'integer', minimum: 0, maximum: 12000 },
							sourceCharacters: { type: 'integer', minimum: 0, maximum: 5000000 },
							sourceRevision: {
								type: 'string',
								pattern: '^[a-f0-9]{64}$',
								description:
									'SHA-256 of complete decoded text; envelope revisions hash saved RTF bytes.',
							},
							truncated: { type: 'boolean' },
						},
						required: [
							'start',
							'end',
							'sourceCharacters',
							'sourceRevision',
							'truncated',
						],
					},
					envelope: ANALYSIS_ENVELOPE_SCHEMA,
				},
				required: [
					'method',
					'agents',
					'collaborationMode',
					'perspectives',
					'synthesis',
					'consensus',
					'availability',
					'coverage',
					'envelope',
				],
			},
			RESULT_REFERENCE_SCHEMA,
		],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		if (
			Object.keys(args).some(
				(key) => !['documentId', 'agents', 'collaborationMode'].includes(key)
			)
		)
			throw new Error('Unsupported critique argument');
		const documentId = getStringArg(args, 'documentId');
		if (!documentId.trim() || documentId.length > 128)
			throw new Error('documentId must contain 1–128 characters and non-whitespace text');
		const agents = collaborationRoles(args.agents);
		const collaborationMode = COLLABORATION_MODES.find(
			(mode) =>
				mode ===
				(args.collaborationMode === undefined ? 'collaborative' : args.collaborationMode)
		);
		if (!collaborationMode) throw new Error('Unsupported collaboration mode');

		try {
			const { source } = project.getEditorialServices();
			const saved = await source.read(documentId);
			const result = await new AICollaboration().collaborateOnDocument(
				{ content: saved.text },
				{ enabledAgents: agents, mode: collaborationMode }
			);
			if ((await source.read(documentId)).revision !== saved.revision)
				throw new Error('Saved source changed during critique');
			const envelope = analysisEnvelope(
				source.projectId,
				'document',
				[saved],
				{},
				'provider',
				{
					operation: 'multi_agent_analysis',
					agents,
					collaborationMode,
				}
			);
			envelope.policy.revisionChecked = true;
			const text = formatPayload({ ...result, envelope }, 'critique');
			return {
				content: [{ type: 'text', text }],
				structuredContent: JSON.parse(text),
			};
		} catch {
			return {
				isError: true,
				content: [
					{
						type: 'text',
						text: 'Critique unavailable or its saved source changed. Retry with the current source and an available provider.',
					},
				],
			};
		}
	},
};

export const semanticSearchHandler: ToolDefinition = {
	name: 'semantic_search',
	title: 'Semantic Search',
	description:
		'Find passages with local story-concept vectors and source context without an API key, and ' +
		'return the most relevant passages with similarity scores and surrounding text. Use this ' +
		'for conceptual "find passages about X" queries; use search for keyword/full-text matching ' +
		'and find_mentions to locate every occurrence of a specific name or term. Indexing and similarity ' +
		'scoring are local; conceptual coverage is bounded to the documented English story vocabulary. ' +
		'Requires an open project with semantic indexing available.',
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
			maxResults: SHARED_DEFS.maxResults,
			threshold: {
				...SHARED_DEFS.threshold,
				description:
					'Minimum similarity score (0-1) a result must meet to be returned. Default 0.3; ' +
					'raise for stricter matches, lower for broader recall.',
			},
		},
		required: ['query'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			results: {
				type: 'array',
				description: 'Documents most relevant to the query, ordered by similarity.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Document id.' },
						title: { type: 'string', description: 'Document title.' },
						snippet: {
							type: 'string',
							description: 'Source context surrounding the matched passage.',
						},
						score: {
							type: ['number', 'null'],
							description: 'Similarity score, or null when unavailable.',
						},
					},
				},
			},
			searchType: {
				type: 'string',
				description: "Search mode used; always 'semantic' for this tool.",
			},
		},
		required: ['results'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const query = getStringArg(args, 'query');
		const maxResults = getOptionalNumberArg(args, 'maxResults') ?? 10;
		const threshold = getOptionalNumberArg(args, 'threshold') ?? 0.3;
		if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
			throw new Error('threshold must be from zero through one');
		const matches = await project
			.getEditorialServices()
			.search.search(query, { limit: maxResults, mode: 'semantic' });
		const results = matches.results
			.filter((match) => match.score >= threshold)
			.map((match) => ({ ...match, id: match.documentId, snippet: match.context }));
		const result = { ...matches, results, searchType: 'semantic' };
		return {
			content: [{ type: 'text', text: JSON.stringify(result) }],
			structuredContent: result,
		};
	},
};
