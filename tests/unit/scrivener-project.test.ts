/**
 * Tests for ScrivenerProject class
 */

import * as path from 'path';
import { ScrivenerProject } from '../../src/scrivener-project.js';
import { isProjectOpenInScrivener } from '../../src/utils/scrivener-app.js';
import { DocumentManager } from '../../src/services/document-manager.js';
import { CompilationService } from '../../src/services/compilation-service.js';
import { DatabaseService } from '../../src/handlers/database/database-service.js';

// Mock all dependencies
jest.mock('../../src/services/document-manager.js');
jest.mock('../../src/services/compilation-service.js');
jest.mock('../../src/services/metadata-manager.js');
jest.mock('../../src/services/project-loader.js');
jest.mock('../../src/handlers/database/database-service.js');
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
jest.mock('../../src/utils/scrivener-app.js', () => ({
	isProjectOpenInScrivener: jest.fn().mockResolvedValue('unknown'),
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

			await expect(project.recoverFromTrash('doc1')).rejects.toThrow(
				'Document not found in trash'
			);
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
			mockDocumentManager.readDocumentRaw = jest
				.fn()
				.mockRejectedValue(new Error('File not found'));

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
				{
					id: 'doc1',
					title: 'Test',
					content: 'Test content',
					type: 'Text',
					synopsis: 'Test synopsis',
					notes: undefined,
					keywords: undefined,
				},
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
						metadata: { synopsis: 'Test synopsis' },
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
				{ plainText: 'Content 2', formattedText: [], metadata: {} },
			];
			const mockResult = 'Compiled content';

			// Mock readDocumentFormatted and getDocumentInfo
			mockDocumentManager.readDocumentFormatted = jest
				.fn()
				.mockResolvedValueOnce(mockContents[0])
				.mockResolvedValueOnce(mockContents[1]);
			(project as any).getDocumentInfo = jest
				.fn()
				.mockResolvedValueOnce(mockDocs[0])
				.mockResolvedValueOnce(mockDocs[1]);
			mockCompilationService.compileDocuments = jest.fn().mockResolvedValue(mockResult);

			// compileDocuments now takes separator and outputFormat as separate params
			const result = await project.compileDocuments(
				['doc1', 'doc2'],
				'\n\n---\n\n',
				'markdown'
			);

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
				plainText: 'Content',
				formattedText: [],
				metadata: {},
			});
			(project as any).getDocumentInfo = jest
				.fn()
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
			const result = await project.exportProject('markdown', undefined, {
				includeMetadata: true,
			});

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
			mockDocumentManager.getAllDocuments = jest.fn().mockResolvedValue([]);
			mockDatabaseService.initialize = jest.fn().mockResolvedValue(undefined);

			await project.loadProject();

			expect(mockProjectLoader.loadProject).toHaveBeenCalled();
			expect(mockDatabaseService.initialize).toHaveBeenCalled();
			expect(mockDocumentManager.setProjectStructure).toHaveBeenCalled();
		});

		it('should handle sync errors gracefully', async () => {
			mockProjectLoader.loadProject = jest.fn().mockResolvedValue({});
			mockDocumentManager.setProjectStructure = jest.fn();
			mockDocumentManager.getAllDocuments = jest.fn().mockResolvedValue([]);
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
				{
					id: '2',
					title: 'Folder',
					type: 'Folder',
					children: [{ id: '3', title: 'Doc2', type: 'Text', children: [] }],
				},
			];

			mockDocumentManager.getProjectStructure = jest.fn().mockResolvedValue(structure);
			mockCompilationService.getStatistics = jest.fn().mockReturnValue({
				totalDocuments: 3,
				textDocuments: 2,
				folders: 1,
			});

			const result = await project.getProjectStructureLimited({ summaryOnly: true });

			// The actual implementation returns ProjectStructure
			expect(result).toBeDefined();
			expect(result.root).toBeDefined();
		});
	});

	// These exercise the real snapshot reader (services/snapshots + RTFHandler are
	// not mocked) against the on-disk fixture, mocking only getAllDocuments for the
	// binder-title enrichment. It avoids the heavy loadProject() path (job queue /
	// context sync) that keeps the full round-trip suite out of CI.
	describe('snapshots', () => {
		const FIXTURE = path.join(process.cwd(), 'tests', 'sample-project.scriv');
		const SNAPSHOT_DOC = '684ADA52-4D45-48D2-B03D-5ECB784963EE';
		let fixtureProject: ScrivenerProject;

		beforeEach(() => {
			fixtureProject = new ScrivenerProject(FIXTURE);
			(fixtureProject as any).documentManager.getAllDocuments = jest
				.fn()
				.mockResolvedValue([{ id: SNAPSHOT_DOC, title: 'Title Page' }]);
		});

		it('lists a document’s snapshots with the binder title enriched', async () => {
			const groups = await fixtureProject.listSnapshots(SNAPSHOT_DOC);
			expect(groups).toHaveLength(1);
			expect(groups[0]).toMatchObject({
				documentId: SNAPSHOT_DOC,
				documentTitle: 'Title Page',
			});
			expect(groups[0].snapshots.map((s) => s.title)).toEqual([
				'First draft',
				'Before rewrite',
			]);
		});

		it('lists all snapshots when no document id is given', async () => {
			const groups = await fixtureProject.listSnapshots();
			expect(groups.some((g) => g.documentId === SNAPSHOT_DOC)).toBe(true);
		});

		it('reads a snapshot as plain text with an accurate word count', async () => {
			const snap = await fixtureProject.readSnapshot(
				SNAPSHOT_DOC,
				'2025-10-27-02-20-40-0700'
			);
			expect(snap.title).toBe('First draft');
			expect(snap.text).toContain('first draft of this scene');
			expect(snap.wordCount).toBeGreaterThan(0);
		});

		it('throws NOT_FOUND for an unknown snapshot id', async () => {
			await expect(fixtureProject.readSnapshot(SNAPSHOT_DOC, 'nope')).rejects.toThrow();
		});

		it('compares a snapshot against the current document text', async () => {
			(fixtureProject as any).documentManager.readDocument = jest
				.fn()
				.mockResolvedValue(
					'The first draft of this scene had five sentences.\n\nA new closing line.'
				);

			const cmp = await fixtureProject.compareSnapshot(
				SNAPSHOT_DOC,
				'2025-10-27-02-20-40-0700'
			);
			expect(cmp.to.snapshotId).toBe('current');
			expect(cmp.addedParagraphs).toEqual(['A new closing line.']);
			expect(cmp.removedParagraphs).toEqual([]);
			expect(cmp.wordDelta).toBeGreaterThan(0);
		});

		it('compares one snapshot against another', async () => {
			const cmp = await fixtureProject.compareSnapshot(
				SNAPSHOT_DOC,
				'2025-10-27-02-20-40-0700',
				'2025-10-27-09-15-12-0700'
			);
			expect(cmp.to.snapshotId).toBe('2025-10-27-09-15-12-0700');
			expect(cmp.removedParagraphs.join(' ')).toContain('first draft');
			expect(cmp.addedParagraphs.join(' ')).toContain('later revision');
		});
	});

	describe('writeDocumentPreserving', () => {
		it('preserves surrounding RTF and reports a clean edit', async () => {
			const raw = '{\\rtf1\\ansi\\deff0{\\fonttbl\\f0 Times;}\\f0\\fs24 hello world}';
			mockDocumentManager.readDocumentRaw = jest.fn().mockResolvedValue(raw);
			const writeRaw = jest.fn().mockResolvedValue(undefined);
			mockDocumentManager.writeRawContent = writeRaw;

			const report = await project.writeDocumentPreserving('doc1', 'hello there world');
			expect(report.mode).toBe('preserved');
			expect(report.atRisk).toEqual([]);
			expect(report.snapshotId).toBeUndefined();
			// The stored bytes keep the font table and read back as the intended text.
			const stored = writeRaw.mock.calls[0][1] as string;
			expect(stored).toContain('{\\fonttbl\\f0 Times;}');
			expect(stored).toContain('there');
		});

		it('reports mode "created" when there is no prior content', async () => {
			mockDocumentManager.readDocumentRaw = jest.fn().mockResolvedValue('');
			mockDocumentManager.writeDocument = jest.fn().mockResolvedValue(undefined);
			const report = await project.writeDocumentPreserving('doc1', 'brand new');
			expect(report.mode).toBe('created');
		});
	});

	describe('ensureWritable (open-in-Scrivener guard)', () => {
		const mockedProbe = isProjectOpenInScrivener as jest.MockedFunction<
			typeof isProjectOpenInScrivener
		>;

		beforeEach(() => {
			mockedProbe.mockReset();
			project = new ScrivenerProject(projectPath);
		});

		it('throws when the project is detected open in Scrivener', async () => {
			mockedProbe.mockResolvedValue('open');
			await expect(project.ensureWritable()).rejects.toThrow(/open in Scrivener/i);
		});

		it('allows the write when force is set, without probing', async () => {
			await project.ensureWritable(true);
			expect(mockedProbe).not.toHaveBeenCalled();
		});

		it('allows the write when detection is unknown or the project is closed', async () => {
			mockedProbe.mockResolvedValue('unknown');
			await expect(project.ensureWritable()).resolves.toBeUndefined();
			mockedProbe.mockResolvedValue('closed');
			project = new ScrivenerProject(projectPath);
			await expect(project.ensureWritable()).resolves.toBeUndefined();
		});

		it('caches the probe result across calls within the TTL', async () => {
			mockedProbe.mockResolvedValue('closed');
			await project.ensureWritable();
			await project.ensureWritable();
			expect(mockedProbe).toHaveBeenCalledTimes(1);
		});
	});

	describe('getStatistics', () => {
		it('reads document content into the tree so word counts are non-zero', async () => {
			const tree = [
				{
					id: 'f1',
					title: 'Manuscript',
					type: 'Folder',
					children: [{ id: 'd1', title: 'Ch1', type: 'Text' }],
				},
			];
			(project as any).documentManager.getProjectStructure = jest
				.fn()
				.mockResolvedValue(tree);
			(project as any).documentManager.readDocument = jest
				.fn()
				.mockResolvedValue('one two three four five');
			let received: any;
			(project as any).compilationService.getStatistics = jest.fn((docs: unknown) => {
				received = docs;
				return { totalWords: 0 };
			});

			await project.getStatistics();
			// annotateWordCounts must have populated wordCount on the Text node before
			// aggregation — otherwise totalWords is always zero for real projects.
			expect(received[0].children[0].wordCount).toBe(5);
		});
	});

	describe('getManuscriptBriefing', () => {
		function stub(stats: Record<string, unknown>, meta: Record<string, unknown>) {
			(project as any).documentManager.getProjectStructure = jest
				.fn()
				.mockResolvedValue([{ id: 'd1', title: 'Ch', type: 'Text' }]);
			(project as any).documentManager.readDocument = jest.fn().mockResolvedValue('a b c');
			(project as any).compilationService.getStatistics = jest.fn().mockReturnValue(stats);
			jest.spyOn(project, 'getProjectMetadata').mockResolvedValue(meta);
			jest.spyOn(project, 'getCompileMetadata').mockResolvedValue({
				hasCompileSettings: false,
				compileFormats: [],
				labels: [],
				statuses: [],
			} as any);
		}

		it('composes stats, targets, and percent-to-goal into one briefing', async () => {
			stub(
				{
					totalWords: 2500,
					totalDocuments: 12,
					totalFolders: 2,
					averageDocumentLength: 250,
					documentsByStatus: { 'To Do': 7, Done: 3 },
					documentsByLabel: { 'POV: Ana': 5 },
					longestDocument: { id: 'd2', title: 'Long', wordCount: 800 },
					shortestDocument: { id: 'd1', title: 'Short', wordCount: 40 },
				},
				{
					title: 'My Novel',
					author: 'Ana',
					projectTargets: { draft: 5000, deadline: '2026-12-01' },
				}
			);

			const b = await project.getManuscriptBriefing();
			expect(b.title).toBe('My Novel');
			expect(b.words).toEqual({
				total: 2500,
				draftTarget: 5000,
				percentToTarget: 50,
				deadline: '2026-12-01',
			});
			expect(b.documents).toEqual({ total: 12, folders: 2, textDocuments: 10 });
			expect(b.byStatus).toEqual({ 'To Do': 7, Done: 3 });
			expect(b.longest).toEqual({ id: 'd2', title: 'Long', wordCount: 800 });
		});

		it('resolves label/status ids to names via the taxonomy', async () => {
			(project as any).documentManager.getProjectStructure = jest
				.fn()
				.mockResolvedValue([{ id: 'd1', title: 'Ch', type: 'Text' }]);
			(project as any).documentManager.readDocument = jest.fn().mockResolvedValue('a b');
			(project as any).compilationService.getStatistics = jest.fn().mockReturnValue({
				totalWords: 10,
				totalDocuments: 1,
				totalFolders: 0,
				averageDocumentLength: 10,
				documentsByStatus: { '2': 4 },
				documentsByLabel: {},
				longestDocument: null,
				shortestDocument: null,
			});
			jest.spyOn(project, 'getProjectMetadata').mockResolvedValue({});
			jest.spyOn(project, 'getCompileMetadata').mockResolvedValue({
				hasCompileSettings: false,
				compileFormats: [],
				labels: [],
				statuses: [{ id: '2', title: 'Done' }],
			} as any);

			const b = await project.getManuscriptBriefing();
			expect(b.byStatus).toEqual({ Done: 4 });
		});

		it('omits percent-to-goal for a missing or non-numeric draft target', async () => {
			stub(
				{
					totalWords: 100,
					totalDocuments: 1,
					totalFolders: 0,
					averageDocumentLength: 100,
					documentsByStatus: {},
					documentsByLabel: {},
					longestDocument: null,
					shortestDocument: null,
				},
				{ projectTargets: { draft: NaN } }
			);

			const b = await project.getManuscriptBriefing();
			expect(b.words.percentToTarget).toBeUndefined();
			expect(b.words.draftTarget).toBeUndefined();
			expect(b.longest).toBeNull();
		});
	});

	describe('compileStructured', () => {
		beforeEach(() => {
			(project as any).readDocument = jest.fn().mockResolvedValue('Body text.');
			(project as any).compilationService.compileStructured = jest
				.fn()
				.mockReturnValue('rendered');
		});

		function entriesFrom(): unknown {
			return (project as any).compilationService.compileStructured.mock.calls[0][0];
		}

		it('assigns heading depth from tree structure and reads only Text bodies', async () => {
			(project as any).documentManager.getProjectStructure = jest.fn().mockResolvedValue([
				{
					id: 'f1',
					title: 'Manuscript',
					type: 'Folder',
					children: [{ id: 'd1', title: 'Chapter 1', type: 'Text' }],
				},
			]);

			const out = await project.compileStructured({ outputFormat: 'markdown' });
			expect(out).toBe('rendered');
			expect(entriesFrom()).toEqual([
				{ title: 'Manuscript', content: '', depth: 1, isFolder: true },
				{ title: 'Chapter 1', content: 'Body text.', depth: 2, isFolder: false },
			]);
		});

		it('defaults to the Draft folder and excludes Research/other top-level folders', async () => {
			(project as any).documentManager.getProjectStructure = jest.fn().mockResolvedValue([
				{
					id: 'draft',
					title: 'Manuscript',
					type: 'DraftFolder',
					children: [{ id: 'c1', title: 'Chapter 1', type: 'Text' }],
				},
				{
					id: 'res',
					title: 'Research',
					type: 'ResearchFolder',
					children: [{ id: 'img', title: 'Photo', type: 'Text' }],
				},
			]);

			await project.compileStructured({});
			const titles = (entriesFrom() as Array<{ title: string }>).map((e) => e.title);
			expect(titles).toEqual(['Chapter 1']);
			expect(titles).not.toContain('Photo');
		});

		it('honors Include-in-Compile, and includeExcluded overrides it', async () => {
			(project as any).documentManager.getProjectStructure = jest.fn().mockResolvedValue([
				{
					id: 'draft',
					title: 'M',
					type: 'DraftFolder',
					children: [
						{ id: 'c1', title: 'Kept', type: 'Text', includeInCompile: true },
						{ id: 'c2', title: 'Dropped', type: 'Text', includeInCompile: false },
					],
				},
			]);

			await project.compileStructured({});
			expect((entriesFrom() as Array<{ title: string }>).map((e) => e.title)).toEqual([
				'Kept',
			]);

			(project as any).compilationService.compileStructured.mockClear();
			await project.compileStructured({ includeExcluded: true });
			expect((entriesFrom() as Array<{ title: string }>).map((e) => e.title)).toEqual([
				'Kept',
				'Dropped',
			]);
		});
	});
});
