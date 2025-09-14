/**
 * Scrivener Project class using modular services
 */

import * as path from 'path';
import { ContentAnalyzer, ContextAnalyzer } from './analysis/index.js';
import { DOCUMENT_TYPES } from './core/constants.js';
import { createError, ErrorCode } from './core/errors.js';
import { getLogger } from './core/logger.js';
import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';
import { DatabaseService } from './handlers/database/index.js';
import { ContextSyncService, type SyncStatus } from './sync/context-sync.js';
import { CleanupManager } from './utils/common.js';
import { ensureProjectDataDirectory } from './utils/project-utils.js';
import { findBinderItem } from './utils/scrivener-utils.js';

// Import service modules
import { CompilationService } from './services/compilation-service.js';
import { documentIndexer, type SearchResult } from './services/document-indexer.js';
import { DocumentManager } from './services/document-manager.js';
import { MetadataManager } from './services/metadata-manager.js';
import { ProjectLoader } from './services/project-loader.js';
import {
	createDocument as createDocumentUtil,
	type DocumentOperationContext,
} from './utils/document-operations.js';

import type {
	ScrivenerDocument as AnalyzerDocument,
	ChapterContext,
} from './analysis/context-analyzer.js';
import type { RTFContent } from './services/parsers/rtf-handler.js';
import type {
	DocumentInfo,
	ExportOptions,
	ProjectStatistics,
	ProjectStructure,
	ScrivenerDocument,
	ScrivenerMetadata,
} from './types/index.js';

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
	private indexInitialized = false;

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

		// Initialize document indexer
		const documents = await this.getAllDocuments();
		await documentIndexer.buildIndex(documents);
		this.indexInitialized = true;
		logger.info('Document index built');

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
		// Use unified document creation utility with transaction support
		const context: DocumentOperationContext = {
			projectStructure: this.documentManager.getProjectStructureData(),
			projectPath: this.projectPath,
			writeDocument: (id, content) => this.documentManager.writeDocument(id, content),
			saveProject: () => this.saveProject(),
		};

		const result = await createDocumentUtil({ title, content, parentId, type }, context);

		return result.id;
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
				logger.warn(`Failed to read document ${id}:`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return await this.compilationService.compileDocuments(documents, {
			separator,
			outputFormat,
		});
	}

	async searchContent(
		query: string,
		options?: {
			caseSensitive?: boolean;
			regex?: boolean;
			searchMetadata?: boolean;
			includeTrash?: boolean;
		}
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		// Use the document indexer for efficient search if available
		if (this.indexInitialized && !options?.searchMetadata) {
			const results = await documentIndexer.searchContent(query, {
				caseSensitive: options?.caseSensitive,
				regex: options?.regex,
				limit: 100,
			});

			// Update index for accessed documents
			for (const result of results.slice(0, 10)) {
				try {
					const content = await this.readDocument(result.documentId);
					await documentIndexer.updateDocumentInIndex(result.documentId, content);
				} catch {
					// Skip if can't read
				}
			}

			return results.map((r: SearchResult) => ({
				documentId: r.documentId,
				title: r.title,
				matches: r.matches,
			}));
		}

		// Fallback to full scan for metadata search or if index not available
		const documents = await this.getAllDocuments(options?.includeTrash);
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

					// Update index while we have the content
					if (this.indexInitialized) {
						await documentIndexer.updateDocumentInIndex(doc.id, content);
					}
				} catch {
					// Skip documents that can't be read
				}
			}
		}

		return this.compilationService.searchInDocuments(docsWithContent, query, options);
	}

	async exportProject(
		format: string,
		_outputPath?: string,
		options?: Partial<ExportOptions>
	): Promise<unknown> {
		const structure = await this.getProjectStructure();
		return await this.compilationService.exportProject(structure, format, options);
	}

	async getStatistics(): Promise<ProjectStatistics> {
		const documents = await this.getAllDocuments();
		return this.compilationService.getStatistics(documents);
	}

	// Metadata operations
	async updateMetadata(documentId: string, metadata: Record<string, unknown>): Promise<void> {
		const structure = this.projectLoader.getProjectStructure();
		if (!structure) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const item = this.findBinderItem(
			structure as unknown as Record<string, unknown>,
			documentId
		);
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
		await this.updateMetadata(documentId, { synopsis, notes });
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
		if (!structure) {
			return {};
		}
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

	async analyzeChapterEnhanced(documentId: string): Promise<ChapterContext> {
		if (!this.contextAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, 'Context analyzer not initialized');
		}

		const document = await this.getDocumentInfo(documentId);
		if (!document.document) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		const content = await this.readDocument(documentId);
		const allDocuments = await this.getAllDocuments();

		const addCharCount = (doc: ScrivenerDocument): AnalyzerDocument => ({
			id: doc.id,
			title: doc.title,
			type: doc.type,
			synopsis: doc.synopsis,
			notes: doc.notes,
			characterCount: doc.content?.length || 0,
			wordCount: doc.wordCount || 0,
			children: doc.children?.map(addCharCount),
		});
		const documentsWithCharCount = allDocuments.map(addCharCount);
		const documentWithCharCount = addCharCount(document.document);
		return (await this.contextAnalyzer.analyzeChapter(
			documentWithCharCount,
			content,
			documentsWithCharCount
		)) as ChapterContext;
	}

	async buildStoryContext(): Promise<unknown> {
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

		const addCharCount = (doc: ScrivenerDocument): AnalyzerDocument => ({
			id: doc.id,
			title: doc.title,
			type: doc.type,
			synopsis: doc.synopsis,
			notes: doc.notes,
			characterCount: doc.content?.length || 0,
			wordCount: doc.wordCount || 0,
			children: doc.children?.map(addCharCount),
		});
		const documentsWithCharCount = documents.map(addCharCount);
		return await this.contextAnalyzer.buildStoryContext(documentsWithCharCount, contexts);
	}

	getSyncStatus(): SyncStatus | { enabled: false; message: string } {
		if (!this.contextSync) {
			return {
				enabled: false,
				message: 'Context sync not initialized',
			};
		}
		return this.contextSync.getSyncStatus();
	}

	markDocumentChanged(documentId: string): void {
		// Track in document indexer for efficient syncing
		if (this.indexInitialized) {
			documentIndexer.markDocumentChanged(documentId);
		}

		// Also track in context sync if available
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
		// Use document indexer for O(1) lookup if available
		if (this.indexInitialized) {
			const docInfo = documentIndexer.getDocumentInfo(documentId);
			if (docInfo) {
				return {
					document: docInfo.document,
					path: docInfo.path,
					metadata: {
						synopsis: docInfo.document.synopsis,
						notes: docInfo.document.notes,
						keywords: docInfo.document.keywords,
						status: docInfo.document.status,
						label: docInfo.document.label,
					},
					location: docInfo.location,
				};
			}
		}

		// Fallback to tree search if index not available or document not found
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
	}): Promise<ProjectStructure> {
		const structure = await this.getProjectStructure(options?.includeTrash);

		// Convert ScrivenerDocument[] to ProjectStructure format
		const root = structure[0] || {
			id: 'root',
			title: 'Project Root',
			type: 'Folder' as const,
			path: '',
			children: structure,
		};

		const convertToDocumentInfo = (doc: ScrivenerDocument): DocumentInfo => ({
			...doc,
			path: typeof doc.path === 'string' ? doc.path.split('/') : doc.path,
			children: doc.children ? doc.children.map(convertToDocumentInfo) : undefined,
		});

		const draft = structure.find((doc) => doc.title === 'Manuscript' || doc.title === 'Draft');
		const research = structure.find((doc) => doc.title === 'Research');
		const trash = options?.includeTrash
			? structure.find((doc) => doc.title === 'Trash')
			: undefined;

		return {
			root: convertToDocumentInfo(root),
			draft: draft ? convertToDocumentInfo(draft) : undefined,
			research: research ? convertToDocumentInfo(research) : undefined,
			trash: trash ? convertToDocumentInfo(trash) : undefined,
			templates: [],
		};
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

	// Compatibility aliases for handlers
	async getDocument(documentId: string): Promise<ScrivenerDocument> {
		const info = await this.getDocumentInfo(documentId);
		const doc = await this.readDocument(documentId);

		if (!info.document) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		return {
			...info.document,
			content: doc || '',
		};
	}

	async getStructure(options?: {
		includeContent?: boolean;
		maxDepth?: number;
	}): Promise<ProjectStructure> {
		return this.getProjectStructureLimited(options);
	}

	get metadata(): ScrivenerMetadata {
		return {
			draftFolder: 'draft', // Default draft folder ID
		};
	}

	get title(): string {
		return this.metadataManager?.getProjectTitle() || 'Untitled Project';
	}

	get structure(): Promise<ProjectStructure> {
		// Alias for getStructure
		return this.getStructure();
	}

	// Private helpers
	private async performInitialSync(): Promise<void> {
		const allDocs = await this.getAllDocuments();
		const BATCH_SIZE = 50;

		for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
			const batch = allDocs.slice(i, i + BATCH_SIZE);
			await Promise.all(batch.map((doc) => this.syncDocumentToDatabase(doc)));
			logger.debug(
				`Synced ${Math.min(i + BATCH_SIZE, allDocs.length)}/${allDocs.length} documents`
			);
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
			logger.warn(`Failed to sync document ${doc.id}:`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private findBinderItem(
		structure: Record<string, unknown>,
		documentId: string
	): Record<string, unknown> | null {
		const scrivenerProject = structure.ScrivenerProject as Record<string, unknown> | undefined;
		if (!scrivenerProject?.Binder) return null;

		const binder = scrivenerProject.Binder;
		const found = findBinderItem(binder, documentId);
		return found as Record<string, unknown> | null;
	}

	// Cleanup
	async close(): Promise<void> {
		logger.info('Closing Scrivener project');

		// Flush any pending changes in the indexer
		if (this.indexInitialized) {
			await documentIndexer.flushChanges();
			documentIndexer.dispose();
			this.indexInitialized = false;
		}

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
