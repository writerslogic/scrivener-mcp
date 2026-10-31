import type { ToolSchema } from './types.js';

export const RESULT_REFERENCE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		_ref: {
			type: 'string',
			description: 'Retrieve with read_result and concatenate pages before parsing JSON.',
		},
		_file: { type: 'string' },
		_size: {
			type: 'integer',
			minimum: 0,
			description: 'UTF-16 character length of the complete JSON result.',
		},
		_preview: { type: 'string', maxLength: 200 },
		_hint: { type: 'string' },
	},
	required: ['_ref', '_file', '_size', '_preview', '_hint'],
};

/**
 * Shared schema definitions to reduce token overhead in MCP tool schemas.
 * Import and reference these instead of repeating property definitions.
 */

export const SHARED_DEFS = {
	docId: {
		type: 'string' as const,
		description: 'Scrivener document UUID, as returned by get_structure (a binder item "id").',
	},
	content: {
		type: 'string' as const,
		description: 'Document body as plain text. May be empty.',
	},
	query: {
		type: 'string' as const,
		description:
			'Search query: keywords for full-text search, or a natural-language phrase for ' +
			'semantic search, depending on the tool.',
	},
	maxResults: {
		type: 'number' as const,
		description: 'Maximum number of results to return.',
	},
	threshold: { type: 'number' as const, description: 'Min score 0-1' },
	format: { type: 'string' as const, enum: ['text', 'rtf', 'html', 'markdown'] as const },
	documentIds: { type: 'array' as const, items: { type: 'string' as const } },
	chapterId: { type: 'string' as const },
	folderId: {
		type: 'string' as const,
		description: 'UUID of a binder folder, as returned by get_structure.',
	},
	includeTrash: {
		type: 'boolean' as const,
		description: 'Set true to include trashed items in the result. Default false.',
	},
	force: {
		type: 'boolean' as const,
		description:
			'Explicitly acknowledge native-app overwrite risk when Scrivener is open or detection is ambiguous. Default false. Never overrides saved revision checks or another server instance.',
	},
} as const;

export const ANALYSIS_ENVELOPE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		requestId: { type: 'string' },
		projectId: { type: ['string', 'null'] },
		createdAt: { type: 'string' },
		sourceFormat: {
			enum: ['saved-rtf', 'supplied-text'],
			description:
				'Bytes hashed for source revisions: saved RTF or caller-supplied UTF-8 text.',
		},
		scope: {
			type: 'object',
			additionalProperties: false,
			properties: {
				kind: { enum: ['manuscript', 'document', 'annotation'] },
				documentIds: { type: 'array', items: { type: 'string' } },
			},
			required: ['kind', 'documentIds'],
		},
		sourceRevisions: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: { documentId: { type: 'string' }, revision: { type: 'string' } },
				required: ['documentId', 'revision'],
			},
		},
		engine: {
			type: 'object',
			additionalProperties: false,
			properties: {
				name: { enum: ['narrative-lens', 'provider', 'scrivener-mcp'] },
				version: { type: ['string', 'null'] },
				configurationHash: { type: 'string' },
				controlsHash: { type: 'string' },
			},
			required: ['name', 'version', 'configurationHash', 'controlsHash'],
		},
		policy: {
			type: 'object',
			additionalProperties: false,
			properties: {
				mode: { enum: ['configured', 'raw', 'author-evidence', 'provider', 'local'] },
				usesSavedProjectControls: { type: 'boolean' },
				authorIntentionsApplied: { type: 'boolean' },
				suppressionsApplied: { type: 'boolean' },
				allowsRawNativeAnalysis: { type: 'boolean' },
				providerAccess: { type: 'boolean' },
				mutatesManuscript: { const: false },
				revisionChecked: { type: 'boolean' },
			},
			required: [
				'mode',
				'usesSavedProjectControls',
				'authorIntentionsApplied',
				'suppressionsApplied',
				'allowsRawNativeAnalysis',
				'providerAccess',
				'mutatesManuscript',
				'revisionChecked',
			],
		},
	},
	required: [
		'requestId',
		'projectId',
		'createdAt',
		'scope',
		'sourceRevisions',
		'sourceFormat',
		'engine',
		'policy',
	],
};

export const NARRATIVE_RESULT_SCHEMA: ToolSchema = {
	type: 'object',
	properties: {
		action: { type: 'string' },
		result: {
			type: 'object',
			description:
				'Complete native result plus reportId, or a lossless JSON fragment. Continue fragments with analyze_manuscript_local action read_report; concatenate data then JSON.parse once.',
			properties: {
				reportId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
				envelope: ANALYSIS_ENVELOPE_SCHEMA,
				encoding: { const: 'json-fragment' },
				data: { type: 'string' },
				pagination: {
					type: 'object',
					additionalProperties: false,
					properties: {
						byteLimit: { type: 'integer' },
						start: { type: 'integer' },
						end: { type: 'integer' },
						total: { type: 'integer' },
						nextCursor: { type: ['string', 'null'] },
					},
					required: ['byteLimit', 'start', 'end', 'total', 'nextCursor'],
				},
			},
			required: ['reportId'],
			oneOf: [
				{ required: ['encoding', 'data', 'pagination'] },
				{ not: { required: ['encoding'] } },
			],
		},
	},
	required: ['action', 'result'],
};
