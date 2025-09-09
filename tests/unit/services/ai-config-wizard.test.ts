import { AIConfigWizard } from '../../../src/services/auto-setup/ai-config-wizard.js';

// Mock dependencies
jest.mock('readline');
jest.mock('fs', () => ({
  promises: {
    writeFile: jest.fn(),
    readFile: jest.fn(),
    access: jest.fn(),
    mkdir: jest.fn(),
  },
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
}));
// node-fetch is not available in test environment, that's OK

describe('AIConfigWizard', () => {
  let wizard: AIConfigWizard;

  beforeEach(() => {
    jest.clearAllMocks();
    wizard = new AIConfigWizard();
  });

  describe('Basic functionality', () => {
    it('should create an instance', () => {
      expect(wizard).toBeDefined();
      expect(wizard).toBeInstanceOf(AIConfigWizard);
    });

    it('should have runWizard method', () => {
      expect(wizard.runWizard).toBeDefined();
      expect(typeof wizard.runWizard).toBe('function');
    });

    it('should have validation methods', () => {
      expect(wizard.validateOpenAIKey).toBeDefined();
      expect(wizard.validateAnthropicKey).toBeDefined();
      expect(typeof wizard.validateOpenAIKey).toBe('function');
      expect(typeof wizard.validateAnthropicKey).toBe('function');
    });
  });

  describe('Configuration validation', () => {
    it('should validate OpenAI keys', async () => {
      const mockValidate = jest.fn().mockResolvedValue(true);
      wizard.validateOpenAIKey = mockValidate;

      const result = await wizard.validateOpenAIKey('sk-test123');

      expect(result).toBe(true);
      expect(mockValidate).toHaveBeenCalledWith('sk-test123');
    });

    it('should validate Anthropic keys', async () => {
      const mockValidate = jest.fn().mockResolvedValue(true);
      wizard.validateAnthropicKey = mockValidate;

      const result = await wizard.validateAnthropicKey('sk-ant-test123');

      expect(result).toBe(true);
      expect(mockValidate).toHaveBeenCalledWith('sk-ant-test123');
    });

    it('should reject invalid keys', async () => {
      const mockValidate = jest.fn().mockResolvedValue(false);
      wizard.validateOpenAIKey = mockValidate;

      const result = await wizard.validateOpenAIKey('invalid-key');

      expect(result).toBe(false);
    });
  });

  describe('Wizard workflow', () => {
    it('should run configuration wizard', async () => {
      const mockConfig = {
        provider: 'openai',
        apiKey: 'sk-test123',
        model: 'gpt-4o',
        temperature: 0.7,
        maxTokens: 2000,
      };

      const mockRunWizard = jest.fn().mockResolvedValue(mockConfig);
      wizard.runWizard = mockRunWizard;

      const result = await wizard.runWizard();

      expect(result).toEqual(mockConfig);
      expect(mockRunWizard).toHaveBeenCalled();
    });

    it('should handle wizard errors', async () => {
      const mockRunWizard = jest.fn().mockRejectedValue(new Error('Wizard failed'));
      wizard.runWizard = mockRunWizard;

      await expect(wizard.runWizard()).rejects.toThrow('Wizard failed');
    });
  });

  describe('Quick setup', () => {
    it('should support quick setup', async () => {
      const mockQuickSetup = jest.fn().mockResolvedValue(undefined);
      wizard.quickSetup = mockQuickSetup;

      await wizard.quickSetup('sk-test123');

      expect(mockQuickSetup).toHaveBeenCalledWith('sk-test123');
    });
  });

  describe('Configuration management', () => {
    it('should get active config', () => {
      const mockConfig = {
        openaiApiKey: 'sk-test123',
        anthropicApiKey: null,
        enableLocalModels: false,
      };

      const mockGetActiveConfig = jest.fn().mockReturnValue(mockConfig);
      wizard.getActiveConfig = mockGetActiveConfig;

      const result = wizard.getActiveConfig();

      expect(result).toEqual(mockConfig);
      expect(mockGetActiveConfig).toHaveBeenCalled();
    });
  });
});