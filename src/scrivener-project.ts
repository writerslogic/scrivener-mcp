/**
 * Scrivener Project class using modular services
 */

import * as path from 'path';
import { DatabaseService } from './database/index.js';
import { ContentAnalyzer, ContextAnalyzer } from './analysis/index.js';
import { ContextSyncService } from './sync/context-sync.js';
import { CleanupManager } from './utils/common.js';
import { ensureProjectDataDirectory } from './utils/project-utils.js';
import { getLogger } from './core/logger.js';
import { createError, ErrorCode } from './core/errors.js';
import { DOCUMENT_TYPES } from './core/constants.js';
import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';

// Import service modules
import { DocumentManager } from './services/document-manager.js';
import { ProjectLoader } from './services/project-loader.js';
import { CompilationService } from './services/compilation-service.js';
import { MetadataManager } from './services/metadata-manager.js';

import type { RTFContent } from './services/parsers/rtf-handler.js';
import type { ScrivenerDocument, ScrivenerMetadata } from './types/index.js';

const logger = getLogger('scrivener-project');

export interface ScrivenerProjectOptions {
	autoSave?: boolean;
	autoBackup?: boolean;
	cacheSize?: number;
	syncInterval?: number;
}

export class ScrivenerProject {
	private projectPath: string;
	private documentManager: DocumentManager;
	private projectLoader: ProjectLoader;
	private compilationService: CompilationService;
	private metadataManager: MetadataManager;
	private databaseService: DatabaseService;
	private contentAnalyzer: ContentAnalyzer;
	private contextAnalyzer?: ContextAnalyzer;
	private contextSync?: ContextSyncService;
	private cleanupManager: CleanupManager;
	private options: ScrivenerProjectOptions;

	constructor(projectPath: string, options: ScrivenerProjectOptions = {}) {
		this.projectPath = path.resolve(projectPath);
		this.options = {
			autoSave: false,
			autoBackup: false,
			cacheSize: 50,
			syncInterval: 30000,
			...options,
		};

		// Initialize services
		this.documentManager = new DocumentManager(this.projectPath);
		this.projectLoader = new ProjectLoader(this.projectPath, {
			autoBackup: this.options.autoBackup,
		});
		this.compilationService = new CompilationService();
		this.metadataManager = new MetadataManager();
		this.databaseService = new DatabaseService(this.projectPath);
		this.contentAnalyzer = new ContentAnalyzer();
		this.cleanupManager = new CleanupManager();

		// Register cleanup
		this.cleanupManager.register(async () => {
			await this.close();
		});
	}

	/**
	 * Load the project
	 */
	async loadProject(): Promise<void> {
		logger.info('Loading Scrivener project');

		// Create .scrivener-mcp directory for project-specific data
		await ensureProjectDataDirectory(this.projectPath);

		// Load project structure
		const structure = await this.projectLoader.loadProject();
		this.documentManager.setProjectStructure(structure);

		// Initialize database
		await this.databaseService.initialize();

		// Initialize async services (job queue, AI services)
		await initializeAsyncServices({
			projectPath: this.projectPath,
			databasePath: path.join(this.projectPath, 'scrivener.db'),
			openaiApiKey: process.env.OPENAI_API_KEY,
		});

		// Initialize enhanced services
		this.contextAnalyzer = new ContextAnalyzer(this.databaseService, this.contentAnalyzer);

		this.contextSync = new ContextSyncService(
			this.projectPath,
			this.databaseService,
			this.contextAnalyzer,
			{
				autoSync: true,
				syncInterval: this.options.syncInterval || 30000,
				contextFileFormat: 'both',
				includeAnalysis: true,
				includeRelationships: true,
			}
		);

		// Perform initial sync
		await this.performInitialSync();
		logger.info('Project loaded successfully');
	}

	/**
	 * Save the project
	 */
	async saveProject(): Promise<void> {
		const structure = this.projectLoader.getProjectStructure();
		await this.projectLoader.saveProject(structure);
	}

	/**
	 * Get project structure
	 */
	async getProjectStructure(includeTrash = false): Promise<ScrivenerDocument[]> {
		return await this.documentManager.getProjectStructure(includeTrash);
	}

	/**
	 * Get all documents
	 */
	async getAllDocuments(includeTrash = false): Promise<ScrivenerDocument[]> {
		return await this.documentManager.getAllDocuments(includeTrash);
	}

	// Document operations
	async readDocument(documentId: string): Promise<string> {
		return await this.documentManager.readDocument(documentId);
	}

	async readDocumentFormatted(documentId: string): Promise<RTFContent> {
		return await this.documentManager.readDocumentFormatted(documentId);
	}

	async writeDocument(documentId: string, content: string | RTFContent): Promise<void> {
		await this.documentManager.writeDocument(documentId, content);
		this.markDocumentChanged(documentId);
	}

	async createDocument(
		title: string,
		content = '',
		parentId?: string,
		type: 'Text' | 'Folder' = DOCUMENT_TYPES.TEXT
	): Promise<string> {
		const id = await this.documentManager.createDocument(title, content, parentId, type);
		await this.saveProject();
		return id;
	}

	async deleteDocument(documentId: string): Promise<void> {
		await this.documentManager.deleteDocument(documentId);
		await this.saveProject();
	}

	async renameDocument(documentId: string, newTitle: string): Promise<void> {
		await this.documentManager.renameDocument(documentId, newTitle);
		await this.saveProject();
	}

	async moveDocument(
		documentId: string,
		newParentId: string | null,
		_position?: number
	): Promise<void> {
		await this.documentManager.moveDocument(documentId, newParentId);
		await this.saveProject();
	}

	async getWordCount(documentId?: string): Promise<{ words: number; characters: number }> {
		return await this.documentManager.getWordCount(documentId);
	}

	async getTotalWordCount(): Promise<number> {
		const count = await this.documentManager.getWordCount();
		return count.words;
	}

	// Compilation operations
	async compileDocuments(
		documentIds: string[],
		separator = '\n\n---\n\n',
		outputFormat: 'text' | 'markdown' | 'html' | 'latex' | 'json' = 'text'
	): Promise<string | object> {
		const documents = [];
		for (const id of documentIds) {
			try {
				const content = await this.documentManager.readDocumentFormatted(id);
				const doc = await this.getDocumentInfo(id);
				documents.push({
					id,
					content,
					title: doc.document?.title || 'Untitled',
				});
			} catch (error) {
				logger.warn(`Failed to read document ${id}:`, error as any);
			}
		}

		return await this.compilationService.compileDocuments(documents, {
			separator,
			outputFormat,
		});
	}

	async searchContent(
		query: string,
		options?: { caseSensitive?: boolean; regex?: boolean; searchMetadata?: boolean }
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		const documents = await this.getAllDocuments();
		const docsWithContent = [];

		for (const doc of documents) {
			if (doc.type === DOCUMENT_TYPES.TEXT) {
				try {
					const content = await this.readDocument(doc.id);
					docsWithContent.push({
						id: doc.id,
						title: doc.title,
						content,
						metadata: {
							synopsis: doc.synopsis,
							notes: doc.notes,
							keywords: doc.keywords,
						},
					});
				} catch {
					// Skip documents that can't be read
				}
			}
		}

		return this.compilationService.searchInDocuments(docsWithContent, query, options);
	}

	async exportProject(format: string, outputPath?: string, options?: any): Promise<any> {
		const structure = await this.getProjectStructure();
		return await this.compilationService.exportProject(structure, format, options);
	}

	async getStatistics(): Promise<any> {
		const documents = await this.getAllDocuments();
		return this.compilationService.getStatistics(documents);
	}

	// Metadata operations
	async updateMetadata(documentId: string, metadata: any): Promise<void> {
		const structure = this.projectLoader.getProjectStructure();
		if (!structure) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const item = this.findBinderItem(structure, documentId);
		if (!item) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		this.metadataManager.updateDocumentMetadata(item, metadata);
		await this.saveProject();
	}

	async updateDocumentMetadata(
		documentId: string,
		metadata: {
			synopsis?: string;
			notes?: string;
			label?: string;
			status?: string;
		}
	): Promise<void> {
		await this.updateMetadata(documentId, metadata);
	}

	async updateSynopsisAndNotes(
		documentId: string,
		synopsis?: string,
		notes?: string
	): Promise<void> {
		await this.updateMetadata(documentId, { synopsis, notes } as any);
	}

	async batchUpdateSynopsisAndNotes(
		updates: Array<{
			documentId: string;
			synopsis?: string;
			notes?: string;
		}>
	): Promise<Array<{ documentId: string; success: boolean; error?: string }>> {
		const results = [];
		for (const update of updates) {
			try {
				await this.updateSynopsisAndNotes(update.documentId, update.synopsis, update.notes);
				results.push({ documentId: update.documentId, success: true });
			} catch (error) {
				results.push({
					documentId: update.documentId,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return results;
	}

	async getProjectMetadata(): Promise<ScrivenerMetadata> {
		const structure = this.projectLoader.getProjectStructure();
		return this.metadataManager.getProjectMetadata(structure);
	}

	// Project management
	async refreshProject(): Promise<void> {
		this.documentManager.clearCache();
		const structure = await this.projectLoader.reloadProject();
		this.documentManager.setProjectStructure(structure);
	}

	async isProjectModified(): Promise<boolean> {
		return await this.projectLoader.isProjectModified();
	}

	clearCache(documentId?: string): void {
		this.documentManager.clearCache(documentId);
	}

	// Database and analysis
	getDatabaseService(): DatabaseService {
		return this.databaseService;
	}

	getContextAnalyzer(): ContextAnalyzer | undefined {
		return this.contextAnalyzer;
	}

	getContextSync(): ContextSyncService | undefined {
		return this.contextSync;
	}

	async analyzeChapterEnhanced(documentId: string): Promise<any> {
		if (!this.contextAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, 'Context analyzer not initialized');
		}

		const document = await this.getDocumentInfo(documentId);
		if (!document.document) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		const content = await this.readDocument(documentId);
		const allDocuments = await this.getAllDocuments();

		return await this.contextAnalyzer.analyzeChapter(
			document.document as any,
			content,
			allDocuments as any[]
		);
	}

	async buildStoryContext(): Promise<any> {
		if (!this.contextAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, 'Context analyzer not initialized');
		}

		const documents = await this.getAllDocuments();
		const contexts = [];

		for (const doc of documents) {
			if (doc.type === DOCUMENT_TYPES.TEXT) {
				const context = await this.contextAnalyzer.getChapterContext(doc.id);
				if (context) {
					contexts.push(context);
				}
			}
		}

		return await this.contextAnalyzer.buildStoryContext(documents as any[], contexts);
	}

	getSyncStatus(): any {
		if (!this.contextSync) {
			return {
				enabled: false,
				message: 'Context sync not initialized',
			};
		}
		return this.contextSync.getSyncStatus();
	}

	markDocumentChanged(documentId: string): void {
		if (this.contextSync) {
			this.contextSync.markDocumentChanged(documentId);
		}
	}

	async exportContextFiles(exportPath: string): Promise<void> {
		if (!this.contextSync) {
			throw createError(ErrorCode.INVALID_STATE, 'Context sync not initialized');
		}
		await this.contextSync.exportContextFiles(exportPath);
	}

	// Additional methods
	async getDocumentInfo(documentId: string): Promise<{
		document: ScrivenerDocument | null;
		path: Array<{ id: string; title: string; type: string }>;
		metadata: Record<string, unknown>;
		location: 'active' | 'trash' | 'unknown';
	}> {
		const structure = await this.getProjectStructure(true);
		let foundDoc: ScrivenerDocument | null = null;
		let path: Array<{ id: string; title: string; type: string }> = [];
		let location: 'active' | 'trash' | 'unknown' = 'unknown';

		const searchInDocs = (
			docs: ScrivenerDocument[],
			currentPath: Array<{ id: string; title: string; type: string }>
		): boolean => {
			for (const doc of docs) {
				const newPath = [...currentPath, { id: doc.id, title: doc.title, type: doc.type }];

				if (doc.id === documentId) {
					foundDoc = doc;
					path = newPath;
					return true;
				}

				if (doc.children && searchInDocs(doc.children, newPath)) {
					return true;
				}
			}
			return false;
		};

		if (searchInDocs(structure, [])) {
			location = 'active';
		}

		const metadata: Record<string, unknown> = {};
		if (foundDoc) {
			const doc = foundDoc as ScrivenerDocument;
			Object.assign(metadata, {
				synopsis: doc.synopsis,
				notes: doc.notes,
				label: doc.label,
				status: doc.status,
				keywords: doc.keywords,
				includeInCompile: doc.includeInCompile,
				...doc.customMetadata,
			});
		}

		return { document: foundDoc, path, metadata, location };
	}

	async getTrashDocuments(): Promise<ScrivenerDocument[]> {
		const allDocs = await this.getProjectStructure(true);
		const trashDocs: ScrivenerDocument[] = [];

		// Find trash folder
		for (const doc of allDocs) {
			if (doc.path && doc.path.startsWith('Trash/')) {
				trashDocs.push(doc);
			}
		}

		return trashDocs;
	}

	async searchTrash(
		query: string,
		options?: { caseSensitive?: boolean; regex?: boolean }
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		const trashDocs = await this.getTrashDocuments();
		const docsWithContent = [];

		for (const doc of trashDocs) {
			if (doc.type === DOCUMENT_TYPES.TEXT) {
				try {
					const content = await this.readDocument(doc.id);
					docsWithContent.push({
						id: doc.id,
						title: `[TRASH] ${doc.title}`,
						content,
						metadata: {},
					});
				} catch {
					// Skip
				}
			}
		}

		return this.compilationService.searchInDocuments(docsWithContent, query, options);
	}

	async recoverFromTrash(documentId: string, targetParentId?: string): Promise<void> {
		await this.documentManager.recoverFromTrash(documentId, targetParentId);
		await this.saveProject();
	}

	async getProjectStructureLimited(options?: {
		maxDepth?: number;
		folderId?: string;
		includeTrash?: boolean;
		summaryOnly?: boolean;
	}): Promise<any> {
		const structure = await this.getProjectStructure(options?.includeTrash);

		if (options?.summaryOnly) {
			const stats = this.compilationService.getStatistics(structure);
			return {
				...stats,
				tree: structure.slice(0, 3), // Just top level items
			};
		}

		return structure;
	}

	async getDocumentAnnotations(documentId: string): Promise<Map<string, string>> {
		try {
			// Get the raw RTF content for the document
			const rtfContent = await this.documentManager.readDocumentRaw(documentId);

			// Extract annotations using the RTF handler
			return this.compilationService.extractAnnotations(rtfContent);
		} catch (error) {
			logger.warn(`Failed to extract annotations for document ${documentId}`, { error });
			return new Map<string, string>();
		}
	}

	// Private helpers
	private async performInitialSync(): Promise<void> {
		try {
			logger.info('Performing initial sync');

			const allDocs = await this.getAllDocuments();
			for (const doc of allDocs) {
				await this.syncDocumentToDatabase(doc);
			}

			if (this.contextSync) {
				await this.contextSync.performSync();
			}

			logger.info('Initial sync completed');
		} catch (error) {
			logger.error('Initial sync failed:', error as any);
		}
	}

	private async syncDocumentToDatabase(doc: ScrivenerDocument): Promise<void> {
		try {
			let wordCount = 0;
			let characterCount = 0;

			if (doc.type === DOCUMENT_TYPES.TEXT) {
				try {
					const content = await this.readDocument(doc.id);
					const words = content
						.trim()
						.split(/\s+/)
						.filter((w) => w.length > 0);
					wordCount = words.length;
					characterCount = content.length;
				} catch {
					// Document might not have content yet
				}
			}

			await this.databaseService.syncDocumentData({
				id: doc.id,
				title: doc.title,
				type: doc.type,
				synopsis: doc.synopsis,
				notes: doc.notes,
				wordCount,
				characterCount,
			});
		} catch (error) {
			logger.warn(`Failed to sync document ${doc.id}:`, error as any);
		}
	}

	private findBinderItem(structure: any, documentId: string): any {
		if (!structure?.ScrivenerProject?.Binder) return null;

		const searchInBinder = (container: any): any => {
			if (!container) return null;

			const items = container.BinderItem || container.Children?.BinderItem;
			if (!items) return null;

			const itemArray = Array.isArray(items) ? items : [items];

			for (const item of itemArray) {
				if (item.UUID === documentId) return item;

				if (item.Children?.BinderItem) {
					const found = searchInBinder(item.Children);
					if (found) return found;
				}
			}

			return null;
		};

		return searchInBinder(structure.ScrivenerProject.Binder);
	}

	// Cleanup
	async close(): Promise<void> {
		logger.info('Closing Scrivener project');

		if (this.contextSync) {
			this.contextSync.close();
		}

		// Shutdown async services (job queue, AI services)
		await shutdownAsyncServices();

		await this.databaseService.close();
		await this.documentManager.close();

		logger.info('Project closed');
	}
}
