import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';
import { LangChainContentEnhancer } from '../../../../src/services/enhancements/langchain-content-enhancer.js';
import type { CacheEntry } from '../../../../src/types/index.js';
import { ApplicationError as AppError, ErrorCode } from '../../../../src/core/errors.js';

// Mock dependencies
jest.mock('../../../../src/utils/logger.js', () => ({
  Logger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

jest.mock('../../../../src/core/cache.js', () => ({
  CacheManager: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
    has: jest.fn(),
  })),
}));

jest.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: jest.fn(() => ({
      format: jest.fn().mockResolvedValue('formatted prompt'),
    })),
  },
}));

jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn(() => ({
    invoke: jest.fn().mockResolvedValue({
      content: 'Enhanced content',
    }),
  })),
}));

describe('LangChainContentEnhancer', () => {
  let enhancer: LangChainContentEnhancer;
  let mockCache: any;
  let mockLlm: any;

  beforeEach(() => {
    mockCache = {
      get: jest.fn(),
      set: jest.fn(),
      clear: jest.fn(),
      has: jest.fn(),
    };

    mockLlm = {
      invoke: jest.fn().mockResolvedValue({
        content: 'Enhanced content with improved style and clarity.',
      }),
    };

    enhancer = new LangChainContentEnhancer();
    enhancer['cache'] = mockCache;
    enhancer['llm'] = mockLlm;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor and Initialization', () => {
    it('should create enhancer with default configuration', () => {
      expect(enhancer).toBeInstanceOf(LangChainContentEnhancer);
      expect(enhancer['cacheEnabled']).toBe(true);
      expect(enhancer['model']).toBe('gpt-4o-mini');
    });

    it('should create enhancer with custom configuration', () => {
      const customEnhancer = new LangChainContentEnhancer({
        model: 'gpt-4o',
        temperature: 0.8,
        maxRetries: 5,
        cacheEnabled: false,
      });

      expect(customEnhancer['model']).toBe('gpt-4o');
      expect(customEnhancer['temperature']).toBe(0.8);
      expect(customEnhancer['maxRetries']).toBe(5);
      expect(customEnhancer['cacheEnabled']).toBe(false);
    });
  });

  describe('enhanceContent', () => {
    it('should enhance content successfully', async () => {
      const input = {
        content: 'Original content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      const result = await enhancer.enhanceContent(input);

      expect(result.enhancedContent).toBe('Enhanced content with improved style and clarity.');
      expect(result.originalLength).toBe(16);
      expect(result.enhancedLength).toBe(49);
      expect(result.improvementScore).toBeGreaterThan(0);
      expect(result.metadata).toBeDefined();
      expect(result.metadata.enhancementType).toBe('clarity');
      expect(result.metadata.targetAudience).toBe('general');
    });

    it('should use cached result when available', async () => {
      const cacheEntry: CacheEntry = {
        key: 'test-key',
        value: {
          enhancedContent: 'Cached enhanced content',
          originalLength: 16,
          enhancedLength: 23,
          improvementScore: 0.8,
          metadata: {
            enhancementType: 'clarity',
            targetAudience: 'general',
            model: 'gpt-4o-mini',
            temperature: 0.3,
            processingTime: 1000,
            timestamp: new Date(),
          },
        },
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      };

      mockCache.has.mockReturnValue(true);
      mockCache.get.mockReturnValue(cacheEntry);

      const input = {
        content: 'Original content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      const result = await enhancer.enhanceContent(input);

      expect(result.enhancedContent).toBe('Cached enhanced content');
      expect(mockLlm.invoke).not.toHaveBeenCalled();
      expect(mockCache.get).toHaveBeenCalled();
    });

    it('should handle different enhancement types', async () => {
      const enhancementTypes = ['clarity', 'style', 'tone', 'structure', 'vocabulary'] as const;

      for (const enhancementType of enhancementTypes) {
        const input = {
          content: 'Test content',
          targetAudience: 'general' as const,
          enhancementType,
        };

        const result = await enhancer.enhanceContent(input);

        expect(result.metadata.enhancementType).toBe(enhancementType);
        expect(mockLlm.invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining(enhancementType),
          })
        );
      }
    });

    it('should handle different target audiences', async () => {
      const audiences = ['general', 'academic', 'technical', 'children', 'young_adult'] as const;

      for (const targetAudience of audiences) {
        const input = {
          content: 'Test content',
          targetAudience,
          enhancementType: 'clarity' as const,
        };

        const result = await enhancer.enhanceContent(input);

        expect(result.metadata.targetAudience).toBe(targetAudience);
        expect(mockLlm.invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining(targetAudience),
          })
        );
      }
    });

    it('should handle enhancement with custom style guide', async () => {
      const input = {
        content: 'Test content',
        targetAudience: 'general' as const,
        enhancementType: 'style' as const,
        styleGuide: {
          tonePreferences: ['professional', 'engaging'],
          writingStyle: 'concise',
          vocabularyLevel: 'intermediate',
        },
      };

      const result = await enhancer.enhanceContent(input);

      expect(result.metadata.styleGuide).toEqual(input.styleGuide);
      expect(mockLlm.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('professional'),
        })
      );
    });

    it('should handle enhancement failure gracefully', async () => {
      mockLlm.invoke.mockRejectedValue(new Error('API error'));

      const input = {
        content: 'Test content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      await expect(enhancer.enhanceContent(input)).rejects.toThrow(AppError);
      await expect(enhancer.enhanceContent(input)).rejects.toThrow('Content enhancement failed');
    });

    it('should handle empty content', async () => {
      const input = {
        content: '',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      await expect(enhancer.enhanceContent(input)).rejects.toThrow(AppError);
      await expect(enhancer.enhanceContent(input)).rejects.toThrow('Content cannot be empty');
    });

    it('should calculate improvement score correctly', async () => {
      mockLlm.invoke.mockResolvedValue({
        content: 'This is significantly enhanced content with much better clarity and improved readability.',
      });

      const input = {
        content: 'Bad content.',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      const result = await enhancer.enhanceContent(input);

      expect(result.improvementScore).toBeGreaterThan(0);
      expect(result.improvementScore).toBeLessThanOrEqual(1);
    });
  });

  describe('enhanceBatch', () => {
    it('should enhance multiple content pieces', async () => {
      const inputs = [
        {
          content: 'First content',
          targetAudience: 'general' as const,
          enhancementType: 'clarity' as const,
        },
        {
          content: 'Second content',
          targetAudience: 'academic' as const,
          enhancementType: 'style' as const,
        },
      ];

      const results = await enhancer.enhanceBatch(inputs);

      expect(results).toHaveLength(2);
      expect(results[0].metadata.enhancementType).toBe('clarity');
      expect(results[1].metadata.enhancementType).toBe('style');
      expect(mockLlm.invoke).toHaveBeenCalledTimes(2);
    });

    it('should handle partial failures in batch processing', async () => {
      mockLlm.invoke
        .mockResolvedValueOnce({ content: 'Enhanced first content' })
        .mockRejectedValueOnce(new Error('API error for second'));

      const inputs = [
        {
          content: 'First content',
          targetAudience: 'general' as const,
          enhancementType: 'clarity' as const,
        },
        {
          content: 'Second content',
          targetAudience: 'academic' as const,
          enhancementType: 'style' as const,
        },
      ];

      const results = await enhancer.enhanceBatch(inputs, { continueOnError: true });

      expect(results).toHaveLength(2);
      expect(results[0].enhancedContent).toBe('Enhanced first content');
      expect(results[1]).toBeInstanceOf(Error);
    });

    it('should respect concurrency limit', async () => {
      const inputs = Array(10).fill(0).map((_, i) => ({
        content: `Content ${i}`,
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      }));

      await enhancer.enhanceBatch(inputs, { concurrency: 3 });

      // Should have been called 10 times total, but in batches of 3
      expect(mockLlm.invoke).toHaveBeenCalledTimes(10);
    });
  });

  describe('Cache Management', () => {
    it('should clear cache when requested', async () => {
      await enhancer.clearCache();

      expect(mockCache.clear).toHaveBeenCalled();
    });

    it('should skip caching when disabled', async () => {
      const noCacheEnhancer = new LangChainContentEnhancer({ cacheEnabled: false });
      noCacheEnhancer['llm'] = mockLlm;

      const input = {
        content: 'Test content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      await noCacheEnhancer.enhanceContent(input);

      expect(mockCache.get).not.toHaveBeenCalled();
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('should generate correct cache key', () => {
      const input = {
        content: 'Test content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      const key = enhancer['generateCacheKey'](input);

      expect(key).toContain('clarity');
      expect(key).toContain('general');
      expect(key).toContain('Test content');
    });
  });

  describe('Error Handling', () => {
    it('should throw AppError with correct error code for API failures', async () => {
      mockLlm.invoke.mockRejectedValue(new Error('Rate limit exceeded'));

      const input = {
        content: 'Test content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      try {
        await enhancer.enhanceContent(input);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCode.EXTERNAL_SERVICE_ERROR);
      }
    });

    it('should handle invalid input gracefully', async () => {
      const input = {
        content: 'Test',
        targetAudience: 'invalid_audience' as any,
        enhancementType: 'invalid_type' as any,
      };

      await expect(enhancer.enhanceContent(input)).rejects.toThrow(AppError);
    });

    it('should handle network timeouts', async () => {
      mockLlm.invoke.mockRejectedValue(new Error('Network timeout'));

      const input = {
        content: 'Test content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      try {
        await enhancer.enhanceContent(input);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).message).toContain('Content enhancement failed');
      }
    });
  });

  describe('Performance and Metrics', () => {
    it('should track processing time', async () => {
      const input = {
        content: 'Test content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      const result = await enhancer.enhanceContent(input);

      expect(result.metadata.processingTime).toBeGreaterThan(0);
      expect(result.metadata.timestamp).toBeInstanceOf(Date);
    });

    it('should include model information in metadata', async () => {
      const input = {
        content: 'Test content',
        targetAudience: 'general' as const,
        enhancementType: 'clarity' as const,
      };

      const result = await enhancer.enhanceContent(input);

      expect(result.metadata.model).toBe('gpt-4o-mini');
      expect(result.metadata.temperature).toBe(0.3);
    });
  });
});