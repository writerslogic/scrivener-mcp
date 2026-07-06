import { describe, it, expect, beforeEach } from '@jest/globals';
import {
	generateScrivenerUUID,
	parseMetadata,
	findBinderItem,
	clearBinderCache,
	getDocumentPath,
	getSynopsisPath,
	getNotesPath,
	traverseBinder,
} from '../../../src/utils/scrivener-utils.js';
import type { BinderItem, BinderContainer } from '../../../src/types/internal.js';

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
				{ ID: 'author', Value: 'John Doe' },
				{ ID: 'genre', Value: 'Science Fiction' },
				{ ID: 'year', Value: '2024' },
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
			const result = parseMetadata(null as unknown as undefined);
			expect(result).toEqual({});
		});

		it('should override duplicate keys with last value', () => {
			const metaDataItems = [
				{ ID: 'author', Value: 'First Author' },
				{ ID: 'author', Value: 'Second Author' },
			];

			const result = parseMetadata(metaDataItems);
			expect(result).toEqual({
				author: 'Second Author',
			});
		});

		it('should handle special characters in keys and values', () => {
			const metaDataItems = [
				{ ID: 'special-key_123', Value: 'Value with spaces & symbols!' },
				{ ID: 'unicode-key', Value: 'Café résumé naïve' },
			];

			const result = parseMetadata(metaDataItems);
			expect(result).toEqual({
				'special-key_123': 'Value with spaces & symbols!',
				'unicode-key': 'Café résumé naïve',
			});
		});
	});

	describe('findBinderItem', () => {
		let mockBinder: BinderContainer;

		beforeEach(() => {
			clearBinderCache();
			mockBinder = {
				BinderItem: {
					UUID: 'root',
					Title: 'Root',
					Type: 'Folder',
					Children: {
						BinderItem: [
							{
								UUID: 'chapter-1',
								Title: 'Chapter 1',
								Type: 'Text',
								Children: {
									BinderItem: [
										{
											UUID: 'scene-1-1',
											Title: 'Scene 1',
											Type: 'Text',
										},
									],
								},
							},
							{
								UUID: 'chapter-2',
								Title: 'Chapter 2',
								Type: 'Text',
							},
							{
								UUID: 'research',
								Title: 'Research',
								Type: 'Folder',
								Children: {
									BinderItem: [
										{
											UUID: 'character-notes',
											Title: 'Character Notes',
											Type: 'Text',
										},
									],
								},
							},
						],
					},
				},
			};
		});

		it('should find a top-level item', () => {
			const result = findBinderItem(mockBinder, 'chapter-1');
			expect(result).toBeDefined();
			expect(result?.UUID).toBe('chapter-1');
			expect(result?.Title).toBe('Chapter 1');
		});

		it('should find a nested item', () => {
			const result = findBinderItem(mockBinder, 'scene-1-1');
			expect(result).toBeDefined();
			expect(result?.UUID).toBe('scene-1-1');
			expect(result?.Title).toBe('Scene 1');
		});

		it('should find a deeply nested item', () => {
			const result = findBinderItem(mockBinder, 'character-notes');
			expect(result).toBeDefined();
			expect(result?.UUID).toBe('character-notes');
			expect(result?.Title).toBe('Character Notes');
		});

		it('should return null for non-existent item', () => {
			const result = findBinderItem(mockBinder, 'non-existent');
			expect(result).toBeNull();
		});

		it('should find the root item itself', () => {
			const result = findBinderItem(mockBinder, 'root');
			expect(result).toBeDefined();
			expect(result?.UUID).toBe('root');
			expect(result?.Title).toBe('Root');
		});

		it('should handle empty binder', () => {
			const emptyBinder: BinderContainer = {
				BinderItem: {
					UUID: 'empty',
					Title: 'Empty',
					Type: 'Folder',
					Children: { BinderItem: [] },
				},
			};
			const result = findBinderItem(emptyBinder, 'non-existent');
			expect(result).toBeNull();
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
		let mockBinder: BinderContainer;
		let visitedItems: BinderItem[];

		beforeEach(() => {
			visitedItems = [];
			mockBinder = {
				BinderItem: {
					UUID: 'root',
					Title: 'Root',
					Type: 'Folder',
					Children: {
						BinderItem: [
							{
								UUID: 'chapter-1',
								Title: 'Chapter 1',
								Type: 'Text',
								Children: {
									BinderItem: [
										{
											UUID: 'scene-1-1',
											Title: 'Scene 1',
											Type: 'Text',
										},
									],
								},
							},
							{
								UUID: 'chapter-2',
								Title: 'Chapter 2',
								Type: 'Text',
							},
						],
					},
				},
			};
		});

		it('should visit all items in depth-first order', () => {
			traverseBinder(mockBinder, (item) => {
				visitedItems.push(item);
			});

			expect(visitedItems).toHaveLength(4);
			expect(visitedItems.map((item) => item.UUID)).toEqual([
				'root',
				'chapter-1',
				'scene-1-1',
				'chapter-2',
			]);
		});

		it('should visit every item regardless of callback return value', () => {
			traverseBinder(mockBinder, (item) => {
				visitedItems.push(item);
				return item.UUID === 'chapter-1'; // return value is ignored
			});

			expect(visitedItems).toHaveLength(4);
			expect(visitedItems.map((item) => item.UUID)).toEqual([
				'root',
				'chapter-1',
				'scene-1-1',
				'chapter-2',
			]);
		});

		it('should handle empty binder', () => {
			const emptyBinder: BinderContainer = {
				BinderItem: {
					UUID: 'empty',
					Title: 'Empty',
					Type: 'Folder',
					Children: { BinderItem: [] },
				},
			};

			traverseBinder(emptyBinder, (item) => {
				visitedItems.push(item);
			});

			expect(visitedItems).toHaveLength(1);
			expect(visitedItems[0].UUID).toBe('empty');
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
