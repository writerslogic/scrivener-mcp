import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';
import { generateScrivenerUUID, parseMetadata, findBinderItem } from '../../src/utils/scrivener-utils.js';
import { ensureProjectDataDirectory, getQueueStatePath, getCacheDirectory } from '../../src/utils/project-utils.js';
import { isTransientDatabaseError, toDatabaseError } from '../../src/utils/database.js';
import { ApplicationError as AppError, ErrorCode } from '../../src/core/errors.js';
import { LangChainCompilationService } from '../../src/services/compilation/langchain-compiler.js';
import { compileDocumentsHandler } from '../../src/handlers/compilation-handlers.js';

// Mock file system operations
jest.mock('fs/promises', () => ({
  mkdir: jest.fn(),
  access: jest.fn(),
  constants: { F_OK: 0 },
}));

// Mock logger
jest.mock('../../src/utils/logger.js', () => ({
  Logger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

describe('Utility Adoption Workflow Integration', () => {
  let mockProject: any;
  let mockContext: any;

  beforeEach(() => {
    mockProject = {
      projectPath: '/test/project',
      getAllDocuments: jest.fn().mockResolvedValue([
        {
          id: generateScrivenerUUID(),
          content: 'Chapter 1 content',
          title: 'Chapter 1',
          type: 'Text',
          path: 'Manuscript/Chapter 1',
          metadata: 'Title: Chapter 1\nSynopsis: Opening chapter',
        },
        {
          id: generateScrivenerUUID(),
          content: 'Chapter 2 content',
          title: 'Chapter 2',
          type: 'Text',
          path: 'Manuscript/Chapter 2',
          metadata: 'Title: Chapter 2\nSynopsis: Second chapter',
        },
      ]),
      getDocument: jest.fn(),
      compileDocuments: jest.fn().mockResolvedValue('Fallback compiled content'),
      getProjectMetadata: jest.fn().mockResolvedValue({
        title: 'Test Novel',
        author: 'Test Author',
      }),
      getStatistics: jest.fn().mockResolvedValue({
        documentCount: 2,
        wordCount: 1000,
        characterCount: 5000,
      }),
    };

    mockContext = {
      project: mockProject,
    };

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('End-to-End Utility Integration', () => {
    it('should demonstrate complete utility adoption workflow', async () => {
      // Step 1: Generate consistent UUIDs for all documents
      const documents = await mockProject.getAllDocuments();
      expect(documents).toHaveLength(2);
      
      // Verify UUIDs are properly formatted
      documents.forEach((doc: any) => {
        expect(doc.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      });

      // Step 2: Parse metadata using utility function
      const parsedMetadata = documents.map((doc: any) => ({
        ...doc,
        parsedMeta: parseMetadata(doc.metadata || ''),
      }));

      expect(parsedMetadata[0].parsedMeta.Title).toBe('Chapter 1');
      expect(parsedMetadata[0].parsedMeta.Synopsis).toBe('Opening chapter');
      expect(parsedMetadata[1].parsedMeta.Title).toBe('Chapter 2');
      expect(parsedMetadata[1].parsedMeta.Synopsis).toBe('Second chapter');

      // Step 3: Setup project directories using project utilities
      const projectPath = mockProject.projectPath;
      const dataDir = await ensureProjectDataDirectory(projectPath);
      const cacheDir = getCacheDirectory(projectPath);
      const queuePath = getQueueStatePath(projectPath);

      expect(dataDir).toBe(`${projectPath}/.scrivener-data`);
      expect(cacheDir).toBe(`${projectPath}/.scrivener-data/cache`);
      expect(queuePath).toBe(`${projectPath}/.scrivener-data/queue-state.json`);

      // Step 4: Find binder items using utility
      const binderStructure = [
        {
          id: documents[0].id,
          title: 'Chapter 1',
          type: 'Text',
          children: [],
        },
        {
          id: 'manuscript',
          title: 'Manuscript',
          type: 'Folder',
          children: [
            {
              id: documents[1].id,
              title: 'Chapter 2',
              type: 'Text',
              children: [],
            },
          ],
        },
      ];

      const foundItem = findBinderItem(binderStructure as any, documents[1].id);
      expect(foundItem).toBeDefined();
      expect(foundItem?.title).toBe('Chapter 2');

      // Step 5: Demonstrate error handling integration
      try {
        const dbError = new Error('Database connection failed');
        dbError.code = 'ServiceUnavailable';
        
        const isTransient = isTransientDatabaseError(dbError);
        expect(isTransient).toBe(true);
        
        const appError = toDatabaseError(dbError, 'test operation');
        expect(appError).toBeInstanceOf(AppError);
        expect(appError.code).toBe(ErrorCode.DATABASE_ERROR);
        expect(appError.message).toContain('test operation');
      } catch (error) {
        // This should not happen in this test
        expect.fail('Error handling integration failed');
      }
    });

    it('should integrate utilities in compilation workflow', async () => {
      // Mock LangChain compilation service
      const mockCompileWithAI = jest.fn().mockResolvedValue({
        content: 'AI-enhanced compiled content',
        metadata: {
          format: 'text',
          wordCount: 1500,
          generatedElements: {},
          optimizations: ['ai-enhanced'],
          targetAudience: 'general',
          compiledAt: new Date().toISOString(),
          processingTime: 2000,
        },
        dynamicElements: {},
        quality: { score: 0.9, suggestions: [], issues: [] },
      });

      // Use utility-generated UUIDs in compilation
      const documents = await mockProject.getAllDocuments();
      mockProject.getDocument.mockImplementation((id: string) => {
        const doc = documents.find(d => d.id === id);
        return Promise.resolve(doc || null);
      });

      // Mock compilation service to use utilities
      jest.mock('../../src/services/compilation/langchain-compiler.js', () => ({
        LangChainCompilationService: jest.fn(() => ({
          initialize: jest.fn(),
          compileWithAI: mockCompileWithAI,
        })),
      }));

      const args = {
        format: 'text' as const,
        includeSynopsis: true,
        includeNotes: false,
        hierarchical: true,
      };

      const result = await compileDocumentsHandler.handler(args, mockContext);

      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].data.enhanced).toBe(true);
      expect(result.content[0].data.langChainProcessed).toBe(true);

      // Verify that UUIDs were properly handled throughout the process
      expect(mockProject.getAllDocuments).toHaveBeenCalled();
    });

    it('should handle error propagation through utility chain', async () => {
      // Simulate error at different levels of the utility chain
      
      // Level 1: UUID generation (should not fail under normal circumstances)
      const uuid1 = generateScrivenerUUID();
      const uuid2 = generateScrivenerUUID();
      expect(uuid1).not.toBe(uuid2);

      // Level 2: Metadata parsing with invalid data
      const invalidMetadata = 'Invalid\nFormat\nWithout\nColons';
      const parsed = parseMetadata(invalidMetadata);
      expect(parsed).toEqual({}); // Should handle gracefully

      // Level 3: Binder search with invalid structure
      const invalidBinder = null;
      const foundItem = findBinderItem(invalidBinder, 'any-id');
      expect(foundItem).toBeNull();

      // Level 4: Database error handling
      const networkError = new Error('Network timeout');
      const isTransient = isTransientDatabaseError(networkError);
      expect(isTransient).toBe(true); // Should identify timeout as transient

      const convertedError = toDatabaseError(networkError, 'network operation');
      expect(convertedError).toBeInstanceOf(AppError);
      expect(convertedError.code).toBe(ErrorCode.DATABASE_ERROR);
    });

    it('should demonstrate caching workflow with utilities', async () => {
      const projectPath = '/test/project';
      
      // Setup cache directory using project utilities
      const cacheDir = getCacheDirectory(projectPath);
      expect(cacheDir).toBe(`${projectPath}/.scrivener-data/cache`);

      // Generate cache keys using UUID utility
      const cacheKey1 = generateScrivenerUUID();
      const cacheKey2 = generateScrivenerUUID();
      
      expect(cacheKey1).not.toBe(cacheKey2);
      expect(cacheKey1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      // Simulate cache entry metadata parsing
      const cacheMetadata = 'CacheKey: test-key\nTimestamp: 2024-01-01T00:00:00Z\nExpiry: 3600';
      const parsedCache = parseMetadata(cacheMetadata);
      
      expect(parsedCache.CacheKey).toBe('test-key');
      expect(parsedCache.Timestamp).toBe('2024-01-01T00:00:00Z');
      expect(parsedCache.Expiry).toBe('3600');
    });

    it('should handle concurrent utility operations', async () => {
      // Simulate concurrent UUID generation (should be thread-safe)
      const concurrentUUIDs = await Promise.all([
        generateScrivenerUUID(),
        generateScrivenerUUID(),
        generateScrivenerUUID(),
        generateScrivenerUUID(),
        generateScrivenerUUID(),
      ]);

      // All UUIDs should be unique
      const uniqueUUIDs = new Set(concurrentUUIDs);
      expect(uniqueUUIDs.size).toBe(5);

      // Concurrent metadata parsing
      const metadataInputs = [
        'Title: Doc1\nAuthor: Author1',
        'Title: Doc2\nAuthor: Author2',
        'Title: Doc3\nAuthor: Author3',
      ];

      const parsedResults = await Promise.all(
        metadataInputs.map(metadata => Promise.resolve(parseMetadata(metadata)))
      );

      expect(parsedResults).toHaveLength(3);
      expect(parsedResults[0].Title).toBe('Doc1');
      expect(parsedResults[1].Title).toBe('Doc2');
      expect(parsedResults[2].Title).toBe('Doc3');

      // Concurrent directory operations
      const projectPaths = ['/project1', '/project2', '/project3'];
      const cacheDirs = await Promise.all(
        projectPaths.map(path => Promise.resolve(getCacheDirectory(path)))
      );

      expect(cacheDirs).toEqual([
        '/project1/.scrivener-data/cache',
        '/project2/.scrivener-data/cache',
        '/project3/.scrivener-data/cache',
      ]);
    });

    it('should validate complete utility integration in real workflow', async () => {
      // This test simulates a complete workflow from document creation to compilation
      
      // Step 1: Create project structure using utilities
      const projectPath = '/test/novel-project';
      const dataDir = await ensureProjectDataDirectory(projectPath);
      
      // Step 2: Generate document IDs using utility
      const chapterIds = [
        generateScrivenerUUID(),
        generateScrivenerUUID(),
        generateScrivenerUUID(),
      ];

      // Step 3: Create documents with metadata
      const chapters = chapterIds.map((id, index) => ({
        id,
        title: `Chapter ${index + 1}`,
        content: `Content of chapter ${index + 1}`,
        metadata: `Title: Chapter ${index + 1}\nWordCount: ${500 + index * 100}\nStatus: Draft`,
      }));

      // Step 4: Parse all metadata using utility
      const chaptersWithParsedMeta = chapters.map(chapter => ({
        ...chapter,
        parsedMeta: parseMetadata(chapter.metadata),
      }));

      // Verify metadata parsing worked correctly
      chaptersWithParsedMeta.forEach((chapter, index) => {
        expect(chapter.parsedMeta.Title).toBe(`Chapter ${index + 1}`);
        expect(chapter.parsedMeta.WordCount).toBe(`${500 + index * 100}`);
        expect(chapter.parsedMeta.Status).toBe('Draft');
      });

      // Step 5: Create binder structure and test navigation
      const binderStructure = [
        {
          id: 'manuscript',
          title: 'Manuscript',
          type: 'Folder',
          children: chaptersWithParsedMeta.map(chapter => ({
            id: chapter.id,
            title: chapter.title,
            type: 'Text',
            children: [],
          })),
        },
      ];

      // Test finding each chapter in the binder
      chaptersWithParsedMeta.forEach(chapter => {
        const found = findBinderItem(binderStructure, chapter.id);
        expect(found).toBeDefined();
        expect(found?.title).toBe(chapter.title);
      });

      // Step 6: Simulate error handling during processing
      const processingErrors = [
        { error: new Error('Network timeout'), operation: 'save_document' },
        { error: new Error('Disk full'), operation: 'cache_write' },
        { error: new Error('Permission denied'), operation: 'file_access' },
      ];

      processingErrors.forEach(({ error, operation }) => {
        const appError = toDatabaseError(error, operation);
        expect(appError).toBeInstanceOf(AppError);
        expect(appError.message).toContain(operation);
        expect(appError.code).toBe(ErrorCode.DATABASE_ERROR);
      });

      // Step 7: Verify queue state path utility
      const queuePath = getQueueStatePath(projectPath);
      expect(queuePath).toBe(`${projectPath}/.scrivener-data/queue-state.json`);

      // Step 8: Verify cache directory utility
      const cacheDir = getCacheDirectory(projectPath);
      expect(cacheDir).toBe(`${projectPath}/.scrivener-data/cache`);

      // All utilities worked together successfully
      expect(dataDir).toBe(`${projectPath}/.scrivener-data`);
      expect(chaptersWithParsedMeta).toHaveLength(3);
      expect(chapterIds).toHaveLength(3);
      expect(chapterIds.every(id => id.match(/^[0-9a-f-]{36}$/i))).toBe(true);
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle large-scale utility operations efficiently', async () => {
      const startTime = Date.now();

      // Generate 1000 UUIDs
      const uuids = [];
      for (let i = 0; i < 1000; i++) {
        uuids.push(generateScrivenerUUID());
      }

      // Parse 1000 metadata strings
      const metadataStrings = Array(1000).fill(0).map((_, i) => 
        `Title: Document ${i}\nAuthor: Author ${i}\nWordCount: ${i * 100}`
      );
      const parsedMeta = metadataStrings.map(parseMetadata);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within reasonable time (adjust as needed)
      expect(duration).toBeLessThan(5000); // 5 seconds

      // Verify all operations completed correctly
      expect(new Set(uuids).size).toBe(1000); // All UUIDs unique
      expect(parsedMeta).toHaveLength(1000);
      expect(parsedMeta[999].Title).toBe('Document 999');
    });

    it('should maintain data integrity across utility operations', async () => {
      // Create test data
      const originalData = {
        id: generateScrivenerUUID(),
        metadata: 'Title: Test Document\nAuthor: Test Author\nGenre: Fiction',
        projectPath: '/test/integrity-check',
      };

      // Process through utility chain
      const parsedMeta = parseMetadata(originalData.metadata);
      const dataDir = await ensureProjectDataDirectory(originalData.projectPath);
      const cacheDir = getCacheDirectory(originalData.projectPath);

      // Verify data integrity
      expect(originalData.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(parsedMeta.Title).toBe('Test Document');
      expect(parsedMeta.Author).toBe('Test Author');
      expect(parsedMeta.Genre).toBe('Fiction');
      expect(dataDir).toBe(`${originalData.projectPath}/.scrivener-data`);
      expect(cacheDir).toBe(`${originalData.projectPath}/.scrivener-data/cache`);

      // Create binder and verify navigation
      const binderItem = {
        id: originalData.id,
        title: parsedMeta.Title,
        type: 'Text',
        children: [],
      };

      const found = findBinderItem([binderItem], originalData.id);
      expect(found).toEqual(binderItem);
    });
  });
});