import { continuityFindingSchema } from './story-handlers.js';
import { requireProject } from './types.js';
/**
 * Async handler definitions for job queue operations
 */

import type { JobType } from '../services/queue/job-queue.js';
import type { ScrivenerDocument } from '../types/index.js';
import { compact } from '../core/response-formatter.js';
import * as asyncHandlers from './async-handlers.js';
import { SHARED_DEFS } from './shared-schemas.js';
import type { ToolDefinition } from './types.js';

export const asyncHandlerDefinitions: ToolDefinition[] = [
	{
		name: 'queue_document_analysis',
		title: 'Queue Document Analysis',
		description:
			'Enqueue a background NLP analysis of one document (readability, entities, sentiment) and ' +
			'return a job id immediately without blocking. Poll the job with get_job_status and stop it ' +
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
			properties: {
				documentId: SHARED_DEFS.docId,
				content: SHARED_DEFS.content,
				options: {
					type: 'object',
					description:
						'Optional flags selecting which analyses to run and the job priority.',
					properties: {
						includeReadability: {
							type: 'boolean',
							description: 'Include readability scoring. Default false.',
						},
						includeEntities: {
							type: 'boolean',
							description:
								'Include named-entity extraction (characters, places). Default false.',
						},
						includeSentiment: {
							type: 'boolean',
							description: 'Include sentiment analysis. Default false.',
						},
						priority: {
							type: 'number',
							description: 'Queue priority; higher runs sooner. Default 0.',
						},
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
				structuredContent: { jobId: result.jobId },
			};
		},
	},
	{
		name: 'queue_project_analysis',
		title: 'Queue Project Analysis',
		description:
			'Enqueue a background batch analysis across many documents at once and return a job id ' +
			'immediately. Poll progress with get_job_status and stop it with cancel_job. Use this to ' +
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
			properties: {
				projectId: {
					type: 'string',
					description: 'Identifier of the project the documents belong to.',
				},
				documents: {
					type: 'array',
					description:
						'Array of documents (id and content) to include in the batch analysis.',
				},
				options: {
					type: 'object',
					description: 'Optional batch execution settings.',
					properties: {
						parallel: {
							type: 'boolean',
							description:
								'Process documents concurrently rather than sequentially. Default false.',
						},
						batchSize: {
							type: 'number',
							description:
								'Number of documents per batch when processing in parallel.',
						},
						priority: {
							type: 'number',
							description: 'Queue priority; higher runs sooner. Default 0.',
						},
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
					documents: ScrivenerDocument[];
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
				structuredContent: { jobId: result.jobId },
			};
		},
	},
	{
		name: 'suggest_improvements',
		title: 'Suggest Improvements',
		description:
			'Generate AI writing suggestions for a prompt or a specific document — ideas for revision, ' +
			'next steps, or alternatives. Returns suggestion text. Optionally grounds the suggestions in ' +
			'a document\'s content. Use this for generative "how could this be better" help; use ' +
			'analyze_document for structured metrics or check_consistency to find contradictions.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					description:
						'What to get suggestions about, e.g. "tighten the opening paragraph".',
				},
				documentId: SHARED_DEFS.docId,
				useContext: {
					type: 'boolean',
					description:
						"Ground suggestions in the referenced document's content. Default false.",
				},
				async: {
					type: 'boolean',
					description:
						'Run as a background job and return a job id instead of waiting. Default false.',
				},
			},
			required: ['prompt'],
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
		name: 'analyze_writing_style',
		title: 'Analyze Writing Style',
		description:
			'Analyze the prose style of one or more text samples — sentence variety, tone, voice, ' +
			'pacing, and other stylistic features — and return a structured style profile. Use this to ' +
			'characterize how something is written; use analyze_document for document-level metrics or ' +
			'check_plot_consistency for narrative coherence.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				samples: {
					type: 'array',
					description:
						'Array of text samples (strings) to analyze. Provide one or more passages of prose.',
				},
			},
			required: ['samples'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				analysis: {
					type: 'object',
					description:
						'Structured style profile of the samples (sentence variety, tone, voice, pacing, and other stylistic features).',
				},
			},
			required: ['analysis'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.analyzeWritingStyle(
				args as {
					samples: string[];
				}
			);
			return {
				content: [
					{
						type: 'text',
						text: compact(result),
					},
				],
				structuredContent: { analysis: result.analysis },
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
			'after enqueuing work; use cancel_job to stop a job.',
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
					description: 'Job result when the job has completed.',
				},
				error: {
					type: 'string',
					description: 'Failure reason when the job failed or was not found.',
				},
			},
			required: ['state', 'progress'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.getJobStatus(
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
				structuredContent: result as Record<string, unknown>,
			};
		},
	},
	{
		name: 'cancel_job',
		title: 'Cancel Job',
		description:
			'Cancel a queued or running background job by its type and id. Returns whether the ' +
			'cancellation succeeded. Cancelling an already-finished or unknown job is harmless. Use ' +
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
