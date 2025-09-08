/**
 * Async handlers for job queue operations
 * Provides MCP handlers for async processing with BullMQ
 */

import { JobQueueService, JobType } from '../services/queue/job-queue.js';
import { LangChainService } from '../services/ai/langchain-service.js';
import { createError, ErrorCode } from '../core/errors.js';
import { validateInput } from '../utils/common.js';
import { getLogger } from '../core/logger.js';
import type { ScrivenerDocument } from '../types/index.js';

let jobQueueService: JobQueueService | null = null;
let langchainService: LangChainService | null = null;
const logger = getLogger('async-handlers');

/**
 * Initialize async services
 */
export async function initializeAsyncServices(options: {
	redisUrl?: string;
	openaiApiKey?: string;
	databasePath?: string;
	neo4jUri?: string;
} = {}): Promise<void> {
	try {
		// Initialize job queue if Redis is available
		if (options.redisUrl || process.env.REDIS_URL) {
			jobQueueService = new JobQueueService(options.redisUrl || process.env.REDIS_URL);
			await jobQueueService.initialize({
				langchainApiKey: options.openaiApiKey,
				databasePath: options.databasePath,
				neo4jUri: options.neo4jUri,
			});
			logger.info('Job queue service initialized');
		}

		// Initialize LangChain service if API key is available
		if (options.openaiApiKey || process.env.OPENAI_API_KEY) {
			langchainService = new LangChainService(options.openaiApiKey);
			logger.info('LangChain service initialized');
		}
	} catch (error) {
		logger.warn('Failed to initialize async services', { error });
		// Don't throw - allow app to run without async features
	}
}

/**
 * Queue document analysis job
 */
export async function queueDocumentAnalysis(params: {
	documentId: string;
	content: string;
	options?: {
		includeReadability?: boolean;
		includeEntities?: boolean;
		includeSentiment?: boolean;
		priority?: number;
	};
}): Promise<{ jobId: string; message: string }> {
	validateInput(params, { documentId: { required: true }, content: { required: true } });

	if (!jobQueueService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'Job queue service not available. Please configure Redis.'
		);
	}

	const jobId = await jobQueueService.addJob(
		JobType.ANALYZE_DOCUMENT,
		{
			documentId: params.documentId,
			content: params.content,
			options: params.options,
		},
		{
			priority: params.options?.priority,
		}
	);

	return {
		jobId,
		message: `Document analysis queued with job ID: ${jobId}`,
	};
}

/**
 * Queue project analysis job
 */
export async function queueProjectAnalysis(params: {
	projectId: string;
	documents: ScrivenerDocument[];
	options?: {
		parallel?: boolean;
		batchSize?: number;
		priority?: number;
	};
}): Promise<{ jobId: string; message: string; estimatedTime?: number }> {
	validateInput(params, { projectId: { required: true }, documents: { required: true } });

	if (!jobQueueService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'Job queue service not available'
		);
	}

	const jobId = await jobQueueService.addJob(
		JobType.ANALYZE_PROJECT,
		{
			projectId: params.projectId,
			documents: params.documents,
			options: params.options,
		},
		{
			priority: params.options?.priority,
		}
	);

	// Estimate processing time (rough estimate: 2 seconds per document)
	const estimatedTime = params.documents.length * 2;

	return {
		jobId,
		message: `Project analysis queued with ${params.documents.length} documents`,
		estimatedTime,
	};
}

/**
 * Build vector store for semantic search
 */
export async function buildVectorStore(params: {
	documents: ScrivenerDocument[];
	rebuild?: boolean;
}): Promise<{ jobId?: string; message: string }> {
	validateInput(params, { documents: { required: true } });

	// If job queue is available, use it
	if (jobQueueService) {
		const jobId = await jobQueueService.addJob(
			JobType.BUILD_VECTOR_STORE,
			{ documents: params.documents },
			{ priority: 1 } // High priority
		);

		return {
			jobId,
			message: `Vector store build queued with ${params.documents.length} documents`,
		};
	}

	// Otherwise, process synchronously with LangChain
	if (!langchainService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'LangChain service not available'
		);
	}

	if (params.rebuild) {
		langchainService.clearMemory();
	}

	await langchainService.buildVectorStore(params.documents);

	return {
		message: `Vector store built with ${params.documents.length} documents`,
	};
}

/**
 * Perform semantic search
 */
export async function semanticSearch(params: {
	query: string;
	topK?: number;
}): Promise<{
	results: Array<{
		content: string;
		metadata: Record<string, unknown>;
		score?: number;
	}>;
}> {
	validateInput(params, { query: { required: true } });

	if (!langchainService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'LangChain service not available'
		);
	}

	const results = await langchainService.semanticSearch(
		params.query,
		params.topK || 5
	);

	return {
		results: results.map(doc => ({
			content: doc.pageContent,
			metadata: doc.metadata,
		})),
	};
}

/**
 * Generate AI suggestions with context
 */
export async function generateSuggestions(params: {
	prompt: string;
	documentId?: string;
	useContext?: boolean;
	async?: boolean;
}): Promise<{ jobId?: string; suggestions?: string; message?: string }> {
	validateInput(params, { prompt: { required: true } });

	// If async is requested and job queue is available
	if (params.async && jobQueueService) {
		const jobId = await jobQueueService.addJob(
			JobType.GENERATE_SUGGESTIONS,
			{
				documentId: params.documentId,
				prompt: params.prompt,
			},
			{ priority: 2 }
		);

		return {
			jobId,
			message: 'Suggestion generation queued',
		};
	}

	// Otherwise, process synchronously
	if (!langchainService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'LangChain service not available'
		);
	}

	const suggestions = params.useContext
		? await langchainService.generateWithContext(params.prompt)
		: await langchainService.generateWithContext(params.prompt, { topK: 0 });

	return { suggestions };
}

/**
 * Analyze writing style
 */
export async function analyzeWritingStyle(params: {
	samples: string[];
}): Promise<{ analysis: Record<string, unknown> }> {
	validateInput(params, { samples: { required: true } });

	if (!langchainService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'LangChain service not available'
		);
	}

	const analysis = await langchainService.analyzeWritingStyle(params.samples);

	return { analysis };
}

/**
 * Check plot consistency
 */
export async function checkPlotConsistency(params: {
	documents: ScrivenerDocument[];
	async?: boolean;
}): Promise<{
	jobId?: string;
	issues?: Array<{
		issue: string;
		severity: 'low' | 'medium' | 'high';
		locations: string[];
		suggestion: string;
	}>;
	message?: string;
}> {
	validateInput(params, { documents: { required: true } });

	// If async is requested and job queue is available
	if (params.async && jobQueueService) {
		const jobId = await jobQueueService.addJob(
			JobType.CHECK_CONSISTENCY,
			{ documents: params.documents },
			{ priority: 3 }
		);

		return {
			jobId,
			message: 'Consistency check queued',
		};
	}

	// Otherwise, process synchronously
	if (!langchainService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'LangChain service not available'
		);
	}

	const issues = await langchainService.checkPlotConsistency(params.documents);

	return { issues };
}

/**
 * Get job status
 */
export async function getJobStatus(params: {
	jobType: JobType;
	jobId: string;
}): Promise<{
	state: string;
	progress: number;
	result?: unknown;
	error?: string;
}> {
	validateInput(params, { jobType: { required: true }, jobId: { required: true } });

	if (!jobQueueService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'Job queue service not available'
		);
	}

	return await jobQueueService.getJobStatus(params.jobType, params.jobId);
}

/**
 * Cancel a job
 */
export async function cancelJob(params: {
	jobType: JobType;
	jobId: string;
}): Promise<{ message: string }> {
	validateInput(params, { jobType: { required: true }, jobId: { required: true } });

	if (!jobQueueService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'Job queue service not available'
		);
	}

	await jobQueueService.cancelJob(params.jobType, params.jobId);

	return { message: `Job ${params.jobId} cancelled` };
}

/**
 * Get queue statistics
 */
export async function getQueueStats(params: {
	jobType?: JobType;
}): Promise<{
	queues: Array<{
		type: JobType;
		stats: {
			waiting: number;
			active: number;
			completed: number;
			failed: number;
			delayed: number;
		};
	}>;
}> {
	if (!jobQueueService) {
		throw createError(
			ErrorCode.AI_SERVICE_ERROR,
			null,
			'Job queue service not available'
		);
	}

	const queues: Array<{
		type: JobType;
		stats: {
			waiting: number;
			active: number;
			completed: number;
			failed: number;
			delayed: number;
		};
	}> = [];

	if (params.jobType) {
		// Get stats for specific queue
		const stats = await jobQueueService.getQueueStats(params.jobType);
		queues.push({ type: params.jobType, stats });
	} else {
		// Get stats for all queues
		for (const jobType of Object.values(JobType)) {
			const stats = await jobQueueService.getQueueStats(jobType);
			queues.push({ type: jobType, stats });
		}
	}

	return { queues };
}

/**
 * Shutdown async services
 */
export async function shutdownAsyncServices(): Promise<void> {
	if (jobQueueService) {
		await jobQueueService.shutdown();
		jobQueueService = null;
	}

	if (langchainService) {
		langchainService.clearMemory();
		langchainService = null;
	}

	logger.info('Async services shutdown complete');
}