import type { Job } from 'bullmq';
import { createHmac, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { getLogger } from '../core/logger.js';
import { AIClient } from '../services/ai/ai-client.js';
import { AIWritingService } from '../services/ai/ai-writing-service.js';
import { ContentAnalyzer } from '../analysis/base-analyzer.js';
import { JobQueueService, JobType } from '../services/queue/job-queue.js';
import type { ScrivenerDocument } from '../types/index.js';
import {
	ErrorCode,
	createError,
	formatDuration,
	getEnv,
	handleError,
	measureExecution,
	retry,
	validateInput,
} from '../utils/common.js';

let jobQueueService: JobQueueService | null = null;
let aiWritingService: AIWritingService | null = null;
const logger = getLogger('async-handlers');
let localAnalyzer: ContentAnalyzer | undefined;
let lifecycle: Promise<void> = Promise.resolve();
let configuration: string | undefined;
const configurationKey = randomBytes(32);
let activeOperations = 0;
const drainCallbacks: Array<() => void> = [];

function transition(operation: () => Promise<void>): Promise<void> {
	const pending = lifecycle.then(operation);
	lifecycle = pending.catch(() => undefined);
	return pending;
}

async function withAsyncServices<T>(
	operation: (queue: JobQueueService | null, writing: AIWritingService | null) => Promise<T>
): Promise<T> {
	while (true) {
		const pending = lifecycle;
		await pending;
		if (pending !== lifecycle) continue;
		activeOperations++;
		try {
			return await operation(jobQueueService, aiWritingService);
		} finally {
			activeOperations--;
			if (activeOperations === 0) for (const notify of drainCallbacks.splice(0)) notify();
		}
	}
}

async function closeCurrentServices(): Promise<void> {
	if (activeOperations) await new Promise<void>((notify) => drainCallbacks.push(notify));
	localAnalyzer?.dispose();
	localAnalyzer = undefined;
	const queue = jobQueueService;
	const writing = aiWritingService;
	jobQueueService = null;
	aiWritingService = null;
	configuration = undefined;
	try {
		await queue?.shutdown();
	} finally {
		writing?.clearMemory();
	}
}

export async function analyzeWorkflowDocument(params: {
	documentId: string;
	content: string;
}): Promise<unknown> {
	return withAsyncServices(async (jobQueueService) => {
		if (jobQueueService)
			return jobQueueService.analyzeDocument({
				...params,
				options: {
					includeReadability: true,
					includeEntities: true,
					includeSentiment: true,
				},
			});
		localAnalyzer ??= new ContentAnalyzer();
		return localAnalyzer.analyzeContent(params.content, params.documentId);
	});
}

export async function initializeAsyncServices(
	options: {
		redisUrl?: string;
		openaiApiKey?: string;
		databasePath?: string;
		neo4jUri?: string;
		projectPath?: string;
	} = {}
): Promise<void> {
	return transition(async () => {
		const projectPath = options.projectPath ? resolve(options.projectPath) : undefined;
		const key = createHmac('sha256', configurationKey)
			.update(
				JSON.stringify({
					projectPath,
					redisUrl: options.redisUrl || getEnv('REDIS_URL'),
					databasePath: options.databasePath,
					openaiApiKey: options.openaiApiKey || getEnv('OPENAI_API_KEY'),
					neo4jUri: options.neo4jUri || getEnv('NEO4J_URI'),
					anthropicApiKey: getEnv('ANTHROPIC_API_KEY'),
					openrouterApiKey: getEnv('OPENROUTER_API_KEY'),
				})
			)
			.digest('hex');
		if (configuration === key && jobQueueService) return;
		let queue: JobQueueService | undefined;
		try {
			await closeCurrentServices();
			const candidate = new JobQueueService(projectPath);
			queue = candidate;
			const initResult = await measureExecution(async () => {
				await retry(
					() =>
						candidate.initialize({
							openaiApiKey: options.openaiApiKey || getEnv('OPENAI_API_KEY'),
							databasePath: options.databasePath,
							neo4jUri: options.neo4jUri || getEnv('NEO4J_URI'),
						}),
					{ maxAttempts: 3 }
				);
				const aiClient = new AIClient({
					openaiApiKey: options.openaiApiKey || getEnv('OPENAI_API_KEY'),
				});
				const writing = aiClient.isAvailable ? new AIWritingService(aiClient) : null;
				jobQueueService = candidate;
				aiWritingService = writing;
				configuration = key;
				logger.info(
					`Job queue service initialized with ${candidate.getConnectionInfo().type} connection`
				);
			});
			logger.info(
				`Async services initialization completed in ${formatDuration(initResult.ms)}`
			);
		} catch (error) {
			if (jobQueueService === queue) {
				jobQueueService = null;
				aiWritingService?.clearMemory();
				aiWritingService = null;
				configuration = undefined;
			}
			await queue?.shutdown();
			const appError = handleError(error, 'initializeAsyncServices');
			logger.warn('Failed to initialize async services', { error: appError.message });
		}
	});
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
	return withAsyncServices(async (jobQueueService) => {
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
	});
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
	return withAsyncServices(async (jobQueueService) => {
		validateInput(params, { projectId: { required: true }, documents: { required: true } });

		if (!jobQueueService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'Job queue service not available');
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
	});
}

export async function buildVectorStore(params: {
	documents: ScrivenerDocument[];
	rebuild?: boolean;
}): Promise<{ jobId?: string; message: string }> {
	return withAsyncServices(async (jobQueueService, aiWritingService) => {
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

		// Otherwise, process synchronously with the AI writing service
		if (!aiWritingService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'AI writing service not available');
		}

		if (params.rebuild) {
			aiWritingService.clearMemory();
		}

		await aiWritingService.buildVectorStore(params.documents);

		return {
			message: `Vector store built with ${params.documents.length} documents`,
		};
	});
}

export async function semanticSearch(params: { query: string; topK?: number }): Promise<{
	results: Array<{
		content: string;
		metadata: Record<string, unknown>;
		score?: number;
	}>;
}> {
	return withAsyncServices(async (jobQueueService, aiWritingService) => {
		validateInput(params, { query: { required: true } });

		if (!aiWritingService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'AI writing service not available');
		}

		const results = await aiWritingService.semanticSearch(params.query, params.topK || 5);

		return {
			results: results.map((doc) => ({
				content: doc.pageContent,
				metadata: doc.metadata,
			})),
		};
	});
}

export async function generateSuggestions(params: {
	prompt: string;
	documentId?: string;
	useContext?: boolean;
	async?: boolean;
}): Promise<{ jobId?: string; suggestions?: string; message?: string }> {
	return withAsyncServices(async (jobQueueService, aiWritingService) => {
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
		if (!aiWritingService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'AI writing service not available');
		}

		const suggestions = await aiWritingService.generateWithContext(params.prompt, {
			topK: params.useContext ? 3 : 0,
		});

		return { suggestions };
	});
}

export async function analyzeWritingStyle(params: {
	samples: string[];
}): Promise<{ analysis: Record<string, unknown> }> {
	return withAsyncServices(async (jobQueueService, aiWritingService) => {
		validateInput(params, { samples: { required: true } });

		if (!aiWritingService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'AI writing service not available');
		}

		const analysis = await aiWritingService.analyzeWritingStyle(params.samples);

		return { analysis };
	});
}

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
	return withAsyncServices(async (jobQueueService, aiWritingService) => {
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
		if (!aiWritingService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'AI writing service not available');
		}

		const issues = await aiWritingService.checkPlotConsistency(params.documents);

		return { issues };
	});
}

export async function getJobStatus(params: { jobType: JobType; jobId: string }): Promise<{
	state: string;
	progress: number;
	result?: unknown;
	error?: string;
}> {
	return withAsyncServices(async (jobQueueService) => {
		validateInput(params, { jobType: { required: true }, jobId: { required: true } });

		if (!jobQueueService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'Job queue service not available');
		}

		const jobStatus = await jobQueueService.getJobStatus(params.jobType, params.jobId);

		// Handle null response (job not found)
		if (!jobStatus) {
			return {
				state: 'not_found',
				progress: 0,
				error: `Job ${params.jobId} not found`,
			};
		}

		// Handle Job object from v2 API
		if ('attemptsMade' in jobStatus) {
			// This is a Job object from BullMQ
			const job = jobStatus as Job<unknown, unknown, string>;
			return {
				state: await job.getState(),
				progress: typeof job.progress === 'number' ? job.progress : 0,
				result: job.returnvalue,
				error: job.failedReason,
			};
		}

		// Already in the correct format from v1 API
		return jobStatus;
	});
}

/**
 * Cancel a job
 */
export async function cancelJob(params: {
	jobType: JobType;
	jobId: string;
}): Promise<{ message: string }> {
	return withAsyncServices(async (jobQueueService) => {
		validateInput(params, { jobType: { required: true }, jobId: { required: true } });

		if (!jobQueueService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'Job queue service not available');
		}

		await jobQueueService.cancelJob(params.jobType, params.jobId);

		return { message: `Job ${params.jobId} cancelled` };
	});
}

/**
 * Helper function to normalize queue stats from different API versions
 */
function normalizeQueueStats(rawStats: Record<string, unknown>): {
	waiting: number;
	active: number;
	completed: number;
	failed: number;
	delayed: number;
} {
	// Handle both v1 (direct object) and v2 (Record<string, unknown>) formats
	return {
		waiting: Number(rawStats.waiting || 0),
		active: Number(rawStats.active || 0),
		completed: Number(rawStats.completed || 0),
		failed: Number(rawStats.failed || 0),
		delayed: Number(rawStats.delayed || 0),
	};
}

export async function getQueueStats(params: { jobType?: JobType }): Promise<{
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
	return withAsyncServices(async (jobQueueService) => {
		if (!jobQueueService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'Job queue service not available');
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
			const rawStats = await jobQueueService.getQueueStats(params.jobType);
			const stats = normalizeQueueStats(rawStats);
			queues.push({ type: params.jobType, stats });
		} else {
			// Get stats for all queues
			for (const jobType of Object.values(JobType)) {
				const rawStats = await jobQueueService.getQueueStats(jobType);
				const stats = normalizeQueueStats(rawStats);
				queues.push({ type: jobType, stats });
			}
		}

		return { queues };
	});
}

/**
 * Shutdown async services
 */
export async function shutdownAsyncServices(): Promise<void> {
	return transition(async () => {
		await closeCurrentServices();
		logger.info('Async services shutdown complete');
	});
}
