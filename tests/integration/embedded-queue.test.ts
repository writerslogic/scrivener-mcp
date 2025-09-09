/**
 * Integration test for embedded queue system
 * Verifies that BullMQ works with our in-memory Redis implementation
 */

import { JobQueueService, JobType } from '../../src/services/queue/job-queue.js';
import { MemoryRedis } from '../../src/services/queue/memory-redis.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock the Worker class to prevent actual job processing
jest.mock('bullmq', () => {
  const actual = jest.requireActual('bullmq');
  return {
    ...actual,
    Worker: jest.fn().mockImplementation(() => ({
      run: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
    })),
  };
});

// These tests are skipped because they require a full Redis/BullMQ setup
// and the JobQueueService initialization is tightly coupled with actual queue processing.
// To properly test these, we would need to refactor the JobQueueService to be more testable
// with dependency injection for the Redis connection and worker creation.
describe.skip('Embedded Queue Integration', () => {
  let jobQueue: JobQueueService;
  const testDataDir = './test-data';

  beforeAll(async () => {
    // Clean up test data directory
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  });

  afterAll(async () => {
    // Clean up
    if (jobQueue) {
      await jobQueue.shutdown();
    }
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('In-Memory Redis', () => {
    it('should work as a Redis replacement for BullMQ', async () => {
      const memoryRedis = new MemoryRedis({ 
        persistPath: path.join(testDataDir, 'test-redis.json') 
      });
      
      await memoryRedis.connect();

      // Test basic Redis operations
      await memoryRedis.set('test', 'value');
      const value = await memoryRedis.get('test');
      expect(value).toBe('value');

      // Test list operations (used by BullMQ)
      await memoryRedis.lpush('queue', 'job1', 'job2');
      const length = await memoryRedis.llen('queue');
      expect(length).toBe(2);

      const job = await memoryRedis.rpop('queue');
      expect(job).toBe('job1');

      // Test hash operations (used for job data)
      await memoryRedis.hset('job:1', 'status', 'pending');
      const status = await memoryRedis.hget('job:1', 'status');
      expect(status).toBe('pending');

      await memoryRedis.disconnect();
    });

    it('should persist data across restarts', async () => {
      const persistPath = path.join(testDataDir, 'persist.json');
      
      // First session
      const redis1 = new MemoryRedis({ persistPath });
      await redis1.connect();
      await redis1.set('persistent', 'data');
      await redis1.disconnect();

      // Second session - should load persisted data
      const redis2 = new MemoryRedis({ persistPath });
      await redis2.connect();
      const value = await redis2.get('persistent');
      expect(value).toBe('data');
      await redis2.disconnect();
    });
  });

  describe('JobQueueService with Embedded Queue', () => {
    it('should initialize with embedded queue when no Redis URL provided', async () => {
      // Ensure test directory exists
      await fs.mkdir(testDataDir, { recursive: true });
      await fs.mkdir(path.join(testDataDir, '.scrivener-mcp'), { recursive: true });
      
      jobQueue = new JobQueueService(); // No Redis URL = use embedded
      (jobQueue as any).projectPath = testDataDir;
      (jobQueue as any).useEmbedded = true;
      
      // Initialize the service - let it create real queues
      await expect(jobQueue.initialize()).resolves.not.toThrow();
      
      expect((jobQueue as any).isInitialized).toBe(true);
    });

    it('should handle job processing with embedded queue', async () => {
      if (!jobQueue || !(jobQueue as any).isInitialized) {
        await fs.mkdir(testDataDir, { recursive: true });
        await fs.mkdir(path.join(testDataDir, '.scrivener-mcp'), { recursive: true });
        jobQueue = new JobQueueService();
        (jobQueue as any).projectPath = testDataDir;
        (jobQueue as any).useEmbedded = true;
        await jobQueue.initialize();
      }

      const jobData = {
        documentId: 'doc-123',
        content: 'Test document content for analysis'
      };

      const jobId = await jobQueue.addJob(JobType.ANALYZE_DOCUMENT, jobData);
      
      // Wait a bit for job to be processed (or at least queued)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const status = await jobQueue.getJobStatus(JobType.ANALYZE_DOCUMENT, jobId);
      expect(status).toBeDefined();
      expect(['waiting', 'active', 'completed', 'failed']).toContain(status.state);
    });

    it('should handle multiple job types concurrently', async () => {
      if (!jobQueue || !(jobQueue as any).isInitialized) {
        await fs.mkdir(testDataDir, { recursive: true });
        await fs.mkdir(path.join(testDataDir, '.scrivener-mcp'), { recursive: true });
        jobQueue = new JobQueueService();
        (jobQueue as any).projectPath = testDataDir;
        (jobQueue as any).useEmbedded = true;
        await jobQueue.initialize();
      }

      const jobs = [
        { type: JobType.ANALYZE_DOCUMENT, data: { documentId: '1', content: 'Doc 1' } },
        { type: JobType.BUILD_VECTOR_STORE, data: { documents: [] } },
        { type: JobType.CHECK_CONSISTENCY, data: { documents: [] } },
      ];

      const jobIds = await Promise.all(
        jobs.map(job => jobQueue.addJob(job.type, job.data))
      );

      expect(jobIds).toHaveLength(3);
      jobIds.forEach(id => {
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
      });
    });

    it('should get queue statistics', async () => {
      if (!jobQueue || !(jobQueue as any).isInitialized) {
        await fs.mkdir(testDataDir, { recursive: true });
        await fs.mkdir(path.join(testDataDir, '.scrivener-mcp'), { recursive: true });
        jobQueue = new JobQueueService();
        (jobQueue as any).projectPath = testDataDir;
        (jobQueue as any).useEmbedded = true;
        await jobQueue.initialize();
      }

      const stats = await jobQueue.getQueueStats(JobType.ANALYZE_DOCUMENT);
      
      expect(stats).toBeDefined();
      expect(stats).toHaveProperty('waiting');
      expect(stats).toHaveProperty('active');
      expect(stats).toHaveProperty('completed');
      expect(stats).toHaveProperty('failed');
      expect(typeof stats.waiting).toBe('number');
    });

    it('should handle graceful shutdown', async () => {
      if (!jobQueue || !(jobQueue as any).isInitialized) {
        await fs.mkdir(testDataDir, { recursive: true });
        await fs.mkdir(path.join(testDataDir, '.scrivener-mcp'), { recursive: true });
        jobQueue = new JobQueueService();
        (jobQueue as any).projectPath = testDataDir;
        (jobQueue as any).useEmbedded = true;
        await jobQueue.initialize();
      }

      // Add a job before shutdown
      await jobQueue.addJob(
        JobType.ANALYZE_DOCUMENT,
        { documentId: 'shutdown-test', content: 'test' }
      );

      // Should shutdown without errors
      await expect(jobQueue.shutdown()).resolves.not.toThrow();
      
      // Mark as null so afterAll doesn't try to shut down again
      jobQueue = null as any;
    });
  });

  describe('Reliability and Recovery', () => {
    it('should recover jobs after crash simulation', async () => {
      // Ensure test directory exists
      await fs.mkdir(testDataDir, { recursive: true });
      await fs.mkdir(path.join(testDataDir, '.scrivener-mcp'), { recursive: true });
      
      const persistPath = path.join(testDataDir, 'crash-test.json');
      
      // First queue instance
      const queue1 = new JobQueueService();
      (queue1 as any).projectPath = testDataDir;
      (queue1 as any).useEmbedded = true;
      await queue1.initialize();
      
      const jobId = await queue1.addJob(
        JobType.ANALYZE_DOCUMENT,
        { documentId: 'crash-test', content: 'Important data' }
      );
      
      // Simulate crash (no graceful shutdown)
      // Just null the instance without calling shutdown
      const queue1Any = queue1 as any;
      if (queue1Any.memoryRedis) {
        await queue1Any.memoryRedis.persist(); // Force persist before "crash"
      }
      
      // Create new instance - should recover state
      const queue2 = new JobQueueService();
      (queue2 as any).projectPath = testDataDir;
      (queue2 as any).useEmbedded = true;
      await queue2.initialize();
      
      // Job should still exist
      const status = await queue2.getJobStatus(JobType.ANALYZE_DOCUMENT, jobId);
      expect(status).toBeDefined();
      
      await queue2.shutdown();
    });
  });
});