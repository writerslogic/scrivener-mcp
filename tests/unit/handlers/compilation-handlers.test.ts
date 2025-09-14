import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';
import {
  compileDocumentsHandler,
  intelligentCompilationHandler,
  generateMarketingMaterialsHandler,
  buildVectorStoreHandler,
} from '../../../src/handlers/compilation-handlers.js';
import type { HandlerContext, HandlerResult } from '../../../src/handlers/types.js';

// Mock dependencies
jest.mock('../../../src/services/compilation/langchain-compiler.js', () => ({
  LangChainCompilationService: jest.fn(() => ({
    initialize: jest.fn(),
    compileWithAI: jest.fn().mockResolvedValue({
      content: 'Compiled with AI',
      metadata: {
        format: 'text',
        wordCount: 1000,
        generatedElements: {},
        optimizations: ['ai-enhanced'],
        targetAudience: 'general',
        compiledAt: new Date().toISOString(),
        processingTime: 1500,
      },
      dynamicElements: {},
      quality: { score: 0.8, suggestions: [], issues: [] },
    }),
    generateMarketingMaterials: jest.fn().mockResolvedValue({
      content: 'Marketing materials',
      processingTime: 1000,
    }),
  })),
}));

jest.mock('../../../src/handlers/langchain-continuous-learning-handler.js', () => ({
  LangChainContinuousLearningHandler: jest.fn(() => ({
    initialize: jest.fn(),
    startFeedbackSession: jest.fn(),
    collectImplicitFeedback: jest.fn(),
  })),
}));

jest.mock('../../../src/services/ai/vector-store.js', () => ({
  VectorStore: jest.fn(() => ({
    initialize: jest.fn(),
    clear: jest.fn(),
    addDocuments: jest.fn(),
    getStats: jest.fn().mockReturnValue({
      totalDocuments: 10,
      totalVectors: 10,
      averageVectorSize: 1536,
    }),
  })),
}));

jest.mock('../../../src/utils/common.js', () => ({
  validateInput: jest.fn(),
}));

describe('Compilation Handlers', () => {
  let mockContext: HandlerContext;
  let mockProject: any;

  beforeEach(() => {
    mockProject = {
      getAllDocuments: jest.fn().mockResolvedValue([
        {
          id: 'doc1',
          content: 'Chapter 1 content',
          title: 'Chapter 1',
          type: 'Text',
          path: 'Manuscript/Chapter 1',
        },
        {
          id: 'doc2',
          content: 'Chapter 2 content',
          title: 'Chapter 2',
          type: 'Text',
          path: 'Manuscript/Chapter 2',
        },
      ]),
      getDocument: jest.fn().mockImplementation((id: string) => {
        if (id === 'doc1') {
          return Promise.resolve({
            id: 'doc1',
            content: 'Chapter 1 content',
            title: 'Chapter 1',
          });
        }
        return Promise.resolve(null);
      }),
      compileDocuments: jest.fn().mockResolvedValue('Fallback compiled content'),
      exportProject: jest.fn().mockResolvedValue({ success: true, path: '/export/path' }),
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
    } as HandlerContext;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('compileDocumentsHandler', () => {
    it('should compile documents with AI enhancement', async () => {
      const args = {
        format: 'text',
        includeSynopsis: true,
        includeNotes: false,
        hierarchical: true,
      };

      const result = await compileDocumentsHandler.handler(args, mockContext);

      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe('Compiled with AI');
      expect(result.content[0].data.enhanced).toBe(true);
      expect(result.content[0].data.langChainProcessed).toBe(true);
    });

    it('should filter documents by root folder', async () => {
      const args = {
        format: 'markdown',
        rootFolderId: 'Manuscript',
      };

      const result = await compileDocumentsHandler.handler(args, mockContext);

      expect(mockProject.getAllDocuments).toHaveBeenCalled();
      expect(result.content[0].data.documentCount).toBe(2);
    });

    it('should fallback on AI compilation failure', async () => {
      const { LangChainCompilationService } = await import('../../../src/services/compilation/langchain-compiler.js');
      jest.mocked(LangChainCompilationService).mockImplementationOnce(() => ({
        initialize: jest.fn(),
        compileWithAI: jest.fn().mockRejectedValue(new Error('AI service unavailable')),
      }) as any);

      const args = { format: 'text' };

      const result = await compileDocumentsHandler.handler(args, mockContext);

      expect(result.content[0].text).toBe('Fallback compiled content');
      expect(result.content[0].data.enhanced).toBe(false);
      expect(result.content[0].data.fallbackReason).toBe('AI service unavailable');
    });

    it('should handle different output formats', async () => {
      const formats = ['text', 'markdown', 'html'] as const;

      for (const format of formats) {
        const args = { format };
        const result = await compileDocumentsHandler.handler(args, mockContext);
        expect(result).toBeDefined();
      }
    });

    it('should handle empty document list', async () => {
      mockProject.getAllDocuments.mockResolvedValueOnce([]);

      const args = { format: 'text' };

      const result = await compileDocumentsHandler.handler(args, mockContext);

      expect(result.content[0].data.documentCount).toBe(0);
    });
  });

  describe('intelligentCompilationHandler', () => {
    it('should perform intelligent compilation', async () => {
      const args = {
        documentsIds: ['doc1'],
        targetOptimization: 'agent-query',
        outputFormat: 'text',
        contentOptimization: true,
      };

      const result = await intelligentCompilationHandler.handler(args, mockContext);

      expect(result.content[0].text).toBe('Compiled with AI');
      expect(result.content[0].data.enhanced).toBe(true);
      expect(result.content[0].data.targetOptimization).toBe('agent-query');
      expect(result.content[0].data.documentCount).toBe(1);
    });

    it('should map target optimizations correctly', async () => {
      const targetMappings = [
        'agent',
        'submission',
        'pitch_packet',
        'synopsis',
        'query_letter',
        'general',
      ];

      for (const target of targetMappings) {
        const args = {
          documentsIds: ['doc1'],
          targetOptimization: target,
          outputFormat: 'text',
        };

        const result = await intelligentCompilationHandler.handler(args, mockContext);
        expect(result.content[0].data.targetOptimization).toBe(target);
      }
    });

    it('should handle invalid document IDs', async () => {
      const args = {
        documentsIds: ['non-existent'],
        targetOptimization: 'general',
        outputFormat: 'text',
      };

      const result = await intelligentCompilationHandler.handler(args, mockContext);

      expect(result.content[0].text).toContain('No valid documents found');
      expect(result.content[0].data.error).toBe(true);
    });

    it('should handle compilation failure gracefully', async () => {
      const { LangChainCompilationService } = await import('../../../src/services/compilation/langchain-compiler.js');
      jest.mocked(LangChainCompilationService).mockImplementationOnce(() => ({
        initialize: jest.fn(),
        compileWithAI: jest.fn().mockRejectedValue(new Error('Service error')),
      }) as any);

      const args = {
        documentsIds: ['doc1'],
        targetOptimization: 'general',
        outputFormat: 'text',
      };

      const result = await intelligentCompilationHandler.handler(args, mockContext);

      expect(result.content[0].text).toContain('Intelligent compilation failed');
      expect(result.content[0].data.error).toBe(true);
    });

    it('should enable marketing materials for non-general targets', async () => {
      const { LangChainCompilationService } = await import('../../../src/services/compilation/langchain-compiler.js');
      const mockCompileWithAI = jest.fn().mockResolvedValue({
        content: 'Compiled',
        metadata: {
          format: 'text',
          wordCount: 100,
          generatedElements: {},
          optimizations: [],
          targetAudience: 'agents',
          compiledAt: new Date().toISOString(),
        },
        dynamicElements: {},
        quality: { score: 0.8, suggestions: [], issues: [] },
      });

      jest.mocked(LangChainCompilationService).mockImplementationOnce(() => ({
        initialize: jest.fn(),
        compileWithAI: mockCompileWithAI,
      }) as any);

      const args = {
        documentsIds: ['doc1'],
        targetOptimization: 'agent',
        outputFormat: 'text',
      };

      await intelligentCompilationHandler.handler(args, mockContext);

      expect(mockCompileWithAI).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          generateMarketingMaterials: true,
        })
      );
    });
  });

  describe('generateMarketingMaterialsHandler', () => {
    it('should generate marketing materials', async () => {
      const args = {
        materialType: 'synopsis',
        length: 'medium',
        targetAudience: 'agents',
      };

      const result = await generateMarketingMaterialsHandler.handler(args, mockContext);

      expect(result.content[0].text).toBe('Marketing materials');
      expect(result.content[0].data.enhanced).toBe(true);
      expect(result.content[0].data.materialType).toBe('synopsis');
      expect(result.content[0].data.targetAudience).toBe('agents');
    });

    it('should handle different material types', async () => {
      const materialTypes = [
        'synopsis',
        'query_letter',
        'pitch_packet',
        'elevator_pitch',
        'book_blurb',
      ];

      for (const materialType of materialTypes) {
        const args = {
          materialType,
          length: 'short',
        };

        const result = await generateMarketingMaterialsHandler.handler(args, mockContext);
        expect(result.content[0].data.materialType).toBe(materialType);
      }
    });

    it('should handle different lengths', async () => {
      const lengths = ['short', 'medium', 'long'];

      for (const length of lengths) {
        const args = {
          materialType: 'synopsis',
          length,
        };

        const result = await generateMarketingMaterialsHandler.handler(args, mockContext);
        
        const expectedWordCount = length === 'short' ? 500 : length === 'long' ? 2000 : 1000;
        // The handler converts length string to number, so we can't directly check it
        // but we can verify the request was processed
        expect(result.content[0].data.length).toBe(expectedWordCount);
      }
    });

    it('should handle projects with no text documents', async () => {
      mockProject.getAllDocuments.mockResolvedValueOnce([
        { id: 'folder1', type: 'Folder', content: null },
      ]);

      const args = {
        materialType: 'synopsis',
      };

      const result = await generateMarketingMaterialsHandler.handler(args, mockContext);

      expect(result.content[0].text).toContain('No text documents found');
      expect(result.content[0].data.error).toBe(true);
    });

    it('should handle generation failures', async () => {
      const { LangChainCompilationService } = await import('../../../src/services/compilation/langchain-compiler.js');
      jest.mocked(LangChainCompilationService).mockImplementationOnce(() => ({
        initialize: jest.fn(),
        generateMarketingMaterials: jest.fn().mockRejectedValue(new Error('Generation failed')),
      }) as any);

      const args = {
        materialType: 'synopsis',
      };

      const result = await generateMarketingMaterialsHandler.handler(args, mockContext);

      expect(result.content[0].text).toContain('Marketing material generation failed');
      expect(result.content[0].data.error).toBe(true);
    });
  });

  describe('buildVectorStoreHandler', () => {
    it('should build vector store successfully', async () => {
      const args = { rebuild: false };

      const result = await buildVectorStoreHandler.handler(args, mockContext);

      expect(result.content[0].text).toContain('Vector store updated successfully');
      expect(result.content[0].data.enhanced).toBe(true);
      expect(result.content[0].data.vectorIndexed).toBe(true);
      expect(result.content[0].data.documentsIndexed).toBe(2);
    });

    it('should rebuild vector store when requested', async () => {
      const args = { rebuild: true };

      const result = await buildVectorStoreHandler.handler(args, mockContext);

      expect(result.content[0].text).toContain('Vector store rebuilt successfully');
    });

    it('should handle documents without content', async () => {
      mockProject.getAllDocuments.mockResolvedValueOnce([
        { id: 'empty1', content: null, title: 'Empty' },
        { id: 'empty2', content: '', title: 'Also Empty' },
      ]);

      const args = { rebuild: false };

      const result = await buildVectorStoreHandler.handler(args, mockContext);

      expect(result.content[0].text).toContain('No documents with content found');
      expect(result.content[0].data.error).toBe(true);
    });

    it('should handle vector store build failures', async () => {
      const { VectorStore } = await import('../../../src/services/ai/vector-store.js');
      jest.mocked(VectorStore).mockImplementationOnce(() => ({
        initialize: jest.fn().mockRejectedValue(new Error('Vector store init failed')),
        clear: jest.fn(),
        addDocuments: jest.fn(),
        getStats: jest.fn(),
      }) as any);

      const args = { rebuild: false };

      const result = await buildVectorStoreHandler.handler(args, mockContext);

      expect(result.content[0].text).toContain('Vector store build failed');
      expect(result.content[0].data.error).toBe(true);
    });

    it('should include document metadata in vector store', async () => {
      const { VectorStore } = await import('../../../src/services/ai/vector-store.js');
      const mockAddDocuments = jest.fn();
      
      jest.mocked(VectorStore).mockImplementationOnce(() => ({
        initialize: jest.fn(),
        clear: jest.fn(),
        addDocuments: mockAddDocuments,
        getStats: jest.fn().mockReturnValue({ totalDocuments: 2 }),
      }) as any);

      const args = { rebuild: false };

      await buildVectorStoreHandler.handler(args, mockContext);

      expect(mockAddDocuments).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'doc1',
            content: 'Chapter 1 content',
            metadata: expect.objectContaining({
              title: 'Chapter 1',
              type: 'Text',
              wordCount: expect.any(Number),
            }),
          }),
        ])
      );
    });
  });

  describe('Handler Input Validation', () => {
    it('should validate compile documents input', async () => {
      const { validateInput } = await import('../../../src/utils/common.js');
      
      const args = { format: 'text' };
      await compileDocumentsHandler.handler(args, mockContext);

      expect(validateInput).toHaveBeenCalled();
    });

    it('should require materialType for marketing generation', () => {
      expect(generateMarketingMaterialsHandler.inputSchema.required).toContain('materialType');
    });

    it('should require documentsIds and targetOptimization for intelligent compilation', () => {
      expect(intelligentCompilationHandler.inputSchema.required).toContain('documentsIds');
      expect(intelligentCompilationHandler.inputSchema.required).toContain('targetOptimization');
    });
  });

  describe('Handler Context Requirements', () => {
    it('should require project context', async () => {
      const contextWithoutProject = {} as HandlerContext;

      await expect(
        compileDocumentsHandler.handler({}, contextWithoutProject)
      ).rejects.toThrow();
    });
  });

  describe('Continuous Learning Integration', () => {
    it('should collect feedback for successful operations', async () => {
      const { LangChainContinuousLearningHandler } = await import('../../../src/handlers/langchain-continuous-learning-handler.js');
      const mockCollectFeedback = jest.fn();
      
      jest.mocked(LangChainContinuousLearningHandler).mockImplementationOnce(() => ({
        initialize: jest.fn(),
        startFeedbackSession: jest.fn(),
        collectImplicitFeedback: mockCollectFeedback,
      }) as any);

      const args = {
        documentsIds: ['doc1'],
        targetOptimization: 'general',
        outputFormat: 'text',
      };

      await intelligentCompilationHandler.handler(args, mockContext);

      expect(mockCollectFeedback).toHaveBeenCalledWith(
        expect.any(String),
        'intelligent_compilation',
        expect.objectContaining({
          success: true,
          targetOptimization: 'general',
          documentsCount: 1,
        })
      );
    });
  });
});