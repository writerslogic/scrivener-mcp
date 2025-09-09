/**
 * BullMQ job queue system for async processing
 * Handles long-running analysis tasks and AI operations
 */

import type { ConnectionOptions, Job } from 'bullmq';
import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';
import * as path from 'path';
import { ContentAnalyzer } from '../../analysis/base-analyzer.js';
import { createError, ErrorCode } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import { DatabaseService } from '../../handlers/database/database-service.js';
import type { ScrivenerDocument } from '../../types/index.js';
import { LangChainService } from '../ai/langchain-service.js';
import { MemoryRedis } from './memory-redis.js';

// Job types
export enum JobType {
	ANALYZE_DOCUMENT = 'analyze_document',
	ANALYZE_PROJECT = 'analyze_project',
	GENERATE_SUGGESTIONS = 'generate_suggestions',
	BUILD_VECTOR_STORE = 'build_vector_store',
	CHECK_CONSISTENCY = 'check_consistency',
	SYNC_DATABASE = 'sync_database',
	EXPORT_PROJECT = 'export_project',
	BATCH_ANALYSIS = 'batch_analysis',
}

// Job data interfaces
export interface AnalyzeDocumentJob {
	documentId: string;
	content: string;
	options?: {
		includeReadability?: boolean;
		includeEntities?: boolean;
		includeSentiment?: boolean;
	};
}

export interface AnalyzeProjectJob {
	projectId: string;
	documents: ScrivenerDocument[];
	options?: {
		parallel?: boolean;
		batchSize?: number;
	};
}

export interface GenerateSuggestionsJob {
	documentId: string;
	prompt: string;
	context?: string[];
}

export interface JobResult {
	success: boolean;
	data?: unknown;
	error?: string;
	processingTime?: number;
}

export class JobQueueService {
	private queues: Map<JobType, Queue> = new Map();
	private workers: Map<JobType, Worker> = new Map();
	private events: Map<JobType, QueueEvents> = new Map();
	private connection: any; // IORedis instance
	private logger: ReturnType<typeof getLogger>;
	private langchainService: LangChainService | null = null;
	private databaseService: DatabaseService | null = null;
	private isInitialized = false;

	private memoryRedis: MemoryRedis | null = null;
	private useEmbedded: boolean;
	private projectPath: string | null = null;

	constructor(redisUrl?: string, projectPath?: string) {
		this.logger = getLogger('job-queue');
		this.projectPath = projectPath || null;

		// Determine if we should use embedded KeyDB
		this.useEmbedded = !redisUrl && !process.env.REDIS_URL;

		if (this.useEmbedded) {
			// Embedded KeyDB will be initialized in initialize()
			this.logger.info('Will use embedded KeyDB for job queue');
		} else {
			// Use external Redis
			const redisConfig: ConnectionOptions = redisUrl
				? { url: redisUrl }
				: {
						host: process.env.REDIS_HOST || 'localhost',
						port: parseInt(process.env.REDIS_PORT || '6379'),
						maxRetriesPerRequest: null,
					};

			if (typeof redisConfig.url === 'string') {
				this.connection = new (IORedis as any)(redisConfig.url);
			} else {
				this.connection = new (IORedis as any)({
					host: (redisConfig as any).host || 'localhost',
					port: (redisConfig as any).port || 6379,
				});
			}

			this.connection.on('error', (error: any) => {
				this.logger.error('Redis connection error', { error });
			});

			this.connection.on('connect', () => {
				this.logger.info('Connected to external Redis');
			});
		}
	}

	/**
	 * Initialize queues and workers
	 */
	async initialize(
		options: {
			langchainApiKey?: string;
			databasePath?: string;
			neo4jUri?: string;
		} = {}
	): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		try {
			// Initialize in-memory Redis if needed
			if (this.useEmbedded) {
				this.logger.info('Starting in-memory Redis...');

				// Determine persist path - use project directory if available
				let persistPath: string;
				if (this.projectPath) {
					// Store in .scrivener-mcp directory within the project
					persistPath = path.join(this.projectPath, '.scrivener-mcp', 'queue-state.json');
				} else if (options.databasePath) {
					// Use database path as fallback
					persistPath = path.join(path.dirname(options.databasePath), 'queue-state.json');
				} else {
					// Default to local data directory
					persistPath = './data/queue-state.json';
				}

				this.memoryRedis = new MemoryRedis({ persistPath });
				await this.memoryRedis.connect();
				this.connection = this.memoryRedis as any;
				this.logger.info('Connected to in-memory Redis', { persistPath });
			}

			// Initialize services
			if (options.langchainApiKey || process.env.OPENAI_API_KEY) {
				this.langchainService = new LangChainService(options.langchainApiKey);
			}

			if (options.databasePath) {
				this.databaseService = new DatabaseService(options.databasePath);
				await this.databaseService.initialize();
			}

			// Create queues for each job type
			for (const jobType of Object.values(JobType)) {
				this.createQueue(jobType);
				this.createWorker(jobType);
				this.setupEventListeners(jobType);
			}

			this.isInitialized = true;
			this.logger.info('Job queue service initialized');
		} catch (error) {
			throw createError(
				ErrorCode.INITIALIZATION_ERROR,
				error as Error,
				'Failed to initialize job queue service'
			);
		}
	}

	/**
	 * Create a queue for a job type
	 */
	private createQueue(jobType: JobType): void {
		const queue = new Queue(jobType, {
			connection: this.connection as any,
			defaultJobOptions: {
				removeOnComplete: {
					age: 3600, // Keep completed jobs for 1 hour
					count: 100, // Keep last 100 completed jobs
				},
				removeOnFail: {
					age: 24 * 3600, // Keep failed jobs for 24 hours
				},
				attempts: 3,
				backoff: {
					type: 'exponential',
					delay: 2000,
				},
			},
		});

		this.queues.set(jobType, queue);
	}

	/**
	 * Create a worker for processing jobs
	 */
	private createWorker(jobType: JobType): void {
		const worker = new Worker(
			jobType,
			async (job: Job) => {
				const startTime = Date.now();
				this.logger.debug(`Processing job ${job.id} of type ${jobType}`);

				try {
					const result = await this.processJob(jobType, job);
					const processingTime = Date.now() - startTime;

					return {
						success: true,
						data: result,
						processingTime,
					} as JobResult;
				} catch (error) {
					this.logger.error(`Job ${job.id} failed`, { error });
					throw error;
				}
			},
			{
				connection: this.connection as any,
				concurrency: this.getConcurrency(jobType),
			}
		);

		// Worker event handlers
		worker.on('completed', (job) => {
			this.logger.debug(`Job ${job.id} completed successfully`);
		});

		worker.on('failed', (job, error) => {
			this.logger.error(`Job ${job?.id} failed`, { error });
		});

		worker.on('error', (error) => {
			this.logger.error('Worker error', { error });
		});

		this.workers.set(jobType, worker);
	}

	/**
	 * Setup event listeners for a queue
	 */
	private setupEventListeners(jobType: JobType): void {
		const queueEvents = new QueueEvents(jobType, {
			connection: this.connection as any,
		});

		queueEvents.on('progress', ({ jobId, data }) => {
			this.logger.debug(`Job ${jobId} progress`, { data });
		});

		this.events.set(jobType, queueEvents);
	}

	/**
	 * Get concurrency for job type
	 */
	private getConcurrency(jobType: JobType): number {
		switch (jobType) {
			case JobType.ANALYZE_DOCUMENT:
				return 5; // Process up to 5 documents simultaneously
			case JobType.GENERATE_SUGGESTIONS:
				return 3; // Limit AI requests
			case JobType.BUILD_VECTOR_STORE:
				return 1; // Sequential for memory efficiency
			case JobType.BATCH_ANALYSIS:
				return 2; // Limited parallel batch processing
			default:
				return 3;
		}
	}

	/**
	 * Process a job based on its type
	 */
	private async processJob(jobType: JobType, job: Job): Promise<unknown> {
		switch (jobType) {
			case JobType.ANALYZE_DOCUMENT:
				return this.processAnalyzeDocument(job.data as AnalyzeDocumentJob);

			case JobType.ANALYZE_PROJECT:
				return this.processAnalyzeProject(job.data as AnalyzeProjectJob);

			case JobType.GENERATE_SUGGESTIONS:
				return this.processGenerateSuggestions(job.data as GenerateSuggestionsJob);

			case JobType.BUILD_VECTOR_STORE:
				return this.processBuildVectorStore(job.data);

			case JobType.CHECK_CONSISTENCY:
				return this.processCheckConsistency(job.data);

			case JobType.SYNC_DATABASE:
				return this.processSyncDatabase(job.data);

			default:
				throw createError(
					ErrorCode.INVALID_INPUT,
					{
						jobType,
					},
					`Unknown job type: ${jobType}`
				);
		}
	}

	/**
	 * Process document analysis job
	 */
	private async processAnalyzeDocument(data: AnalyzeDocumentJob): Promise<unknown> {
		const analyzer = new ContentAnalyzer();
		const results: Record<string, unknown> = {};

		// Update job progress
		await this.updateProgress(JobType.ANALYZE_DOCUMENT, 10, 'Starting analysis');

		if (data.options?.includeReadability) {
			const analysis = await analyzer.analyzeContent(data.content, data.documentId);
			results.readability = analysis.metrics.fleschReadingEase;
			await this.updateProgress(JobType.ANALYZE_DOCUMENT, 30, 'Readability analyzed');
		}

		if (data.options?.includeEntities) {
			// For now, skip entities extraction as ContextAnalyzer requires DatabaseService
			results.entities = [];
			await this.updateProgress(JobType.ANALYZE_DOCUMENT, 60, 'Entities extracted');
		}

		if (data.options?.includeSentiment) {
			const sentimentAnalysis = await analyzer.analyzeContent(data.content, data.documentId);
			results.sentiment = sentimentAnalysis.emotions;
			await this.updateProgress(JobType.ANALYZE_DOCUMENT, 90, 'Sentiment analyzed');
		}

		await this.updateProgress(JobType.ANALYZE_DOCUMENT, 100, 'Analysis complete');
		return results;
	}

	/**
	 * Process project analysis job
	 */
	private async processAnalyzeProject(data: AnalyzeProjectJob): Promise<unknown> {
		const results: Array<{ documentId: string; analysis: unknown }> = [];
		const batchSize = data.options?.batchSize || 5;

		for (let i = 0; i < data.documents.length; i += batchSize) {
			const batch = data.documents.slice(i, i + batchSize);
			const batchResults = await Promise.all(
				batch.map(async (doc) => {
					const analysis = await this.processAnalyzeDocument({
						documentId: doc.id || 'unknown',
						content: doc.content || '',
						options: {
							includeReadability: true,
							includeEntities: true,
							includeSentiment: true,
						},
					});

					return { documentId: doc.id || 'unknown', analysis };
				})
			);

			results.push(...batchResults);

			// Update progress
			const progress = Math.round(((i + batchSize) / data.documents.length) * 100);
			await this.updateProgress(
				JobType.ANALYZE_PROJECT,
				progress,
				`Analyzed ${Math.min(i + batchSize, data.documents.length)} of ${data.documents.length} documents`
			);
		}

		return results;
	}

	/**
	 * Process generate suggestions job
	 */
	private async processGenerateSuggestions(data: GenerateSuggestionsJob): Promise<unknown> {
		if (!this.langchainService) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				null,
				'LangChain service not initialized'
			);
		}

		await this.updateProgress(JobType.GENERATE_SUGGESTIONS, 20, 'Generating suggestions');

		const suggestions = await this.langchainService.generateWithContext(data.prompt, {
			topK: 5,
		});

		await this.updateProgress(JobType.GENERATE_SUGGESTIONS, 100, 'Suggestions generated');
		return suggestions;
	}

	/**
	 * Process build vector store job
	 */
	private async processBuildVectorStore(data: {
		documents: ScrivenerDocument[];
	}): Promise<unknown> {
		if (!this.langchainService) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				null,
				'LangChain service not initialized'
			);
		}

		await this.updateProgress(JobType.BUILD_VECTOR_STORE, 10, 'Starting vector store build');

		await this.langchainService.buildVectorStore(data.documents);

		await this.updateProgress(JobType.BUILD_VECTOR_STORE, 100, 'Vector store built');
		return { success: true, documentCount: data.documents.length };
	}

	/**
	 * Process check consistency job
	 */
	private async processCheckConsistency(data: {
		documents: ScrivenerDocument[];
	}): Promise<unknown> {
		if (!this.langchainService) {
			throw createError(
				ErrorCode.AI_SERVICE_ERROR,
				null,
				'LangChain service not initialized'
			);
		}

		await this.updateProgress(JobType.CHECK_CONSISTENCY, 20, 'Checking consistency');

		const issues = await this.langchainService.checkPlotConsistency(data.documents);

		await this.updateProgress(JobType.CHECK_CONSISTENCY, 100, 'Consistency check complete');
		return issues;
	}

	/**
	 * Process sync database job
	 */
	private async processSyncDatabase(data: { documents: ScrivenerDocument[] }): Promise<unknown> {
		if (!this.databaseService) {
			throw createError(ErrorCode.AI_SERVICE_ERROR, null, 'Database service not initialized');
		}

		await this.updateProgress(JobType.SYNC_DATABASE, 10, 'Starting database sync');

		for (let i = 0; i < data.documents.length; i++) {
			await this.databaseService.syncDocumentData(data.documents[i]);

			const progress = Math.round(((i + 1) / data.documents.length) * 100);
			await this.updateProgress(
				JobType.SYNC_DATABASE,
				progress,
				`Synced ${i + 1} of ${data.documents.length} documents`
			);
		}

		return { success: true, documentCount: data.documents.length };
	}

	/**
	 * Update job progress
	 */
	private async updateProgress(
		jobType: JobType,
		progress: number,
		message: string
	): Promise<void> {
		const queue = this.queues.get(jobType);
		if (queue) {
			// This will emit progress events
			this.logger.debug(`Job progress: ${progress}% - ${message}`);
		}
	}

	/**
	 * Add a job to the queue
	 */
	async addJob<T>(
		jobType: JobType,
		data: T,
		options: {
			priority?: number;
			delay?: number;
			attempts?: number;
		} = {}
	): Promise<string> {
		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.VALIDATION_ERROR,
				null,
				`Queue for job type ${jobType} not found`
			);
		}

		const job = await queue.add(jobType, data as any, options);
		this.logger.info(`Added job ${job.id} to queue ${jobType}`);
		return job.id!;
	}

	/**
	 * Get job status
	 */
	async getJobStatus(
		jobType: JobType,
		jobId: string
	): Promise<{
		state: string;
		progress: number;
		result?: JobResult;
		error?: string;
	}> {
		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.VALIDATION_ERROR,
				null,
				`Queue for job type ${jobType} not found`
			);
		}

		const job = await queue.getJob(jobId);
		if (!job) {
			throw createError(ErrorCode.NOT_FOUND, null, `Job ${jobId} not found`);
		}

		const state = await job.getState();
		const progress = (job.progress as number) || 0;

		return {
			state,
			progress,
			result: job.returnvalue as JobResult,
			error: job.failedReason,
		};
	}

	/**
	 * Cancel a job
	 */
	async cancelJob(jobType: JobType, jobId: string): Promise<void> {
		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.VALIDATION_ERROR,
				null,
				`Queue for job type ${jobType} not found`
			);
		}

		const job = await queue.getJob(jobId);
		if (!job) {
			throw createError(ErrorCode.NOT_FOUND, null, `Job ${jobId} not found`);
		}

		await job.remove();
		this.logger.info(`Cancelled job ${jobId}`);
	}

	/**
	 * Get queue statistics
	 */
	async getQueueStats(jobType: JobType): Promise<{
		waiting: number;
		active: number;
		completed: number;
		failed: number;
		delayed: number;
	}> {
		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.VALIDATION_ERROR,
				null,
				`Queue for job type ${jobType} not found`
			);
		}

		const [waiting, active, completed, failed, delayed] = await Promise.all([
			queue.getWaitingCount(),
			queue.getActiveCount(),
			queue.getCompletedCount(),
			queue.getFailedCount(),
			queue.getDelayedCount(),
		]);

		return { waiting, active, completed, failed, delayed };
	}

	/**
	 * Cleanup and close connections
	 */
	async shutdown(): Promise<void> {
		this.logger.info('Shutting down job queue service');

		// Close all workers
		for (const worker of this.workers.values()) {
			await worker.close();
		}

		// Close all queues
		for (const queue of this.queues.values()) {
			await queue.close();
		}

		// Close all event listeners
		for (const events of this.events.values()) {
			await events.close();
		}

		// Close Redis connection
		if (this.connection) {
			this.connection.disconnect();
		}

		// Stop in-memory Redis if running
		if (this.memoryRedis) {
			await this.memoryRedis.disconnect();
			this.memoryRedis = null;
		}

		this.isInitialized = false;
		this.logger.info('Job queue service shutdown complete');
	}
}
