/**
 * Async handler definitions for job queue operations
 */

import type { JobType } from '../services/queue/job-queue.js';
import type { ScrivenerDocument } from '../types/index.js';
import { safeStringify } from '../utils/common.js';
import * as asyncHandlers from './async-handlers.js';
import type { ToolDefinition } from './types.js';

export const asyncHandlerDefinitions: ToolDefinition[] = [
	{
		name: 'queue_document_analysis',
		description: 'Queue document for async NLP analysis',
		inputSchema: {
			type: 'object',
			properties: {
				documentId: { type: 'string', description: 'Document UUID' },
				content: { type: 'string', description: 'Document content' },
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
						text: safeStringify(result) || JSON.stringify(result, null, 2),
					},
				],
			};
		},
	},
	{
		name: 'queue_project_analysis',
		description: 'Queue project for batch analysis',
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
						text: safeStringify(result) || JSON.stringify(result, null, 2),
					},
				],
			};
		},
	},
	{
		name: 'generate_ai_suggestions',
		description: 'Generate AI writing suggestions',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: { type: 'string', description: 'Suggestion prompt' },
				documentId: { type: 'string' },
				useContext: { type: 'boolean', description: 'Use document context' },
				async: { type: 'boolean', description: 'Run async' },
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
						text: safeStringify(result) || JSON.stringify(result, null, 2),
					},
				],
			};
		},
	},
	{
		name: 'analyze_writing_style',
		description: 'Analyze writing style via AI',
		inputSchema: {
			type: 'object',
			properties: {
				samples: {
					type: 'array',
					description: 'Writing samples',
				},
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
						text: safeStringify(result) || JSON.stringify(result, null, 2),
					},
				],
			};
		},
	},
	{
		name: 'check_plot_consistency',
		description: 'Check plot consistency across documents',
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
						text: safeStringify(result) || JSON.stringify(result, null, 2),
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
						text: safeStringify(result) || JSON.stringify(result, null, 2),
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
						text: safeStringify(result) || JSON.stringify(result, null, 2),
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
						text: safeStringify(result) || JSON.stringify(result, null, 2),
					},
				],
			};
		},
	},
];
