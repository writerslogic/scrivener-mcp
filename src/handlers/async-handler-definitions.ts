/**
 * Async handler definitions for job queue operations
 */

import type { ToolDefinition } from './types.js';
import * as asyncHandlers from './async-handlers.js';
import { safeStringify } from '../utils/common.js';

export const asyncHandlerDefinitions: ToolDefinition[] = [
	{
		name: 'queue_document_analysis',
		description: 'Queue a document for async analysis with advanced NLP features',
		inputSchema: {
			type: 'object',
			properties: {
				documentId: { type: 'string', description: 'Document ID' },
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
			const result = await asyncHandlers.queueDocumentAnalysis(args);
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
		description: 'Queue entire project for batch analysis',
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
			const result = await asyncHandlers.queueProjectAnalysis(args);
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
		name: 'build_vector_store',
		description: 'Build vector store for semantic search using LangChain',
		inputSchema: {
			type: 'object',
			properties: {
				documents: { type: 'array', description: 'Documents to index' },
				rebuild: { type: 'boolean', description: 'Rebuild from scratch' },
			},
			required: ['documents'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.buildVectorStore(args);
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
		name: 'semantic_search',
		description: 'Perform semantic search across indexed documents',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query' },
				topK: { type: 'number', description: 'Number of results' },
			},
			required: ['query'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.semanticSearch(args);
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
		description: 'Generate AI-powered writing suggestions with context',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: { type: 'string', description: 'Prompt for suggestions' },
				documentId: { type: 'string' },
				useContext: { type: 'boolean', description: 'Use document context' },
				async: { type: 'boolean', description: 'Process asynchronously' },
			},
			required: ['prompt'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.generateSuggestions(args);
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
		description: 'Analyze writing style using AI',
		inputSchema: {
			type: 'object',
			properties: {
				samples: {
					type: 'array',
					description: 'Writing samples to analyze',
				},
			},
			required: ['samples'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.analyzeWritingStyle(args);
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
		description: 'Check for plot inconsistencies across documents',
		inputSchema: {
			type: 'object',
			properties: {
				documents: { type: 'array' },
				async: { type: 'boolean' },
			},
			required: ['documents'],
		},
		handler: async (args) => {
			const result = await asyncHandlers.checkPlotConsistency(args);
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
		description: 'Get status of a queued job',
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
			const result = await asyncHandlers.getJobStatus(args);
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
			const result = await asyncHandlers.cancelJob(args);
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
		description: 'Get statistics for job queues',
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
