import {
	describe,
	it,
	expect,
	beforeAll,
	afterAll,
	beforeEach,
	afterEach,
	jest,
} from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	generateScrivenerUUID,
	parseMetadata,
	findBinderItem,
} from '../../src/utils/scrivener-utils.js';
import {
	ensureProjectDataDirectory,
	getQueueStatePath,
	getCacheDirectory,
} from '../../src/utils/project-utils.js';
import { isTransientDatabaseError, toDatabaseError } from '../../src/utils/database.js';
import { ApplicationError as AppError, ErrorCode } from '../../src/core/errors.js';
import type { BinderContainer } from '../../src/types/internal.js';

// Mock logger to keep test output quiet; logging is not the behavior under test.
jest.mock('../../src/core/logger.js', () => ({
	Logger: jest.fn(() => ({
		info: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
		warn: jest.fn(),
	})),
	getLogger: jest.fn(() => ({
		info: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
		warn: jest.fn(),
	})),
}));

/**
 * Create a minimal real directory that satisfies isScrivenerProject(): it just
 * needs a file with a .scrivx extension for findScrivxPath() to discover.
 */
async function createFixtureProjectDir(root: string, name: string): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, `${name}.scrivx`),
		'<?xml version="1.0" encoding="UTF-8"?><ScrivenerProject Version="1.0"/>',
		'utf-8'
	);
	return dir;
}

describe('Utility Adoption Workflow Integration', () => {
	let tmpRoot: string;
	let mockProject: any;
	let mockContext: any;

	beforeAll(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-utility-adoption-'));
	});

	afterAll(async () => {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	beforeEach(() => {
		mockProject = {
			projectPath: '/test/project',
			getAllDocuments: (jest.fn() as any).mockResolvedValue([
				{
					id: generateScrivenerUUID(),
					content: 'Chapter 1 content',
					title: 'Chapter 1',
					type: 'Text',
					path: 'Manuscript/Chapter 1',
					metadata: {
						Title: 'Chapter 1',
						Synopsis: 'Opening chapter',
					},
				},
				{
					id: generateScrivenerUUID(),
					content: 'Chapter 2 content',
					title: 'Chapter 2',
					type: 'Text',
					path: 'Manuscript/Chapter 2',
					metadata: {
						Title: 'Chapter 2',
						Synopsis: 'Second chapter',
					},
				},
			]),
			getDocument: jest.fn(),
			compileDocuments: (jest.fn() as any).mockResolvedValue('Fallback compiled content'),
			getProjectMetadata: (jest.fn() as any).mockResolvedValue({
				title: 'Test Novel',
				author: 'Test Author',
			}),
			getStatistics: (jest.fn() as any).mockResolvedValue({
				documentCount: 2,
				wordCount: 1000,
				characterCount: 5000,
			}),
		};

		mockContext = {
			project: mockProject,
		};

		jest.clearAllMocks();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('End-to-End Utility Integration', () => {
		it('should demonstrate complete utility adoption workflow', async () => {
			// Step 1: Generate consistent UUIDs for all documents
			const documents = await mockProject.getAllDocuments();
			expect(documents).toHaveLength(2);

			// Verify UUIDs are properly formatted
			documents.forEach((doc: any) => {
				expect(doc.id).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
				);
			});

			// Step 2: Parse metadata using utility function
			// In a real scenario, this might come from a raw string or MetaDataItem array
			const rawMetadata = 'Title: Chapter 1\nSynopsis: Opening chapter';
			const parsedMeta = parseMetadata(rawMetadata);

			expect(parsedMeta.Title).toBe('Chapter 1');
			expect(parsedMeta.Synopsis).toBe('Opening chapter');

			// Step 3: Setup project directories using project utilities, against a real
			// directory that satisfies isScrivenerProject() (ensureProjectDataDirectory
			// rejects paths that aren't real Scrivener projects).
			const projectPath = await createFixtureProjectDir(tmpRoot, 'test-project');
			const dataDir = await ensureProjectDataDirectory(projectPath);
			const cacheDir = getCacheDirectory(projectPath);
			const queuePath = getQueueStatePath(projectPath);

			expect(dataDir).toBe(`${projectPath}/.scrivener-mcp`);
			expect(cacheDir).toBe(`${projectPath}/.scrivener-mcp/cache`);
			expect(queuePath).toBe(`${projectPath}/.scrivener-mcp/queue-state.json`);

			// Step 4: Find binder items using utility. findBinderItem() operates on the
			// raw parsed-XML shape: a container with a BinderItem array, items keyed by
			// UUID, and nested containers under Children.
			const binderStructure: BinderContainer = {
				BinderItem: [
					{
						UUID: documents[0].id,
						Title: 'Chapter 1',
						Type: 'Text',
					},
					{
						UUID: 'manuscript',
						Title: 'Manuscript',
						Type: 'Folder',
						Children: {
							BinderItem: [
								{
									UUID: documents[1].id,
									Title: 'Chapter 2',
									Type: 'Text',
								},
							],
						},
					},
				],
			};

			const foundItem = findBinderItem(binderStructure, documents[1].id);
			expect(foundItem).toBeDefined();
			expect(foundItem?.Title).toBe('Chapter 2');

			// Step 5: Demonstrate error handling integration. Per the documented
			// transient-error policy (src/utils/database.ts), only TIMEOUT, LOCK, and
			// TRANSACTION classifications are retried; connection/service errors are not.
			const dbError = new Error('Database connection failed') as any;
			dbError.code = 'ServiceUnavailable';

			const isTransient = isTransientDatabaseError(dbError);
			expect(isTransient).toBe(false);

			const appError = toDatabaseError(dbError, 'test operation');
			expect(appError).toBeInstanceOf(AppError);
			expect(appError.code).toBe(ErrorCode.CONNECTION_ERROR);
			expect(appError.message).toContain('test operation');
		});

		it('should handle error propagation through utility chain', async () => {
			// Simulate error at different levels of the utility chain

			// Level 1: UUID generation (should not fail under normal circumstances)
			const uuid1 = generateScrivenerUUID();
			const uuid2 = generateScrivenerUUID();
			expect(uuid1).not.toBe(uuid2);

			// Level 2: Metadata parsing with invalid data
			const invalidMetadata = 'Invalid\nFormat\nWithout\nColons';
			const parsed = parseMetadata(invalidMetadata);
			expect(parsed).toEqual({}); // Should handle gracefully

			// Level 3: Binder search with invalid structure
			const invalidBinder = null as any;
			const foundItem = findBinderItem(invalidBinder, 'any-id');
			expect(foundItem).toBeNull();

			// Level 4: Database error handling. "timeout" classifies as TIMEOUT, which
			// is both transient and mapped to TIMEOUT_ERROR (a more specific code than
			// the generic DATABASE_ERROR).
			const networkError = new Error('Network timeout');
			const isTransient = isTransientDatabaseError(networkError);
			expect(isTransient).toBe(true); // Should identify timeout as transient

			const convertedError = toDatabaseError(networkError, 'network operation');
			expect(convertedError).toBeInstanceOf(AppError);
			expect(convertedError.code).toBe(ErrorCode.TIMEOUT_ERROR);
		});

		it('should demonstrate caching workflow with utilities', async () => {
			const projectPath = '/test/project';

			// Setup cache directory using project utilities
			const cacheDir = getCacheDirectory(projectPath);
			expect(cacheDir).toBe(`${projectPath}/.scrivener-mcp/cache`);

			// Generate cache keys using UUID utility
			const cacheKey1 = generateScrivenerUUID();
			const cacheKey2 = generateScrivenerUUID();

			expect(cacheKey1).not.toBe(cacheKey2);
			expect(cacheKey1).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
			);

			// Simulate cache entry metadata parsing
			const cacheMetadata =
				'CacheKey: test-key\nTimestamp: 2024-01-01T00:00:00Z\nExpiry: 3600';
			const parsedCache = parseMetadata(cacheMetadata as any);

			expect(parsedCache.CacheKey).toBe('test-key');
			expect(parsedCache.Timestamp).toBe('2024-01-01T00:00:00Z');
			expect(parsedCache.Expiry).toBe('3600');
		});

		it('should handle concurrent utility operations', async () => {
			// Simulate concurrent UUID generation (should be thread-safe)
			const concurrentUUIDs = await Promise.all([
				generateScrivenerUUID(),
				generateScrivenerUUID(),
				generateScrivenerUUID(),
				generateScrivenerUUID(),
				generateScrivenerUUID(),
			]);

			// All UUIDs should be unique
			const uniqueUUIDs = new Set(concurrentUUIDs);
			expect(uniqueUUIDs.size).toBe(5);

			// Concurrent metadata parsing
			const metadataInputs = [
				'Title: Doc1\nAuthor: Author1',
				'Title: Doc2\nAuthor: Author2',
				'Title: Doc3\nAuthor: Author3',
			];

			const parsedResults = await Promise.all(
				metadataInputs.map((metadata) => Promise.resolve(parseMetadata(metadata as any)))
			);

			expect(parsedResults).toHaveLength(3);
			expect(parsedResults[0].Title).toBe('Doc1');
			expect(parsedResults[1].Title).toBe('Doc2');
			expect(parsedResults[2].Title).toBe('Doc3');

			// Concurrent directory operations
			const projectPaths = ['/project1', '/project2', '/project3'];
			const cacheDirs = await Promise.all(
				projectPaths.map((path) => Promise.resolve(getCacheDirectory(path)))
			);

			expect(cacheDirs).toEqual([
				'/project1/.scrivener-mcp/cache',
				'/project2/.scrivener-mcp/cache',
				'/project3/.scrivener-mcp/cache',
			]);
		});

		it('should validate complete utility integration in real workflow', async () => {
			// This test simulates a complete workflow from document creation to compilation

			// Step 1: Create project structure using utilities, against a real directory
			// that satisfies isScrivenerProject().
			const projectPath = await createFixtureProjectDir(tmpRoot, 'novel-project');
			const dataDir = await ensureProjectDataDirectory(projectPath);

			// Step 2: Generate document IDs using utility
			const chapterIds = [
				generateScrivenerUUID(),
				generateScrivenerUUID(),
				generateScrivenerUUID(),
			];

			// Step 3: Create documents with metadata
			const chapters = chapterIds.map((id, index) => ({
				id,
				title: `Chapter ${index + 1}`,
				content: `Content of chapter ${index + 1}`,
				metadata: {
					Title: `Chapter ${index + 1}`,
					WordCount: `${500 + index * 100}`,
					Status: 'Draft',
				},
			}));

			// Step 4: Parse metadata using the utility's documented "Key: Value" string
			// format (parseMetadata treats a plain object as a single MetaDataItem and
			// looks for an ID/Value pair, not arbitrary keys).
			const chaptersWithParsedMeta = chapters.map((chapter) => ({
				...chapter,
				parsedMeta: parseMetadata(
					Object.entries(chapter.metadata)
						.map(([key, value]) => `${key}: ${value}`)
						.join('\n')
				),
			}));

			// Verify metadata parsing worked correctly
			chaptersWithParsedMeta.forEach((chapter, index) => {
				expect(chapter.parsedMeta.Title).toBe(`Chapter ${index + 1}`);
				expect(chapter.parsedMeta.WordCount).toBe(`${500 + index * 100}`);
				expect(chapter.parsedMeta.Status).toBe('Draft');
			});

			// Step 5: Create binder structure and test navigation
			const binderStructure: BinderContainer = {
				BinderItem: [
					{
						UUID: 'manuscript',
						Title: 'Manuscript',
						Type: 'Folder',
						Children: {
							BinderItem: chaptersWithParsedMeta.map((chapter) => ({
								UUID: chapter.id,
								Title: chapter.title,
								Type: 'Text',
							})),
						},
					},
				],
			};

			// Test finding each chapter in the binder
			chaptersWithParsedMeta.forEach((chapter) => {
				const found = findBinderItem(binderStructure, chapter.id);
				expect(found).toBeDefined();
				expect(found?.Title).toBe(chapter.title);
			});

			// Step 6: Simulate error handling during processing. "Network timeout"
			// classifies as TIMEOUT (a specific code); the other two fall through to
			// the generic DATABASE_ERROR classification.
			const processingErrors = [
				{
					error: new Error('Network timeout'),
					operation: 'save_document',
					expectedCode: ErrorCode.TIMEOUT_ERROR,
				},
				{
					error: new Error('Disk full'),
					operation: 'cache_write',
					expectedCode: ErrorCode.DATABASE_ERROR,
				},
				{
					error: new Error('Permission denied'),
					operation: 'file_access',
					expectedCode: ErrorCode.DATABASE_ERROR,
				},
			];

			processingErrors.forEach(({ error, operation, expectedCode }) => {
				const appError = toDatabaseError(error, operation);
				expect(appError).toBeInstanceOf(AppError);
				expect(appError.message).toContain(operation);
				expect(appError.code).toBe(expectedCode);
			});

			// Step 7: Verify queue state path utility
			const queuePath = getQueueStatePath(projectPath);
			expect(queuePath).toBe(`${projectPath}/.scrivener-mcp/queue-state.json`);

			// Step 8: Verify cache directory utility
			const cacheDir = getCacheDirectory(projectPath);
			expect(cacheDir).toBe(`${projectPath}/.scrivener-mcp/cache`);

			// All utilities worked together successfully
			expect(dataDir).toBe(`${projectPath}/.scrivener-mcp`);
			expect(chaptersWithParsedMeta).toHaveLength(3);
			expect(chapterIds).toHaveLength(3);
			expect(chapterIds.every((id) => id.match(/^[0-9a-f-]{36}$/i))).toBe(true);
		});
	});

	describe('Performance and Reliability', () => {
		it('should handle large-scale utility operations efficiently', async () => {
			const startTime = Date.now();

			// Generate 1000 UUIDs
			const uuids = [];
			for (let i = 0; i < 1000; i++) {
				uuids.push(generateScrivenerUUID());
			}

			// Parse 1000 metadata strings
			const metadataStrings = Array(1000)
				.fill(0)
				.map((_, i) => `Title: Document ${i}\nAuthor: Author ${i}\nWordCount: ${i * 100}`);
			const parsedMeta = metadataStrings.map((m) => parseMetadata(m as any));

			const endTime = Date.now();
			const duration = endTime - startTime;

			// Should complete within reasonable time (adjust as needed)
			expect(duration).toBeLessThan(5000); // 5 seconds

			// Verify all operations completed correctly
			expect(new Set(uuids).size).toBe(1000); // All UUIDs unique
			expect(parsedMeta).toHaveLength(1000);
			expect(parsedMeta[999].Title).toBe('Document 999');
		});

		it('should maintain data integrity across utility operations', async () => {
			// Create test data
			const originalData = {
				id: generateScrivenerUUID(),
				metadata: 'Title: Test Document\nAuthor: Test Author\nGenre: Fiction',
				projectPath: await createFixtureProjectDir(tmpRoot, 'integrity-check'),
			};

			// Process through utility chain
			const parsedMeta = parseMetadata(originalData.metadata as any);
			const dataDir = await ensureProjectDataDirectory(originalData.projectPath);
			const cacheDir = getCacheDirectory(originalData.projectPath);

			// Verify data integrity
			expect(originalData.id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
			);
			expect(parsedMeta.Title).toBe('Test Document');
			expect(parsedMeta.Author).toBe('Test Author');
			expect(parsedMeta.Genre).toBe('Fiction');
			expect(dataDir).toBe(`${originalData.projectPath}/.scrivener-mcp`);
			expect(cacheDir).toBe(`${originalData.projectPath}/.scrivener-mcp/cache`);

			// Create binder and verify navigation
			const binderItem = {
				UUID: originalData.id,
				Title: parsedMeta.Title,
				Type: 'Text',
			};

			const found = findBinderItem({ BinderItem: [binderItem] }, originalData.id);
			expect(found).toEqual(binderItem);
		});
	});
});
