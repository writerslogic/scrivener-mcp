import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  generateScrivenerUUID,
  parseMetadata,
  findBinderItem,
  getDocumentPath,
  getSynopsisPath,
  getNotesPath,
  traverseBinder,
} from '../../../src/utils/scrivener-utils.js';
import type { BinderItem } from '../../../src/types/index.js';

describe('Scrivener Utils', () => {
  describe('generateScrivenerUUID', () => {
    it('should generate a valid UUID format', () => {
      const uuid = generateScrivenerUUID();
      expect(uuid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i);
    });

    it('should generate unique UUIDs', () => {
      const uuid1 = generateScrivenerUUID();
      const uuid2 = generateScrivenerUUID();
      expect(uuid1).not.toBe(uuid2);
    });

    it('should generate UUIDs consistently', () => {
      const uuids = Array.from({ length: 100 }, () => generateScrivenerUUID());
      const uniqueUuids = new Set(uuids);
      expect(uniqueUuids.size).toBe(100);
    });
  });

  describe('parseMetadata', () => {
    it('should parse simple metadata items', () => {
      const metaDataItems = [
        { key: 'author', value: 'John Doe' },
        { key: 'genre', value: 'Science Fiction' },
        { key: 'year', value: '2024' },
      ];

      const result = parseMetadata(metaDataItems);
      expect(result).toEqual({
        author: 'John Doe',
        genre: 'Science Fiction',
        year: '2024',
      });
    });

    it('should handle empty metadata', () => {
      const result = parseMetadata([]);
      expect(result).toEqual({});
    });

    it('should handle undefined metadata', () => {
      const result = parseMetadata(undefined);
      expect(result).toEqual({});
    });

    it('should handle null metadata', () => {
      const result = parseMetadata(null);
      expect(result).toEqual({});
    });

    it('should override duplicate keys with last value', () => {
      const metaDataItems = [
        { key: 'author', value: 'First Author' },
        { key: 'author', value: 'Second Author' },
      ];

      const result = parseMetadata(metaDataItems);
      expect(result).toEqual({
        author: 'Second Author',
      });
    });

    it('should handle special characters in keys and values', () => {
      const metaDataItems = [
        { key: 'special-key_123', value: 'Value with spaces & symbols!' },
        { key: 'unicode-key', value: 'Café résumé naïve' },
      ];

      const result = parseMetadata(metaDataItems);
      expect(result).toEqual({
        'special-key_123': 'Value with spaces & symbols!',
        'unicode-key': 'Café résumé naïve',
      });
    });
  });

  describe('findBinderItem', () => {
    let mockBinder: BinderItem;

    beforeEach(() => {
      mockBinder = {
        id: 'root',
        title: 'Root',
        type: 'Folder',
        children: [
          {
            id: 'chapter-1',
            title: 'Chapter 1',
            type: 'Text',
            children: [
              {
                id: 'scene-1-1',
                title: 'Scene 1',
                type: 'Text',
                children: [],
              },
            ],
          },
          {
            id: 'chapter-2',
            title: 'Chapter 2',
            type: 'Text',
            children: [],
          },
          {
            id: 'research',
            title: 'Research',
            type: 'Folder',
            children: [
              {
                id: 'character-notes',
                title: 'Character Notes',
                type: 'Text',
                children: [],
              },
            ],
          },
        ],
      };
    });

    it('should find a top-level item', () => {
      const result = findBinderItem(mockBinder, 'chapter-1');
      expect(result).toBeDefined();
      expect(result?.id).toBe('chapter-1');
      expect(result?.title).toBe('Chapter 1');
    });

    it('should find a nested item', () => {
      const result = findBinderItem(mockBinder, 'scene-1-1');
      expect(result).toBeDefined();
      expect(result?.id).toBe('scene-1-1');
      expect(result?.title).toBe('Scene 1');
    });

    it('should find a deeply nested item', () => {
      const result = findBinderItem(mockBinder, 'character-notes');
      expect(result).toBeDefined();
      expect(result?.id).toBe('character-notes');
      expect(result?.title).toBe('Character Notes');
    });

    it('should return undefined for non-existent item', () => {
      const result = findBinderItem(mockBinder, 'non-existent');
      expect(result).toBeUndefined();
    });

    it('should find the root item itself', () => {
      const result = findBinderItem(mockBinder, 'root');
      expect(result).toBeDefined();
      expect(result?.id).toBe('root');
      expect(result?.title).toBe('Root');
    });

    it('should handle empty binder', () => {
      const emptyBinder: BinderItem = {
        id: 'empty',
        title: 'Empty',
        type: 'Folder',
        children: [],
      };
      const result = findBinderItem(emptyBinder, 'non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('Path Utilities', () => {
    const projectPath = '/path/to/project.scriv';

    describe('getDocumentPath', () => {
      it('should generate correct document path', () => {
        const documentId = 'ABC123';
        const result = getDocumentPath(projectPath, documentId);
        expect(result).toBe('/path/to/project.scriv/Files/Data/ABC123/content.rtf');
      });

      it('should handle trailing slash in project path', () => {
        const projectPathWithSlash = '/path/to/project.scriv/';
        const documentId = 'ABC123';
        const result = getDocumentPath(projectPathWithSlash, documentId);
        expect(result).toBe('/path/to/project.scriv/Files/Data/ABC123/content.rtf');
      });
    });

    describe('getSynopsisPath', () => {
      it('should generate correct synopsis path', () => {
        const documentId = 'ABC123';
        const result = getSynopsisPath(projectPath, documentId);
        expect(result).toBe('/path/to/project.scriv/Files/Data/ABC123/synopsis.txt');
      });
    });

    describe('getNotesPath', () => {
      it('should generate correct notes path', () => {
        const documentId = 'ABC123';
        const result = getNotesPath(projectPath, documentId);
        expect(result).toBe('/path/to/project.scriv/Files/Data/ABC123/notes.rtf');
      });
    });
  });

  describe('traverseBinder', () => {
    let mockBinder: BinderItem;
    let visitedItems: BinderItem[];

    beforeEach(() => {
      visitedItems = [];
      mockBinder = {
        id: 'root',
        title: 'Root',
        type: 'Folder',
        children: [
          {
            id: 'chapter-1',
            title: 'Chapter 1',
            type: 'Text',
            children: [
              {
                id: 'scene-1-1',
                title: 'Scene 1',
                type: 'Text',
                children: [],
              },
            ],
          },
          {
            id: 'chapter-2',
            title: 'Chapter 2',
            type: 'Text',
            children: [],
          },
        ],
      };
    });

    it('should visit all items in depth-first order', () => {
      traverseBinder(mockBinder, (item) => {
        visitedItems.push(item);
        return false; // Continue traversal
      });

      expect(visitedItems).toHaveLength(4);
      expect(visitedItems.map((item) => item.id)).toEqual([
        'root',
        'chapter-1',
        'scene-1-1',
        'chapter-2',
      ]);
    });

    it('should stop traversal when callback returns true', () => {
      traverseBinder(mockBinder, (item) => {
        visitedItems.push(item);
        return item.id === 'chapter-1'; // Stop at chapter-1
      });

      expect(visitedItems).toHaveLength(2);
      expect(visitedItems.map((item) => item.id)).toEqual(['root', 'chapter-1']);
    });

    it('should handle empty binder', () => {
      const emptyBinder: BinderItem = {
        id: 'empty',
        title: 'Empty',
        type: 'Folder',
        children: [],
      };

      traverseBinder(emptyBinder, (item) => {
        visitedItems.push(item);
        return false;
      });

      expect(visitedItems).toHaveLength(1);
      expect(visitedItems[0].id).toBe('empty');
    });

    it('should provide correct depth information', () => {
      const depths: number[] = [];
      traverseBinder(mockBinder, (item, depth) => {
        visitedItems.push(item);
        depths.push(depth);
        return false;
      });

      expect(depths).toEqual([0, 1, 2, 1]);
    });
  });
});