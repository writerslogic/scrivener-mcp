import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  ensureProjectDataDirectory,
  getQueueStatePath,
  getCacheDirectory,
  getProjectConfigPath,
  getProjectBackupPath,
} from '../../../src/utils/project-utils.js';

describe('Project Utils', () => {
  const testProjectPath = '/tmp/test-project.scriv';
  const testDataPath = join(testProjectPath, 'data');

  beforeEach(() => {
    // Clean up any existing test data
    if (existsSync(testDataPath)) {
      rmSync(testDataPath, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test data
    if (existsSync(testDataPath)) {
      rmSync(testDataPath, { recursive: true, force: true });
    }
  });

  describe('ensureProjectDataDirectory', () => {
    it('should create data directory if it does not exist', async () => {
      expect(existsSync(testDataPath)).toBe(false);
      
      await ensureProjectDataDirectory(testProjectPath);
      
      expect(existsSync(testDataPath)).toBe(true);
    });

    it('should not throw if directory already exists', async () => {
      mkdirSync(testDataPath, { recursive: true });
      expect(existsSync(testDataPath)).toBe(true);
      
      await expect(ensureProjectDataDirectory(testProjectPath)).resolves.not.toThrow();
    });

    it('should handle nested path creation', async () => {
      const nestedProjectPath = '/tmp/nested/deep/project.scriv';
      const nestedDataPath = join(nestedProjectPath, 'data');
      
      try {
        await ensureProjectDataDirectory(nestedProjectPath);
        expect(existsSync(nestedDataPath)).toBe(true);
      } finally {
        // Cleanup nested structure
        if (existsSync('/tmp/nested')) {
          rmSync('/tmp/nested', { recursive: true, force: true });
        }
      }
    });

    it('should handle project path with trailing slash', async () => {
      const projectPathWithSlash = testProjectPath + '/';
      
      await ensureProjectDataDirectory(projectPathWithSlash);
      
      expect(existsSync(testDataPath)).toBe(true);
    });
  });

  describe('getQueueStatePath', () => {
    it('should return correct queue state path', () => {
      const result = getQueueStatePath(testProjectPath);
      expect(result).toBe(join(testProjectPath, 'data', 'queue-state.json'));
    });

    it('should handle project path with trailing slash', () => {
      const projectPathWithSlash = testProjectPath + '/';
      const result = getQueueStatePath(projectPathWithSlash);
      expect(result).toBe(join(testProjectPath, 'data', 'queue-state.json'));
    });

    it('should work with different project paths', () => {
      const differentProject = '/home/user/novel.scriv';
      const result = getQueueStatePath(differentProject);
      expect(result).toBe('/home/user/novel.scriv/data/queue-state.json');
    });
  });

  describe('getCacheDirectory', () => {
    it('should return correct cache directory path', () => {
      const result = getCacheDirectory(testProjectPath);
      expect(result).toBe(join(testProjectPath, 'data', 'cache'));
    });

    it('should handle project path with trailing slash', () => {
      const projectPathWithSlash = testProjectPath + '/';
      const result = getCacheDirectory(projectPathWithSlash);
      expect(result).toBe(join(testProjectPath, 'data', 'cache'));
    });

    it('should work with different project paths', () => {
      const differentProject = '/home/user/story.scriv';
      const result = getCacheDirectory(differentProject);
      expect(result).toBe('/home/user/story.scriv/data/cache');
    });
  });

  describe('getProjectConfigPath', () => {
    it('should return correct config path', () => {
      const result = getProjectConfigPath(testProjectPath);
      expect(result).toBe(join(testProjectPath, 'data', 'config.json'));
    });

    it('should handle project path with trailing slash', () => {
      const projectPathWithSlash = testProjectPath + '/';
      const result = getProjectConfigPath(projectPathWithSlash);
      expect(result).toBe(join(testProjectPath, 'data', 'config.json'));
    });
  });

  describe('getProjectBackupPath', () => {
    it('should return correct backup path', () => {
      const result = getProjectBackupPath(testProjectPath);
      expect(result).toBe(join(testProjectPath, 'data', 'backups'));
    });

    it('should handle project path with trailing slash', () => {
      const projectPathWithSlash = testProjectPath + '/';
      const result = getProjectBackupPath(projectPathWithSlash);
      expect(result).toBe(join(testProjectPath, 'data', 'backups'));
    });
  });

  describe('Path normalization', () => {
    it('should handle Windows-style paths', () => {
      const windowsPath = 'C:\\Users\\Author\\project.scriv';
      const result = getQueueStatePath(windowsPath);
      expect(result).toContain('queue-state.json');
    });

    it('should handle relative paths', () => {
      const relativePath = './my-project.scriv';
      const result = getCacheDirectory(relativePath);
      expect(result).toContain('data');
      expect(result).toContain('cache');
    });

    it('should handle paths with spaces', () => {
      const pathWithSpaces = '/Users/Author/My Novel Project.scriv';
      const result = getProjectConfigPath(pathWithSpaces);
      expect(result).toBe('/Users/Author/My Novel Project.scriv/data/config.json');
    });

    it('should handle paths with special characters', () => {
      const pathWithSpecial = '/Users/Author/Café & Résumé.scriv';
      const result = getProjectBackupPath(pathWithSpecial);
      expect(result).toBe('/Users/Author/Café & Résumé.scriv/data/backups');
    });
  });
});