import type { ContinuityOptions, ContinuityReport } from '../editorial/continuity-service.js';
import type { ManuscriptSource } from '../editorial/types.js';
/**
 * Optimized BullMQ job queue with automatic KeyDB/Redis detection
 */

import type { Job, ConnectionOptions } from 'bullmq';
import { Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import * as path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { ContentAnalyzer } from '../../analysis/base-analyzer.js';
import { extractNamedEntities } from 'narrative-lens';
import { nlpAnalyzer } from '../analysis/nlp-sentiment-analyzer.js';
import { analysisEnvelope } from '../editorial/analysis-envelope.js';
import { createError, ErrorCode } from '../../core/errors.js';
import { getLogger } from '../../core/logger.js';
import { DatabaseService } from '../../handlers/database/database-service.js';
import { getEnvConfig } from '../../utils/env-config.js';
import { getDocumentPath } from '../../utils/scrivener-utils.js';
import { AIClient } from '../ai/ai-client.js';
import { AIWritingService } from '../ai/ai-writing-service.js';
import {
	WritingSuggestions,
	type SuggestionRequest,
	type PreparedSuggestions,
	type SuggestionResult,
} from '../ai/writing-suggestions.js';
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
	options?: { parallel?: boolean; batchSize?: number };
}

const analysisFlags = ['includeReadability', 'includeEntities', 'includeSentiment'] as const;
const liveEmbeddedOwners = new Set<string>();
export const MAX_ANALYSIS_CONTENT_LENGTH = 5_000_000;
export const MAX_ANALYSIS_DOCUMENTS = 5000;
export const MAX_EMBEDDED_ACTIVE_JOBS = 5;
export const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
export const MAX_RETAINED_JOBS = 100;
export const QUEUE_RESULT_TTL_MS = 3600_000;

function validateDocumentAnalysis(data: AnalyzeDocumentJob): void {
	if (
		!data ||
		typeof data.documentId !== 'string' ||
		!data.documentId.trim() ||
		data.documentId.length > 255 ||
		typeof data.content !== 'string' ||
		data.content.length > MAX_ANALYSIS_CONTENT_LENGTH
	)
		throw new UnrecoverableError(
			'Analysis requires a 1–255 character documentId and text up to 5000000 characters'
		);
	if (
		data.options !== undefined &&
		(!data.options ||
			typeof data.options !== 'object' ||
			Array.isArray(data.options) ||
			Object.entries(data.options).some(
				([key, value]) =>
					!analysisFlags.includes(key as (typeof analysisFlags)[number]) ||
					typeof value !== 'boolean'
			))
	)
		throw new UnrecoverableError(
			'Analysis options must contain only boolean includeReadability, includeEntities and includeSentiment flags'
		);
}

export type GenerateSuggestionsJob = PreparedSuggestions;

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
	inputBytes?: number;
	finishedAt?: number;
	cancellation?: 'requested' | 'stopped' | 'result-discarded';
	result?: unknown;
	error?: string;
	owner?: { pid: number; host: string; instance?: string };
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
	private readonly controllers = new Map<string, AbortController>();
	private readonly embeddedRuns = new Map<string, Promise<void>>();
	private readonly pendingEmbeddedResults = new Map<string, EmbeddedJobStatus>();
	private logger: ReturnType<typeof getLogger>;

	// Services
	private contentAnalyzer: ContentAnalyzer | null = null;
	private aiWritingService: AIWritingService | null = null;
	private writingSuggestions?: WritingSuggestions;
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
			source?: () => ManuscriptSource;
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
		if (
			this.embeddedStore ||
			this.connection ||
			this.workers.size ||
			this.events.size ||
			this.queues.size ||
			this.contentAnalyzer ||
			this.databaseService ||
			this.aiWritingService
		)
			await this.shutdown();

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
			this.aiWritingService = new AIWritingService(aiClient);
			this.writingSuggestions = new WritingSuggestions(
				this.aiWritingService,
				this.requireScope().projectId,
				this.projectPath,
				options.source
			);

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
					if (![JobType.EXPORT_PROJECT, JobType.BATCH_ANALYSIS].includes(jobType))
						this.createWorker(jobType);
					this.setupEventListeners(jobType);
				}
			}

			this.isInitialized = true;
			liveEmbeddedOwners.add(this.unboundIdentity);
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
					count: MAX_RETAINED_JOBS,
				},
				attempts: jobType === JobType.GENERATE_SUGGESTIONS ? 1 : 3,
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
					if (!job.id) throw new UnrecoverableError('Queue job has no identity');
					if (this.readEmbeddedJob(job.id)?.state !== 'active')
						this.reserveJob(jobType, job.data as ScopedJob, job.id, false);
					const result = await this.processJob(
						jobType,
						job,
						AbortSignal.timeout(300_000)
					);
					if (Buffer.byteLength(JSON.stringify(result) ?? 'null') > MAX_QUEUE_BYTES)
						throw new UnrecoverableError(
							'Queue result exceeds the 64 MiB retention budget'
						);
					this.finishEmbeddedJob(job.id, { jobType, state: 'completed', progress: 100 });
					this.logger.debug(`Job ${job.id} completed successfully`);
					return result;
				} catch (error) {
					if (
						job.id &&
						(error instanceof UnrecoverableError ||
							job.attemptsMade + 1 >= (job.opts?.attempts ?? 1))
					)
						this.finishEmbeddedJob(job.id, { jobType, state: 'failed', progress: 0 });
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

	private getConcurrency(jobType: JobType): number {
		switch (jobType) {
			case JobType.ANALYZE_DOCUMENT:
				return 5;
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

	private async processJob(jobType: JobType, job: Job, signal?: AbortSignal): Promise<unknown> {
		signal?.throwIfAborted();
		const data = readScopedJob(this.requireScope(), jobType, job.id, job.data);
		this.validateAnalysisJob(jobType, data);
		switch (jobType) {
			case JobType.ANALYZE_DOCUMENT:
				return this.processAnalyzeDocument(data as unknown as AnalyzeDocumentJob);
			case JobType.ANALYZE_PROJECT:
				return this.processAnalyzeProject(data as unknown as AnalyzeProjectJob, signal);
			case JobType.GENERATE_SUGGESTIONS:
				return this.processGenerateSuggestions(
					data as unknown as GenerateSuggestionsJob,
					signal
				);
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

	private async processAnalyzeDocument(
		data: AnalyzeDocumentJob
	): Promise<Record<string, unknown>> {
		validateDocumentAnalysis(data);
		if (!this.contentAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, null, 'Content analyzer not initialized');
		}

		const options = {
			includeReadability: data.options?.includeReadability ?? true,
			includeEntities: data.options?.includeEntities ?? false,
			includeSentiment: data.options?.includeSentiment ?? false,
		};
		const analysis = await this.contentAnalyzer.analyzeContent(data.content, data.documentId);
		const results: Record<string, unknown> = {
			documentId: data.documentId,
			timestamp: new Date().toISOString(),
			envelope: analysisEnvelope(
				this.scope?.projectId ?? this.unboundIdentity,
				'document',
				[
					{
						documentId: data.documentId,
						revision: createHash('sha256').update(data.content).digest('hex'),
					},
				],
				{},
				'raw',
				{ operation: 'queue_document_analysis', options },
				'supplied-text'
			),
			analysis,
		};

		if (options.includeReadability) {
			const available =
				analysis.metrics.fleschReadingEase !== null &&
				analysis.metrics.fleschKincaidGrade !== null;
			results.readability = {
				availability: available ? 'available' : 'unavailable',
				...(!available
					? {
							reason: analysis.unavailable?.includes('metrics')
								? 'analysis_failed'
								: 'no_words',
						}
					: {}),
				fleschReadingEase: analysis.metrics.fleschReadingEase,
				fleschKincaidGrade: analysis.metrics.fleschKincaidGrade,
				readingTime: analysis.metrics.readingTime,
			};
		}
		if (options.includeEntities) {
			try {
				const value = extractNamedEntities([data.content]);
				results.entities = value.modelIdentity
					? { availability: 'available', method: 'narrative-lens-ner', value }
					: {
							availability: 'unavailable',
							method: 'narrative-lens-ner',
							reason: 'model_unavailable',
							value: null,
						};
			} catch (error) {
				results.entities = {
					availability: 'unavailable',
					method: 'narrative-lens-ner',
					reason:
						error instanceof Error && error.message === 'onnx_feature_disabled'
							? 'onnx_feature_disabled'
							: 'analysis_failed',
					value: null,
				};
			}
		}
		if (options.includeSentiment) {
			try {
				const value = nlpAnalyzer.analyzeSentiment(data.content);
				results.sentiment = value.tokens.length
					? {
							availability: 'available',
							method: 'local-lexicon',
							score: value.score,
							comparative: value.comparative,
							emotion: value.emotion,
						}
					: {
							availability: 'unavailable',
							method: 'local-lexicon',
							reason: 'no_words',
							score: null,
							comparative: null,
							emotion: null,
						};
			} catch {
				results.sentiment = {
					availability: 'unavailable',
					method: 'local-lexicon',
					reason: 'analysis_failed',
					score: null,
					comparative: null,
					emotion: null,
				};
			}
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
		validateDocumentAnalysis(data);
		const snapshot = scopeJob(
			this.scope ?? createQueueScope(this.unboundIdentity),
			JobType.ANALYZE_DOCUMENT,
			data as unknown as Record<string, unknown>
		).payload;
		if (!this.contentAnalyzer) this.contentAnalyzer = new ContentAnalyzer();
		return this.processAnalyzeDocument(snapshot as unknown as AnalyzeDocumentJob);
	}

	private validateAnalysisJob(jobType: JobType, data: Record<string, unknown>): void {
		if (jobType === JobType.ANALYZE_DOCUMENT)
			validateDocumentAnalysis(data as unknown as AnalyzeDocumentJob);
		if (jobType !== JobType.ANALYZE_PROJECT) return;
		const project = data as unknown as AnalyzeProjectJob;
		if (
			typeof project.projectId !== 'string' ||
			!project.projectId.trim() ||
			project.projectId.length > 255 ||
			!Array.isArray(project.documents) ||
			!project.documents.length ||
			project.documents.length > MAX_ANALYSIS_DOCUMENTS
		)
			throw new UnrecoverableError(
				'Project analysis requires a 1–255 character projectId and 1–5000 documents'
			);
		const ids = new Set<string>();
		for (const doc of project.documents) {
			validateDocumentAnalysis({ documentId: doc?.id, content: doc?.content });
			if (ids.has(doc.id))
				throw new UnrecoverableError(
					'Project analysis document identifiers must be unique'
				);
			ids.add(doc.id);
		}
		if (
			project.options !== undefined &&
			(!project.options ||
				typeof project.options !== 'object' ||
				Array.isArray(project.options) ||
				Object.keys(project.options).some(
					(key) => !['parallel', 'batchSize'].includes(key)
				) ||
				(project.options.parallel !== undefined &&
					typeof project.options.parallel !== 'boolean') ||
				(project.options.batchSize !== undefined &&
					(!Number.isInteger(project.options.batchSize) ||
						project.options.batchSize < 1 ||
						project.options.batchSize > 5)))
		)
			throw new UnrecoverableError(
				'Project analysis options require a boolean parallel flag and an integer batchSize from 1 through 5'
			);
	}

	private async processAnalyzeProject(
		data: AnalyzeProjectJob,
		signal?: AbortSignal
	): Promise<Record<string, unknown>> {
		const results: Record<string, unknown>[] = [];
		const batchSize = data.options?.parallel ? (data.options.batchSize ?? 5) : 1;
		for (let start = 0; start < data.documents.length; start += batchSize) {
			signal?.throwIfAborted();
			const batch = await Promise.allSettled(
				data.documents
					.slice(start, start + batchSize)
					.map((doc) =>
						this.processAnalyzeDocument({ documentId: doc.id, content: doc.content })
					)
			);
			const failures = batch.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : []
			);
			if (failures.length)
				throw new AggregateError(failures, 'Project document analysis failed');
			for (const result of batch)
				if (result.status === 'fulfilled') results.push(result.value);
		}
		return { projectId: data.projectId, documents: results };
	}

	private async processGenerateSuggestions(
		data: GenerateSuggestionsJob,
		signal?: AbortSignal
	): Promise<SuggestionResult> {
		if (!this.writingSuggestions) throw new Error('Writing suggestions are unavailable');
		return this.writingSuggestions.generate(data, signal);
	}

	async generateSuggestions(
		data: SuggestionRequest,
		signal?: AbortSignal
	): Promise<SuggestionResult> {
		if (!this.isInitialized || !this.writingSuggestions)
			throw new Error('Writing suggestions are unavailable');
		signal?.throwIfAborted();
		return this.processGenerateSuggestions(await this.writingSuggestions.prepare(data), signal);
	}

	async analyzeWritingStyle(samples: string[]) {
		if (!this.isInitialized || !this.aiWritingService?.isAvailable)
			throw new Error('AI writing provider is unavailable');
		const { projectId } = this.requireScope();
		const result = await this.aiWritingService.analyzeWritingStyle(samples);
		return {
			...result,
			envelope: analysisEnvelope(
				projectId,
				'document',
				result.coverage.samples.map(({ sampleId, revision }) => ({
					documentId: sampleId,
					revision,
				})),
				{},
				'provider',
				{ operation: 'analyze_writing_style', coverage: result.coverage },
				'supplied-text'
			),
		};
	}

	private async processBuildVectorStore(
		data: BuildVectorStoreJob
	): Promise<Record<string, unknown>> {
		if (!this.aiWritingService) {
			throw createError(ErrorCode.INVALID_STATE, null, 'AI writing service not initialized');
		}

		try {
			const scrivenerDocs = data.documents.map((doc) => {
				const metadata = doc.metadata ?? {};
				for (const key of ['title', 'path', 'revision'])
					if (metadata[key] !== undefined && typeof metadata[key] !== 'string')
						throw new Error(`Indexed document metadata ${key} must be a string`);
				const {
					title,
					path: sourcePath,
					revision,
				} = metadata as Record<string, string | undefined>;
				return {
					id: doc.id,
					content: doc.content,
					title: title || `Document ${doc.id}`,
					type: 'Text' as const,
					path: sourcePath || '',
					...(revision !== undefined ? { metadata: { revision } } : {}),
				};
			});

			await this.aiWritingService.buildVectorStore(scrivenerDocs, { rebuild: data.rebuild });

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
		if ([JobType.EXPORT_PROJECT, JobType.BATCH_ANALYSIS].includes(jobType))
			throw new Error(
				'This legacy job type cannot be submitted; use the export_project tool or queue_project_analysis.'
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
		const payload =
			jobType === JobType.GENERATE_SUGGESTIONS
				? {
						...(await this.writingSuggestions!.prepare(
							data as unknown as SuggestionRequest
						)),
					}
				: data;
		if (!this.isInitialized) throw new Error('Job queue closed during request admission');
		const envelope = scopeJob(scope, jobType, payload);
		this.validateAnalysisJob(jobType, envelope.payload);
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

		this.reserveJob(jobType, envelope, jobId, false);
		let job: Job;
		try {
			job = await queue.add(jobType, envelope, { ...options, jobId });
		} catch (error) {
			throw new Error(
				`Redis submission outcome is unknown for ${jobId}; its capacity reservation is retained until completion or confirmed cancellation.`,
				{ cause: error }
			);
		}
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
		this.reserveJob(jobType, data, jobId, true);
		const controller = new AbortController();
		this.controllers.set(jobId, controller);
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
		this.logger.info(`Job ${jobId} added to embedded queue ${jobType}`);

		const run = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
			let status: EmbeddedJobStatus;
			try {
				signal.throwIfAborted();
				const result = await this.processJob(jobType, { id: jobId, data } as Job, signal);
				status =
					signal.aborted || this.readEmbeddedJob(jobId)?.cancellation === 'requested'
						? {
								jobType,
								state: 'cancelled',
								progress: 0,
								cancellation: 'result-discarded',
							}
						: { jobType, state: 'completed', progress: 100, result };
				if (Buffer.byteLength(JSON.stringify(status)) > MAX_QUEUE_BYTES)
					throw new Error('Queue result exceeds the 64 MiB retention budget');
			} catch (error) {
				status = {
					jobType,
					state:
						signal.aborted || this.readEmbeddedJob(jobId)?.cancellation === 'requested'
							? 'cancelled'
							: 'failed',
					...(signal.aborted ? { cancellation: 'stopped' as const } : {}),
					progress: 0,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			try {
				this.finishEmbeddedJob(jobId, status);
			} catch {
				this.logger.error('Background job outcome is awaiting durable storage', { jobId });
			}
		});
		this.embeddedRuns.set(jobId, run);
		void run.then(
			() => {
				this.embeddedRuns.delete(jobId);
				this.controllers.delete(jobId);
			},
			() => this.embeddedRuns.delete(jobId)
		);

		return jobId;
	}

	private reserveJob(jobType: JobType, data: ScopedJob, jobId: string, embedded: boolean): void {
		const inputBytes = Buffer.byteLength(JSON.stringify(data));
		const admit = (): void => {
			this.pruneEmbeddedJobs();
			const active = this.activeEmbeddedJobs();
			if (
				active.length >= MAX_EMBEDDED_ACTIVE_JOBS ||
				active.reduce((bytes, status) => bytes + (status.inputBytes ?? 0), inputBytes) >
					MAX_QUEUE_BYTES
			)
				throw new Error(
					'Queue is saturated: active job or 64 MiB input budget reached; retry after polling existing jobs.'
				);
			this.storeEmbeddedJob(jobId, {
				jobType,
				state: 'active',
				progress: 0,
				inputBytes,
				...(embedded
					? {
							owner: {
								pid: process.pid,
								host: hostname(),
								instance: this.unboundIdentity,
							},
						}
					: {}),
			});
		};
		if (this.embeddedStore) this.embeddedStore.transaction(admit);
		else admit();
	}

	private activeEmbeddedJobs(): EmbeddedJobStatus[] {
		if (!this.embeddedStore)
			return [...this.embeddedJobs.values()].filter((status) => status.state === 'active');
		const items = this.embeddedStore.page<EmbeddedJobStatus & { id: string }>(
			this.embeddedNamespace(),
			{ limit: 100 },
			['id', 'state', 'inputBytes'],
			{ field: 'state', values: ['active'] }
		).items;
		return items.filter((status) => this.readEmbeddedJob(status.id)?.state === 'active');
	}

	private pruneEmbeddedJobs(): void {
		const entries: Array<[string, EmbeddedJobStatus]> = [];
		if (this.embeddedStore) {
			let after: string | undefined;
			do {
				const page = this.embeddedStore.page<EmbeddedJobStatus & { id: string }>(
					this.embeddedNamespace(),
					{ limit: 100, after },
					['id', 'state', 'finishedAt']
				);
				for (const item of page.items) entries.push([item.id, item]);
				after = page.nextCursor ?? undefined;
			} while (after);
		} else entries.push(...this.embeddedJobs);
		const terminal = entries
			.filter(([, status]) => status.state !== 'active')
			.sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
		let retained = terminal.length;
		let bytes =
			this.embeddedStore?.usage(this.embeddedNamespace()).bytes ??
			Buffer.byteLength(JSON.stringify([...this.embeddedJobs]));
		for (const [id, status] of terminal) {
			const expired =
				status.finishedAt !== undefined &&
				Date.now() - status.finishedAt >= QUEUE_RESULT_TTL_MS;
			if (!expired && retained <= MAX_RETAINED_JOBS && bytes <= MAX_QUEUE_BYTES) continue;
			if (this.pendingEmbeddedResults.has(id) || this.embeddedRuns.has(id)) continue;
			if (this.embeddedStore) {
				this.embeddedStore.delete(this.embeddedNamespace(), id);
				bytes = this.embeddedStore.usage(this.embeddedNamespace()).bytes;
			} else {
				this.embeddedJobs.delete(id);
				bytes = Buffer.byteLength(JSON.stringify([...this.embeddedJobs]));
			}
			retained--;
		}
	}

	private storeEmbeddedJob(id: string, status: EmbeddedJobStatus): void {
		if (this.embeddedStore)
			this.embeddedStore.put(this.embeddedNamespace(), id, { id, ...status });
		else this.embeddedJobs.set(id, status);
	}

	private finishEmbeddedJob(id: string, status: EmbeddedJobStatus): void {
		const terminal = this.pendingEmbeddedResults.get(id) ?? {
			...status,
			finishedAt: status.finishedAt ?? Date.now(),
		};
		const finish = (): EmbeddedJobStatus => {
			const current = this.embeddedStore
				? this.embeddedStore.get<EmbeddedJobStatus>(this.embeddedNamespace(), id)
				: this.embeddedJobs.get(id);
			if (!current) throw new Error('Embedded job state disappeared before completion');
			if (current.state !== 'active') return current;
			this.embeddedStore?.put(this.embeddedNamespace(), id, { id, ...terminal });
			return terminal;
		};
		try {
			const committed = this.embeddedStore
				? this.embeddedStore.transaction(finish)
				: finish();
			if (!this.embeddedStore) this.embeddedJobs.set(id, committed);
			this.pendingEmbeddedResults.delete(id);
			this.pruneEmbeddedJobs();
		} catch (cause) {
			this.pendingEmbeddedResults.set(id, terminal);
			throw new Error(
				'Background job outcome is awaiting durable storage; retry after storage recovers.',
				{ cause }
			);
		}
	}

	private readEmbeddedJob(id: string): EmbeddedJobStatus | undefined {
		const pending = this.pendingEmbeddedResults.get(id);
		if (pending) this.finishEmbeddedJob(id, pending);
		const status = this.embeddedStore
			? this.embeddedStore.get<EmbeddedJobStatus>(this.embeddedNamespace(), id)
			: this.embeddedJobs.get(id);
		if (status?.state === 'active' && status.owner?.host === hostname()) {
			let stopped =
				status.owner.pid === process.pid &&
				Boolean(status.owner.instance) &&
				!liveEmbeddedOwners.has(status.owner.instance!);
			if (!stopped) {
				try {
					process.kill(status.owner.pid, 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ESRCH') stopped = true;
					else if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
				}
			}
			if (stopped) {
				const interrupted: EmbeddedJobStatus = {
					...status,
					state: 'interrupted',
					error: 'The previous server stopped; this job was not automatically replayed.',
				};
				this.storeEmbeddedJob(id, interrupted);
				return interrupted;
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
			this.pruneEmbeddedJobs();
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
			if (status.state !== 'active') return;
			const cancel = (): void => {
				const current = this.readEmbeddedJob(jobId);
				if (current?.state === 'active')
					this.storeEmbeddedJob(jobId, { ...current, cancellation: 'requested' });
			};
			if (this.embeddedStore) this.embeddedStore.transaction(cancel);
			else cancel();
			this.controllers.get(jobId)?.abort(new Error('Job cancellation requested'));
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

		if ((await job.getState()) === 'active')
			throw new Error(
				'This Redis job is active and cannot be interrupted; wait for completion.'
			);
		await job.remove();
		if (this.readEmbeddedJob(jobId))
			this.finishEmbeddedJob(jobId, {
				jobType,
				state: 'cancelled',
				progress: 0,
				cancellation: 'stopped',
			});
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
			for (const [id, status] of this.pendingEmbeddedResults)
				if (status.jobType === jobType) this.finishEmbeddedJob(id, status);

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

	/** Borrowed service; queue shutdown drains work and owns its cleanup. */
	getWritingService(): AIWritingService | null {
		return this.aiWritingService;
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
		const failures: unknown[] = [];
		const close = async (operation: () => unknown): Promise<boolean> => {
			try {
				await operation();
				return true;
			} catch (error) {
				failures.push(error);
				return false;
			}
		};
		for (const run of await Promise.allSettled(this.embeddedRuns.values()))
			if (run.status === 'rejected') failures.push(run.reason);
		for (const [id, status] of this.pendingEmbeddedResults) {
			try {
				this.finishEmbeddedJob(id, status);
			} catch (error) {
				failures.push(error);
			}
		}

		for (const [type, worker] of this.workers.entries()) {
			if (await close(() => worker.close())) this.workers.delete(type);
		}
		if (this.workers.size)
			throw new AggregateError(
				failures,
				'Job queue workers failed to close; dependent resources retained'
			);
		if (!this.pendingEmbeddedResults.size) {
			liveEmbeddedOwners.delete(this.unboundIdentity);
			if (await close(() => this.embeddedStore?.close())) this.embeddedStore = undefined;
		}

		for (const [type, events] of this.events.entries()) {
			if (await close(() => events.close())) this.events.delete(type);
		}

		for (const [type, queue] of this.queues.entries()) {
			if (await close(() => queue.close())) this.queues.delete(type);
		}

		if (!this.queues.size && !this.events.size && (await close(() => this.connection?.quit())))
			this.connection = undefined;

		this.embeddedJobs.clear();
		this.writingSuggestions = undefined;
		if (await close(() => this.contentAnalyzer?.dispose())) this.contentAnalyzer = null;
		const results = await Promise.allSettled([
			this.databaseService?.close(),
			this.aiWritingService?.clearMemory(),
		]);
		if (results[0].status === 'fulfilled') this.databaseService = null;
		if (results[1].status === 'fulfilled') this.aiWritingService = null;
		if (!this.embeddedStore) this.scope = undefined;
		this.continuity = undefined;

		this.isInitialized = false;
		failures.push(
			...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
		);
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, 'Job queue resources failed to close');
		this.logger.info('Job queue service shutdown complete');
	}
}
