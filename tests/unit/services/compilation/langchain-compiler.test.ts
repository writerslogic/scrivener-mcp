import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { LangChainCompilationService } from '../../../../src/services/compilation/langchain-compiler.js';
import type { LangChainCompilationOptions, CompiledDocument, GeneratedElements } from '../../../../src/services/compilation/langchain-compiler.js';
import type { ProjectStatistics } from '../../../../src/types/index.js';
import { ApplicationError as AppError, ErrorCode } from '../../../../src/core/errors.js';

// Mock the dependencies
jest.mock('../../../../src/services/ai/langchain-service-enhanced.js', () => ({
  EnhancedLangChainService: jest.fn(() => ({
    generateWithTemplate: jest.fn().mockResolvedValue({ content: 'Generated content' }),
  })),
}));

jest.mock('../../../../src/services/ai/langchain-advanced-features.js', () => ({
  AdvancedLangChainFeatures: jest.fn(() => ({})),
}));

jest.mock('../../../../src/core/logger.js', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('LangChainCompilationService', () => {
  let service: LangChainCompilationService;
  let mockDocuments: Array<{ id: string; content: string; title: string }>;
  let mockProjectStats: ProjectStatistics;

  beforeEach(() => {
    service = new LangChainCompilationService();
    
    mockDocuments = [
      { id: 'doc1', content: 'Chapter 1 content here', title: 'Chapter 1' },
      { id: 'doc2', content: 'Chapter 2 content here', title: 'Chapter 2' },
    ];

    mockProjectStats = {
      totalDocuments: 2,
      totalWords: 1000,
      totalCharacters: 5000,
      averageWordsPerDocument: 500,
      documentCount: 2,
      wordCount: 1000,
      characterCount: 5000,
      textDocuments: 2,
      folders: 1,
      images: 0,
      lastModified: new Date().toISOString(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor and Initialization', () => {
    it('should create service with proper initialization', () => {
      expect(service).toBeInstanceOf(LangChainCompilationService);
    });

    it('should initialize target optimizations', () => {
      expect(service['targetOptimizations']).toBeDefined();
      expect(service['targetOptimizations'].size).toBeGreaterThan(0);
    });

    it('should have correct target optimization configurations', () => {
      const agentQuery = service['targetOptimizations'].get('agent-query');
      expect(agentQuery).toEqual({
        maxLength: 250,
        style: 'professional',
        focusElements: ['hook', 'stakes', 'conflict'],
        tone: 'compelling',
        structure: 'query-standard'
      });

      const submission = service['targetOptimizations'].get('submission');
      expect(submission).toEqual({
        maxLength: 5000,
        style: 'polished',
        focusElements: ['opening', 'pacing', 'voice'],
        tone: 'confident',
        structure: 'manuscript-standard'
      });
    });
  });

  describe('compileWithAI', () => {
    it('should compile documents with basic options', async () => {
      const options: LangChainCompilationOptions = {
        outputFormat: 'text',
        targetOptimization: 'general',
      };

      // Mock the parent class method
      jest.spyOn(service as any, 'compileDocuments').mockResolvedValue('Compiled content');

      const result = await service.compileWithAI(mockDocuments, options);

      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('metadata');
      expect(result).toHaveProperty('dynamicElements');
      expect(result).toHaveProperty('quality');
      expect(result.metadata.wordCount).toBeGreaterThan(0);
    });

    it('should handle target optimization', async () => {
      const options: LangChainCompilationOptions = {
        outputFormat: 'text',
        target: 'agent-query',
        optimizeForTarget: true,
      };

      jest.spyOn(service as any, 'compileDocuments').mockResolvedValue('Base compiled content');
      
      const result = await service.compileWithAI(mockDocuments, options);

      expect(result.metadata.optimizations).toContain('Formatted as query letter');
    });

    it('should handle content enhancement', async () => {
      const options: LangChainCompilationOptions = {
        outputFormat: 'text',
        enhanceContent: true,
      };

      jest.spyOn(service as any, 'compileDocuments').mockResolvedValue('Base content');
      
      const result = await service.compileWithAI(mockDocuments, options);

      expect(result.metadata.optimizations).toContain('Enhanced prose quality');
    });

    it('should generate dynamic elements when requested', async () => {
      const options: LangChainCompilationOptions = {
        outputFormat: 'text',
        generateDynamicElements: true,
      };

      jest.spyOn(service as any, 'compileDocuments').mockResolvedValue('Content for analysis');
      
      const result = await service.compileWithAI(mockDocuments, options);

      expect(result.dynamicElements).toBeDefined();
      expect(result.dynamicElements.synopsis).toBeDefined();
    });

    it('should handle project statistics integration', async () => {
      const options: LangChainCompilationOptions = {
        outputFormat: 'text',
      };

      jest.spyOn(service as any, 'compileDocuments').mockResolvedValue('Content');
      
      const result = await service.compileWithAI(mockDocuments, options, mockProjectStats);

      expect(result).toBeDefined();
      // Should log project statistics for enhanced compilation
    });

    it('should handle compilation errors gracefully', async () => {
      const options: LangChainCompilationOptions = {
        outputFormat: 'text',
      };

      jest.spyOn(service as any, 'compileDocuments').mockRejectedValue(new Error('Compilation failed'));
      
      const result = await service.compileWithAI(mockDocuments, options);

      expect(result.metadata.optimizations).toContain('fallback-to-standard');
      expect(result.quality.issues).toContain('Could not perform AI optimization');
    });
  });

  describe('Target Optimization Methods', () => {
    beforeEach(() => {
      // Mock the langchain service methods
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockResolvedValue({
        content: 'Optimized content for target'
      });
    });

    it('should optimize for query letter', async () => {
      const content = 'Sample manuscript content';
      const options: LangChainCompilationOptions = { genre: 'fantasy' };

      const result = await service['optimizeForQueryLetter'](content, options);

      expect(result.content).toBe('Optimized content for target');
      expect(result.optimizations).toContain('Formatted as query letter');
      expect(result.optimizations).toContain('Optimized hook and stakes');
    });

    it('should optimize for submission', async () => {
      const content = 'Sample manuscript content';
      const options: LangChainCompilationOptions = { genre: 'science fiction' };

      const result = await service['optimizeForSubmission'](content, options);

      expect(result.content).toBe('Optimized content for target');
      expect(result.optimizations).toContain('Polished for submission');
      expect(result.optimizations).toContain('Enhanced opening hook');
    });

    it('should optimize for pitch packet', async () => {
      const content = 'Sample manuscript content';
      const options: LangChainCompilationOptions = { genre: 'mystery' };

      const result = await service['optimizeForPitch'](content, options);

      expect(result.content).toBe('Optimized content for target');
      expect(result.optimizations).toContain('Formatted as pitch packet');
      expect(result.optimizations).toContain('Added market positioning');
    });

    it('should optimize for synopsis', async () => {
      const content = 'Sample manuscript content';
      const options: LangChainCompilationOptions = { genre: 'romance' };

      const result = await service['optimizeForSynopsis'](content, options);

      expect(result.content).toBe('Optimized content for target');
      expect(result.optimizations).toContain('Professional synopsis format');
      expect(result.optimizations).toContain('Complete plot summary');
    });
  });

  describe('Dynamic Element Generation', () => {
    beforeEach(() => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockImplementation((template: any, content: any, options: any) => {
        if (template === 'synopsis_generation') {
          return Promise.resolve({ content: 'Generated synopsis' });
        }
        if (template === 'hook_generation') {
          return Promise.resolve({ content: '1. Hook one\n2. Hook two\n3. Hook three' });
        }
        if (template === 'blurb_generation') {
          return Promise.resolve({ content: 'Generated blurb' });
        }
        if (template === 'metadata_extraction') {
          return Promise.resolve({
            content: JSON.stringify({
              tagline: 'A compelling tagline',
              themes: ['love', 'betrayal', 'redemption'],
              settings: ['medieval castle', 'dark forest']
            })
          });
        }
        return Promise.resolve({ content: 'Generated content' });
      });
    });

    it('should generate synopsis', async () => {
      const content = 'Sample content';
      const options: LangChainCompilationOptions = { genre: 'fantasy' };

      const result = await service['generateSynopsis'](content, options);

      expect(result).toBe('Generated synopsis');
    });

    it('should generate hooks', async () => {
      const content = 'Sample content';
      const options: LangChainCompilationOptions = { genre: 'thriller' };

      const result = await service['generateHooks'](content, options);

      expect(result).toEqual(['Hook one', 'Hook two', 'Hook three']);
    });

    it('should generate blurb', async () => {
      const content = 'Sample content';
      const options: LangChainCompilationOptions = { audience: 'readers' };

      const result = await service['generateBlurb'](content, options);

      expect(result).toBe('Generated blurb');
    });

    it('should generate and parse metadata', async () => {
      const content = 'Sample content';
      const options: LangChainCompilationOptions = { genre: 'fantasy' };

      const result = await service['generateMetadata'](content, options);

      expect(result.tagline).toBe('A compelling tagline');
      expect(result.themes).toEqual(['love', 'betrayal', 'redemption']);
      expect(result.settings).toEqual(['medieval castle', 'dark forest']);
    });

    it('should handle metadata parsing errors gracefully', async () => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockResolvedValue({
        content: 'Invalid JSON'
      });

      const content = 'Sample content';
      const options: LangChainCompilationOptions = {};

      const result = await service['generateMetadata'](content, options);

      expect(result.tagline).toBe('A compelling story');
      expect(result.themes).toEqual([]);
      expect(result.settings).toEqual([]);
    });
  });

  describe('Content Enhancement', () => {
    it('should enhance content with AI', async () => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockResolvedValue({
        content: 'Enhanced content with better prose'
      });

      const content = 'Original content';
      const options: LangChainCompilationOptions = { genre: 'literary' };

      const result = await service['enhanceContentWithAI'](content, options);

      expect(result.content).toBe('Enhanced content with better prose');
      expect(result.optimizations).toContain('Enhanced prose quality');
      expect(result.optimizations).toContain('Improved clarity and flow');
    });

    it('should handle enhancement failures', async () => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockRejectedValue(
        new Error('AI service unavailable')
      );

      const content = 'Original content';
      const options: LangChainCompilationOptions = {};

      const result = await service['enhanceContentWithAI'](content, options);

      expect(result.content).toBe(content); // Should return original
      expect(result.optimizations).toContain('Content enhancement unavailable');
    });
  });

  describe('Content Condensation', () => {
    it('should not condense content within word limit', async () => {
      const content = 'Short content';
      const maxWords = 100;

      const result = await service['condenseToLength'](content, maxWords);

      expect(result.content).toBe(content);
      expect(result.optimizations).toEqual([]);
    });

    it('should condense content exceeding word limit', async () => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockResolvedValue({
        content: 'Condensed content'
      });

      const content = 'This is a very long piece of content '.repeat(50); // Much longer than limit
      const maxWords = 10;

      const result = await service['condenseToLength'](content, maxWords);

      expect(result.content).toBe('Condensed content');
      expect(result.optimizations[0]).toContain('Condensed from');
      expect(result.optimizations[0]).toContain('to 10 words');
    });
  });

  describe('Quality Assessment', () => {
    it('should assess content quality', async () => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockResolvedValue({
        content: JSON.stringify({
          score: 0.85,
          suggestions: ['Improve dialogue', 'Strengthen opening', 'Add more description'],
          issues: ['Pacing issue in middle']
        })
      });

      const content = 'Content to assess';
      const target = 'general';

      const result = await service['assessQuality'](content, target);

      expect(result.score).toBe(0.85);
      expect(result.suggestions).toHaveLength(3);
      expect(result.issues).toContain('Pacing issue in middle');
    });

    it('should handle assessment failures', async () => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockRejectedValue(
        new Error('Assessment failed')
      );

      const content = 'Content to assess';

      const result = await service['assessQuality'](content);

      expect(result.score).toBe(0.7);
      expect(result.suggestions).toContain('Manual quality review recommended');
      expect(result.issues).toContain('Automated assessment unavailable');
    });

    it('should constrain quality scores to valid range', async () => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockResolvedValue({
        content: JSON.stringify({
          score: 1.5, // Invalid: above 1.0
          suggestions: [],
          issues: []
        })
      });

      const result = await service['assessQuality']('test content');

      expect(result.score).toBe(1.0); // Should be capped at 1.0
    });
  });

  describe('Batch Compilation', () => {
    it('should process multiple batches', async () => {
      const batches = [
        {
          documents: [mockDocuments[0]],
          options: { outputFormat: 'text' as const },
        },
        {
          documents: [mockDocuments[1]],
          options: { outputFormat: 'markdown' as const },
        },
      ];

      jest.spyOn(service, 'compileWithAI').mockResolvedValue({
        content: 'Batch compiled',
        metadata: {
          format: 'text',
          wordCount: 100,
          generatedElements: {},
          optimizations: [],
          targetAudience: 'general',
          compiledAt: new Date().toISOString()
        },
        dynamicElements: {},
        quality: { score: 0.8, suggestions: [], issues: [] }
      });

      const results = await service.batchCompile(batches);

      expect(results).toHaveLength(2);
      expect(service.compileWithAI).toHaveBeenCalledTimes(2);
    });

    it('should handle batch compilation failures', async () => {
      const batches = [
        {
          documents: mockDocuments,
          options: { outputFormat: 'text' as const },
        },
      ];

      jest.spyOn(service, 'compileWithAI').mockRejectedValue(new Error('Batch failed'));
      jest.spyOn(service as any, 'compileDocuments').mockResolvedValue('Fallback content');

      const results = await service.batchCompile(batches);

      expect(results).toHaveLength(1);
      expect(results[0].metadata.optimizations).toContain('batch-compilation-failed');
    });
  });

  describe('Marketing Materials Generation', () => {
    it('should generate marketing materials', async () => {
      jest.spyOn(service, 'generateDynamicElements').mockResolvedValue({
        synopsis: 'Marketing synopsis',
        hooks: ['Marketing hook 1', 'Marketing hook 2'],
        blurb: 'Marketing blurb',
      });

      const options: LangChainCompilationOptions = {
        materialType: 'synopsis',
        targetAudience: 'publishers'
      };

      const result = await service.generateMarketingMaterials(mockDocuments, options);

      expect(result.synopsis).toBe('Marketing synopsis');
      expect(result.hooks).toEqual(['Marketing hook 1', 'Marketing hook 2']);
    });

    it('should handle marketing materials generation without project stats', async () => {
      jest.spyOn(service, 'generateDynamicElements').mockResolvedValue({
        synopsis: 'Basic synopsis',
      });

      const result = await service.generateMarketingMaterials(mockDocuments);

      expect(result.synopsis).toBe('Basic synopsis');
    });
  });

  describe('Error Handling', () => {
    it('should create proper AppErrors', async () => {
      jest.spyOn(service as any, 'compileDocuments').mockRejectedValue(new Error('Test error'));

      const result = await service.compileWithAI(mockDocuments, {});

      // Should fallback gracefully, not throw
      expect(result).toBeDefined();
      expect(result.metadata.optimizations).toContain('fallback-to-standard');
    });

    it('should handle target optimization errors', async () => {
      jest.spyOn(service['langchain'], 'generateWithTemplate').mockRejectedValue(
        new Error('AI service error')
      );

      const result = await service['optimizeForTarget']('content', 'agent-query', {});

      expect(result.content).toBe('content'); // Should return original
      expect(result.optimizations).toContain('Target optimization failed, using original content');
    });
  });
});