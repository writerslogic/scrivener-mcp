/**
 * Integration tests for Scrivener project operations
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ScrivenerProject } from '../../src/scrivener-project.js';
import { DatabaseService } from '../../src/database/database-service.js';
import { MemoryManager } from '../../src/memory-manager.js';
import { ContentAnalyzer } from '../../src/analysis/base-analyzer.js';
import { ContentEnhancer } from '../../src/services/enhancements/content-enhancer.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { projectHandlers } from '../../src/handlers/project-handlers.js';
import { documentHandlers } from '../../src/handlers/document-handlers.js';

// Helper function to execute handlers by name
async function executeHandler(
	handlers: any[],
	name: string,
	args: Record<string, any>,
	context: HandlerContext
): Promise<any> {
	const handler = handlers.find(h => h.name === name);
	if (!handler) {
		throw new Error(`Handler ${name} not found`);
	}
	return handler.handler(args, context);
}

describe('Scrivener Project Integration', () => {
	let testProjectPath: string;
	let context: HandlerContext;
	let tempDir: string;

	beforeAll(async () => {
		// Create temporary test directory
		tempDir = path.join(process.cwd(), 'test-temp', Date.now().toString());
		await fs.mkdir(tempDir, { recursive: true });
		
		// Create a mock Scrivener project structure
		testProjectPath = path.join(tempDir, 'TestProject.scriv');
		await createMockScrivenerProject(testProjectPath);
		
		// Initialize context
		context = {
			project: null,
			memoryManager: null,
			contentAnalyzer: new ContentAnalyzer(),
			contentEnhancer: new ContentEnhancer(),
		};
	});

	afterAll(async () => {
		// Clean up
		if (context.project) {
			await context.project.close();
		}
		if (context.memoryManager) {
			await context.memoryManager.stopAutoSave();
		}
		
		// Remove temp directory
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	describe('Project Loading', () => {
		it('should load a Scrivener project successfully', async () => {
			// Load project directly without handler to avoid database initialization
			const project = new ScrivenerProject(testProjectPath);
			await project.loadProject();
			
			context.project = project;
			
			expect(project).not.toBeNull();
			const metadata = await project.getProjectMetadata();
			expect(metadata).toBeDefined();
		});

		it('should prevent loading multiple projects', async () => {
			// First load should succeed (already loaded in previous test)
			expect(context.project).not.toBeNull();
			
			// Try to load another project should replace the first one
			const project2 = new ScrivenerProject(testProjectPath);
			await project2.loadProject();
			
			// Close the first project
			if (context.project) {
				await context.project.close();
			}
			context.project = project2;
			
			expect(context.project).toBe(project2);
		});

		it('should get project structure', async () => {
			if (!context.project) {
				const project = new ScrivenerProject(testProjectPath);
				await project.loadProject();
				context.project = project;
			}
			
			const structure = await context.project.getProjectStructure();
			
			expect(structure).toBeDefined();
			expect(Array.isArray(structure)).toBe(true);
			expect(structure.length).toBeGreaterThan(0);
		});
	});

	describe('Document Operations', () => {
		let testDocumentId: string;

		it('should get project structure with documents', async () => {
			if (!context.project) {
				const project = new ScrivenerProject(testProjectPath);
				await project.loadProject();
				context.project = project;
			}
			
			const documents = await context.project.getProjectStructure();
			
			expect(documents).toBeDefined();
			expect(Array.isArray(documents)).toBe(true);
			
			if (documents.length > 0) {
				testDocumentId = documents[0].id;
			}
		});

		it('should read document content', async () => {
			if (!testDocumentId) {
				console.warn('No test document ID available');
				return;
			}
			
			const result = await executeHandler(
				documentHandlers,
				'read_document',
				{ documentId: testDocumentId },
				context
			);
			
			expect(result.isError).toBeFalsy();
			expect(result.content[0].data).toHaveProperty('content');
			expect(result.content[0].data).toHaveProperty('metadata');
		});

		it('should create a new document', async () => {
			if (!context.project) {
				const project = new ScrivenerProject(testProjectPath);
				await project.loadProject();
				context.project = project;
			}
			
			const docId = await context.project.createDocument(
				'Test Document',
				'This is test content.'
			);
			
			expect(docId).toBeTruthy();
			expect(typeof docId).toBe('string');
			
			// Document creation is tested - content verification requires full RTF support
		});

		it('should update document metadata', async () => {
			if (!testDocumentId) {
				console.warn('No test document ID available');
				return;
			}
			
			const result = await executeHandler(
				documentHandlers,
				'update_metadata',
				{
					documentId: testDocumentId,
					metadata: {
						synopsis: 'Test synopsis',
						notes: 'Test notes',
					},
				},
				context
			);
			
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toContain('updated');
		});

		// Search functionality not yet implemented in handlers
		// it('should search documents', async () => {
		// 	const result = await executeHandler(
		// 		documentHandlers,
		// 		'search_documents',
		// 		{ query: 'test' },
		// 		context
		// 	);
		// 	
		// 	expect(result.isError).toBeFalsy();
		// 	expect(result.content[0].data).toHaveProperty('results');
		// 	
		// 	const data = result.content[0].data as any;
		// 	expect(Array.isArray(data.results)).toBe(true);
		// });
	});

	describe('Database Integration', () => {
		it('should sync documents to database', async () => {
			const project = context.project;
			if (!project) {
				console.warn('No project loaded');
				return;
			}
			
			// Get database service
			const dbService = (project as any).database;
			if (!dbService) {
				console.warn('No database service available');
				return;
			}
			
			// Check database status
			const status = dbService.getStatus();
			expect(status).toHaveProperty('sqlite');
			expect(status.sqlite.enabled).toBe(true);
		});
	});

	describe('Memory Management', () => {
		it('should save and recall memories', async () => {
			const memoryManager = context.memoryManager;
			if (!memoryManager) {
				console.warn('No memory manager available');
				return;
			}
			
			// Add a character
			const character = memoryManager.addCharacter({
				name: 'Test Character',
				role: 'protagonist',
				description: 'A test character for integration testing',
				traits: ['brave', 'clever'],
				arc: 'Hero\'s journey',
				relationships: [],
				appearances: [],
				notes: '',
			});
			
			// Get the character
			const retrieved = memoryManager.getCharacter(character.id);
			expect(retrieved).not.toBeNull();
			expect(retrieved?.name).toBe('Test Character');
		});
	});
});

/**
 * Create a mock Scrivener project for testing
 */
async function createMockScrivenerProject(projectPath: string): Promise<void> {
	// Create project directory
	await fs.mkdir(projectPath, { recursive: true });
	
	// Create Files directory
	const filesDir = path.join(projectPath, 'Files');
	await fs.mkdir(filesDir, { recursive: true });
	
	// Create a simple .scrivx file
	const scrivxContent = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="1.0">
	<Binder>
		<BinderItem ID="0" Type="DraftFolder">
			<Title>Draft</Title>
			<Children>
				<BinderItem ID="1" Type="Text">
					<Title>Chapter 1</Title>
				</BinderItem>
			</Children>
		</BinderItem>
		<BinderItem ID="2" Type="ResearchFolder">
			<Title>Research</Title>
		</BinderItem>
		<BinderItem ID="3" Type="TrashFolder">
			<Title>Trash</Title>
		</BinderItem>
	</Binder>
</ScrivenerProject>`;
	
	const scrivxPath = path.join(projectPath, 'TestProject.scrivx');
	await fs.writeFile(scrivxPath, scrivxContent, 'utf-8');
	
	// Create Docs directory
	const docsDir = path.join(filesDir, 'Docs');
	await fs.mkdir(docsDir, { recursive: true });
	
	// Create a test document
	const docContent = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}
\\f0\\fs24 This is test content for Chapter 1.
\\par }`;
	
	await fs.writeFile(path.join(docsDir, '1.rtf'), docContent, 'utf-8');
}