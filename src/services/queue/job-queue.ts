import type { ContinuityOptions, ContinuityReport } from '../editorial/continuity-service.js';
/**
 * Optimized BullMQ job queue with automatic KeyDB/Redis detection
 */

import type { Job, ConnectionOptions } from 'bullmq';
import { Queue, QueueEvents, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { ContentAnalyzer } from '../../analysis/base-analyzer.js';
import { createError, ErrorCode } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import { DatabaseService } from '../../handlers/database/database-service.js';
import { getEnvConfig } from '../../utils/env-config.js';
import { getDocumentPath } from '../../utils/scrivener-utils.js';
import { AIClient } from '../ai/ai-client.js';
import { AIWritingService } from '../ai/ai-writing-service.js';
import { createBullMQConnection, detectConnection } from './keydb-detector.js';
import { MutationCoordinator } from '../editorial/mutation-coordinator.js';
import { PersistentStore } from '../editorial/persistent-store.js';
import { getOrCreateProjectIdentity } from '../editorial/project-identity.js';
import {
	createQueueScope,
	LEGACY_QUEUE_NOTICE,
	ownsJobId,
	readScopedJob,
	scopeJob,
	scopedJobId,
	type QueueScope,
	type ScopedJob,
} from './project-scope.js';

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
	prompt: string;
	analysisResults: Record<string, unknown>;
}

export interface BuildVectorStoreJob {
	documents: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
	rebuild?: boolean;
}

export interface CheckConsistencyJob {
	projectId: string;
	documents: Array<{ id: string; revision: string }>;
	checkTypes?: ContinuityOptions['checkTypes'];
}

export interface SyncDatabaseJob {
	documents: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
}

export interface ExportProjectJob {
	projectId: string;
	format: 'json' | 'markdown' | 'html';
	outputPath: string;
}

export interface BatchAnalysisJob {
	documents: Array<{ id: string; content: string }>;
	options?: Record<string, unknown>;
}

// Status record for a job run inline by the embedded (no Redis) queue, shaped to match
// what getJobStatus's "v1 API" branch already returns for non-BullMQ job results.
interface EmbeddedJobStatus {
	jobType: JobType;
	state: 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
	progress: number;
	result?: unknown;
	error?: string;
	owner?: { pid: number; host: string };
}

/**
 * Optimized Job Queue Service
 */
export class JobQueueService {
	private queues: Map<JobType, Queue> = new Map();
	private workers: Map<JobType, Worker> = new Map();
	private events: Map<JobType, QueueEvents> = new Map();
	private connection: Redis | undefined = undefined;
	private embeddedJobs: Map<string, EmbeddedJobStatus> = new Map();
	private embeddedStore?: PersistentStore;
	private scope?: QueueScope;
	private readonly unboundIdentity = randomUUID();
	private continuity?: (options: ContinuityOptions) => Promise<ContinuityReport>;
	private readonly embeddedRuns = new Map<string, Promise<void>>();
	private logger: ReturnType<typeof getLogger>;

	// Services
	private contentAnalyzer: ContentAnalyzer | null = null;
	private aiWritingService: AIWritingService | null = null;
	private databaseService: DatabaseService | null = null;

	// State
	private isInitialized = false;
	private connectionType: 'keydb' | 'redis' | 'embedded' = 'embedded';
	private projectPath: string | null = null;

	constructor(projectPath?: string) {
		this.logger = getLogger('job-queue-v2');
		this.projectPath = projectPath || null;
	}

	async initialize(
		options: {
			redisUrl?: string;
			sqliteOnly?: boolean;
			continuity?: (options: ContinuityOptions) => Promise<ContinuityReport>;
			openaiApiKey?: string;
			databasePath?: string;
			neo4jUri?: string;
		} = {}
	): Promise<void> {
		if (this.isInitialized) {
			return;
		}
		if (options.sqliteOnly !== undefined && typeof options.sqliteOnly !== 'boolean')
			throw new Error('sqliteOnly must be a boolean');

		try {
			this.continuity = options.continuity;
			if (this.projectPath) {
				this.projectPath = await realpath(this.projectPath);
				const statePath = path.join(this.projectPath, '.scrivener-mcp', 'editorial.sqlite');
				new MutationCoordinator(this.projectPath).assertProjectPath(statePath);
				this.embeddedStore = new PersistentStore(statePath);
				this.scope = createQueueScope(
					getOrCreateProjectIdentity(this.embeddedStore),
					this.projectPath
				);
			} else this.scope = createQueueScope(this.unboundIdentity);
			// Step 1: Detect and establish connection
			const connectionInfo = await detectConnection(
				options.redisUrl !== undefined ? [options.redisUrl] : undefined
			);

			if (connectionInfo.isAvailable && connectionInfo.url) {
				// Use KeyDB or Redis
				this.connection = createBullMQConnection(connectionInfo.url);
				this.connectionType = connectionInfo.type as 'keydb' | 'redis';
				this.logger.info(`Using ${connectionInfo.type} for job queue`, {
					version: connectionInfo.version,
				});
			} else {
				this.logger.info('No KeyDB/Redis found, using embedded queue');
				this.connectionType = 'embedded';
			}

			// Step 2: Initialize services
			const envConfig = getEnvConfig();
			const aiClient = new AIClient({
				openaiApiKey: options.openaiApiKey || envConfig.openaiApiKey,
				anthropicApiKey: envConfig.anthropicApiKey,
				openrouterApiKey: envConfig.openrouterApiKey,
			});
			if (aiClient.isAvailable) {
				this.aiWritingService = new AIWritingService(aiClient);
				this.logger.info('AI writing service initialized');
			}

			if (this.projectPath) {
				this.databaseService = options.sqliteOnly
					? new DatabaseService(this.projectPath, {
							neo4j: {
								enabled: false,
								uri: 'bolt://127.0.0.1:1',
								user: '',
								password: '',
							},
						})
					: new DatabaseService(this.projectPath);
				await this.databaseService.initialize();
				this.logger.info('Database service initialized');
			}

			this.contentAnalyzer = new ContentAnalyzer();

			// Step 3: Create queues and workers for each job type.
			if (this.connectionType !== 'embedded') {
				for (const jobType of Object.values(JobType)) {
					this.createQueue(jobType);
					this.createWorker(jobType);
					this.setupEventListeners(jobType);
				}
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
			// Tear down any queues/workers/connections created before the failure so
			// a retry starts clean instead of orphaning the partial state.
			await this.shutdown().catch((cleanupError) => {
				this.logger.warn('Cleanup after failed initialization also failed', {
					error: (cleanupError as Error).message,
				});
			});
			throw createError(
				ErrorCode.INITIALIZATION_ERROR,
				error as Error,
				'Failed to initialize job queue service'
			);
		}
	}

	private createQueue(jobType: JobType): void {
		if (!this.connection) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Connection not initialized');
		}
		const queue = new Queue(jobType, {
			prefix: this.requireScope().prefix,
			connection: this.connection as ConnectionOptions,
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
				prefix: this.requireScope().prefix,
				connection: this.connection as ConnectionOptions,
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
			prefix: this.requireScope().prefix,
			connection: this.connection as ConnectionOptions,
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

	private async processJob(jobType: JobType, job: Job): Promise<unknown> {
		const data = readScopedJob(this.requireScope(), jobType, job.id, job.data);
		switch (jobType) {
			case JobType.ANALYZE_DOCUMENT:
				return this.processAnalyzeDocument(data as unknown as AnalyzeDocumentJob);
			case JobType.ANALYZE_PROJECT:
				return this.processAnalyzeProject(data as unknown as AnalyzeProjectJob);
			case JobType.GENERATE_SUGGESTIONS:
				return this.processGenerateSuggestions(data as unknown as GenerateSuggestionsJob);
			case JobType.BUILD_VECTOR_STORE:
				return this.processBuildVectorStore(data as unknown as BuildVectorStoreJob);
			case JobType.CHECK_CONSISTENCY:
				return this.processCheckConsistency(data as unknown as CheckConsistencyJob);
			case JobType.SYNC_DATABASE:
				return this.processSyncDatabase(data as unknown as SyncDatabaseJob);
			default:
				throw new Error(`Unknown job type: ${jobType}`);
		}
	}

	// TODO: Job processors (simplified versions)
	private async processAnalyzeDocument(
		data: AnalyzeDocumentJob
	): Promise<Record<string, unknown>> {
		if (!this.contentAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Content analyzer not initialized');
		}

		const results: Record<string, unknown> = {
			documentId: data.documentId,
			timestamp: new Date().toISOString(),
		};

		if (
			data.options?.includeReadability ||
			data.options?.includeEntities ||
			data.options?.includeSentiment
		) {
			// Use the content analyzer for full analysis
			const analysis = await this.contentAnalyzer.analyzeContent(
				data.content,
				data.documentId
			);
			results.analysis = analysis;
			results.readability = {
				fleschReadingEase: analysis.metrics.fleschReadingEase,
				fleschKincaidGrade: analysis.metrics.fleschKincaidGrade,
				readingTime: analysis.metrics.readingTime,
			};
		}

		// Store results in database if available
		if (this.databaseService) {
			try {
				// Store the analysis results. Arg 2 is the analysisType label, not the
				// document body (passing data.content here stored the whole text as the type).
				await this.databaseService.storeContentAnalysis(
					data.documentId,
					'document',
					results
				);
				this.logger.debug('Analysis results stored in database', {
					documentId: data.documentId,
				});
			} catch (error) {
				this.logger.error('Failed to store analysis results', {
					documentId: data.documentId,
					error: error instanceof Error ? error.message : String(error),
				});
				// Don't fail the job if storage fails
			}
		}

		return results;
	}

	async analyzeDocument(data: AnalyzeDocumentJob): Promise<Record<string, unknown>> {
		if (!this.contentAnalyzer) this.contentAnalyzer = new ContentAnalyzer();
		return this.processAnalyzeDocument(data);
	}

	private async processAnalyzeProject(data: AnalyzeProjectJob): Promise<Record<string, unknown>> {
		const results: Record<string, unknown>[] = [];
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

	private async processGenerateSuggestions(
		data: GenerateSuggestionsJob
	): Promise<Record<string, unknown>> {
		if (!this.aiWritingService) {
			throw createError(ErrorCode.INVALID_STATE, null, 'AI writing service not initialized');
		}

		// Generate suggestions using the AI writing service's RAG capabilities
		const suggestions: Array<{ type: string; suggestion: string; timestamp: string }> = [];
		let lastError: Error | undefined;

		try {
			// Generate different types of suggestions based on the prompt
			const promptTypes = [
				'Suggest improvements for pacing and flow',
				'Identify areas where character development could be enhanced',
				'Recommend ways to strengthen dialogue',
				'Suggest plot consistency improvements',
			];

			for (const promptType of promptTypes) {
				const fullPrompt = `${data.prompt}\n\nSpecific focus: ${promptType}\n\nContent:\n${(data.content || '').substring(0, 3000)}`;
				const suggestion = await this.aiWritingService.generateWithContext(fullPrompt, {
					topK: 3,
					temperature: 0.7,
				});
				suggestions.push({
					type: promptType,
					suggestion,
					timestamp: new Date().toISOString(),
				});
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			this.logger.error('Failed to generate suggestions', {
				documentId: data.documentId,
				error: lastError.message,
			});
		}

		// Don't report success with zero results when generation actually failed;
		// surface the error so the job is marked failed instead of silently empty.
		if (suggestions.length === 0 && lastError) {
			throw lastError;
		}

		return {
			documentId: data.documentId,
			suggestions,
			generatedAt: new Date().toISOString(),
		};
	}

	private async processBuildVectorStore(
		data: BuildVectorStoreJob
	): Promise<Record<string, unknown>> {
		if (!this.aiWritingService) {
			throw createError(ErrorCode.INVALID_STATE, null, 'AI writing service not initialized');
		}

		// Build or rebuild the vector store with the provided documents
		try {
			// Clear existing vector store if rebuilding
			if (data.rebuild) {
				await this.aiWritingService.clearMemory();
			}

			// Convert documents to the format expected by the AI writing service
			const scrivenerDocs = data.documents.map((doc) => ({
				id: doc.id,
				content: doc.content,
				title: (doc.metadata?.title as string) || `Document ${doc.id}`,
				type: 'Text' as const,
				path: (doc.metadata?.path as string) || '',
			}));

			// Build the vector store
			await this.aiWritingService.buildVectorStore(scrivenerDocs);

			this.logger.info('Vector store built successfully', {
				documentCount: data.documents.length,
				rebuilt: data.rebuild || false,
			});

			return {
				documentsProcessed: data.documents.length,
				status: 'success',
				rebuilt: data.rebuild || false,
				timestamp: new Date().toISOString(),
			};
		} catch (error) {
			this.logger.error('Failed to build vector store', {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	private async processCheckConsistency(data: CheckConsistencyJob): Promise<ContinuityReport> {
		if (!this.continuity || data.projectId !== this.requireScope().projectId)
			throw new Error(
				'Continuity analysis requires the selected project and its canonical evidence service'
			);
		if (
			!Array.isArray(data.documents) ||
			!data.documents.length ||
			data.documents.length > 5000 ||
			data.documents.some(
				(doc) =>
					!doc ||
					typeof doc.id !== 'string' ||
					typeof doc.revision !== 'string' ||
					!/^[a-f0-9]{64}$/.test(doc.revision)
			)
		)
			throw new Error(
				'Continuity jobs require 1–5000 saved document identities and revisions'
			);
		return this.continuity({
			documentIds: data.documents.map((doc) => doc.id),
			expectedRevisions: data.documents.map((doc) => ({
				documentId: doc.id,
				revision: doc.revision,
			})),
			checkTypes: data.checkTypes,
		});
	}

	private async processSyncDatabase(data: SyncDatabaseJob): Promise<Record<string, unknown>> {
		if (!this.databaseService || !this.projectPath) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Database service not initialized');
		}
		const projectPath = this.projectPath;

		// Sync documents to database
		let syncedCount = 0;
		const errors: Array<{ documentId: string; error: string }> = [];

		try {
			for (const doc of data.documents) {
				try {
					await this.databaseService.syncDocumentData({
						id: doc.id,
						title: (doc.metadata?.title as string) || `Document ${doc.id}`,
						type: (doc.metadata?.type as string) || 'Text',
						path: getDocumentPath(projectPath, doc.id),
						wordCount: doc.content.split(/\s+/).length,
						synopsis: doc.metadata?.synopsis as string,
						notes: doc.metadata?.notes as string,
					});
					syncedCount++;
				} catch (error) {
					errors.push({
						documentId: doc.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			this.logger.info('Database sync completed', {
				synced: syncedCount,
				total: data.documents.length,
				failed: errors.length,
			});

			return {
				synced: syncedCount,
				total: data.documents.length,
				failed: errors.length,
				errors: errors.length > 0 ? errors : undefined,
				timestamp: new Date().toISOString(),
			};
		} catch (error) {
			this.logger.error('Database sync failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async addJob(
		jobType: JobType,
		data: Record<string, unknown>,
		options?: { priority?: number; delay?: number }
	): Promise<string> {
		if (!this.isInitialized)
			throw createError(ErrorCode.INVALID_STATE, null, 'Job queue is not initialized');
		if (!Object.values(JobType).includes(jobType))
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Queue for job type ${jobType} not found`
			);
		if (
			options?.priority !== undefined &&
			(!Number.isInteger(options.priority) ||
				options.priority < 0 ||
				options.priority > 2097151)
		)
			throw new Error('Queue priority must be an integer from 0 through 2097151');
		if (
			options?.delay !== undefined &&
			(!Number.isSafeInteger(options.delay) || options.delay < 0)
		)
			throw new Error('Queue delay must be a non-negative safe integer');
		const scope = this.requireScope();
		const envelope = scopeJob(scope, jobType, data);
		const jobId = scopedJobId(scope);
		if (this.connectionType === 'embedded') {
			if (options?.priority || options?.delay)
				throw new Error(
					'Embedded jobs run immediately; nonzero priority or delay requires Redis or KeyDB'
				);
			return this.addEmbeddedJob(jobType, envelope, jobId);
		}

		const queue = this.queues.get(jobType);
		if (!queue) {
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Queue for job type ${jobType} not found`
			);
		}

		const job = await queue.add(jobType, envelope, { ...options, jobId });
		if (job.id !== jobId) throw new Error('Queue returned a job outside the submitted scope');
		this.logger.info(`Job ${job.id} added to queue ${jobType}`);
		return job.id as string;
	}

	/**
	 * Run a job inline, without BullMQ, when no Redis/KeyDB connection is available.
	 * Returns immediately; the result lands in `embeddedJobs` once the job settles.
	 */
	private async addEmbeddedJob(
		jobType: JobType,
		data: ScopedJob,
		jobId: string
	): Promise<string> {
		this.storeEmbeddedJob(jobId, {
			jobType,
			state: 'active',
			progress: 0,
			owner: { pid: process.pid, host: hostname() },
		});
		this.logger.info(`Job ${jobId} added to embedded queue ${jobType}`);

		const run = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
			if (this.readEmbeddedJob(jobId)?.state === 'cancelled') return;
			await this.processJob(jobType, { id: jobId, data } as Job)
				.then((result) => {
					this.finishEmbeddedJob(jobId, {
						jobType,
						state: 'completed',
						progress: 100,
						result,
					});
					this.logger.info(`Job completed: ${jobId}`);
				})
				.catch((error: unknown) => {
					this.finishEmbeddedJob(jobId, {
						jobType,
						state: 'failed',
						progress: 0,
						error: error instanceof Error ? error.message : String(error),
					});
					this.logger.error(`Job failed: ${jobId}`, { error });
				});
		});
		this.embeddedRuns.set(jobId, run);
		void run.then(
			() => this.embeddedRuns.delete(jobId),
			() => this.embeddedRuns.delete(jobId)
		);

		return jobId;
	}

	private storeEmbeddedJob(id: string, status: EmbeddedJobStatus): void {
		this.embeddedJobs.set(id, status);
		this.embeddedStore?.put(this.embeddedNamespace(), id, { id, ...status });
	}

	private finishEmbeddedJob(id: string, status: EmbeddedJobStatus): void {
		const finish = (): void => {
			if (this.readEmbeddedJob(id)?.state === 'active') this.storeEmbeddedJob(id, status);
		};
		if (this.embeddedStore) this.embeddedStore.transaction(finish);
		else finish();
	}

	private readEmbeddedJob(id: string): EmbeddedJobStatus | undefined {
		const status =
			this.embeddedStore?.get<EmbeddedJobStatus>(this.embeddedNamespace(), id) ??
			this.embeddedJobs.get(id);
		if (status?.state === 'active' && status.owner?.host === hostname()) {
			try {
				process.kill(status.owner.pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
					const interrupted: EmbeddedJobStatus = {
						...status,
						state: 'interrupted',
						error: 'The previous server stopped; this job was not automatically replayed.',
					};
					this.storeEmbeddedJob(id, interrupted);
					return interrupted;
				}
			}
		}
		return status;
	}

	async waitForJob(jobType: JobType, jobId: string): Promise<Job | EmbeddedJobStatus | null> {
		if (this.connectionType !== 'embedded')
			throw new Error(
				'waitForJob is only available for embedded jobs; poll external queue jobs'
			);
		await this.embeddedRuns.get(jobId);
		return this.getJobStatus(jobType, jobId);
	}

	async getJobStatus(jobType: JobType, jobId: string): Promise<Job | EmbeddedJobStatus | null> {
		if (!this.scope || !ownsJobId(this.scope, jobId)) return null;
		if (this.connectionType === 'embedded') {
			const status = this.readEmbeddedJob(jobId);
			return status?.jobType === jobType ? status : null;
		}

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
		readScopedJob(this.requireScope(), jobType, job.id, job.data);

		// Return the actual Job object
		return job;
	}

	/**
	 * Cancel a job
	 */
	async cancelJob(jobType: JobType, jobId: string): Promise<void> {
		if (!this.scope || !ownsJobId(this.scope, jobId))
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				'Job was not found in the selected project queue'
			);
		if (this.connectionType === 'embedded') {
			const status = this.readEmbeddedJob(jobId);
			if (!status || status.jobType !== jobType) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Job ${jobId} not found in queue ${jobType}`
				);
			}
			this.finishEmbeddedJob(jobId, { ...status, state: 'cancelled', owner: undefined });
			this.logger.info(`Job ${jobId} cancelled from queue ${jobType}`);
			return;
		}

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
		readScopedJob(this.requireScope(), jobType, job.id, job.data);

		await job.remove();
		this.logger.info(`Job ${jobId} cancelled from queue ${jobType}`);
	}

	async getQueueStats(jobType: JobType): Promise<Record<string, unknown>> {
		if (this.connectionType === 'embedded') {
			if (!Object.values(JobType).includes(jobType)) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Queue for job type ${jobType} not found`
				);
			}

			let active = 0;
			let completed = 0;
			let failed = 0;
			let cancelled = 0;
			if (this.embeddedStore) {
				const counts = this.embeddedStore.countBy(this.embeddedNamespace(), 'state', {
					field: 'jobType',
					value: jobType,
				});
				if (
					Object.keys(counts).some(
						(state) =>
							!['active', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
								state
							)
					)
				)
					throw new Error('Malformed embedded queue state');
				return {
					waiting: 0,
					active: counts.active ?? 0,
					completed: counts.completed ?? 0,
					failed: (counts.failed ?? 0) + (counts.interrupted ?? 0),
					cancelled: counts.cancelled ?? 0,
					delayed: 0,
				};
			}
			const jobs = this.embeddedJobs.values();
			for (const job of jobs) {
				if (job.jobType !== jobType) continue;
				if (job.state === 'active') active++;
				else if (job.state === 'completed') completed++;
				else if (job.state === 'cancelled') cancelled++;
				else failed++;
			}
			return { waiting: 0, active, completed, failed, cancelled, delayed: 0 };
		}

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

	private requireScope(): QueueScope {
		if (!this.scope)
			throw createError(ErrorCode.INVALID_STATE, null, 'Queue project scope is unavailable');
		return this.scope;
	}

	private embeddedNamespace(): string {
		return `embedded-jobs:${this.requireScope().id}`;
	}

	getConnectionInfo(): {
		type: string;
		isConnected: boolean;
		scopeId?: string;
		legacyQueues: 'excluded';
		migrationNotice: string;
	} {
		return {
			type: this.connectionType,
			isConnected: this.isInitialized,
			scopeId: this.scope?.id,
			legacyQueues: 'excluded',
			migrationNotice: LEGACY_QUEUE_NOTICE,
		};
	}

	/**
	 * Shutdown gracefully
	 */
	async shutdown(): Promise<void> {
		this.isInitialized = false;
		this.logger.info('Shutting down job queue service');
		await Promise.all(this.embeddedRuns.values());
		this.embeddedStore?.close();
		this.embeddedStore = undefined;

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
			await this.connection.quit();
		}

		// Clear maps
		this.queues.clear();
		this.workers.clear();
		this.events.clear();
		this.embeddedJobs.clear();
		this.contentAnalyzer?.dispose();
		const results = await Promise.allSettled([
			this.databaseService?.close(),
			this.aiWritingService?.clearMemory(),
		]);
		if (results[0].status === 'fulfilled') this.databaseService = null;
		if (results[1].status === 'fulfilled') this.aiWritingService = null;
		this.contentAnalyzer = null;
		this.connection = undefined;
		this.scope = undefined;
		this.continuity = undefined;

		this.isInitialized = false;
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : []
		);
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, 'Job queue resources failed to close');
		this.logger.info('Job queue service shutdown complete');
	}
}
