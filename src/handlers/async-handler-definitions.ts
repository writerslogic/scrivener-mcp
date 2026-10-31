import { continuityFindingSchema } from './story-handlers.js';
import { requireProject } from './types.js';
/**
 * Async handler definitions for job queue operations
 */

import {
	MAX_ANALYSIS_CONTENT_LENGTH,
	MAX_ANALYSIS_DOCUMENTS,
	type JobType,
	type AnalyzeProjectJob,
} from '../services/queue/job-queue.js';
import { compact, formatPayload } from '../core/response-formatter.js';
import * as asyncHandlers from './async-handlers.js';
import {
	ANALYSIS_ENVELOPE_SCHEMA,
	RESULT_REFERENCE_SCHEMA,
	SHARED_DEFS,
} from './shared-schemas.js';
import { MAX_SUGGESTION_PROMPT } from '../services/ai/writing-suggestions.js';
import {
	MAX_STYLE_SAMPLES,
	MAX_STYLE_SAMPLE_LENGTH,
	MAX_STYLE_CONTEXT,
	STYLE_FIELDS,
	STYLE_SCALARS,
	STYLE_LISTS,
} from '../services/ai/writing-style.js';
import type { ToolDefinition } from './types.js';

const prioritySchema = {
	type: 'integer' as const,
	minimum: 0,
	maximum: 2097151,
	description:
		'Default 0 runs before prioritized jobs; lower positive numbers run sooner. Nonzero priorities require Redis or KeyDB.',
};

const analysisContentSchema = { ...SHARED_DEFS.content, maxLength: MAX_ANALYSIS_CONTENT_LENGTH };
const analysisDocumentIdSchema = { ...SHARED_DEFS.docId, minLength: 1, maxLength: 255 };

const styleResultSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		analysis: {
			type: 'object',
			additionalProperties: false,
			properties: {
				...Object.fromEntries(
					STYLE_SCALARS.map((field) => [field, { type: ['string', 'null'] }])
				),
				...Object.fromEntries(
					STYLE_LISTS.map((field) => [
						field,
						{ type: ['array', 'null'], items: { type: 'string' } },
					])
				),
			},
			required: STYLE_FIELDS,
		},
		availability: {
			type: 'object',
			additionalProperties: false,
			properties: {
				status: { enum: ['available', 'partial', 'unavailable'] },
				unavailableFields: {
					type: 'array',
					items: { enum: STYLE_FIELDS },
					uniqueItems: true,
				},
				partialFields: {
					type: 'array',
					items: { enum: [...STYLE_LISTS] },
					uniqueItems: true,
				},
			},
			required: ['status', 'unavailableFields', 'partialFields'],
		},
		coverage: {
			type: 'object',
			additionalProperties: false,
			properties: {
				truncated: { type: 'boolean' },
				samples: {
					type: 'array',
					minItems: 1,
					maxItems: MAX_STYLE_SAMPLES,
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							sampleId: {
								type: 'string',
								description:
									'Positional supplied-text identity, sample-1 through sample-64; not a saved binder ID.',
							},
							revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
							start: { const: 0 },
							end: { type: 'integer', minimum: 0, maximum: MAX_STYLE_CONTEXT },
							sourceCharacters: {
								type: 'integer',
								minimum: 1,
								maximum: MAX_STYLE_SAMPLE_LENGTH,
							},
							truncated: { type: 'boolean' },
						},
						required: [
							'sampleId',
							'revision',
							'start',
							'end',
							'sourceCharacters',
							'truncated',
						],
					},
				},
			},
			required: ['truncated', 'samples'],
		},
		envelope: ANALYSIS_ENVELOPE_SCHEMA,
	},
	required: ['analysis', 'availability', 'coverage', 'envelope'],
};

export const asyncHandlerDefinitions: ToolDefinition[] = [
	{
		name: 'queue_document_analysis',
		title: 'Queue Document Analysis',
		description:
			'Enqueue local analysis of supplied text with a SHA-256 source revision and raw policy. ' +
			'Base prose analysis always runs; readability is included by default. Optional named entities require a local Narrative Lens NER model; sentiment uses a local lexicon heuristic. Unavailable sections are explicit. ' +
			'return a job id immediately without blocking. Poll the job with get_job_status and request cancellation ' +
			'with cancel_job. Use this for large documents where a synchronous analyze_document call ' +
			'would be slow; use analyze_document directly for quick, inline results.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				documentId: analysisDocumentIdSchema,
				content: analysisContentSchema,
				options: {
					type: 'object',
					additionalProperties: false,
					description:
						'Optional result sections and scheduling priority; base prose analysis always runs.',
					properties: {
						includeReadability: {
							type: 'boolean',
							default: true,
							description: 'Include readability scoring. Default true.',
						},
						includeEntities: {
							type: 'boolean',
							default: false,
							description:
								'Include native named-entity extraction or an explicit unavailable result when the native build or model is unavailable. Default false.',
						},
						includeSentiment: {
							type: 'boolean',
							default: false,
							description:
								'Include local lexicon sentiment scores; these are heuristic signals, not model probabilities. Default false.',
						},
						priority: prioritySchema,
					},
				},
			},
			required: ['documentId', 'content'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				jobId: {
					type: 'string',
					description: 'Identifier of the queued job; poll it with get_job_status.',
				},
			},
			required: ['jobId'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.queueDocumentAnalysis(
				args as {
					documentId: string;
					content: string;
					options?: {
						includeReadability?: boolean;
						includeEntities?: boolean;
						includeSentiment?: boolean;
						priority?: number;
					};
				}
			);
			return {
				content: [
					{
						type: 'text',
						text: compact(result),
					},
				],
				structuredContent: result,
			};
		},
	},
	{
		name: 'queue_project_analysis',
		title: 'Queue Project Analysis',
		description:
			'Enqueue local analysis of 1–5000 supplied document texts, preserving input order and a source revision per document, and return a job id ' +
			'immediately. Poll progress with get_job_status and request cancellation with cancel_job. Use this to ' +
			'analyze a whole manuscript or large set of documents; for a single document prefer ' +
			'queue_document_analysis or the synchronous analyze_document.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				projectId: {
					type: 'string',
					minLength: 1,
					maxLength: 255,
					description:
						'Caller-supplied project label. The result envelope separately identifies the selected queue project; supplied text is not read from or checked against saved documents.',
				},
				documents: {
					type: 'array',
					minItems: 1,
					maxItems: MAX_ANALYSIS_DOCUMENTS,
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							id: analysisDocumentIdSchema,
							content: analysisContentSchema,
						},
						required: ['id', 'content'],
					},
					description:
						'Array of documents (id and content) to include in the batch analysis.',
				},
				options: {
					type: 'object',
					additionalProperties: false,
					description: 'Optional batch execution settings.',
					properties: {
						parallel: {
							type: 'boolean',
							description:
								'Process documents concurrently rather than sequentially. Default false.',
						},
						batchSize: {
							type: 'integer',
							minimum: 1,
							maximum: 5,
							description:
								'Maximum concurrent documents when parallel is true. Default 5. Sequential execution uses one document at a time.',
						},
						priority: prioritySchema,
					},
				},
			},
			required: ['projectId', 'documents'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				jobId: {
					type: 'string',
					description: 'Identifier of the queued batch job; poll it with get_job_status.',
				},
			},
			required: ['jobId'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.queueProjectAnalysis(
				args as {
					projectId: string;
					documents: AnalyzeProjectJob['documents'];
					options?: {
						parallel?: boolean;
						batchSize?: number;
						priority?: number;
					};
				}
			);
			return {
				content: [
					{
						type: 'text',
						text: compact(result),
					},
				],
				structuredContent: result,
			};
		},
	},
	{
		name: 'suggest_improvements',
		title: 'Suggest Improvements',
		description:
			'Generate AI writing suggestions for a prompt or a specific document — ideas for revision, ' +
			'next steps, or alternatives. Returns suggestion text, context coverage and a provenance envelope; large results use read_result references. ' +
			'With useContext, sends up to the first 16000 UTF-16 characters of the saved document to the configured provider, checking its revision before and after generation. ' +
			'Queued jobs return the same result through get_job_status and are not automatically retried. Use this for generative "how could this be better" help; use ' +
			'analyze_document for structured metrics or check_consistency to find contradictions.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				prompt: {
					type: 'string',
					minLength: 1,
					maxLength: MAX_SUGGESTION_PROMPT,
					description:
						'What to get suggestions about, e.g. "tighten the opening paragraph".',
				},
				documentId: analysisDocumentIdSchema,
				useContext: {
					type: 'boolean',
					description:
						'Use the saved document identified by documentId, which is required when true. Default false; no manuscript context is sent when false.',
					default: false,
				},
				async: {
					type: 'boolean',
					description:
						'Run as a background job and return a job id instead of waiting. Default false.',
				},
			},
			required: ['prompt'],
			allOf: [
				{
					if: { properties: { useContext: { const: true } }, required: ['useContext'] },
					then: { required: ['documentId'] },
				},
			],
		},
		outputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				suggestions: { type: 'string' },
				envelope: ANALYSIS_ENVELOPE_SCHEMA,
				context: {
					oneOf: [
						{
							type: 'object',
							additionalProperties: false,
							properties: { mode: { const: 'none' } },
							required: ['mode'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								mode: { const: 'saved-document' },
								start: { const: 0 },
								end: { type: 'integer', minimum: 0, maximum: 16000 },
								sourceCharacters: { type: 'integer', minimum: 0 },
								truncated: { type: 'boolean' },
							},
							required: ['mode', 'start', 'end', 'sourceCharacters', 'truncated'],
						},
					],
				},
				jobId: { type: 'string' },
				message: { type: 'string' },
				...RESULT_REFERENCE_SCHEMA.properties,
			},
			oneOf: [
				{ required: ['suggestions', 'envelope', 'context'] },
				{ required: ['jobId', 'message'] },
				{ required: RESULT_REFERENCE_SCHEMA.required },
			],
		},
		handler: async (args) => {
			const result = await asyncHandlers.generateSuggestions(
				args as {
					prompt: string;
					documentId?: string;
					useContext?: boolean;
					async?: boolean;
				}
			);
			const text = formatPayload(result, 'writing-suggestions');
			return {
				content: [
					{
						type: 'text',
						text,
					},
				],
				structuredContent: JSON.parse(text),
			};
		},
	},
	{
		name: 'analyze_writing_style',
		title: 'Analyze Writing Style',
		description:
			'Analyze the prose style of one or more text samples — sentence variety, tone, voice, ' +
			'pacing, and other stylistic features — using the configured provider or client sampling. Sends at most 8000 UTF-16 characters, including sample separators. ' +
			'Returns a structured style profile with field availability, exact sample coverage, supplied-text revisions and a provenance envelope; large results use read_result references. Use this to ' +
			'characterize how something is written; use analyze_document for document-level metrics or ' +
			'check_plot_consistency for narrative coherence.',
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
				samples: {
					type: 'array',
					minItems: 1,
					maxItems: MAX_STYLE_SAMPLES,
					items: { type: 'string', minLength: 1, maxLength: MAX_STYLE_SAMPLE_LENGTH },
					description:
						'Array of text samples (strings) to analyze. Provide one or more passages of prose.',
				},
			},
			required: ['samples'],
		},
		outputSchema: {
			type: 'object',
			properties: {},
			oneOf: [styleResultSchema, RESULT_REFERENCE_SCHEMA],
		},
		handler: async (args) => {
			const result = await asyncHandlers.analyzeWritingStyle(
				args as {
					samples: string[];
				}
			);
			const text = formatPayload(result, 'writing-style');
			return {
				content: [
					{
						type: 'text',
						text,
					},
				],
				structuredContent: JSON.parse(text),
			};
		},
	},
	{
		name: 'check_plot_consistency',
		title: 'Check Plot Consistency',
		description:
			'Analyze saved manuscript revisions using the same local, evidence-backed continuity and curated canon service as check_consistency. Inference and uncertainty stay explicit. Optional background execution returns identical report semantics; keyword counts and character absences are not treated as contradictions.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				documents: {
					type: 'array',
					minItems: 1,
					maxItems: 5000,
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', minLength: 1, maxLength: 128 },
							content: { type: 'string', maxLength: 10000000 },
						},
						required: ['id'],
					},
					description:
						'Saved manuscript document IDs. Optional content must match the saved text; external or unsaved text is rejected.',
				},
				async: {
					type: 'boolean',
					description:
						'Run as a background job and return a job id instead of waiting. Default false.',
				},
			},
			required: ['documents'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				issues: {
					type: 'array',
					description:
						'Canonical continuity findings with quoted evidence and saved revisions.',
					items: continuityFindingSchema,
				},
				coverage: {
					type: 'string',
					description: 'Actual local analysis coverage and limitations.',
				},
				jobId: {
					type: 'string',
					description: 'Identifier of the queued job (present when run asynchronously).',
				},
				message: {
					type: 'string',
					description: 'Human-readable status message.',
				},
			},
		},
		handler: async (args, context) => {
			const result = await asyncHandlers.checkPlotConsistency(
				args as {
					documents: Array<{ id: string; content?: string }>;
					async?: boolean;
				},
				requireProject(context).getEditorialServices()
			);
			return {
				content: [
					{
						type: 'text',
						text: compact(result),
					},
				],
				structuredContent: result as Record<string, unknown>,
			};
		},
	},
	{
		name: 'get_job_status',
		title: 'Get Job Status',
		description:
			'Look up the status and progress of a background job previously started by ' +
			'queue_document_analysis, queue_project_analysis, or another async tool. Returns the job ' +
			'state (queued, running, completed, failed), progress, and result when finished. Poll this ' +
			'after enqueuing work; use cancel_job to request cancellation.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				jobType: {
					type: 'string',
					description: 'The kind of job, as returned when the job was enqueued.',
					enum: [
						'analyze_document',
						'analyze_project',
						'generate_suggestions',
						'build_vector_store',
						'check_consistency',
						'sync_database',
						'export_project',
						'batch_analysis',
					],
				},
				jobId: {
					type: 'string',
					description: 'The job id returned when the job was enqueued.',
				},
			},
			required: ['jobType', 'jobId'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				state: {
					type: 'string',
					description:
						'Current job state (e.g. queued, running, completed, failed, not_found).',
				},
				progress: {
					type: 'number',
					description: 'Completion progress of the job.',
				},
				result: {
					description:
						'Completed result, or an opaque _ref for large results. Retrieve _ref with read_result, follow nextOffset, concatenate text, then JSON.parse. References expire after one hour or server restart.',
				},
				error: {
					type: 'string',
					description: 'Failure reason when the job failed or was not found.',
				},
			},
			required: ['state', 'progress'],
		},
		handler: async (args) => {
			const status = await asyncHandlers.getJobStatus(
				args as {
					jobType: JobType;
					jobId: string;
				}
			);
			const result = {
				...status,
				...(status.result !== undefined
					? { result: JSON.parse(formatPayload(status.result, 'job-result')) }
					: {}),
			};
			return {
				content: [
					{
						type: 'text',
						text: compact(result),
					},
				],
				structuredContent: result as Record<string, unknown>,
			};
		},
	},
	{
		name: 'cancel_job',
		title: 'Cancel Job',
		description:
			'Cancel background work by its type and id. Embedded jobs cancelled before execution do not run; already running embedded work finishes internally and its result is discarded. Redis/KeyDB jobs must be waiting or delayed to be removed; active-job cancellation can fail. Unknown or foreign jobs return an error. Use ' +
			'get_job_status first to check whether a job is still in progress.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				jobType: {
					type: 'string',
					description: 'The kind of job, as returned when the job was enqueued.',
				},
				jobId: {
					type: 'string',
					description: 'The job id returned when the job was enqueued.',
				},
			},
			required: ['jobType', 'jobId'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.cancelJob(
				args as {
					jobType: JobType;
					jobId: string;
				}
			);
			return {
				content: [
					{
						type: 'text',
						text: compact(result),
					},
				],
			};
		},
	},
	{
		name: 'get_queue_stats',
		title: 'Inspect Project Queues',
		description:
			'Inspect background queue counts, backend connectivity and the current project scope. ' +
			'Reports excluded legacy queues and migration guidance without processing or modifying jobs.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				jobType: {
					type: 'string',
					description: 'Optional job type to inspect; omit to report all project queues.',
				},
			},
			required: [],
		},
		outputSchema: {
			type: 'object',
			properties: {
				queues: {
					type: 'array',
					description: 'Selected project queue counts.',
					items: { type: 'object' },
				},
				connection: {
					type: 'object',
					description: 'Backend, project scope, and legacy-queue migration notice.',
					properties: {
						type: { type: 'string', description: 'Selected queue backend.' },
						isConnected: {
							type: 'boolean',
							description: 'Whether the selected backend is connected.',
						},
						scopeId: {
							type: 'string',
							description:
								'Opaque identity binding queues to this project and location.',
						},
						legacyQueues: {
							type: 'string',
							enum: ['excluded'],
							description: 'Unscoped legacy queues remain excluded from execution.',
						},
						migrationNotice: {
							type: 'string',
							description: 'Guidance for deliberately requeuing legacy work.',
						},
					},
					required: ['type', 'isConnected', 'legacyQueues', 'migrationNotice'],
				},
			},
			required: ['queues', 'connection'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.getQueueStats(args);
			return {
				structuredContent: result,
				content: [
					{
						type: 'text',
						text: compact(result),
					},
				],
			};
		},
	},
];
