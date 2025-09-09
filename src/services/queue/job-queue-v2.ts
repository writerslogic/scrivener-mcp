/**
 * Optimized BullMQ job queue with automatic KeyDB/Redis detection
 */

import { Queue, Worker, QueueEvents } from 'bullmq';
import type { Job } from 'bullmq';
import * as path from 'path';
import { getLogger } from '../../core/logger.js';
import { createError, ErrorCode } from '../../core/errors.js';
import { detectConnection, createBullMQConnection } from './keydb-detector.js';
import { MemoryRedis } from './memory-redis.js';
import { ContentAnalyzer } from '../../analysis/base-analyzer.js';
import { getEnvConfig } from '../../utils/env-config.js';
import { LangChainService } from '../ai/langchain-service.js';
import { DatabaseService } from '../../database/database-service.js';

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

// Job interfaces
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
	documents: Array<{ id: string; content: string }>;
}

export interface GenerateSuggestionsJob {
	documentId: string;
	content: string;
	analysisResults: any;
}

export interface BuildVectorStoreJob {
	documents: Array<{ id: string; content: string; metadata?: any }>;
	rebuild?: boolean;
}

export interface CheckConsistencyJob {
	documents: Array<{ id: string; content: string }>;
	checkTypes?: string[];
}

export interface SyncDatabaseJob {
	documents: Array<{ id: string; content: string; metadata?: any }>;
}

export interface ExportProjectJob {
	projectId: string;
	format: 'json' | 'markdown' | 'html';
	outputPath: string;
}

export interface BatchAnalysisJob {
	documents: Array<{ id: string; content: string }>;
	options?: any;
}

/**
 * Optimized Job Queue Service
 */
export class JobQueueService {
	private queues: Map<JobType, Queue> = new Map();
	private workers: Map<JobType, Worker> = new Map();
	private events: Map<JobType, QueueEvents> = new Map();
	private connection: any = null;
	private logger: ReturnType<typeof getLogger>;

	// Services
	private contentAnalyzer: ContentAnalyzer | null = null;
	private langchainService: LangChainService | null = null;
	private databaseService: DatabaseService | null = null;

	// State
	private isInitialized = false;
	private connectionType: 'keydb' | 'redis' | 'embedded' = 'embedded';
	private projectPath: string | null = null;

	constructor(projectPath?: string) {
		this.logger = getLogger('job-queue-v2');
		this.projectPath = projectPath || null;
	}

	/**
	 * Initialize with automatic KeyDB/Redis detection
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
			// Step 1: Detect and establish connection
			const connectionInfo = await detectConnection();

			if (connectionInfo.isAvailable && connectionInfo.url) {
				// Use KeyDB or Redis
				this.connection = createBullMQConnection(connectionInfo.url);
				this.connectionType = connectionInfo.type as 'keydb' | 'redis';
				this.logger.info(`Using ${connectionInfo.type} for job queue`, {
					version: connectionInfo.version,
				});
			} else {
				// Fallback to embedded MemoryRedis
				this.logger.info('No KeyDB/Redis found, using embedded queue');

				const persistPath = this.projectPath
					? path.join(this.projectPath, '.scrivener-mcp', 'queue-state.json')
					: './data/queue-state.json';

				// Create directory if needed
				const fs = await import('fs/promises');
				const dir = path.dirname(persistPath);
				await fs.mkdir(dir, { recursive: true });

				this.memoryRedis = new MemoryRedis({ persistPath });
				await this.memoryRedis.connect();
				this.connection = this.memoryRedis as any;
				this.connectionType = 'embedded';
			}

			// Step 2: Initialize services
			const envConfig = getEnvConfig();
			if (options.langchainApiKey || envConfig.openaiApiKey) {
				this.langchainService = new LangChainService(
					options.langchainApiKey || envConfig.openaiApiKey
				);
				this.logger.info('LangChain service initialized');
			}

			if (options.databasePath) {
				this.databaseService = new DatabaseService(options.databasePath);
				await this.databaseService.initialize();
				this.logger.info('Database service initialized');
			}

			this.contentAnalyzer = new ContentAnalyzer();

			// Step 3: Create queues and workers for each job type
			for (const jobType of Object.values(JobType)) {
				this.createQueue(jobType);
				this.createWorker(jobType);
				this.setupEventListeners(jobType);
			}

			this.isInitialized = true;
			this.logger.info('Job queue service initialized', {
				connection: this.connectionType,
				queues: Object.values(JobType).length,
			});
		} catch (error) {
			this.logger.error('Failed to initialize job queue', {
				error: (error as Error).message,
				stack: (error as Error).stack,
			});
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
			connection: this.connection,
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
				this.logger.debug(`Processing job ${job.id} of type ${jobType}`);
				try {
					const result = await this.processJob(jobType, job);
					this.logger.debug(`Job ${job.id} completed successfully`);
					return result;
				} catch (error) {
					this.logger.error(`Job ${job.id} failed`, { error });
					throw error;
				}
			},
			{
				connection: this.connection,
				concurrency: this.getConcurrency(jobType),
			}
		);

		// Worker event handlers
		worker.on('completed', (job) => {
			this.logger.info(`Job completed: ${job.id}`);
		});

		worker.on('failed', (job, error) => {
			this.logger.error(`Job failed: ${job?.id}`, { error });
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
			connection: this.connection,
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
				return this.processBuildVectorStore(job.data as BuildVectorStoreJob);
			case JobType.CHECK_CONSISTENCY:
				return this.processCheckConsistency(job.data as CheckConsistencyJob);
			case JobType.SYNC_DATABASE:
				return this.processSyncDatabase(job.data as SyncDatabaseJob);
			default:
				throw new Error(`Unknown job type: ${jobType}`);
		}
	}

	// Job processors (simplified versions)
	private async processAnalyzeDocument(data: AnalyzeDocumentJob): Promise<any> {
		if (!this.contentAnalyzer) {
			throw new Error('Content analyzer not initialized');
		}

		const results: any = {
			documentId: data.documentId,
			timestamp: new Date().toISOString(),
		};

		if (data.options?.includeReadability) {
			// Use the content analyzer for full analysis
			const analysis = await this.contentAnalyzer.analyzeContent(
				data.content,
				data.documentId
			);
			results.readability = {
				fleschReadingEase: analysis.metrics.fleschReadingEase,
				fleschKincaidGrade: analysis.metrics.fleschKincaidGrade,
				readingTime: analysis.metrics.readingTime,
			};
		}

		// Store results in database if available (would need to implement this method)
		// For now, just log the results
		if (this.databaseService) {
			this.logger.debug('Analysis results ready for storage', {
				documentId: data.documentId,
			});
			// await this.databaseService.storeAnalysisResults(data.documentId, results);
		}

		return results;
	}

	private async processAnalyzeProject(data: AnalyzeProjectJob): Promise<any> {
		const results = [];
		for (const doc of data.documents) {
			const result = await this.processAnalyzeDocument({
				documentId: doc.id,
				content: doc.content,
				options: { includeReadability: true },
			});
			results.push(result);
		}
		return { projectId: data.projectId, documents: results };
	}

	private async processGenerateSuggestions(data: GenerateSuggestionsJob): Promise<any> {
		if (!this.langchainService) {
			throw new Error('LangChain service not initialized');
		}
		// Simplified - would call LangChain here
		return { documentId: data.documentId, suggestions: [] };
	}

	private async processBuildVectorStore(data: BuildVectorStoreJob): Promise<any> {
		if (!this.langchainService) {
			throw new Error('LangChain service not initialized');
		}
		// Simplified - would build vector store here
		return { documentsProcessed: data.documents.length };
	}

	private async processCheckConsistency(data: CheckConsistencyJob): Promise<any> {
		// Simplified consistency check
		return { documents: data.documents.length, issues: [] };
	}

	private async processSyncDatabase(data: SyncDatabaseJob): Promise<any> {
		if (!this.databaseService) {
			throw new Error('Database service not initialized');
		}
		// Simplified - would sync to database here
		return { synced: data.documents.length };
	}

	/**
	 * Add a job to the queue
	 */
	async addJob(
		jobType: JobType,
		data: any,
		options?: { priority?: number; delay?: number }
	): Promise<string> {
		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Queue for job type ${jobType} not found`
			);
		}

		const job = await queue.add(jobType, data, options);
		this.logger.info(`Job ${job.id} added to queue ${jobType}`);
		return job.id as string;
	}

	/**
	 * Get job status
	 */
	async getJobStatus(jobType: JobType, jobId: string): Promise<any> {
		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Queue for job type ${jobType} not found`
			);
		}

		const job = await queue.getJob(jobId);
		if (!job) {
			return null;
		}

		return {
			id: job.id,
			state: await job.getState(),
			progress: job.progress,
			data: job.data,
			returnvalue: job.returnvalue,
			failedReason: job.failedReason,
		};
	}

	/**
	 * Cancel a job
	 */
	async cancelJob(jobType: JobType, jobId: string): Promise<void> {
		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Queue for job type ${jobType} not found`
			);
		}

		const job = await queue.getJob(jobId);
		if (!job) {
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Job ${jobId} not found in queue ${jobType}`
			);
		}

		await job.remove();
		this.logger.info(`Job ${jobId} cancelled from queue ${jobType}`);
	}

	/**
	 * Get queue statistics
	 */
	async getQueueStats(jobType: JobType): Promise<any> {
		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
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
	 * Get connection info
	 */
	getConnectionInfo(): { type: string; isConnected: boolean } {
		return {
			type: this.connectionType,
			isConnected: this.isInitialized,
		};
	}

	/**
	 * Shutdown gracefully
	 */
	async shutdown(): Promise<void> {
		this.logger.info('Shutting down job queue service');

		// Close workers first
		for (const [type, worker] of this.workers.entries()) {
			await worker.close();
			this.logger.debug(`Worker ${type} closed`);
		}

		// Close event listeners
		for (const [type, events] of this.events.entries()) {
			await events.close();
			this.logger.debug(`Events ${type} closed`);
		}

		// Close queues
		for (const [type, queue] of this.queues.entries()) {
			await queue.close();
			this.logger.debug(`Queue ${type} closed`);
		}

		// Close connection
		if (this.connection) {
			if (this.connectionType === 'embedded' && this.memoryRedis) {
				await this.memoryRedis.disconnect();
			} else if (this.connection.quit) {
				await this.connection.quit();
			}
		}

		// Clear maps
		this.queues.clear();
		this.workers.clear();
		this.events.clear();

		this.isInitialized = false;
		this.logger.info('Job queue service shutdown complete');
	}

	// Add missing memoryRedis property
	private memoryRedis: MemoryRedis | null = null;
}
