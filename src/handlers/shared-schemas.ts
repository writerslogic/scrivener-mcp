import type { ToolSchema } from './types.js';

export const RESULT_REFERENCE_SCHEMA = {
	type: 'object',
	description: 'Reference to a complete JSON result retained in the server session spool.',
	additionalProperties: false,
	properties: {
		_ref: {
			type: 'string',
			description:
				'Opaque resultId for read_result; concatenate its text pages before parsing the complete JSON.',
		},
		_size: {
			type: 'integer',
			minimum: 0,
			description: 'Length of the complete JSON string in UTF-16 code units.',
		},
		_preview: {
			type: 'string',
			maxLength: 200,
			description:
				'First up to 200 UTF-16 code units of the stored JSON; may be incomplete JSON.',
		},
		_hint: {
			type: 'string',
			description:
				'Retrieval instructions and expiration conditions for this spooled result.',
		},
	},
	required: ['_ref', '_size', '_preview', '_hint'],
};

/**
 * Shared schema definitions to reduce token overhead in MCP tool schemas.
 * Import and reference these instead of repeating property definitions.
 */

export const SHARED_DEFS = {
	dryRun: {
		type: 'boolean' as const,
		description:
			'Validate and preview the structural change without writing. Reuse the returned expectedRevision when applying.',
	},
	binderRevision: {
		type: 'string' as const,
		pattern: '^[a-f0-9]{64}$',
		description:
			'Binder revision returned by a structural preview. A changed binder rejects the operation.',
	},
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
	threshold: {
		type: 'number' as const,
		description: 'Minimum match score on a zero-to-one scale.',
	},
	format: {
		type: 'string' as const,
		enum: ['text', 'rtf', 'html', 'markdown'] as const,
		description: 'Format used to represent document content.',
	},
	documentIds: {
		type: 'array' as const,
		items: { type: 'string' as const, description: 'Scrivener binder document UUID.' },
		description: 'Scrivener binder UUIDs of the selected documents.',
	},
	chapterId: {
		type: 'string' as const,
		description: 'Binder UUID of the chapter document or folder selected by the tool.',
	},
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
	description:
		'Provenance linking the request to its source revisions, engine settings and execution policy.',
	additionalProperties: false,
	properties: {
		requestId: {
			type: 'string',
			description:
				'Deterministic SHA-256 of canonical project, scope, revision, control, policy, request and engine-version inputs; excludes createdAt.',
		},
		projectId: {
			type: ['string', 'null'],
			description:
				'Project identity or isolated queue-instance identity; null when the request has neither.',
		},
		createdAt: {
			type: 'string',
			description: 'UTC ISO 8601 timestamp when this provenance envelope was created.',
		},
		sourceFormat: {
			enum: ['saved-rtf', 'supplied-text'],
			description:
				'Source representation hashed for revisions: saved RTF text or caller-supplied text, encoded as UTF-8.',
		},
		scope: {
			type: 'object',
			description: 'Request scope and ordered identifiers of the source documents used.',
			additionalProperties: false,
			properties: {
				kind: {
					enum: ['manuscript', 'document', 'annotation'],
					description:
						'Scope category: manuscript, document-level request or author-evidence annotation analysis.',
				},
				documentIds: {
					type: 'array',
					items: {
						type: 'string',
						description: 'Source document identifier used in sourceRevisions.',
					},
					description:
						'Source document identifiers in analysis order; saved documents use binder UUIDs.',
				},
			},
			required: ['kind', 'documentIds'],
		},
		sourceRevisions: {
			type: 'array',
			description:
				'Revision fingerprint for each source document, in the same order as scope.documentIds.',
			items: {
				type: 'object',
				description:
					'Document identity paired with the exact input revision used for analysis.',
				additionalProperties: false,
				properties: {
					documentId: {
						type: 'string',
						description:
							'Source identifier matching the corresponding scope.documentIds entry.',
					},
					revision: {
						type: 'string',
						description:
							'SHA-256 of the UTF-8 source representation identified by sourceFormat, before analysis.',
					},
				},
				required: ['documentId', 'revision'],
			},
		},
		engine: {
			type: 'object',
			description:
				'Selected analysis backend and fingerprints of its recorded configuration and author controls.',
			additionalProperties: false,
			properties: {
				name: {
					enum: ['narrative-lens', 'provider', 'scrivener-mcp'],
					description: 'Analysis backend family selected by the execution policy.',
				},
				version: {
					type: ['string', 'null'],
					description:
						'Installed Narrative Lens package version; null for provider or scrivener-mcp results.',
				},
				configurationHash: {
					type: 'string',
					description:
						'SHA-256 of canonical configuration, or request parameters for raw and local policies.',
				},
				controlsHash: {
					type: 'string',
					description:
						'SHA-256 of the complete canonical author-controls object recorded for this result.',
				},
			},
			required: ['name', 'version', 'configurationHash', 'controlsHash'],
		},
		policy: {
			type: 'object',
			description:
				'Declared control usage, provider access, manuscript mutation and source-freshness checks.',
			additionalProperties: false,
			properties: {
				mode: {
					enum: ['configured', 'raw', 'author-evidence', 'provider', 'local'],
					description:
						'Configured native analysis, raw native analysis, explicit author evidence, provider processing or local processing.',
				},
				usesSavedProjectControls: {
					type: 'boolean',
					description:
						'Whether configured or author-evidence analysis selected saved project controls.',
				},
				authorIntentionsApplied: {
					type: 'boolean',
					description:
						'Whether configured analysis included nonempty saved scene intentions.',
				},
				suppressionsApplied: {
					type: 'boolean',
					description:
						'Whether configured analysis included saved finding-suppression rules.',
				},
				allowsRawNativeAnalysis: {
					type: 'boolean',
					description:
						'Whether this request selected raw native analysis without saved project controls.',
				},
				providerAccess: {
					type: 'boolean',
					description:
						'Whether provider access was enabled for this operation; does not certify successful provider output.',
				},
				mutatesManuscript: {
					const: false,
					description:
						'Whether this operation edits manuscript text; always false for these envelopes.',
				},
				revisionChecked: {
					type: 'boolean',
					description:
						'Whether applicable saved-input revisions were rechecked before completion.',
				},
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
	description:
		'Action response containing a complete result or a lossless page of its serialized JSON.',
	properties: {
		action: {
			type: 'string',
			description: 'Action handled for this response; continuation pages use read_report.',
		},
		result: {
			type: 'object',
			description:
				'Complete action-specific result plus reportId, or a lossless JSON fragment. Continue fragments with analyze_manuscript_local action read_report; concatenate data then JSON.parse once.',
			properties: {
				reportId: {
					type: 'string',
					pattern: '^[a-f0-9]{64}$',
					description:
						'SHA-256 identity of the original action and serialized result; pass unchanged to read_report for cached pages.',
				},
				envelope: ANALYSIS_ENVELOPE_SCHEMA,
				encoding: {
					const: 'json-fragment',
					description: 'Identifies data as a fragment of JSON requiring reconstruction.',
				},
				data: {
					type: 'string',
					description:
						'Contiguous slice of the complete result JSON string; concatenate pages in order before parsing.',
				},
				pagination: {
					type: 'object',
					description:
						'Fragment positions in UTF-16 code units and the serialized tool-result byte budget.',
					additionalProperties: false,
					properties: {
						byteLimit: {
							type: 'integer',
							description:
								'Maximum UTF-8 bytes of the serialized tool result, including content and structuredContent; excludes JSON-RPC framing.',
						},
						start: {
							type: 'integer',
							description:
								'Inclusive zero-based UTF-16 code-unit offset into the complete serialized result JSON.',
						},
						end: {
							type: 'integer',
							description:
								'Exclusive UTF-16 code-unit offset immediately after this JSON fragment.',
						},
						total: {
							type: 'integer',
							description:
								'UTF-16 code-unit length of the complete serialized result JSON.',
						},
						nextCursor: {
							type: ['string', 'null'],
							description:
								'Pass unchanged as pageCursor with reportId to continue; null when end reaches total.',
						},
					},
					required: ['byteLimit', 'start', 'end', 'total', 'nextCursor'],
				},
			},
			required: ['reportId'],
			oneOf: [
				{
					description: 'Fragment response carrying JSON text and continuation positions.',
					required: ['encoding', 'data', 'pagination'],
				},
				{
					description: 'Complete action result with no fragment encoding marker.',
					not: { required: ['encoding'] },
				},
			],
		},
	},
	required: ['action', 'result'],
};
