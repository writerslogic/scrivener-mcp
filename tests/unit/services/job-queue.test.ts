/**
 * Tests for JobQueueService with KeyDB/Redis support
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { JobQueueService, JobType } from '../../../src/services/queue/job-queue';
import { Queue, Worker, QueueEvents } from 'bullmq';
import * as keydbDetector from '../../../src/services/queue/keydb-detector';

// Mock BullMQ
jest.mock('bullmq');

// Mock KeyDB detector
jest.mock('../../../src/services/queue/keydb-detector', () => ({
	detectConnection: jest.fn(),
	createBullMQConnection: jest.fn(),
}));

// Mock MemoryRedis
jest.mock('../../../src/services/queue/memory-redis', () => ({
	MemoryRedis: jest.fn().mockImplementation(() => ({
		connect: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
		disconnect: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
		on: jest.fn(),
		once: jest.fn(),
	})),
}));

// Mock services
jest.mock('../../../src/analysis/base-analyzer', () => ({
	ContentAnalyzer: jest.fn(() => ({
		analyzeContent: jest.fn(() => Promise.resolve({
			documentId: 'test-doc',
			metrics: {
				fleschReadingEase: 60,
				fleschKincaidGrade: 8,
				readingTime: 5,
			},
		})),
	})),
}));

jest.mock('../../../src/services/ai/langchain-service', () => ({
	LangChainService: jest.fn(() => ({
		generateWithContext: jest.fn(() => Promise.resolve('AI suggestion')),
		buildVectorStore: jest.fn(() => Promise.resolve()),
		semanticSearch: jest.fn(() => Promise.resolve([])),
	})),
}));

jest.mock('../../../src/database/database-service', () => ({
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

	beforeEach(() => {
		// Setup mocks
		detectConnectionMock = keydbDetector.detectConnection as any;
		createBullMQConnectionMock = keydbDetector.createBullMQConnection as any;

		// Mock Queue
		mockQueue = {
			add: jest.fn(() => Promise.resolve({ id: 'job-123' })),
			getJob: jest.fn(),
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

		// Create service instance
		jobQueueService = new JobQueueService('./test-project');
	});

	afterEach(async () => {
		if (jobQueueService) {
			await jobQueueService.shutdown();
		}
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

		it('should create queues for all job types', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			await jobQueueService.initialize();

			// Check that Queue was created for each job type
			const jobTypeCount = Object.values(JobType).length;
			expect(Queue).toHaveBeenCalledTimes(jobTypeCount);
			expect(Worker).toHaveBeenCalledTimes(jobTypeCount);
			expect(QueueEvents).toHaveBeenCalledTimes(jobTypeCount);
		});

		it('should initialize optional services when API keys provided', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			await jobQueueService.initialize({
				langchainApiKey: 'test-api-key',
				databasePath: './test.db',
			});

			// Check services were initialized
			const { LangChainService } = require('../../../src/services/ai/langchain-service');
			const { DatabaseService } = require('../../../src/database/database-service');
			
			expect(LangChainService).toHaveBeenCalledWith('test-api-key');
			expect(DatabaseService).toHaveBeenCalledWith('./test.db');
		});
	});

	describe('job management', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});
			await jobQueueService.initialize();
		});

		it('should add job to queue', async () => {
			const jobData = {
				documentId: 'doc-123',
				content: 'Test content',
				options: { includeReadability: true },
			};

			const jobId = await jobQueueService.addJob(
				JobType.ANALYZE_DOCUMENT,
				jobData,
				{ priority: 1 }
			);

			expect(jobId).toBe('job-123');
			expect(mockQueue.add).toHaveBeenCalledWith(
				JobType.ANALYZE_DOCUMENT,
				jobData,
				{ priority: 1 }
			);
		});

		it('should get job status', async () => {
			const mockJob = {
				id: 'job-123',
				progress: 50,
				data: { test: 'data' },
				returnvalue: { result: 'completed' },
				failedReason: null,
				getState: jest.fn(() => Promise.resolve('completed')),
			};

			mockQueue.getJob.mockResolvedValue(mockJob as any);

			const status = await jobQueueService.getJobStatus(
				JobType.ANALYZE_DOCUMENT,
				'job-123'
			);

			expect(status).toEqual({
				id: 'job-123',
				state: 'completed',
				progress: 50,
				data: { test: 'data' },
				returnvalue: { result: 'completed' },
				failedReason: null,
			});
		});

		it('should cancel job', async () => {
			const mockJob = {
				id: 'job-123',
				remove: jest.fn(() => Promise.resolve()),
			};

			mockQueue.getJob.mockResolvedValue(mockJob as any);

			await jobQueueService.cancelJob(JobType.ANALYZE_DOCUMENT, 'job-123');

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
	});

	describe('concurrency settings', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});
			await jobQueueService.initialize();
		});

		it('should set correct concurrency for document analysis', () => {
			// Worker constructor should have been called with correct concurrency
			const analyzeDocumentWorkerCall = (Worker as jest.MockedClass<typeof Worker>).mock.calls
				.find(call => call[0] === JobType.ANALYZE_DOCUMENT);
			
			expect(analyzeDocumentWorkerCall?.[2]?.concurrency).toBe(5);
		});

		it('should set correct concurrency for vector store building', () => {
			const vectorStoreWorkerCall = (Worker as jest.MockedClass<typeof Worker>).mock.calls
				.find(call => call[0] === JobType.BUILD_VECTOR_STORE);
			
			expect(vectorStoreWorkerCall?.[2]?.concurrency).toBe(1);
		});

		it('should set correct concurrency for suggestion generation', () => {
			const suggestionsWorkerCall = (Worker as jest.MockedClass<typeof Worker>).mock.calls
				.find(call => call[0] === JobType.GENERATE_SUGGESTIONS);
			
			expect(suggestionsWorkerCall?.[2]?.concurrency).toBe(3);
		});
	});

	describe('shutdown', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});
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
			jobQueueService = new JobQueueService('./test-project');
			
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
			await expect(
				jobQueueService.addJob('INVALID_TYPE' as JobType, {})
			).rejects.toThrow('Queue for job type INVALID_TYPE not found');
		});

		it('should throw error when getting stats for non-existent queue', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});
			await jobQueueService.initialize();

			await expect(
				jobQueueService.getQueueStats('INVALID_TYPE' as JobType)
			).rejects.toThrow('Queue for job type INVALID_TYPE not found');
		});

		it('should handle initialization failure gracefully', async () => {
			detectConnectionMock.mockRejectedValue(new Error('Connection failed'));

			await expect(jobQueueService.initialize()).rejects.toThrow(
				'Failed to initialize job queue service'
			);
		});
	});
});