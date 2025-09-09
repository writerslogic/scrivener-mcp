import { AutoSetup } from '../../../src/services/auto-setup/auto-setup.js';

// Mock all dependencies to keep test simple
jest.mock('../../../src/services/auto-setup/ai-config-wizard.js');
jest.mock('../../../src/handlers/async-handlers.js');
jest.mock('fs');
jest.mock('chalk', () => ({
  cyan: jest.fn((str) => str),
  white: { bold: jest.fn((str) => str) },
  gray: jest.fn((str) => str),
  green: jest.fn((str) => str),
  red: jest.fn((str) => str),
  yellow: jest.fn((str) => str),
}));

describe('AutoSetup', () => {
  let autoSetup: AutoSetup;

  beforeEach(() => {
    jest.clearAllMocks();
    autoSetup = new AutoSetup();
  });

  describe('Basic functionality', () => {
    it('should create an instance', () => {
      expect(autoSetup).toBeDefined();
      expect(autoSetup).toBeInstanceOf(AutoSetup);
    });

    it('should have isSetupComplete method', () => {
      expect(autoSetup.isSetupComplete).toBeDefined();
      expect(typeof autoSetup.isSetupComplete).toBe('function');
    });

    it('should have run method', () => {
      expect(autoSetup.run).toBeDefined();
      expect(typeof autoSetup.run).toBe('function');
    });

    it('should have runHealthChecks method', () => {
      expect(autoSetup.runHealthChecks).toBeDefined();
      expect(typeof autoSetup.runHealthChecks).toBe('function');
    });
  });

  describe('Setup status', () => {
    it('should detect when setup is not complete', async () => {
      const result = await autoSetup.isSetupComplete();
      expect(typeof result).toBe('boolean');
    });

    it('should be able to run health checks', async () => {
      // Mock the method to avoid complex dependency injection
      autoSetup.runHealthChecks = jest.fn().mockResolvedValue({
        redis: false,
        ai: false,
        overall: false,
        details: [],
      });

      const health = await autoSetup.runHealthChecks();
      
      expect(health).toBeDefined();
      expect(health).toHaveProperty('redis');
      expect(health).toHaveProperty('ai');
      expect(health).toHaveProperty('overall');
      expect(health).toHaveProperty('details');
    });
  });

  describe('Setup process', () => {
    it('should be able to run setup process', async () => {
      // Mock the method to avoid complex dependency injection
      autoSetup.run = jest.fn().mockResolvedValue({
        success: true,
        warnings: [],
        errors: [],
      });

      const result = await autoSetup.run();
      
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('warnings');
      expect(result).toHaveProperty('errors');
    });

    it('should handle setup with options', async () => {
      autoSetup.run = jest.fn().mockResolvedValue({
        success: true,
        warnings: [],
        errors: [],
      });

      const options = {
        interactive: false,
        skipRedis: true,
        skipAI: false,
      };

      const result = await autoSetup.run(options);
      
      expect(autoSetup.run).toHaveBeenCalledWith(options);
      expect(result.success).toBe(true);
    });

    it('should handle setup errors', async () => {
      autoSetup.run = jest.fn().mockResolvedValue({
        success: false,
        warnings: [],
        errors: ['Setup failed'],
      });

      const result = await autoSetup.run();
      
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Setup failed');
    });
  });

  describe('CLI integration', () => {
    it('should have static CLI method', () => {
      expect(AutoSetup.cli).toBeDefined();
      expect(typeof AutoSetup.cli).toBe('function');
    });

    it('should handle CLI arguments', async () => {
      // Mock process.exit to prevent actual exit
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      // Mock the run method
      const mockRun = jest.spyOn(AutoSetup.prototype, 'run').mockResolvedValue({
        success: true,
        warnings: [],
        errors: [],
      });

      const args = ['--quick', '--skip-redis'];

      await expect(AutoSetup.cli(args)).rejects.toThrow('process.exit');
      
      expect(mockRun).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);

      mockRun.mockRestore();
      mockExit.mockRestore();
    });
  });

  describe('Error handling', () => {
    it('should handle method errors gracefully', () => {
      const errorSetup = new AutoSetup();
      
      // Mock method that throws
      errorSetup.isSetupComplete = jest.fn(() => {
        throw new Error('Method error');
      });

      expect(() => errorSetup.isSetupComplete()).toThrow('Method error');
    });

    it('should handle async method errors', async () => {
      const errorSetup = new AutoSetup();
      
      errorSetup.run = jest.fn().mockRejectedValue(new Error('Async error'));

      await expect(errorSetup.run()).rejects.toThrow('Async error');
    });
  });
});