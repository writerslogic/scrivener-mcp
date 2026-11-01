/**
 * Tests for JobQueueService with KeyDB/Redis support
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
	JobQueueService,
	JobType,
	MAX_ANALYSIS_CONTENT_LENGTH,
	MAX_ANALYSIS_DOCUMENTS,
} from '../../../src/services/queue/job-queue.js';
import { Queue, Worker, QueueEvents, type Processor, type WorkerOptions } from 'bullmq';
import * as keydbDetector from '../../../src/services/queue/keydb-detector.js';
import { AIClient } from '../../../src/services/ai/ai-client.js';
import { ContentAnalyzer } from '../../../src/analysis/base-analyzer.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock BullMQ
jest.mock('bullmq', () => ({
	...jest.requireActual<typeof import('bullmq')>('bullmq'),
	Queue: jest.fn(),
	Worker: jest.fn(),
	QueueEvents: jest.fn(),
}));

const workerConstructor: new (
	name: string,
	processor: Processor,
	options: WorkerOptions
) => Worker = Worker;

// Mock KeyDB detector
jest.mock('../../../src/services/queue/keydb-detector.js', () => ({
	detectConnection: jest.fn(),
	createBullMQConnection: jest.fn(),
}));

// Mock services
jest.mock('../../../src/analysis/base-analyzer.js', () => ({
	ContentAnalyzer: jest.fn(() => ({
		dispose: jest.fn(),
		analyzeContent: jest.fn(() =>
			Promise.resolve({
				documentId: 'test-doc',
				metrics: {
					fleschReadingEase: 60,
					fleschKincaidGrade: 8,
					readingTime: 5,
				},
			})
		),
	})),
}));

jest.mock('../../../src/services/ai/ai-writing-service.js', () => ({
	AIWritingService: jest.fn(() => ({
		isAvailable: true,
		generateWithContext: jest.fn(() => Promise.resolve('AI suggestion')),
		buildVectorStore: jest.fn(() => Promise.resolve()),
		semanticSearch: jest.fn(() => Promise.resolve([])),
		clearMemory: jest.fn(() => Promise.resolve()),
	})),
}));

jest.mock('../../../src/handlers/database/database-service.js', () => ({
	DatabaseService: jest.fn(() => ({
		initialize: jest.fn(() => Promise.resolve()),
		close: jest.fn(() => Promise.resolve()),
	})),
}));

describe('JobQueueService v2', () => {
	let jobQueueService: JobQueueService;
	let mockQueue: any;
	let mockWorker: any;
	let mockQueueEvents: any;
	let detectConnectionMock: any;
	let createBullMQConnectionMock: any;
	let projectPath: string;
	let storedJobs: Map<string, any>;

	beforeEach(async () => {
		projectPath = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-queue-unit-')));
		storedJobs = new Map();
		// Setup mocks
		detectConnectionMock = keydbDetector.detectConnection as any;
		createBullMQConnectionMock = keydbDetector.createBullMQConnection as any;

		// Mock Queue
		mockQueue = {
			add: jest.fn((name: string, data: unknown, options: { jobId: string }) => {
				const job = { id: options.jobId, name, data };
				storedJobs.set(job.id, job);
				return Promise.resolve(job);
			}),
			getJob: jest.fn((id: string) => Promise.resolve(storedJobs.get(id) ?? null)),
			getWaitingCount: jest.fn(() => Promise.resolve(0)),
			getActiveCount: jest.fn(() => Promise.resolve(0)),
			getCompletedCount: jest.fn(() => Promise.resolve(0)),
			getFailedCount: jest.fn(() => Promise.resolve(0)),
			getDelayedCount: jest.fn(() => Promise.resolve(0)),
			close: jest.fn(() => Promise.resolve()),
		} as any;

		// Mock Worker
		mockWorker = {
			on: jest.fn(),
			close: jest.fn(() => Promise.resolve()),
		} as any;

		// Mock QueueEvents
		mockQueueEvents = {
			on: jest.fn(),
			close: jest.fn(() => Promise.resolve()),
		} as any;

		// Setup constructor mocks
		(Queue as any).mockImplementation(() => mockQueue);
		(Worker as any).mockImplementation(() => mockWorker);
		(QueueEvents as any).mockImplementation(() => mockQueueEvents);

		jobQueueService = new JobQueueService(projectPath);
	});

	afterEach(async () => {
		if (jobQueueService) {
			await jobQueueService.shutdown();
		}
		await rm(projectPath, { recursive: true, force: true });
		jest.clearAllMocks();
	});

	describe('initialization', () => {
		it('should initialize with KeyDB when available', async () => {
			const mockConnection = { quit: jest.fn() };

			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});

			createBullMQConnectionMock.mockReturnValue(mockConnection as any);

			await jobQueueService.initialize();

			expect(detectConnectionMock).toHaveBeenCalled();
			expect(createBullMQConnectionMock).toHaveBeenCalledWith('redis://localhost:6379');

			const connectionInfo = jobQueueService.getConnectionInfo();
			expect(connectionInfo.type).toBe('keydb');
			expect(connectionInfo.isConnected).toBe(true);
		});

		it('should fallback to embedded queue when KeyDB unavailable', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			await jobQueueService.initialize();

			const connectionInfo = jobQueueService.getConnectionInfo();
			expect(connectionInfo.type).toBe('embedded');
			expect(connectionInfo.isConnected).toBe(true);
		});

		it('should initialize with Redis when detected', async () => {
			const mockConnection = { quit: jest.fn() };

			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'redis',
				url: 'redis://localhost:6379',
				version: '7.0.0',
			});

			createBullMQConnectionMock.mockReturnValue(mockConnection as any);

			await jobQueueService.initialize();

			const connectionInfo = jobQueueService.getConnectionInfo();
			expect(connectionInfo.type).toBe('redis');
			expect(connectionInfo.isConnected).toBe(true);
		});

		it('retains legacy queue history but starts workers only for supported job types', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'redis',
				url: 'redis://localhost:6379',
				version: '7.0.0',
			});
			createBullMQConnectionMock.mockReturnValue({ quit: jest.fn(() => Promise.resolve()) });

			await jobQueueService.initialize();

			const jobTypeCount = Object.values(JobType).length;
			expect(Queue).toHaveBeenCalledTimes(jobTypeCount);
			expect(Worker).toHaveBeenCalledTimes(jobTypeCount - 2);
			expect(QueueEvents).toHaveBeenCalledTimes(jobTypeCount);
			expect(Queue).toHaveBeenCalledWith(
				JobType.GENERATE_SUGGESTIONS,
				expect.objectContaining({
					defaultJobOptions: expect.objectContaining({ attempts: 1 }),
				})
			);
		});

		it('should initialize optional services when API keys provided', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			await jobQueueService.initialize({
				openaiApiKey: 'test-api-key',
			});

			const { AIWritingService } = require('../../../src/services/ai/ai-writing-service');
			const { DatabaseService } = require('../../../src/handlers/database/database-service');

			expect(AIWritingService).toHaveBeenCalledWith(expect.any(AIClient));
			expect(DatabaseService).toHaveBeenCalledWith(projectPath);
		});
	});

	describe('job management', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'redis',
				url: 'redis://localhost:6379',
				version: '7.0.0',
			});
			createBullMQConnectionMock.mockReturnValue({ quit: jest.fn(() => Promise.resolve()) });
			await jobQueueService.initialize();
		});

		it('should add job to queue', async () => {
			const jobData = {
				documentId: 'doc-123',
				content: 'Test content',
				options: { includeReadability: true },
			};

			const jobId = await jobQueueService.addJob(JobType.ANALYZE_DOCUMENT, jobData, {
				priority: 1,
			});

			const info = jobQueueService.getConnectionInfo();
			expect(jobId).toMatch(new RegExp(`^${info.scopeId}-`));
			expect(storedJobs.get(jobId).data).toMatchObject({
				version: 1,
				scopeId: info.scopeId,
				jobType: JobType.ANALYZE_DOCUMENT,
				payload: jobData,
			});
		});

		it('should get job status', async () => {
			const id = await jobQueueService.addJob(JobType.ANALYZE_DOCUMENT, {
				documentId: 'test',
				content: '',
			});
			const mockJob = {
				...storedJobs.get(id),
				progress: 50,
				returnvalue: { result: 'completed' },
				failedReason: null,
				getState: jest.fn(() => Promise.resolve('completed')),
			};

			mockQueue.getJob.mockResolvedValue(mockJob as any);

			const status = await jobQueueService.getJobStatus(JobType.ANALYZE_DOCUMENT, id);

			// getJobStatus returns the raw BullMQ Job unchanged; state resolution via
			// job.getState() happens one layer up, in the async-handlers.ts caller.
			expect(status).toBe(mockJob);
		});

		it('should cancel job', async () => {
			const id = await jobQueueService.addJob(JobType.ANALYZE_DOCUMENT, {
				documentId: 'test',
				content: '',
			});
			const mockJob = {
				...storedJobs.get(id),
				remove: jest.fn(() => Promise.resolve()),
			};

			mockQueue.getJob.mockResolvedValue(mockJob as any);

			await jobQueueService.cancelJob(JobType.ANALYZE_DOCUMENT, id);

			expect(mockJob.remove).toHaveBeenCalled();
		});

		it('should get queue statistics', async () => {
			mockQueue.getWaitingCount = jest.fn(() => Promise.resolve(5));
			mockQueue.getActiveCount = jest.fn(() => Promise.resolve(2));
			mockQueue.getCompletedCount = jest.fn(() => Promise.resolve(10));
			mockQueue.getFailedCount = jest.fn(() => Promise.resolve(1));
			mockQueue.getDelayedCount = jest.fn(() => Promise.resolve(3));

			const stats = await jobQueueService.getQueueStats(JobType.ANALYZE_DOCUMENT);

			expect(stats).toEqual({
				waiting: 5,
				active: 2,
				completed: 10,
				failed: 1,
				delayed: 3,
			});
		});

		it('should handle job not found', async () => {
			mockQueue.getJob.mockResolvedValue(null);

			const status = await jobQueueService.getJobStatus(
				JobType.ANALYZE_DOCUMENT,
				'non-existent'
			);

			expect(status).toBeNull();
		});

		it.each(['legacy', 'scope', 'project', 'version', 'type'] as const)(
			'rejects a %s envelope before processing',
			async (kind) => {
				const id = await jobQueueService.addJob(JobType.ANALYZE_DOCUMENT, {
					documentId: 'shared-document',
					content: 'A local scene.',
				});
				const job = storedJobs.get(id);
				if (kind === 'legacy') job.data = job.data.payload;
				else {
					const field = {
						scope: 'scopeId',
						project: 'projectId',
						version: 'version',
						type: 'jobType',
					}[kind]!;
					job.data[field] = kind === 'version' ? 2 : 'foreign';
				}
				const processor = jest
					.mocked(workerConstructor)
					.mock.calls.find(([type]) => type === JobType.ANALYZE_DOCUMENT)![1];
				if (typeof processor !== 'function')
					throw new Error('Missing production processor');
				await expect(processor(job, 'fixture-token')).rejects.toThrow(/ownership/);
				await expect(
					jobQueueService.getJobStatus(JobType.ANALYZE_DOCUMENT, id)
				).rejects.toThrow(/ownership/);
				await expect(
					jobQueueService.cancelJob(JobType.ANALYZE_DOCUMENT, id)
				).rejects.toThrow(/ownership/);
			}
		);

		it.each([2097150, 2097151, 2097152])(
			'enforces the BullMQ priority boundary at %i',
			async (priority) => {
				const request = jobQueueService.addJob(
					JobType.ANALYZE_DOCUMENT,
					{ documentId: 'bounded', content: '' },
					{ priority }
				);
				if (priority > 2097151) await expect(request).rejects.toThrow(/priority/);
				else expect(await request).toMatch(/^[a-f0-9]{64}-/);
			}
		);

		it.each([-1, 0, 1])(
			'bounds analysis text length at limit %+i before enqueueing',
			async (delta) => {
				const content = 'x'.repeat(MAX_ANALYSIS_CONTENT_LENGTH + delta);
				const request = jobQueueService.addJob(JobType.ANALYZE_DOCUMENT, {
					documentId: 'bounded',
					content,
				});
				if (delta > 0) await expect(request).rejects.toThrow(/5000000/);
				else expect(await request).toMatch(/^[a-f0-9]{64}-/);
			}
		);

		it.each([254, 255, 256])('bounds document identifiers at %i characters', async (length) => {
			const request = jobQueueService.addJob(JobType.ANALYZE_DOCUMENT, {
				documentId: 'x'.repeat(length),
				content: '',
			});
			if (length > 255) await expect(request).rejects.toThrow(/documentId/);
			else expect(await request).toMatch(/^[a-f0-9]{64}-/);
		});

		it.each([MAX_ANALYSIS_DOCUMENTS - 1, MAX_ANALYSIS_DOCUMENTS, MAX_ANALYSIS_DOCUMENTS + 1])(
			'bounds project batches at %i documents',
			async (length) => {
				const documents = Array.from({ length }, (_, i) => ({
					id: String(i),
					content: '',
				}));
				const request = jobQueueService.addJob(JobType.ANALYZE_PROJECT, {
					projectId: 'fixture',
					documents,
				});
				if (length > MAX_ANALYSIS_DOCUMENTS)
					await expect(request).rejects.toThrow(/1–5000/);
				else expect(await request).toMatch(/^[a-f0-9]{64}-/);
			}
		);

		it.each([0, 1, 4, 5, 6])('bounds concurrency at %i documents', async (batchSize) => {
			const request = jobQueueService.addJob(JobType.ANALYZE_PROJECT, {
				projectId: 'fixture',
				documents: [{ id: 'scene', content: '' }],
				options: { parallel: true, batchSize },
			});
			if (batchSize < 1 || batchSize > 5) await expect(request).rejects.toThrow(/batchSize/);
			else expect(await request).toMatch(/^[a-f0-9]{64}-/);
		});

		it.each([
			{ documentId: 'scene' },
			{ documentId: 'scene', content: null },
			{ documentId: ' ', content: '' },
			{ documentId: 'scene', content: '', options: null },
			{ documentId: 'scene', content: '', options: [] },
			{ documentId: 'scene', content: '', options: { includeReadability: 'false' } },
			{ documentId: 'scene', content: '', options: { unknown: true } },
		])('rejects malformed analysis before admission: %j', async (data) => {
			await expect(jobQueueService.addJob(JobType.ANALYZE_DOCUMENT, data)).rejects.toThrow(
				/Analysis/
			);
			expect(mockQueue.add).not.toHaveBeenCalled();
		});

		it('rejects malformed and duplicate project documents before admission', async () => {
			for (const documents of [
				[],
				[null],
				[{ id: 'scene' }],
				[
					{ id: 'scene', content: '' },
					{ id: 'scene', content: '' },
				],
			]) {
				await expect(
					jobQueueService.addJob(JobType.ANALYZE_PROJECT, {
						projectId: 'fixture',
						documents,
					})
				).rejects.toThrow();
			}
			expect(mockQueue.add).not.toHaveBeenCalled();
		});

		it('rejects altered payloads at the worker boundary before native processing', async () => {
			const id = await jobQueueService.addJob(JobType.ANALYZE_DOCUMENT, {
				documentId: 'scene',
				content: '',
			});
			const job = storedJobs.get(id);
			job.data.payload.content = 7;
			const processor = jest
				.mocked(workerConstructor)
				.mock.calls.find(([type]) => type === JobType.ANALYZE_DOCUMENT)![1];
			if (typeof processor !== 'function') throw new Error('Missing production processor');
			await expect(processor(job, 'fixture-token')).rejects.toThrow(/text/);
		});

		it.each([JobType.EXPORT_PROJECT, JobType.BATCH_ANALYSIS])(
			'rejects unsupported %s jobs before admission',
			async (jobType) => {
				await expect(jobQueueService.addJob(jobType, {})).rejects.toThrow(
					/legacy job type/
				);
				expect(mockQueue.add).not.toHaveBeenCalled();
			}
		);

		it('honors bounded parallel batches while preserving document order', async () => {
			const documents = Array.from({ length: 4 }, (_, i) => ({
				id: `scene-${i}`,
				content: 'A scene.',
			}));
			const id = await jobQueueService.addJob(JobType.ANALYZE_PROJECT, {
				projectId: 'fixture',
				documents,
				options: { parallel: true, batchSize: 2 },
			});
			const analyzer = jest.mocked(ContentAnalyzer).mock.results[0].value as jest.Mocked<
				Pick<ContentAnalyzer, 'analyzeContent'>
			>;
			const analyze = analyzer.analyzeContent;
			const original = analyze.getMockImplementation()!;
			const releases: Array<() => void> = [];
			let drain = false;
			analyze.mockImplementation(async (content, documentId) => {
				if (!drain) await new Promise<void>((resolve) => releases.push(resolve));
				return original(content, documentId);
			});
			const processor = jest
				.mocked(workerConstructor)
				.mock.calls.find(([type]) => type === JobType.ANALYZE_PROJECT)![1];
			if (typeof processor !== 'function') throw new Error('Missing production processor');
			const running = processor(storedJobs.get(id), 'fixture-token');
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(analyze.mock.calls.map(([, id]) => id)).toEqual(['scene-0', 'scene-1']);
				releases
					.splice(0)
					.reverse()
					.forEach((resolve) => resolve());
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(analyze.mock.calls.map(([, id]) => id)).toEqual(
					documents.map((doc) => doc.id)
				);
				releases
					.splice(0)
					.reverse()
					.forEach((resolve) => resolve());
				await expect(running).resolves.toMatchObject({
					documents: documents.map((doc) => ({ documentId: doc.id })),
				});
			} finally {
				drain = true;
				releases.splice(0).forEach((resolve) => resolve());
				await running;
			}
		});
	});

	describe('concurrency settings', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'redis',
				url: 'redis://localhost:6379',
				version: '7.0.0',
			});
			createBullMQConnectionMock.mockReturnValue({ quit: jest.fn(() => Promise.resolve()) });
			await jobQueueService.initialize();
		});

		it.each([
			{ jobType: JobType.ANALYZE_DOCUMENT, concurrency: 5 },
			{ jobType: JobType.BUILD_VECTOR_STORE, concurrency: 1 },
			{ jobType: JobType.GENERATE_SUGGESTIONS, concurrency: 3 },
		])('sets $jobType concurrency to $concurrency', ({ jobType, concurrency }) => {
			const workerCall = jest
				.mocked(workerConstructor)
				.mock.calls.find(([name]) => name === jobType);

			expect(workerCall?.[2].concurrency).toBe(concurrency);
		});
	});

	describe('shutdown', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'redis',
				url: 'redis://localhost:6379',
				version: '7.0.0',
			});
			createBullMQConnectionMock.mockReturnValue({ quit: jest.fn(() => Promise.resolve()) });
			await jobQueueService.initialize();
		});

		it('should close all workers, events, and queues', async () => {
			await jobQueueService.shutdown();

			expect(mockWorker.close).toHaveBeenCalled();
			expect(mockQueueEvents.close).toHaveBeenCalled();
			expect(mockQueue.close).toHaveBeenCalled();
		});

		it('should close KeyDB connection when using KeyDB', async () => {
			const mockConnection = { quit: jest.fn(() => Promise.resolve()) };

			// Reinitialize with KeyDB
			await jobQueueService.shutdown();
			jobQueueService = new JobQueueService(projectPath);

			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});

			createBullMQConnectionMock.mockReturnValue(mockConnection as any);

			await jobQueueService.initialize();
			await jobQueueService.shutdown();

			expect(mockConnection.quit).toHaveBeenCalled();
		});

		it('should handle shutdown when not initialized', async () => {
			const uninitializedService = new JobQueueService('./test');

			// Should not throw
			await expect(uninitializedService.shutdown()).resolves.toBeUndefined();
		});

		it('retains worker dependencies until failed workers can drain and close', async () => {
			const writing = jobQueueService.getWritingService()!;
			const connection =
				createBullMQConnectionMock.mock.results[
					createBullMQConnectionMock.mock.results.length - 1
				].value;
			mockWorker.close.mockRejectedValue(new Error('Worker close failure'));
			try {
				await expect(jobQueueService.shutdown()).rejects.toThrow(/failed to close/);
				expect(mockQueueEvents.close).not.toHaveBeenCalled();
				expect(mockQueue.close).not.toHaveBeenCalled();
				expect(connection.quit).not.toHaveBeenCalled();
				expect(writing.clearMemory).not.toHaveBeenCalled();
				expect(jobQueueService.getConnectionInfo().isConnected).toBe(false);
			} finally {
				mockWorker.close.mockResolvedValue(undefined);
			}
			await expect(jobQueueService.shutdown()).resolves.toBeUndefined();
			expect(connection.quit).toHaveBeenCalledTimes(1);
			expect(writing.clearMemory).toHaveBeenCalledTimes(1);
		});

		it('retains the shared connection when queue-event cleanup needs a retry', async () => {
			const connection =
				createBullMQConnectionMock.mock.results[
					createBullMQConnectionMock.mock.results.length - 1
				].value;
			mockQueueEvents.close.mockRejectedValue(new Error('Event close failure'));
			try {
				await expect(jobQueueService.shutdown()).rejects.toThrow(/failed to close/);
				expect(connection.quit).not.toHaveBeenCalled();
			} finally {
				mockQueueEvents.close.mockResolvedValue(undefined);
			}
			await jobQueueService.shutdown();
			expect(connection.quit).toHaveBeenCalledTimes(1);
		});
	});

	describe('error handling', () => {
		it('should throw error when adding job to non-existent queue type', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});
			await jobQueueService.initialize();

			// Use an invalid job type
			await expect(jobQueueService.addJob('INVALID_TYPE' as JobType, {})).rejects.toThrow(
				'Queue for job type INVALID_TYPE not found'
			);
		});

		it('should throw error when getting stats for non-existent queue', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});
			await jobQueueService.initialize();

			await expect(jobQueueService.getQueueStats('INVALID_TYPE' as JobType)).rejects.toThrow(
				'Queue for job type INVALID_TYPE not found'
			);
		});

		it('should handle initialization failure gracefully', async () => {
			detectConnectionMock.mockRejectedValue(new Error('Connection failed'));

			await expect(jobQueueService.initialize()).rejects.toThrow(
				'Failed to initialize job queue service'
			);
		});
	});
});
