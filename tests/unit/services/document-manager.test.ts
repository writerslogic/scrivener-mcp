/**
 * Tests for DocumentManager service
 */

import { DocumentManager } from '../../../src/services/document-manager.js';
import { ErrorCode } from '../../../src/core/errors.js';
import { DOCUMENT_TYPES } from '../../../src/core/constants.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock dependencies
jest.mock('fs/promises');
jest.mock('../../../src/core/logger.js', () => ({
	getLogger: jest.fn(() => ({
		info: jest.fn(),
		debug: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	})),
}));

jest.mock('../../../src/services/parsers/rtf-handler.js', () => ({
	RTFHandler: jest.fn().mockImplementation(() => ({
		parseRTF: jest.fn().mockResolvedValue({
			plainText: 'Test content',
			formattedText: [{ text: 'Test content' }],
			metadata: {},
		}),
		generateRTF: jest.fn().mockReturnValue('{\\rtf1 Test content}'),
	})),
}));

describe('DocumentManager', () => {
	let documentManager: DocumentManager;
	const mockProjectPath = '/test/project/path.scriv';

	beforeEach(() => {
		jest.clearAllMocks();
		documentManager = new DocumentManager(mockProjectPath);
		
		// Set up basic project structure
		(documentManager as any).projectStructure = {
			ScrivenerProject: {
				Binder: {
					BinderItem: [{
						UUID: 'root',
						ID: 'root',
						Type: DOCUMENT_TYPES.FOLDER,
						Title: 'Draft',
						Children: {
							BinderItem: [
								{
									UUID: 'doc1',
									ID: 'doc1',
									Type: DOCUMENT_TYPES.TEXT,
									Title: 'Chapter 1',
								},
								{
									UUID: 'folder1',
									ID: 'folder1',
									Type: DOCUMENT_TYPES.FOLDER,
									Title: 'Part 1',
									Children: {
										BinderItem: [
											{
												UUID: 'doc2',
												ID: 'doc2',
												Type: DOCUMENT_TYPES.TEXT,
												Title: 'Chapter 2',
											},
										],
									},
								},
							],
						},
					}],
					SearchResults: [{
						Children: {
							BinderItem: [
								{
									UUID: 'trash1',
									ID: 'trash1',
									Type: DOCUMENT_TYPES.TEXT,
									Title: 'Deleted Chapter',
								},
							],
						},
					}],
				},
			},
		};
	});

	describe('recoverFromTrash', () => {
		it('should recover a document from trash to root', async () => {
			await documentManager.recoverFromTrash('trash1');

			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			const rootItems = binder.BinderItem[0].Children.BinderItem;
			const trashItems = binder.SearchResults[0].Children.BinderItem;

			// Document should be in root
			expect(rootItems).toContainEqual(
				expect.objectContaining({
					ID: 'trash1',
					Title: 'Deleted Chapter',
				})
			);

			// Document should not be in trash
			expect(trashItems).not.toContainEqual(
				expect.objectContaining({
					ID: 'trash1',
				})
			);
		});

		it('should recover a document to a specific parent folder', async () => {
			await documentManager.recoverFromTrash('trash1', 'folder1');

			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			const folderItems = binder.BinderItem[0].Children.BinderItem[1].Children.BinderItem;
			const trashItems = binder.SearchResults[0].Children.BinderItem;

			// Document should be in the target folder
			expect(folderItems).toContainEqual(
				expect.objectContaining({
					ID: 'trash1',
					Title: 'Deleted Chapter',
				})
			);

			// Document should not be in trash
			expect(trashItems).toHaveLength(0);
		});

		it('should throw error if document not found in trash', async () => {
			await expect(documentManager.recoverFromTrash('nonexistent')).rejects.toThrow(
				'Document nonexistent not found in trash'
			);
		});

		it('should throw error if target parent is not a folder', async () => {
			await expect(documentManager.recoverFromTrash('trash1', 'doc1')).rejects.toThrow(
				'Target parent folder doc1 not found'
			);
		});

		it('should throw error if trash is empty', async () => {
			// Empty the trash
			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			binder.SearchResults[0].Children.BinderItem = [];

			await expect(documentManager.recoverFromTrash('trash1')).rejects.toThrow(
				'Trash is empty'
			);
		});

		it('should throw error if project not loaded', async () => {
			(documentManager as any).projectStructure = null;

			await expect(documentManager.recoverFromTrash('trash1')).rejects.toThrow(
				'Project not loaded'
			);
		});

		it('should handle missing trash structure gracefully', async () => {
			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			delete binder.SearchResults;

			await expect(documentManager.recoverFromTrash('trash1')).rejects.toThrow(
				'Trash is empty'
			);
		});

		it('should create parent Children structure if missing', async () => {
			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			// Create a folder without Children
			binder.BinderItem[0].Children.BinderItem.push({
				UUID: 'folder2',
				ID: 'folder2',
				Type: DOCUMENT_TYPES.FOLDER,
				Title: 'Empty Folder',
			});

			await documentManager.recoverFromTrash('trash1', 'folder2');

			const folder = binder.BinderItem[0].Children.BinderItem.find(
				(item: any) => item.ID === 'folder2'
			);
			expect(folder.Children).toBeDefined();
			expect(folder.Children.BinderItem).toContainEqual(
				expect.objectContaining({
					ID: 'trash1',
				})
			);
		});
	});

	describe('readDocumentRaw', () => {
		const mockRtfContent = '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}} Test content}';

		beforeEach(() => {
			(fs.readFile as jest.Mock).mockResolvedValue(mockRtfContent);
		});

		it('should read raw RTF content from file', async () => {
			const result = await documentManager.readDocumentRaw('doc1');

			expect(result).toBe(mockRtfContent);
			expect(fs.readFile).toHaveBeenCalledWith(
				expect.stringContaining('doc1/content.rtf'),
				'utf-8'
			);
		});

		it('should return empty string if file not found', async () => {
			const error: any = new Error('File not found');
			error.code = 'ENOENT';
			(fs.readFile as jest.Mock).mockRejectedValue(error);

			const result = await documentManager.readDocumentRaw('nonexistent');

			expect(result).toBe('');
		});

		it('should throw other errors', async () => {
			const error = new Error('Permission denied');
			(fs.readFile as jest.Mock).mockRejectedValue(error);

			await expect(documentManager.readDocumentRaw('doc1')).rejects.toThrow(
				'Permission denied'
			);
		});

		it('should use correct document path', async () => {
			await documentManager.readDocumentRaw('doc1');

			const expectedPath = path.join(
				mockProjectPath,
				'Files',
				'Data',
				'doc1',
				'content.rtf'
			);
			expect(fs.readFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
		});
	});

	describe('readDocument', () => {
		it('should return plain text content', async () => {
			(fs.readFile as jest.Mock).mockResolvedValue('{\\rtf1 Test content}');

			const result = await documentManager.readDocument('doc1');

			expect(result).toBe('Test content');
		});

		it('should cache document content', async () => {
			(fs.readFile as jest.Mock).mockResolvedValue('{\\rtf1 Test content}');

			// First read
			await documentManager.readDocument('doc1');
			// Second read should use cache
			await documentManager.readDocument('doc1');

			// Should only read file once
			expect(fs.readFile).toHaveBeenCalledTimes(1);
		});
	});

	describe('deleteDocument', () => {
		it('should move document to trash', async () => {
			await documentManager.deleteDocument('doc1');

			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			const rootItems = binder.BinderItem[0].Children.BinderItem;
			const trashItems = binder.SearchResults[0].Children.BinderItem;

			// Document should not be in root
			expect(rootItems).not.toContainEqual(
				expect.objectContaining({
					ID: 'doc1',
				})
			);

			// Document should be in trash
			expect(trashItems).toContainEqual(
				expect.objectContaining({
					ID: 'doc1',
					Title: 'Chapter 1',
				})
			);
		});

		it('should create trash structure if missing', async () => {
			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			delete binder.SearchResults;

			await documentManager.deleteDocument('doc1');

			expect(binder.SearchResults).toBeDefined();
			expect(binder.SearchResults[0].Children.BinderItem).toContainEqual(
				expect.objectContaining({
					ID: 'doc1',
				})
			);
		});

		it('should throw error if document not found', async () => {
			await expect(documentManager.deleteDocument('nonexistent')).rejects.toThrow(
				'Document nonexistent not found'
			);
		});
	});

	describe('moveDocument', () => {
		it('should move document to another folder', async () => {
			await documentManager.moveDocument('doc1', 'folder1');

			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			const rootItems = binder.BinderItem[0].Children.BinderItem;
			// Find the folder by ID since its position may have changed
			const folder = rootItems.find((item: any) => item.ID === 'folder1');
			const folderItems = folder?.Children?.BinderItem;

			// Document should not be in root
			expect(rootItems).not.toContainEqual(
				expect.objectContaining({
					ID: 'doc1',
				})
			);

			// Document should be in folder
			expect(folderItems).toContainEqual(
				expect.objectContaining({
					ID: 'doc1',
					Title: 'Chapter 1',
				})
			);
		});

		it('should move document to root when parentId is null', async () => {
			// Move doc2 from folder to root
			await documentManager.moveDocument('doc2', null);

			const binder = (documentManager as any).projectStructure.ScrivenerProject.Binder;
			const rootItems = binder.BinderItem[0].Children.BinderItem;
			// Find the folder by ID since its position may have changed
			const folder = rootItems.find((item: any) => item.ID === 'folder1');
			const folderItems = folder?.Children?.BinderItem || [];

			// Document should be in root
			expect(rootItems).toContainEqual(
				expect.objectContaining({
					ID: 'doc2',
					Title: 'Chapter 2',
				})
			);

			// Document should not be in folder
			expect(folderItems).not.toContainEqual(
				expect.objectContaining({
					ID: 'doc2',
				})
			);
		});

		it('should throw error if moving document to itself', async () => {
			await expect(documentManager.moveDocument('doc1', 'doc1')).rejects.toThrow(
				'Cannot move document to itself'
			);
		});

		it('should throw error if parent is not a folder', async () => {
			await expect(documentManager.moveDocument('doc1', 'doc2')).rejects.toThrow(
				'Parent folder doc2 not found'
			);
		});
	});
});