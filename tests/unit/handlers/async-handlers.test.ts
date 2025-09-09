import { JobQueueService, JobType } from '../../../src/services/queue/job-queue.js';
import { LangChainService } from '../../../src/services/ai/langchain-service.js';

// Mock services
jest.mock('../../../src/services/queue/job-queue.js');
jest.mock('../../../src/services/ai/langchain-service.js');

describe('Async Handler Infrastructure', () => {
  let mockJobQueue: jest.Mocked<JobQueueService>;
  let mockLangChain: jest.Mocked<LangChainService>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock JobQueueService
    mockJobQueue = {
      initialize: jest.fn().mockResolvedValue(undefined),
      addJob: jest.fn().mockResolvedValue('job-123'),
      getJobStatus: jest.fn().mockResolvedValue({
        state: 'completed',
        progress: 100,
        result: { success: true, data: 'Analysis complete' },
        error: null,
      }),
      getQueueStats: jest.fn().mockResolvedValue({
        waiting: 2,
        active: 1,
        completed: 10,
        failed: 0,
        delayed: 0,
      }),
      cancelJob: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as any;
    (JobQueueService as jest.Mock).mockImplementation(() => mockJobQueue);

    // Mock LangChainService
    mockLangChain = {
      processDocument: jest.fn().mockResolvedValue([
        { pageContent: 'Test content', metadata: { source: 'test.scriv' } }
      ]),
      buildVectorStore: jest.fn().mockResolvedValue(undefined),
      semanticSearch: jest.fn().mockResolvedValue([
        { pageContent: 'Test result', metadata: { source: 'test.scriv' } }
      ]),
      generateWithContext: jest.fn().mockResolvedValue('Generated text'),
      summarizeChapter: jest.fn().mockResolvedValue('Chapter summary'),
      analyzeWritingStyle: jest.fn().mockResolvedValue({
        tone: 'neutral',
        style: 'formal',
        suggestions: ['Use more active voice']
      }),
    } as any;
    (LangChainService as jest.Mock).mockImplementation(() => mockLangChain);
  });

  describe('Service Integration', () => {
    it('should be able to create JobQueueService instance', () => {
      const service = new JobQueueService();
      expect(service).toBeDefined();
    });

    it('should be able to create LangChainService instance', () => {
      const service = new LangChainService();
      expect(service).toBeDefined();
    });

    it('should support all expected job types', () => {
      expect(JobType.ANALYZE_DOCUMENT).toBeDefined();
      expect(JobType.ANALYZE_PROJECT).toBeDefined();
      expect(JobType.GENERATE_SUGGESTIONS).toBeDefined();
      expect(JobType.BUILD_VECTOR_STORE).toBeDefined();
      expect(JobType.CHECK_CONSISTENCY).toBeDefined();
      expect(JobType.SYNC_DATABASE).toBeDefined();
    });
  });

  describe('Job Queue Integration', () => {
    it('should be able to add jobs to queue', async () => {
      const service = new JobQueueService();
      await service.initialize();

      const jobId = await service.addJob(JobType.ANALYZE_DOCUMENT, {
        documentId: 'doc-123',
        content: 'Test content',
      });

      expect(jobId).toBe('job-123');
      expect(mockJobQueue.addJob).toHaveBeenCalledWith(
        JobType.ANALYZE_DOCUMENT,
        expect.objectContaining({
          documentId: 'doc-123',
          content: 'Test content',
        })
      );
    });

    it('should be able to check job status', async () => {
      const service = new JobQueueService();
      await service.initialize();

      const status = await service.getJobStatus(JobType.ANALYZE_DOCUMENT, 'job-123');

      expect(status.state).toBe('completed');
      expect(status.progress).toBe(100);
    });

    it('should be able to get queue statistics', async () => {
      const service = new JobQueueService();
      await service.initialize();

      const stats = await service.getQueueStats(JobType.ANALYZE_DOCUMENT);

      expect(stats.waiting).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.completed).toBe(10);
    });
  });

  describe('LangChain Integration', () => {
    it('should be able to process documents', async () => {
      const service = new LangChainService();
      
      const document = {
        id: 'doc-123',
        title: 'Test Document',
        type: 'Text' as const,
        content: 'Test content',
        path: '/test/path',
        metadata: {
          created: new Date(),
          modified: new Date(),
          status: 'Draft' as const,
          label: null,
          synopsis: null,
          notes: null,
          keywords: [],
          customMetadata: {},
        },
        children: [],
      };

      const chunks = await service.processDocument(document);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveProperty('pageContent');
      expect(chunks[0]).toHaveProperty('metadata');
    });

    it('should be able to perform semantic search', async () => {
      const service = new LangChainService();

      const results = await service.semanticSearch('test query');

      expect(results).toHaveLength(1);
      expect(results[0].pageContent).toBe('Test result');
    });

    it('should be able to generate with context', async () => {
      const service = new LangChainService();

      const response = await service.generateWithContext('Test prompt');

      expect(response).toBe('Generated text');
    });

    it('should be able to summarize chapters', async () => {
      const service = new LangChainService();

      const summary = await service.summarizeChapter('Chapter content');

      expect(summary).toBeDefined();
    });

    it('should be able to analyze writing style', async () => {
      const service = new LangChainService();

      const analysis = await service.analyzeWritingStyle(['Test text sample']);

      expect(analysis.tone).toBe('neutral');
      expect(analysis.style).toBe('formal');
      expect(analysis.suggestions).toContain('Use more active voice');
    });
  });

  describe('Error Handling', () => {
    it('should handle job queue initialization errors', async () => {
      mockJobQueue.initialize.mockRejectedValue(new Error('Init failed'));

      const service = new JobQueueService();

      await expect(service.initialize()).rejects.toThrow('Init failed');
    });

    it('should handle job addition errors', async () => {
      mockJobQueue.addJob.mockRejectedValue(new Error('Queue error'));

      const service = new JobQueueService();
      await service.initialize();

      await expect(service.addJob(JobType.ANALYZE_DOCUMENT, {})).rejects.toThrow('Queue error');
    });

    it('should handle LangChain service errors', async () => {
      mockLangChain.semanticSearch.mockRejectedValue(new Error('LangChain error'));

      const service = new LangChainService();

      await expect(service.semanticSearch('test')).rejects.toThrow('LangChain error');
    });
  });

  describe('Service Lifecycle', () => {
    it('should properly shutdown job queue service', async () => {
      const service = new JobQueueService();
      await service.initialize();
      await service.shutdown();

      expect(mockJobQueue.shutdown).toHaveBeenCalled();
    });

    it('should handle shutdown errors gracefully', async () => {
      mockJobQueue.shutdown.mockRejectedValue(new Error('Shutdown error'));

      const service = new JobQueueService();
      await service.initialize();

      await expect(service.shutdown()).rejects.toThrow('Shutdown error');
    });
  });
});