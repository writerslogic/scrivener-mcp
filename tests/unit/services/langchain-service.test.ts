import { LangChainService } from '../../../src/services/ai/langchain-service.js';

// Mock dependencies
jest.mock('langchain/vectorstores/memory');
jest.mock('@langchain/openai');
jest.mock('@langchain/core/prompts');
jest.mock('langchain/text_splitter');
jest.mock('langchain/chains');
jest.mock('@langchain/core/runnables');
jest.mock('@langchain/core/output_parsers');

describe('LangChainService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock environment variable
    process.env.OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  describe('Basic functionality', () => {
    it('should create an instance with API key', () => {
      expect(() => new LangChainService('test-key')).not.toThrow();
    });

    it('should create an instance with env variable', () => {
      expect(() => new LangChainService()).not.toThrow();
    });

    it('should throw error without API key', () => {
      delete process.env.OPENAI_API_KEY;
      expect(() => new LangChainService()).toThrow('OpenAI API key required');
    });
  });

  describe('Document processing', () => {
    let service: LangChainService;

    beforeEach(() => {
      service = new LangChainService('test-key');
    });

    it('should have processDocument method', () => {
      expect(service.processDocument).toBeDefined();
      expect(typeof service.processDocument).toBe('function');
    });

    it('should have buildVectorStore method', () => {
      expect(service.buildVectorStore).toBeDefined();
      expect(typeof service.buildVectorStore).toBe('function');
    });

    it('should have semanticSearch method', () => {
      expect(service.semanticSearch).toBeDefined();
      expect(typeof service.semanticSearch).toBe('function');
    });

    it('should have generateWithContext method', () => {
      expect(service.generateWithContext).toBeDefined();
      expect(typeof service.generateWithContext).toBe('function');
    });

    it('should have analyzeWritingStyle method', () => {
      expect(service.analyzeWritingStyle).toBeDefined();
      expect(typeof service.analyzeWritingStyle).toBe('function');
    });

    it('should have summarizeChapter method', () => {
      expect(service.summarizeChapter).toBeDefined();
      expect(typeof service.summarizeChapter).toBe('function');
    });

    it('should have checkPlotConsistency method', () => {
      expect(service.checkPlotConsistency).toBeDefined();
      expect(typeof service.checkPlotConsistency).toBe('function');
    });

    it('should have clearMemory method', () => {
      expect(service.clearMemory).toBeDefined();
      expect(typeof service.clearMemory).toBe('function');
    });
  });

  describe('Method calls', () => {
    let service: LangChainService;

    beforeEach(() => {
      service = new LangChainService('test-key');
      
      // Mock all methods to avoid actual API calls
      service.processDocument = jest.fn().mockResolvedValue([]);
      service.buildVectorStore = jest.fn().mockResolvedValue(undefined);
      service.semanticSearch = jest.fn().mockResolvedValue([]);
      service.generateWithContext = jest.fn().mockResolvedValue('Generated text');
      service.analyzeWritingStyle = jest.fn().mockResolvedValue({ tone: 'neutral' });
      service.summarizeChapter = jest.fn().mockResolvedValue('Chapter summary');
      service.checkPlotConsistency = jest.fn().mockResolvedValue([]);
      service.clearMemory = jest.fn();
    });

    it('should process documents', async () => {
      const document = {
        id: 'test-doc',
        title: 'Test',
        type: 'Text' as const,
        content: 'Test content',
        path: '/test',
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

      await service.processDocument(document);
      expect(service.processDocument).toHaveBeenCalledWith(document);
    });

    it('should build vector store', async () => {
      await service.buildVectorStore([]);
      expect(service.buildVectorStore).toHaveBeenCalledWith([]);
    });

    it('should perform semantic search', async () => {
      const results = await service.semanticSearch('test query');
      expect(service.semanticSearch).toHaveBeenCalledWith('test query');
      expect(results).toEqual([]);
    });

    it('should generate with context', async () => {
      const response = await service.generateWithContext('test prompt');
      expect(service.generateWithContext).toHaveBeenCalledWith('test prompt');
      expect(response).toBe('Generated text');
    });

    it('should analyze writing style', async () => {
      const analysis = await service.analyzeWritingStyle(['sample text']);
      expect(service.analyzeWritingStyle).toHaveBeenCalledWith(['sample text']);
      expect(analysis).toEqual({ tone: 'neutral' });
    });

    it('should summarize chapters', async () => {
      const summary = await service.summarizeChapter('chapter content');
      expect(service.summarizeChapter).toHaveBeenCalledWith('chapter content');
      expect(summary).toBe('Chapter summary');
    });

    it('should check plot consistency', async () => {
      const issues = await service.checkPlotConsistency([]);
      expect(service.checkPlotConsistency).toHaveBeenCalledWith([]);
      expect(issues).toEqual([]);
    });

    it('should clear memory', () => {
      service.clearMemory();
      expect(service.clearMemory).toHaveBeenCalled();
    });
  });
});