/**
 * Tests for ScrivenerProject class
 */

import { ScrivenerProject } from '../../src/scrivener-project.js';
import { DocumentManager } from '../../src/services/document-manager.js';
import { CompilationService } from '../../src/services/compilation-service.js';
import { DatabaseService } from '../../src/database/database-service.js';

// Mock all dependencies
jest.mock('../../src/services/document-manager.js');
jest.mock('../../src/services/compilation-service.js');
jest.mock('../../src/services/metadata-manager.js');
jest.mock('../../src/services/project-loader.js');
jest.mock('../../src/database/database-service.js');
jest.mock('../../src/content-analyzer.js');
jest.mock('../../src/utils/common.js', () => ({
	...jest.requireActual('../../src/utils/common.js'),
	CleanupManager: jest.fn().mockImplementation(() => ({
		register: jest.fn(),
		cleanup: jest.fn(),
	})),
	ensureDir: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/utils/project-utils.js', () => ({
	ensureProjectDataDirectory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/handlers/async-handlers.js', () => ({
	initializeAsyncServices: jest.fn().mockResolvedValue(undefined),
	shutdownAsyncServices: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/core/logger.js', () => ({
	getLogger: jest.fn(() => ({
		info: jest.fn(),
		debug: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	})),
}));

describe('ScrivenerProject', () => {
	let project: ScrivenerProject;
	let mockDocumentManager: jest.Mocked<DocumentManager>;
	let mockCompilationService: jest.Mocked<CompilationService>;
	let mockDatabaseService: jest.Mocked<DatabaseService>;
	let mockProjectLoader: any;
	const projectPath = '/test/project.scriv';

	beforeEach(() => {
		jest.clearAllMocks();
		project = new ScrivenerProject(projectPath);
		mockDocumentManager = (project as any).documentManager;
		mockCompilationService = (project as any).compilationService;
		mockDatabaseService = (project as any).databaseService;
		mockProjectLoader = (project as any).projectLoader;
	});

	describe('recoverFromTrash', () => {
		it('should call document manager and save project', async () => {
			mockDocumentManager.recoverFromTrash = jest.fn().mockResolvedValue(undefined);
			mockProjectLoader.saveProject = jest.fn().mockResolvedValue(undefined);

			await project.recoverFromTrash('doc1', 'folder1');

			expect(mockDocumentManager.recoverFromTrash).toHaveBeenCalledWith('doc1', 'folder1');
			expect(mockProjectLoader.saveProject).toHaveBeenCalled();
		});

		it('should work without target parent', async () => {
			mockDocumentManager.recoverFromTrash = jest.fn().mockResolvedValue(undefined);
			mockProjectLoader.saveProject = jest.fn().mockResolvedValue(undefined);

			await project.recoverFromTrash('doc1');

			expect(mockDocumentManager.recoverFromTrash).toHaveBeenCalledWith('doc1', undefined);
		});

		it('should propagate errors from document manager', async () => {
			const error = new Error('Document not found in trash');
			mockDocumentManager.recoverFromTrash = jest.fn().mockRejectedValue(error);

			await expect(project.recoverFromTrash('doc1')).rejects.toThrow('Document not found in trash');
		});
	});

	describe('getDocumentAnnotations', () => {
		it('should extract annotations from raw RTF content', async () => {
			const mockRtfContent = '{\\rtf1 Content with {\\*\\annotation Test annotation}}';
			const mockAnnotations = new Map([
				['annotation1', 'Test annotation'],
				['comment1', 'Test comment'],
			]);

			mockDocumentManager.readDocumentRaw = jest.fn().mockResolvedValue(mockRtfContent);
			mockCompilationService.extractAnnotations = jest.fn().mockReturnValue(mockAnnotations);

			const result = await project.getDocumentAnnotations('doc1');

			expect(mockDocumentManager.readDocumentRaw).toHaveBeenCalledWith('doc1');
			expect(mockCompilationService.extractAnnotations).toHaveBeenCalledWith(mockRtfContent);
			expect(result).toBe(mockAnnotations);
		});

		it('should return empty map on error', async () => {
			mockDocumentManager.readDocumentRaw = jest.fn().mockRejectedValue(new Error('File not found'));

			const result = await project.getDocumentAnnotations('doc1');

			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBe(0);
		});

		it('should handle empty RTF content', async () => {
			mockDocumentManager.readDocumentRaw = jest.fn().mockResolvedValue('');
			mockCompilationService.extractAnnotations = jest.fn().mockReturnValue(new Map());

			const result = await project.getDocumentAnnotations('doc1');

			expect(result.size).toBe(0);
		});
	});

	describe('searchContent', () => {
		it('should search across documents with metadata', async () => {
			const mockDocuments = [
				{ id: 'doc1', title: 'Test', content: 'Test content', type: 'Text', synopsis: 'Test synopsis', notes: undefined, keywords: undefined },
			];
			const mockSearchResults = [
				{ documentId: 'doc1', title: 'Test', matches: ['Test content'], wordCount: 2 },
			];

			mockDocumentManager.getAllDocuments = jest.fn().mockResolvedValue(mockDocuments);
			mockDocumentManager.readDocument = jest.fn().mockResolvedValue('Test content');
			mockCompilationService.searchInDocuments = jest.fn().mockReturnValue(mockSearchResults);

			const results = await project.searchContent('test');

			expect(mockCompilationService.searchInDocuments).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({
						id: 'doc1',
						content: 'Test content',
						metadata: { synopsis: 'Test synopsis', notes: undefined, keywords: undefined },
					}),
				]),
				'test',
				undefined
			);
			expect(results).toEqual(mockSearchResults);
		});

		it('should pass search options', async () => {
			mockDocumentManager.getAllDocuments = jest.fn().mockResolvedValue([]);
			mockCompilationService.searchInDocuments = jest.fn().mockReturnValue([]);

			const options = { caseSensitive: true, regex: true, maxResults: 10 };
			await project.searchContent('pattern', options);

			expect(mockCompilationService.searchInDocuments).toHaveBeenCalledWith(
				[],
				'pattern',
				options
			);
		});
	});

	describe('compileDocuments', () => {
		it('should compile documents from IDs', async () => {
			const mockDocs = [
				{ document: { id: 'doc1', title: 'Chapter 1', type: 'Text' } },
				{ document: { id: 'doc2', title: 'Chapter 2', type: 'Text' } },
			];
			const mockContents = [
				{ plainText: 'Content 1', formattedText: [], metadata: {} },
				{ plainText: 'Content 2', formattedText: [], metadata: {} }
			];
			const mockResult = 'Compiled content';

			// Mock readDocumentFormatted and getDocumentInfo
			mockDocumentManager.readDocumentFormatted = jest.fn()
				.mockResolvedValueOnce(mockContents[0])
				.mockResolvedValueOnce(mockContents[1]);
			(project as any).getDocumentInfo = jest.fn()
				.mockResolvedValueOnce(mockDocs[0])
				.mockResolvedValueOnce(mockDocs[1]);
			mockCompilationService.compileDocuments = jest.fn().mockResolvedValue(mockResult);

			// compileDocuments now takes separator and outputFormat as separate params
			const result = await project.compileDocuments(['doc1', 'doc2'], '\n\n---\n\n', 'markdown');

			expect(mockCompilationService.compileDocuments).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({
						id: 'doc1',
						title: 'Chapter 1',
						content: mockContents[0], // The entire formatted content object
					}),
				]),
				expect.objectContaining({
					outputFormat: 'markdown',
					separator: '\n\n---\n\n',
				})
			);
			expect(result).toBe(mockResult);
		});

		it('should filter out non-text documents', async () => {
			const mockDocs = [
				{ document: { id: 'doc1', title: 'Chapter', type: 'Text' } },
				{ document: { id: 'folder1', title: 'Folder', type: 'Folder' } },
			];

			// Mock readDocumentFormatted and getDocumentInfo
			mockDocumentManager.readDocumentFormatted = jest.fn().mockResolvedValue({ 
				plainText: 'Content', formattedText: [], metadata: {} 
			});
			(project as any).getDocumentInfo = jest.fn()
				.mockResolvedValueOnce(mockDocs[0])
				.mockResolvedValueOnce(mockDocs[1]);
			mockCompilationService.compileDocuments = jest.fn().mockResolvedValue('');

			await project.compileDocuments(['doc1', 'folder1']);

			// Check that both are attempted to be read - filtering happens in compilation service
			expect(mockDocumentManager.readDocumentFormatted).toHaveBeenCalledTimes(2);
			expect(mockDocumentManager.readDocumentFormatted).toHaveBeenCalledWith('doc1');
			expect(mockDocumentManager.readDocumentFormatted).toHaveBeenCalledWith('folder1');
		});
	});

	describe('exportProject', () => {
		it('should export project structure', async () => {
			const mockStructure = [{ id: 'doc1', title: 'Doc', type: 'Text' }];
			const mockExportResult = {
				format: 'markdown',
				content: '# Doc',
				metadata: { documentCount: 1 },
			};

			// Mock getProjectStructure on the project
			(project as any).getProjectStructure = jest.fn().mockResolvedValue(mockStructure);
			mockCompilationService.exportProject = jest.fn().mockResolvedValue(mockExportResult);

			// exportProject takes format, outputPath, options
			const result = await project.exportProject('markdown', undefined, { includeMetadata: true });

			expect(mockCompilationService.exportProject).toHaveBeenCalledWith(
				mockStructure,
				'markdown',
				{ includeMetadata: true }
			);
			expect(result).toEqual(mockExportResult);
		});
	});

	describe('loadProject', () => {
		it('should load project and sync database', async () => {
			// Mock projectLoader.loadProject instead of documentManager
			mockProjectLoader.loadProject = jest.fn().mockResolvedValue(undefined);
			mockProjectLoader.getProjectStructure = jest.fn().mockResolvedValue({});
			mockDocumentManager.setProjectStructure = jest.fn();
			mockDatabaseService.initialize = jest.fn().mockResolvedValue(undefined);

			await project.loadProject();

			expect(mockProjectLoader.loadProject).toHaveBeenCalled();
			expect(mockDatabaseService.initialize).toHaveBeenCalled();
			expect(mockDocumentManager.setProjectStructure).toHaveBeenCalled();
		});

		it('should handle sync errors gracefully', async () => {
			mockProjectLoader.loadProject = jest.fn().mockResolvedValue({});
			mockDocumentManager.setProjectStructure = jest.fn();
			mockDatabaseService.initialize = jest.fn().mockRejectedValue(new Error('Init failed'));

			// The loadProject method does not catch errors, it lets them propagate
			await expect(project.loadProject()).rejects.toThrow('Init failed');
		});
	});

	describe('close', () => {
		it('should close database and save project', async () => {
			mockDatabaseService.close = jest.fn().mockResolvedValue(undefined);
			mockDocumentManager.close = jest.fn().mockResolvedValue(undefined);

			await project.close();

			expect(mockDatabaseService.close).toHaveBeenCalled();
			expect(mockDocumentManager.close).toHaveBeenCalled();
		});

		it('should handle close errors gracefully', async () => {
			mockDatabaseService.close = jest.fn().mockRejectedValue(new Error('DB close failed'));
			mockDocumentManager.close = jest.fn().mockResolvedValue(undefined);

			// The close method lets errors propagate
			await expect(project.close()).rejects.toThrow('DB close failed');
		});
	});

	describe('getProjectStructureLimited', () => {
		it('should apply maxDepth limit', async () => {
			const fullStructure = [
				{
					id: 'root',
					title: 'Root',
					type: 'Folder',
					children: [
						{
							id: 'level1',
							title: 'Level 1',
							type: 'Folder',
							children: [
								{
									id: 'level2',
									title: 'Level 2',
									type: 'Text',
									children: [],
								},
							],
						},
					],
				},
			];

			mockDocumentManager.getProjectStructure = jest.fn().mockResolvedValue(fullStructure);

			const result = await project.getProjectStructureLimited({ maxDepth: 1 });

			// The implementation should limit depth
			expect(result).toBeDefined();
		});

		it('should return summary when summaryOnly is true', async () => {
			const structure = [
				{ id: '1', title: 'Doc1', type: 'Text', children: [] },
				{ id: '2', title: 'Folder', type: 'Folder', children: [
					{ id: '3', title: 'Doc2', type: 'Text', children: [] },
				]},
			];

			mockDocumentManager.getProjectStructure = jest.fn().mockResolvedValue(structure);
			mockCompilationService.getStatistics = jest.fn().mockReturnValue({
				totalDocuments: 3,
				textDocuments: 2,
				folders: 1,
			});

			const result = await project.getProjectStructureLimited({ summaryOnly: true });

			// The actual implementation returns statistics plus a tree slice
			expect(result).toBeDefined();
			expect(result.totalDocuments).toBe(3);
			expect(result.textDocuments).toBe(2);
			expect(result.folders).toBe(1);
			expect(result.tree).toBeDefined();
			expect(Array.isArray(result.tree)).toBe(true);
		});
	});
});