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
			'Scan a set of documents for plot-level inconsistencies — timeline conflicts, contradicted ' +
			'facts, dropped threads — and return the issues found with the documents involved. Use this ' +
			'for story/plot coherence across chapters; use check_consistency for general consistency ' +
			'checks or analyze_writing_style for prose-level analysis.',
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
					description:
						'Array of documents (id and content) to check together, e.g. the chapters of a manuscript.',
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
					description: 'Plot-level inconsistencies found (present for synchronous runs).',
					items: {
						type: 'object',
						properties: {
							issue: {
								type: 'string',
								description: 'Description of the inconsistency.',
							},
							severity: {
								type: 'string',
								description: 'Severity of the issue.',
								enum: ['low', 'medium', 'high'],
							},
							locations: {
								type: 'array',
								description: 'Document ids involved in the issue.',
								items: { type: 'string' },
							},
							suggestion: {
								type: 'string',
								description: 'Suggested way to resolve the issue.',
							},
						},
					},
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
		handler: async (args) => {
			const result = await asyncHandlers.checkPlotConsistency(
				args as {
					documents: ScrivenerDocument[];
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
		description: 'Get job queue statistics',
		inputSchema: {
			type: 'object',
			properties: {
				jobType: { type: 'string' },
			},
			required: [],
		},
		handler: async (args) => {
			const result = await asyncHandlers.getQueueStats(args);
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
];
