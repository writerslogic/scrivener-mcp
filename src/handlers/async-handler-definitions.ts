/**
 * Async handler definitions for job queue operations
 */

import type { JobType } from '../services/queue/job-queue.js';
import type { ScrivenerDocument } from '../types/index.js';
import { compact } from '../core/response-formatter.js';
import { safeStringify } from '../utils/common.js';
import * as asyncHandlers from './async-handlers.js';
import { SHARED_DEFS } from './shared-schemas.js';
import type { ToolDefinition } from './types.js';

export const asyncHandlerDefinitions: ToolDefinition[] = [
	{
		name: 'queue_document_analysis',
		description: 'Queue async NLP analysis',
		inputSchema: {
			type: 'object',
			properties: {
				documentId: SHARED_DEFS.docId,
				content: SHARED_DEFS.content,
				options: {
					type: 'object',
					properties: {
						includeReadability: { type: 'boolean' },
						includeEntities: { type: 'boolean' },
						includeSentiment: { type: 'boolean' },
						priority: { type: 'number' },
					},
				},
			},
			required: ['documentId', 'content'],
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
			};
		},
	},
	{
		name: 'queue_project_analysis',
		description: 'Queue batch project analysis',
		inputSchema: {
			type: 'object',
			properties: {
				projectId: { type: 'string' },
				documents: { type: 'array' },
				options: {
					type: 'object',
					properties: {
						parallel: { type: 'boolean' },
						batchSize: { type: 'number' },
						priority: { type: 'number' },
					},
				},
			},
			required: ['projectId', 'documents'],
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
			};
		},
	},
	{
		name: 'generate_ai_suggestions',
		description: 'Generate writing suggestions',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: { type: 'string' },
				documentId: SHARED_DEFS.docId,
				useContext: { type: 'boolean' },
				async: { type: 'boolean' },
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
		description: 'Analyze writing style',
		inputSchema: {
			type: 'object',
			properties: {
				samples: { type: 'array' },
			},
			required: ['samples'],
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
			};
		},
	},
	{
		name: 'check_plot_consistency',
		description: 'Check plot consistency',
		inputSchema: {
			type: 'object',
			properties: {
				documents: { type: 'array' },
				async: { type: 'boolean' },
			},
			required: ['documents'],
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
			};
		},
	},
	{
		name: 'get_job_status',
		description: 'Get queued job status',
		inputSchema: {
			type: 'object',
			properties: {
				jobType: {
					type: 'string',
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
				jobId: { type: 'string' },
			},
			required: ['jobType', 'jobId'],
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
			};
		},
	},
	{
		name: 'cancel_job',
		description: 'Cancel a queued job',
		inputSchema: {
			type: 'object',
			properties: {
				jobType: { type: 'string' },
				jobId: { type: 'string' },
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
