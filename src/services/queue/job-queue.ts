/**
 * Optimized BullMQ job queue with automatic KeyDB/Redis detection
 */

import type { Job, ConnectionOptions } from 'bullmq';
import { Queue, QueueEvents, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import * as path from 'path';
import { ContentAnalyzer } from '../../analysis/base-analyzer.js';
import { createError, ErrorCode } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import { getQueueStatePath } from '../../utils/project-utils.js';
import { DatabaseService } from '../../handlers/database/database-service.js';
import { getEnvConfig } from '../../utils/env-config.js';
import { getDocumentPath } from '../../utils/scrivener-utils.js';
import { AIClient } from '../ai/ai-client.js';
import { AIWritingService } from '../ai/ai-writing-service.js';
import { createBullMQConnection, detectConnection } from './keydb-detector.js';
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
	documents: Array<{ id: string; content: string }>;
	checkTypes?: string[];
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
	state: 'active' | 'completed' | 'failed';
	progress: number;
	result?: unknown;
	error?: string;
}

/**
 * Optimized Job Queue Service
 */
export class JobQueueService {
	private queues: Map<JobType, Queue> = new Map();
	private workers: Map<JobType, Worker> = new Map();
	private events: Map<JobType, QueueEvents> = new Map();
	private connection: Redis | MemoryRedis | undefined = undefined;
	private memoryRedis: MemoryRedis | undefined = undefined;
	private embeddedJobs: Map<string, EmbeddedJobStatus> = new Map();
	private embeddedJobCounter = 0;
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

	/**
	 * Initialize with automatic KeyDB/Redis detection
	 */
	async initialize(
		options: {
			openaiApiKey?: string;
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
					? getQueueStatePath(this.projectPath)
					: './data/queue-state.json';

				// Create directory if needed
				const fs = await import('fs/promises');
				const dir = path.dirname(persistPath);
				await fs.mkdir(dir, { recursive: true });

				this.memoryRedis = new MemoryRedis({ persistPath });
				await this.memoryRedis.connect();
				this.connection = this.memoryRedis;
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
				this.databaseService = new DatabaseService(this.projectPath);
				await this.databaseService.initialize();
				this.logger.info('Database service initialized');
			}

			this.contentAnalyzer = new ContentAnalyzer();

			// Step 3: Create queues and workers for each job type.
			// MemoryRedis is not a real ioredis client (no duplicate(), no Lua script
			// support), so handing it to BullMQ as `connection` makes BullMQ treat it as
			// connection *options* instead and open a real socket to the default
			// 127.0.0.1:6379 -- which then fails forever since nothing listens there.
			// The embedded fallback runs jobs inline instead of through BullMQ.
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

	/**
	 * Create a queue for a job type
	 */
	private createQueue(jobType: JobType): void {
		if (!this.connection) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Connection not initialized');
		}
		const queue = new Queue(jobType, {
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
				this.aiWritingService.clearMemory();
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

	private async processCheckConsistency(
		data: CheckConsistencyJob
	): Promise<Record<string, unknown>> {
		// Perform comprehensive consistency checks
		const issues: Array<{
			type: string;
			severity: string;
			description: string;
			details: unknown;
		}> = [];
		const checkTypes = data.checkTypes || ['characters', 'timeline', 'locations', 'plot'];

		try {
			// Character consistency checks
			if (checkTypes.includes('characters')) {
				const characterIssues = this.checkCharacterConsistency(data.documents);
				issues.push(...characterIssues);
			}

			// Timeline consistency checks
			if (checkTypes.includes('timeline')) {
				const timelineIssues = this.checkTimelineConsistency(data.documents);
				issues.push(...timelineIssues);
			}

			// Location consistency checks
			if (checkTypes.includes('locations')) {
				const locationIssues = await this.checkLocationConsistency(data.documents);
				issues.push(...locationIssues);
			}

			// Plot consistency checks
			if (checkTypes.includes('plot')) {
				const plotIssues = await this.checkPlotConsistency(data.documents);
				issues.push(...plotIssues);
			}

			// Sort issues by severity
			issues.sort((a, b) => {
				const severityOrder = { high: 0, medium: 1, low: 2 };
				return (
					(severityOrder[a.severity as keyof typeof severityOrder] || 2) -
					(severityOrder[b.severity as keyof typeof severityOrder] || 2)
				);
			});

			return {
				documents: data.documents.length,
				issues,
				totalIssues: issues.length,
				byType: checkTypes.reduce(
					(acc, type) => {
						acc[type] = issues.filter((i) => i.type === type).length;
						return acc;
					},
					{} as Record<string, number>
				),
				checkedAt: new Date().toISOString(),
			};
		} catch (error) {
			this.logger.error('Consistency check failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			return { documents: data.documents.length, issues: [], error: 'Check failed' };
		}
	}

	private checkCharacterConsistency(documents: Array<{ id: string; content: string }>) {
		const issues: Array<{
			type: string;
			severity: string;
			description: string;
			details: unknown;
		}> = [];
		const characterMentions = new Map<string, number[]>();

		// Track character mentions across documents
		documents.forEach((doc, index) => {
			// Simple character detection - look for capitalized names
			const names = doc.content.match(/\b[A-Z][a-z]+\b/g) || [];
			names.forEach((name) => {
				if (!characterMentions.has(name)) {
					characterMentions.set(name, []);
				}
				characterMentions.get(name)?.push(index);
			});
		});

		// Check for disappearing characters
		characterMentions.forEach((mentions, character) => {
			if (mentions.length > 2) {
				const gaps: Array<{ start: number; end: number; gap: number }> = [];
				for (let i = 1; i < mentions.length; i++) {
					const gap = mentions[i] - mentions[i - 1];
					if (gap > 3) {
						gaps.push({ start: mentions[i - 1], end: mentions[i], gap });
					}
				}
				if (gaps.length > 0) {
					issues.push({
						type: 'characters',
						severity: gaps.some((g) => g.gap > 5) ? 'high' : 'medium',
						description: `Character "${character}" has unexplained absences`,
						details: gaps,
					});
				}
			}
		});

		return issues;
	}

	private checkTimelineConsistency(documents: Array<{ id: string; content: string }>) {
		const issues: Array<{
			type: string;
			severity: string;
			description: string;
			details: unknown;
		}> = [];
		const timeMarkers: Array<{ docIndex: number; marker: string }> = [];

		documents.forEach((doc, index) => {
			// Look for time indicators
			const timePatterns = [
				/\b(\d{1,2})\s*(hours?|days?|weeks?|months?|years?)\s*(ago|later|before|after)\b/gi,
				/\b(morning|afternoon|evening|night|dawn|dusk|midnight|noon)\b/gi,
				/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi,
			];

			timePatterns.forEach((pattern) => {
				const matches = doc.content.match(pattern) || [];
				matches.forEach((match) => {
					timeMarkers.push({ docIndex: index, marker: match });
				});
			});
		});

		// Check for conflicting time references
		if (timeMarkers.length > 10) {
			issues.push({
				type: 'timeline',
				severity: 'low',
				description: 'Multiple time references detected - verify chronological consistency',
				details: { markerCount: timeMarkers.length },
			});
		}

		return issues;
	}

	private async checkLocationConsistency(_documents: Array<{ id: string; content: string }>) {
		const issues: Array<{
			type: string;
			severity: string;
			description: string;
			details: unknown;
		}> = [];

		try {
			// Use AI to detect spatial and location inconsistencies
			if (this.aiWritingService) {
				const response = await this.aiWritingService.generateWithContext(
					`Analyze these manuscript excerpts for location and spatial inconsistencies.
					Look for characters being in two places at once, distances changing, or layout contradictions.`
				);

				if (
					response.toLowerCase().includes('inconsistency') ||
					response.toLowerCase().includes('contradiction')
				) {
					issues.push({
						type: 'locations',
						severity: 'medium',
						description: 'Potential spatial or location inconsistency detected',
						details: response,
					});
				}
			}
		} catch (error) {
			this.logger.warn('AI location check failed, falling back to pattern matching', {
				error,
			});
		}

		return issues;
	}

	private async checkPlotConsistency(documents: Array<{ id: string; content: string }>) {
		const issues: Array<{
			type: string;
			severity: string;
			description: string;
			details: unknown;
		}> = [];

		try {
			if (this.aiWritingService) {
				const response = await this.aiWritingService.checkPlotConsistency(
					documents.map((d) => ({
						...d,
						title: `Document ${d.id}`,
						type: 'Text' as const,
						path: '',
					}))
				);

				return response.map((issue) => ({
					type: 'plot',
					severity: issue.severity,
					description: issue.issue,
					details: { suggestion: issue.suggestion, locations: issue.locations },
				}));
			}
		} catch (error) {
			this.logger.warn('AI plot check failed', { error });
		}

		return issues;
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
			// Begin a transaction for atomic sync
			const transactionId = await this.databaseService.beginTransaction();

			try {
				// Sync each document
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

				// Prepare and commit the transaction if successful
				if (syncedCount > 0) {
					await this.databaseService.prepareTransaction(transactionId);
					await this.databaseService.commitTransaction(transactionId);
				} else {
					// Rollback if nothing was synced
					await this.databaseService.rollbackTransaction(transactionId);
				}
			} catch (error) {
				// Rollback on any error
				await this.databaseService.rollbackTransaction(transactionId);
				throw error;
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

	/**
	 * Add a job to the queue
	 */
	async addJob(
		jobType: JobType,
		data: Record<string, unknown>,
		options?: { priority?: number; delay?: number }
	): Promise<string> {
		if (this.connectionType === 'embedded') {
			return this.addEmbeddedJob(jobType, data);
		}

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
	 * Run a job inline, without BullMQ, when no Redis/KeyDB connection is available.
	 * Returns immediately; the result lands in `embeddedJobs` once the job settles.
	 */
	private async addEmbeddedJob(jobType: JobType, data: Record<string, unknown>): Promise<string> {
		if (!Object.values(JobType).includes(jobType)) {
			throw createError(ErrorCode.NOT_FOUND, undefined, `Queue for job type ${jobType} not found`);
		}

		const jobId = `embedded-${jobType}-${++this.embeddedJobCounter}`;
		this.embeddedJobs.set(jobId, { jobType, state: 'active', progress: 0 });
		this.logger.info(`Job ${jobId} added to embedded queue ${jobType}`);

		void this.processJob(jobType, { id: jobId, data } as Job)
			.then((result) => {
				this.embeddedJobs.set(jobId, {
					jobType,
					state: 'completed',
					progress: 100,
					result,
				});
				this.logger.info(`Job completed: ${jobId}`);
			})
			.catch((error: unknown) => {
				this.embeddedJobs.set(jobId, {
					jobType,
					state: 'failed',
					progress: 0,
					error: error instanceof Error ? error.message : String(error),
				});
				this.logger.error(`Job failed: ${jobId}`, { error });
			});

		return jobId;
	}

	/**
	 * Get job status
	 */
	async getJobStatus(jobType: JobType, jobId: string): Promise<Job | EmbeddedJobStatus | null> {
		if (this.connectionType === 'embedded') {
			return this.embeddedJobs.get(jobId) ?? null;
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

		// Return the actual Job object
		return job;
	}

	/**
	 * Cancel a job
	 */
	async cancelJob(jobType: JobType, jobId: string): Promise<void> {
		if (this.connectionType === 'embedded') {
			if (!this.embeddedJobs.delete(jobId)) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Job ${jobId} not found in queue ${jobType}`
				);
			}
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

		await job.remove();
		this.logger.info(`Job ${jobId} cancelled from queue ${jobType}`);
	}

	/**
	 * Get queue statistics
	 */
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
			for (const job of this.embeddedJobs.values()) {
				if (job.jobType !== jobType) continue;
				if (job.state === 'active') active++;
				else if (job.state === 'completed') completed++;
				else failed++;
			}
			return { waiting: 0, active, completed, failed, delayed: 0 };
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
		this.embeddedJobs.clear();

		this.isInitialized = false;
		this.logger.info('Job queue service shutdown complete');
	}
}
