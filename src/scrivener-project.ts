import * as fs from 'fs/promises';
import * as path from 'path';
import { parseStringPromise, Builder } from 'xml2js';
import type { RTFContent } from './rtf-handler.js';
import { RTFHandler } from './rtf-handler.js';
import { DatabaseService } from './database/index.js';
import { ContentAnalyzer } from './content-analyzer.js';
import { EnhancedAnalyzer } from './analysis/enhanced-analyzer.js';
import { ContextSyncService } from './sync/context-sync.js';
import {
	AppError,
	ErrorCode,
	Cache,
	validateInput,
	isValidDocumentId,
	safeReadFile,
	safeWriteFile,
	ensureDir,
	CleanupManager,
} from './utils/common.js';
import { getDocumentPath, generateScrivenerUUID } from './utils/scrivener-utils.js';
import type {
	ProjectStructure,
	BinderItem,
	BinderContainer,
	MetaDataItem,
	ErrorWithCode,
} from './types/internal.js';

export interface ScrivenerDocument {
	id: string;
	title: string;
	type: 'Text' | 'Folder' | 'Other';
	path: string;
	content?: string;
	synopsis?: string;
	notes?: string;
	label?: string;
	status?: string;
	includeInCompile?: boolean;
	children?: ScrivenerDocument[];
	customMetadata?: Record<string, string>;
	keywords?: string[];
}

export interface ScrivenerMetadata {
	title?: string;
	author?: string;
	keywords?: string[];
	projectTargets?: {
		draft?: number;
		session?: number;
		deadline?: string;
	};
	customFields?: Record<string, string>;
}

export class ScrivenerProject {
	private projectPath: string;
	private scrivxPath: string;
	private projectStructure?: ProjectStructure;
	private rtfHandler: RTFHandler;
	private documentCache: Cache<RTFContent>;
	private databaseService: DatabaseService;
	private contentAnalyzer: ContentAnalyzer;
	private enhancedAnalyzer?: EnhancedAnalyzer;
	private contextSync?: ContextSyncService;
	private cleanupManager: CleanupManager;

	/**
	 * Constructs a new ScrivenerProject instance.
	 * @param projectPath The absolute path to the `.scriv` project directory.
	 */
	constructor(projectPath: string) {
		this.projectPath = path.resolve(projectPath);
		const projectName = path.basename(projectPath, path.extname(projectPath));
		this.scrivxPath = path.join(this.projectPath, `${projectName}.scrivx`);
		this.rtfHandler = new RTFHandler();
		this.documentCache = new Cache<RTFContent>({
			ttl: 5 * 60 * 1000, // 5 minutes
			maxSize: 50,
			onEvict: (key, _value) => {
				// Document evicted from cache
			},
		});
		this.databaseService = new DatabaseService(this.projectPath);
		this.contentAnalyzer = new ContentAnalyzer();
		this.cleanupManager = new CleanupManager();

		// Register cleanup tasks
		this.cleanupManager.register(async () => {
			await this.close();
		});
	}

	/**
	 * Loads the Scrivener project's main `.scrivx` file into memory.
	 * @throws {Error} If the project file cannot be read or parsed.
	 */
	async loadProject(): Promise<void> {
		try {
			const scrivxContent = await safeReadFile(this.scrivxPath);
			this.projectStructure = await parseStringPromise(scrivxContent, {
				explicitArray: false,
				mergeAttrs: true,
			});
			if (!this.projectStructure?.ScrivenerProject) {
				throw new AppError(
					'Invalid Scrivener project structure: Missing ScrivenerProject element.',
					ErrorCode.PROJECT_ERROR
				);
			}

			// Binder might be an empty string if it was saved as <Binder/>, convert to object
			if ((this.projectStructure.ScrivenerProject.Binder as unknown) === '') {
				this.projectStructure.ScrivenerProject.Binder = {};
			}

			// Initialize database service
			await this.databaseService.initialize();

			// Initialize enhanced analyzer and context sync
			this.enhancedAnalyzer = new EnhancedAnalyzer(
				this.databaseService,
				this.contentAnalyzer
			);
			this.contextSync = new ContextSyncService(
				this.projectPath,
				this.databaseService,
				this.enhancedAnalyzer,
				{
					autoSync: true,
					syncInterval: 30000,
					contextFileFormat: 'both',
					includeAnalysis: true,
					includeRelationships: true,
				}
			);

			if (!this.projectStructure.ScrivenerProject.Binder) {
				this.projectStructure.ScrivenerProject.Binder = {};
			}

			// Track when the project was loaded for modification detection
			this.projectStructure._loadTime = Date.now();

			// Perform initial sync after project load
			await this.performInitialSync();
		} catch (error) {
			if (error instanceof AppError) {
				throw error;
			}
			const err = error as ErrorWithCode;
			if (err.code === 'ENOENT') {
				throw new AppError(
					`Scrivener project file not found at "${this.scrivxPath}". Ensure the path is correct.`,
					ErrorCode.NOT_FOUND,
					{ path: this.scrivxPath }
				);
			} else if (err.code === 'EACCES') {
				throw new AppError(
					`Permission denied reading project file at "${this.scrivxPath}".`,
					ErrorCode.PERMISSION_DENIED,
					{ path: this.scrivxPath }
				);
			}
			throw new AppError(
				`Failed to load Scrivener project from "${this.scrivxPath}": ${err.message || String(error)}`,
				ErrorCode.PROJECT_ERROR,
				{ path: this.scrivxPath, originalError: err.message }
			);
		}
	}

	/**
	 * Saves the current project structure back to the `.scrivx` file.
	 * @throws {Error} If no project is currently loaded.
	 */
	async saveProject(): Promise<void> {
		if (!this.projectStructure) {
			throw new Error('No project loaded to save.');
		}

		// Create a clean structure for saving (without internal properties)
		const cleanProjectStructure = JSON.parse(
			JSON.stringify(this.projectStructure.ScrivenerProject)
		);

		const saveStructure = {
			ScrivenerProject: cleanProjectStructure,
		};

		const builder = new Builder({
			xmldec: { version: '1.0', encoding: 'UTF-8' },
			renderOpts: { pretty: true, indent: '    ' },
		});
		const xml = builder.buildObject(saveStructure);
		await safeWriteFile(this.scrivxPath, xml);
	}

	/**
	 * Retrieves the hierarchical structure of the entire project binder.
	 * @returns A promise that resolves to an array of ScrivenerDocument objects.
	 */
	async getProjectStructure(includeTrash = false): Promise<ScrivenerDocument[]> {
		if (!this.projectStructure) await this.loadProject();

		const binder = this.projectStructure?.ScrivenerProject?.Binder;
		if (!binder) return [];

		return this.parseBinderItems(binder.BinderItem || [], includeTrash);
	}

	/**
	 * Reads the plain text content of a specific document.
	 * Uses caching to improve performance for repeated reads.
	 * @param documentId The UUID of the document.
	 * @returns A promise that resolves to the document's plain text content.
	 * @throws {Error} If the document file cannot be read.
	 */
	async readDocument(documentId: string): Promise<string> {
		// Validate document ID
		if (!isValidDocumentId(documentId)) {
			throw new AppError(`Invalid document ID: ${documentId}`, ErrorCode.INVALID_INPUT, {
				documentId,
			});
		}

		const docPath = this.getDocumentPath(documentId);
		return await safeReadFile(docPath);
	}

	/**
	 * Reads the rich text formatted content of a specific document.
	 * Uses caching to improve performance for repeated reads.
	 * Cache entries expire after 5 minutes to balance performance with freshness.
	 * @param documentId The UUID of the document.
	 * @returns A promise that resolves to an RTFContent object.
	 * @throws {Error} If the document file cannot be read.
	 */
	async readDocumentFormatted(documentId: string): Promise<RTFContent> {
		// Validate document ID
		if (!isValidDocumentId(documentId)) {
			throw new AppError(`Invalid document ID: ${documentId}`, ErrorCode.INVALID_INPUT);
		}

		// Check cache first
		const cached = this.documentCache.get(documentId);
		if (cached) {
			return cached;
		}

		// Read from disk if not cached
		const docPath = this.getDocumentPath(documentId);
		try {
			const rtfContent = await this.rtfHandler.readRTF(docPath);

			// Update cache
			this.documentCache.set(documentId, rtfContent);

			return rtfContent;
		} catch (error) {
			// Provide specific error messages based on error type
			const err = error as ErrorWithCode;
			if (err.code === 'ENOENT') {
				throw new Error(
					`[ENOENT] Document file not found for ${documentId} at "${docPath}". The document may have been deleted or moved.`
				);
			} else if (err.code === 'EACCES') {
				throw new Error(
					`[EACCES] Permission denied reading document ${documentId} at "${docPath}".`
				);
			} else if (err.message?.includes('RTF')) {
				throw new Error(
					`Invalid RTF format in document ${documentId} at "${docPath}": ${err.message}`
				);
			} else {
				throw new Error(
					`Failed to read document ${documentId} at "${docPath}": ${err.message || String(error)}`
				);
			}
		}
	}

	/**
	 * Writes content to a specific document.
	 * Invalidates the cache for the modified document.
	 * @param documentId The UUID of the document.
	 * @param content The plain text or RTFContent object to write.
	 * @throws {Error} If the document file cannot be written.
	 */
	async writeDocument(documentId: string, content: string | RTFContent): Promise<void> {
		// Validate input
		validateInput(
			{ documentId, content },
			{
				documentId: {
					type: 'string',
					required: true,
					custom: (id) => isValidDocumentId(id) || 'Invalid document ID format',
				},
				content: {
					required: true,
				},
			}
		);
		const docPath = this.getDocumentPath(documentId);
		try {
			await this.rtfHandler.writeRTF(docPath, content);

			// Invalidate cache for this document
			this.documentCache.delete(documentId);

			// Mark document as changed for sync
			this.markDocumentChanged(documentId);
		} catch (error) {
			const err = error as ErrorWithCode;
			if (err.code === 'ENOENT') {
				throw new Error(
					`[ENOENT] Directory not found for document ${documentId}. Ensure the project structure is valid.`
				);
			} else if (err.code === 'EACCES') {
				throw new Error(
					`[EACCES] Permission denied writing document ${documentId} at "${docPath}".`
				);
			} else if (err.code === 'ENOSPC') {
				throw new Error(
					`[ENOSPC] No space left on device to write document ${documentId}.`
				);
			} else {
				throw new Error(
					`Failed to write document ${documentId} at "${docPath}": ${err.message || String(error)}`
				);
			}
		}
	}

	/**
	 * Creates a new document or folder and adds it to the project.
	 * @param parentId The UUID of the parent folder, or null to add to the root.
	 * @param title The title of the new item.
	 * @param type The type of item to create ('Text' or 'Folder').
	 * @returns A promise that resolves to the UUID of the newly created item.
	 * @throws {Error} If the parent document is not found.
	 */
	async createDocument(
		parentId: string | null,
		title: string,
		type: 'Text' | 'Folder' = 'Text'
	): Promise<string> {
		if (!this.projectStructure) await this.loadProject();

		const uuid = generateScrivenerUUID();
		const newItem = {
			UUID: uuid,
			Type: type,
			Title: title,
			MetaData: {
				IncludeInCompile: 'Yes',
				Created: new Date().toISOString(),
				Modified: new Date().toISOString(),
			},
			Children: type === 'Folder' ? { BinderItem: [] } : undefined,
		};

		if (type === 'Text') {
			const docPath = this.getDocumentPath(uuid);
			// Create directory structure for the document
			await ensureDir(path.dirname(docPath));
			await this.rtfHandler.writeRTF(docPath, '');
		}

		let targetContainer = this.projectStructure?.ScrivenerProject?.Binder;
		if (!targetContainer) {
			throw new Error('Project structure is invalid.');
		}

		if (parentId) {
			const parent = this.findBinderItem(targetContainer, parentId);
			if (!parent || parent?.Type !== 'Folder') {
				throw new Error(`Parent ${parentId} not found or is not a folder.`);
			}
			targetContainer = parent.Children;
		}

		if (!targetContainer) {
			throw new Error('Target container is not available.');
		}

		this.addToBinderContainer(targetContainer, newItem);

		await this.saveProject();
		return uuid;
	}

	/**
	 * Deletes a document or folder from the project.
	 * @param documentId The UUID of the item to delete.
	 * @throws {Error} If the document is not found.
	 */
	async deleteDocument(documentId: string): Promise<void> {
		if (!this.projectStructure) await this.loadProject();

		const docPath = this.getDocumentPath(documentId);

		const binder = this.projectStructure?.ScrivenerProject?.Binder;
		if (!binder) {
			throw new Error('Project structure is invalid.');
		}

		if (!this.deleteBinderItem(binder, documentId, true)) {
			throw new Error(`Document ${documentId} not found.`);
		}

		try {
			await fs.unlink(docPath);
		} catch (error) {
			const err = error as ErrorWithCode;
			if (err.code !== 'ENOENT') {
				console.error(
					`Warning: Could not delete RTF file for document ${documentId}: ${err.message || String(error)}`
				);
			}
		}

		await this.saveProject();
	}

	/**
	 * Renames a document in the binder.
	 * @param documentId The UUID of the document to rename.
	 * @param newTitle The new title for the document.
	 * @throws {Error} If the document is not found.
	 */
	async renameDocument(documentId: string, newTitle: string): Promise<void> {
		if (!this.projectStructure) await this.loadProject();

		const binder = this.projectStructure?.ScrivenerProject?.Binder;
		if (!binder) {
			throw new Error('Project structure is invalid.');
		}

		const item = this.findBinderItem(binder, documentId);
		if (!item) {
			throw new Error(`Document with ID "${documentId}" not found.`);
		}
		item.Title = newTitle;
		this.updateModifiedDate(item);
		await this.saveProject();
	}

	/**
	 * Moves a document or folder to a new parent folder.
	 * @param documentId The UUID of the item to move.
	 * @param newParentId The UUID of the new parent folder, or null to move to the root.
	 * @throws {Error} If the document or new parent is not found.
	 */
	async moveDocument(documentId: string, newParentId: string | null): Promise<void> {
		if (!this.projectStructure) await this.loadProject();

		const binder = this.projectStructure?.ScrivenerProject?.Binder;
		if (!binder) {
			throw new Error('Project structure is invalid.');
		}

		// Check if trying to move item to itself (no-op)
		if (documentId === newParentId) {
			return; // No operation needed
		}

		const extractedItem = this.extractBinderItem(binder, documentId);
		if (!extractedItem) {
			throw new Error(`Document ${documentId} not found.`);
		}

		if (newParentId) {
			const newParent = this.findBinderItem(binder, newParentId);
			if (!newParent || newParent?.Type !== 'Folder') {
				throw new Error(`Parent ${newParentId} not found or is not a folder.`);
			}
			if (!newParent.Children) {
				newParent.Children = { BinderItem: [] };
			}
			this.addToBinderContainer(newParent.Children, extractedItem);
		} else {
			// Move to the root
			this.addToBinderContainer(binder, extractedItem);
		}

		this.updateModifiedDate(extractedItem);
		await this.saveProject();
	}

	/**
	 * Refreshes the in-memory project state by reloading the .scrivx file.
	 * WARNING: This will overwrite any unsaved in-memory changes.
	 * Also clears the document cache to ensure fresh reads.
	 */
	async refreshProject(): Promise<void> {
		// Refreshing project from disk

		// Clear all caches
		this.documentCache.clear();

		// Reload project structure
		await this.loadProject();

		// Project refresh complete. Cache cleared.
	}

	/**
	 * Checks if the project file has been modified since last load.
	 * @returns True if the project file has been modified externally.
	 */
	async isProjectModified(): Promise<boolean> {
		try {
			const stats = await fs.stat(this.scrivxPath);
			const lastLoadTime = this.projectStructure?._loadTime;

			if (!lastLoadTime) {
				return false;
			}

			return stats.mtime.getTime() > lastLoadTime;
		} catch {
			return false;
		}
	}

	/**
	 * Clears the document cache for a specific document or all documents.
	 * @param documentId Optional document ID to clear. If not provided, clears all.
	 */
	clearCache(documentId?: string): void {
		if (documentId) {
			this.documentCache.delete(documentId);
		} else {
			this.documentCache.clear();
		}
	}

	/**
	 * Updates the metadata for a specific document.
	 * @param documentId The UUID of the document.
	 * @param metadata The partial metadata object to update.
	 * @throws {Error} If the document is not found.
	 */
	async updateMetadata(documentId: string, metadata: Partial<ScrivenerMetadata>): Promise<void> {
		if (!this.projectStructure) await this.loadProject();

		const binder = this.projectStructure?.ScrivenerProject?.Binder;
		if (!binder) {
			throw new Error('Project structure is invalid.');
		}

		const item = this.findBinderItem(binder, documentId);
		if (!item) {
			throw new Error(`Document ${documentId} not found.`);
		}

		if (!item.MetaData) {
			item.MetaData = {};
		}

		const metaData = item.MetaData;

		if (metadata.title !== undefined) {
			item.Title = metadata.title;
		}

		if (metadata.keywords) {
			metaData.Keywords = metadata.keywords.join(',');
		}

		if (metadata.customFields) {
			if (!metaData.CustomMetaData) {
				metaData.CustomMetaData = { MetaDataItem: [] };
			}
			const customMetaItems = Array.isArray(metaData.CustomMetaData.MetaDataItem)
				? metaData.CustomMetaData.MetaDataItem
				: metaData.CustomMetaData.MetaDataItem
					? [metaData.CustomMetaData.MetaDataItem]
					: [];

			Object.entries(metadata.customFields).forEach(([key, value]) => {
				const existing = customMetaItems.find((mdItem: MetaDataItem) => mdItem?.ID === key);
				if (existing) {
					existing.Value = value;
				} else {
					customMetaItems.push({
						ID: key,
						Value: value,
					});
				}
			});
			metaData.CustomMetaData.MetaDataItem = customMetaItems;
		}

		this.updateModifiedDate(item);
		await this.saveProject();
	}

	/**
	 * Get the database service instance
	 */
	getDatabaseService(): DatabaseService {
		return this.databaseService;
	}

	/**
	 * Close database connections
	 */
	/**
	 * Sync a document to the database
	 */
	private async syncDocumentToDatabase(doc: ScrivenerDocument): Promise<void> {
		try {
			// Get word count for the document
			let wordCount = 0;
			let characterCount = 0;

			try {
				const content = await this.readDocument(doc.id);
				const words = content
					.trim()
					.split(/\s+/)
					.filter((word) => word.length > 0);
				wordCount = words.length;
				characterCount = content.length;
			} catch {
				// Document might not have content yet, that's okay
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
			// Log error but don't throw to avoid breaking project loading
			console.warn(`Failed to sync document ${doc.id}:`, error);
		}
	}

	/**
	 * Updates the synopsis and/or notes for a specific document.
	 * @param documentId The UUID of the document.
	 * @param synopsis The new synopsis text (optional).
	 * @param notes The new notes text (optional).
	 * @throws {Error} If the document is not found.
	 */
	async updateSynopsisAndNotes(
		documentId: string,
		synopsis?: string,
		notes?: string
	): Promise<void> {
		if (!this.projectStructure) await this.loadProject();

		const binder = this.projectStructure?.ScrivenerProject?.Binder;
		if (!binder) {
			throw new Error('Project structure is invalid.');
		}

		const item = this.findBinderItem(binder, documentId);
		if (!item) {
			throw new Error(`Document ${documentId} not found.`);
		}

		if (!item.MetaData) {
			item.MetaData = {};
		}

		// Update synopsis
		if (synopsis !== undefined) {
			item.MetaData.Synopsis = synopsis;
		}

		// Update notes
		if (notes !== undefined) {
			item.MetaData.Notes = notes;
		}

		this.updateModifiedDate(item);
		await this.saveProject();
	}

	/**
	 * Batch update synopsis and notes for multiple documents.
	 * @param updates Array of update objects with documentId, synopsis, and/or notes.
	 * @returns Array of results indicating success/failure for each document.
	 */
	async batchUpdateSynopsisAndNotes(
		updates: Array<{
			documentId: string;
			synopsis?: string;
			notes?: string;
		}>
	): Promise<Array<{ documentId: string; success: boolean; error?: string }>> {
		if (!this.projectStructure) await this.loadProject();

		const results: Array<{ documentId: string; success: boolean; error?: string }> = [];

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

	/**
	 * Retrieves the combined word and character count for a specific document or the entire project.
	 * @param documentId The UUID of the document. If not provided, the entire project is counted.
	 * @returns An object with `words` and `characters` counts.
	 */
	async getWordCount(documentId?: string): Promise<{ words: number; characters: number }> {
		let content = '';

		if (documentId) {
			content = await this.readDocument(documentId);
		} else {
			const docs = await this.getAllDocuments();
			const textDocs = docs.filter((doc) => doc.type === 'Text');

			const promises = textDocs.map((doc) => this.readDocument(doc.id).catch(() => ''));
			const allContents = await Promise.all(promises);
			content = allContents.join(' ');
		}

		const words = content
			.trim()
			.split(/\s+/)
			.filter((word) => word.length > 0).length;
		const characters = content.length;

		return { words, characters };
	}

	/**
	 * Compiles the content of multiple documents into a single string or formatted object.
	 * @param documentIds An array of UUIDs for the documents to compile.
	 * @param separator The string to use between documents.
	 * @param outputFormat The desired output format ('text', 'markdown', or 'html').
	 * @returns A promise that resolves to the compiled content.
	 */
	async compileDocuments(
		documentIds: string[],
		separator: string = '\n\n',
		outputFormat: 'text' | 'markdown' | 'html' | 'latex' | 'json' = 'text'
	): Promise<string | RTFContent> {
		const promises = documentIds.map((id) => this.readDocumentFormatted(id).catch(() => null));
		const rtfContents = (await Promise.all(promises)).filter(Boolean) as RTFContent[];

		if (outputFormat === 'text') {
			const plainTexts = rtfContents.map((c) => c.plainText).filter((text) => text.trim());
			return plainTexts.join(separator);
		}

		if (outputFormat === 'json') {
			// Return structured JSON representation
			return JSON.stringify(
				{
					documents: rtfContents.map((content, index) => ({
						id: documentIds[index],
						plainText: content.plainText,
						formattedText: content.formattedText,
					})),
					totalWordCount: rtfContents.reduce(
						(sum, c) => sum + c.plainText.split(/\s+/).length,
						0
					),
				},
				null,
				2
			);
		}

		let compiledContent = '';
		for (let i = 0; i < rtfContents.length; i++) {
			const content = rtfContents[i];
			if (content.plainText.trim()) {
				if (outputFormat === 'markdown') {
					content.formattedText.forEach((part) => {
						let text = part.text;
						if (part.style?.bold) text = `**${text}**`;
						if (part.style?.italic) text = `*${text}*`;
						compiledContent += text;
					});
					if (i < rtfContents.length - 1) compiledContent += separator;
				} else if (outputFormat === 'html') {
					content.formattedText.forEach((part) => {
						let text = part.text;
						if (part.style?.bold) text = `<b>${text}</b>`;
						if (part.style?.italic) text = `<i>${text}</i>`;
						compiledContent += text;
					});
					if (i < rtfContents.length - 1) compiledContent += separator;
				} else if (outputFormat === 'latex') {
					// LaTeX output format
					content.formattedText.forEach((part) => {
						let text = part.text
							.replace(/\\/g, '\\textbackslash{}')
							.replace(/[{}]/g, '\\$&')
							.replace(/[_%#&$]/g, '\\$&');

						if (part.style?.bold && part.style?.italic) {
							text = `\\textbf{\\textit{${text}}}`;
						} else if (part.style?.bold) {
							text = `\\textbf{${text}}`;
						} else if (part.style?.italic) {
							text = `\\textit{${text}}`;
						}
						compiledContent += text;
					});
					if (i < rtfContents.length - 1) {
						compiledContent += '\n\n\\par\n\n';
					}
				}
			}
		}

		return compiledContent;
	}

	async searchContent(
		query: string,
		options?: { caseSensitive?: boolean; regex?: boolean; searchMetadata?: boolean }
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		if (!this.projectStructure) await this.loadProject();

		const results: Array<{ documentId: string; title: string; matches: string[] }> = [];
		const documents = await this.getAllDocuments();

		for (const doc of documents) {
			if (doc.type === 'Text') {
				const matches: string[] = [];
				let content = '';

				try {
					// Read content for text search
					content = await this.readDocument(doc.id);
					matches.push(...this.findMatches(content, query, options));
				} catch {
					// Skip documents that can't be read
				}

				// Search in metadata if requested
				if (options?.searchMetadata) {
					if (doc.title.toLowerCase().includes(query.toLowerCase())) {
						matches.push(`Title match: ${doc.title}`);
					}
					if (doc.label?.toLowerCase().includes(query.toLowerCase())) {
						matches.push(`Label match: ${doc.label}`);
					}
					if (doc.status?.toLowerCase().includes(query.toLowerCase())) {
						matches.push(`Status match: ${doc.status}`);
					}
					if (doc.synopsis?.toLowerCase().includes(query.toLowerCase())) {
						matches.push(`Synopsis match: ${doc.synopsis}`);
					}
					if (doc.keywords) {
						for (const keyword of doc.keywords) {
							if (keyword.toLowerCase().includes(query.toLowerCase())) {
								matches.push(`Keyword match: ${keyword}`);
							}
						}
					}
				}

				if (matches.length > 0) {
					results.push({
						documentId: doc.id,
						title: doc.title,
						matches,
					});
				}
			}
		}

		return results;
	}

	private findMatches(
		content: string,
		query: string,
		options?: { caseSensitive?: boolean; regex?: boolean }
	): string[] {
		const matches: string[] = [];

		if (options?.regex) {
			const flags = options.caseSensitive ? 'g' : 'gi';
			const regex = new RegExp(query, flags);
			const found = content.match(regex);
			if (found) matches.push(...found);
		} else {
			const searchContent = options?.caseSensitive ? content : content.toLowerCase();
			const searchQuery = options?.caseSensitive ? query : query.toLowerCase();

			let index = searchContent.indexOf(searchQuery);
			while (index !== -1) {
				const contextStart = Math.max(0, index - 50);
				const contextEnd = Math.min(content.length, index + query.length + 50);
				matches.push(content.substring(contextStart, contextEnd));
				index = searchContent.indexOf(searchQuery, index + 1);
			}
		}

		return matches;
	}

	private parseBinderItems(
		items: BinderItem | BinderItem[],
		includeTrash = false
	): ScrivenerDocument[] {
		if (!items) return [];
		if (Array.isArray(items) && items.length === 0) return [];
		const itemArray = Array.isArray(items) ? items : [items];

		// Filter out Trash folder and its contents unless explicitly requested
		const filteredItems = includeTrash
			? itemArray
			: itemArray.filter((item) => item.Type !== 'TrashFolder');

		return filteredItems.map((item) => this.parseBinderItem(item, includeTrash));
	}

	private parseBinderItem(item: BinderItem, includeTrash = false): ScrivenerDocument {
		// With mergeAttrs: true, attributes are directly on the item
		const uuid = item?.UUID || item?.ID || '';

		const itemType = item?.Type;
		const docType: 'Text' | 'Folder' | 'Other' =
			itemType === 'Text' || itemType === 'Folder' ? itemType : 'Other';

		const doc: ScrivenerDocument = {
			id: uuid,
			title: item.Title || 'Untitled',
			type: docType,
			path: this.getDocumentPath(uuid),
			children: [],
		};

		if (item.MetaData) {
			// With explicitArray: false, MetaData is an object
			const metadata = item.MetaData;
			doc.includeInCompile = metadata.IncludeInCompile === 'Yes';
			doc.label = metadata.Label;
			doc.status = metadata.Status;

			// Parse synopsis if present
			if (metadata.Synopsis) {
				doc.synopsis = metadata.Synopsis;
			}

			// Parse notes if present
			if (metadata.Notes) {
				doc.notes = metadata.Notes;
			}

			// Parse keywords if present
			if (metadata.Keywords) {
				// With explicitArray: false, Keywords is a string
				if (typeof metadata.Keywords === 'string') {
					doc.keywords = metadata.Keywords.split(';')
						.map((k: string) => k.trim())
						.filter((k: string) => k);
				}
			}

			if (metadata.CustomMetaData?.MetaDataItem) {
				doc.customMetadata = {};
				const metaItems = Array.isArray(metadata.CustomMetaData.MetaDataItem)
					? metadata.CustomMetaData.MetaDataItem
					: [metadata.CustomMetaData.MetaDataItem];
				metaItems.forEach((mdItem: MetaDataItem) => {
					// With mergeAttrs: true, ID is directly on the item
					const itemId = mdItem.ID || mdItem.id;
					const itemValue = mdItem.Value || mdItem._ || mdItem;
					if (itemId && itemValue && typeof itemValue === 'string') {
						doc.customMetadata![itemId] = itemValue;
					}
				});
			}
		}

		if (item.Children?.BinderItem) {
			// parseBinderItems handles both single items and arrays
			doc.children = this.parseBinderItems(item.Children.BinderItem, includeTrash);
		}

		// Sync document with database (async, don't await to avoid blocking)
		this.syncDocumentToDatabase(doc).catch((error) =>
			console.warn(`Failed to sync document ${doc.id} to database:`, error)
		);

		return doc;
	}

	private getDocumentPath(uuid: string): string {
		return getDocumentPath(this.projectPath, uuid);
	}

	/**
	 * Helper function to safely add an item to a BinderContainer
	 */
	private addToBinderContainer(container: BinderContainer, item: BinderItem): void {
		if (!container.BinderItem) {
			container.BinderItem = [item];
		} else if (Array.isArray(container.BinderItem)) {
			container.BinderItem.push(item);
		} else {
			// If it was a single item, convert to array and add
			container.BinderItem = [container.BinderItem, item];
		}
	}

	/**
	 * Helper function to find a binder item by its UUID.
	 */
	private findBinderItem(container: BinderContainer, uuid: string): BinderItem | null {
		if (!container?.BinderItem) return null;

		// Handle both single item and array cases
		const items = Array.isArray(container.BinderItem)
			? container.BinderItem
			: [container.BinderItem];

		for (const item of items) {
			if (item?.UUID === uuid) return item;
			if (item.Children?.BinderItem) {
				const found = this.findBinderItem(item.Children, uuid);
				if (found) return found;
			}
		}
		return null;
	}

	/**
	 * Helper function to extract and return a binder item by its UUID,
	 * removing it from its current location.
	 */
	private extractBinderItem(container: BinderContainer, uuid: string): BinderItem | null {
		if (!container?.BinderItem) return null;

		// Handle both single item and array cases
		const items = Array.isArray(container.BinderItem)
			? container.BinderItem
			: [container.BinderItem];

		const index = items.findIndex((item: BinderItem) => item?.UUID === uuid);
		if (index !== -1) {
			if (Array.isArray(container.BinderItem)) {
				const [item] = container.BinderItem.splice(index, 1);
				// If array becomes empty, remove the property entirely
				if (container.BinderItem.length === 0) {
					delete container.BinderItem;
				}
				return item;
			} else {
				// If it was a single item, extract it and remove the property
				const item = container.BinderItem as BinderItem;
				delete container.BinderItem;
				return item;
			}
		}

		for (const item of items) {
			if (item.Children?.BinderItem) {
				const extracted = this.extractBinderItem(item.Children, uuid);
				if (extracted) return extracted;
			}
		}
		return null;
	}

	/**
	 * Helper function to delete a binder item by its UUID.
	 */
	private deleteBinderItem(
		container: BinderContainer,
		uuid: string,
		isRoot: boolean = false
	): boolean {
		if (!container?.BinderItem) return false;

		// Handle both single item and array cases
		const items = Array.isArray(container.BinderItem)
			? container.BinderItem
			: [container.BinderItem];

		const index = items.findIndex((item: BinderItem) => item?.UUID === uuid);
		if (index !== -1) {
			if (Array.isArray(container.BinderItem)) {
				container.BinderItem.splice(index, 1);
				// If array becomes empty, remove the property entirely (but not for root Binder)
				if (container.BinderItem.length === 0 && !isRoot) {
					delete container.BinderItem;
				}
			} else {
				// If it was a single item and we're deleting it, remove the property (but not for root Binder)
				if (!isRoot) {
					delete container.BinderItem;
				} else {
					container.BinderItem = [];
				}
			}
			return true;
		}

		for (const item of items) {
			if (item.Children?.BinderItem) {
				if (this.deleteBinderItem(item.Children, uuid)) return true;
			}
		}
		return false;
	}

	/**
	 * Helper function to get a flat list of all documents in the project.
	 */
	async getAllDocuments(includeTrash = false): Promise<ScrivenerDocument[]> {
		const structure = await this.getProjectStructure(includeTrash);
		const allDocs: ScrivenerDocument[] = [];

		const traverse = (docs: ScrivenerDocument[]) => {
			for (const doc of docs) {
				allDocs.push(doc);
				if (doc.children) traverse(doc.children);
			}
		};

		traverse(structure);
		return allDocs;
	}

	/**
	 * Get only documents that are in the Trash folder
	 */
	async getTrashDocuments(): Promise<ScrivenerDocument[]> {
		if (!this.projectStructure) await this.loadProject();

		const binder = this.projectStructure?.ScrivenerProject?.Binder;
		if (!binder) return [];

		// Find the trash folder
		const binderItems = Array.isArray(binder.BinderItem)
			? binder.BinderItem
			: [binder.BinderItem];
		const trashFolder = binderItems.find((item) => item?.Type === 'TrashFolder');

		if (!trashFolder || !trashFolder.Children?.BinderItem) {
			return [];
		}

		// Parse all items in trash, including nested folders
		const trashDocs = this.parseBinderItems(trashFolder.Children.BinderItem, true);
		const allTrashDocs: ScrivenerDocument[] = [];

		const traverse = (docs: ScrivenerDocument[]) => {
			for (const doc of docs) {
				allTrashDocs.push(doc);
				if (doc.children) traverse(doc.children);
			}
		};

		traverse(trashDocs);
		return allTrashDocs;
	}

	/**
	 * Search only within trash documents
	 */
	async searchTrash(
		query: string,
		options?: { caseSensitive?: boolean; regex?: boolean }
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		const results: Array<{ documentId: string; title: string; matches: string[] }> = [];
		const trashDocs = await this.getTrashDocuments();

		for (const doc of trashDocs) {
			if (doc.type === 'Text') {
				const matches: string[] = [];
				try {
					const content = await this.readDocument(doc.id);
					matches.push(...this.findMatches(content, query, options));

					if (matches.length > 0) {
						results.push({
							documentId: doc.id,
							title: `[TRASH] ${doc.title}`,
							matches,
						});
					}
				} catch {
					// Skip documents that can't be read
				}
			}
		}

		return results;
	}

	/**
	 * Recover a document from trash by moving it to a specific location
	 */
	async recoverFromTrash(documentId: string, targetParentId?: string): Promise<void> {
		if (!this.projectStructure) await this.loadProject();

		const binder = this.projectStructure?.ScrivenerProject?.Binder;
		if (!binder) throw new Error('Project structure not loaded');

		// Find the document in trash
		const binderItems = Array.isArray(binder.BinderItem)
			? binder.BinderItem
			: [binder.BinderItem];
		const trashFolder = binderItems.find((item) => item?.Type === 'TrashFolder');

		if (!trashFolder) {
			throw new Error('Trash folder not found');
		}

		// Find and remove the document from trash
		const removedItem = this.removeBinderItem(trashFolder, documentId);
		if (!removedItem) {
			throw new Error(`Document ${documentId} not found in trash`);
		}

		// Add to target location (root binder if no parent specified)
		if (targetParentId) {
			const parent = this.findBinderItem(binder, targetParentId);
			if (!parent || parent.Type !== 'Folder') {
				throw new Error(`Target parent ${targetParentId} not found or is not a folder`);
			}
			if (!parent.Children) parent.Children = { BinderItem: [] };
			if (!parent.Children.BinderItem) parent.Children.BinderItem = [];

			const children = Array.isArray(parent.Children.BinderItem)
				? parent.Children.BinderItem
				: [parent.Children.BinderItem];
			children.push(removedItem);
			parent.Children.BinderItem = children.length === 1 ? children[0] : children;
		} else {
			// Add to root
			const rootItems = Array.isArray(binder.BinderItem)
				? binder.BinderItem
				: [binder.BinderItem];
			const validItems = rootItems.filter((item): item is BinderItem => item !== undefined);
			validItems.splice(validItems.length - 1, 0, removedItem); // Insert before trash folder
			binder.BinderItem = validItems.length === 1 ? validItems[0] : validItems;
		}

		await this.saveProject();
	}

	/**
	 * Helper function to remove a binder item from a container
	 */
	private removeBinderItem(container: BinderItem, targetId: string): BinderItem | null {
		if (!container.Children?.BinderItem) return null;

		const items = Array.isArray(container.Children.BinderItem)
			? container.Children.BinderItem
			: [container.Children.BinderItem];

		const index = items.findIndex((item) => item.UUID === targetId || item.ID === targetId);
		if (index !== -1) {
			const removed = items.splice(index, 1)[0];
			container.Children.BinderItem =
				items.length === 0 ? [] : items.length === 1 ? items[0] : items;
			return removed;
		}

		// Search recursively in children
		for (const item of items) {
			if (item.Children?.BinderItem) {
				const found = this.removeBinderItem(item, targetId);
				if (found) return found;
			}
		}

		return null;
	}

	/**
	 * Get detailed information about a document including its parent hierarchy
	 */
	async getDocumentInfo(documentId: string): Promise<{
		document: ScrivenerDocument | null;
		path: Array<{ id: string; title: string; type: string }>;
		metadata: Record<string, unknown>;
		location: 'active' | 'trash' | 'unknown';
	}> {
		if (!this.projectStructure) await this.loadProject();

		// Check in active documents
		const structure = await this.getProjectStructure(false);
		let foundDoc: ScrivenerDocument | null = null;
		let path: Array<{ id: string; title: string; type: string }> = [];
		let location: 'active' | 'trash' | 'unknown' = 'unknown';

		// Helper to search and build path
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
		} else {
			// Check in trash
			const trashDocs = await this.getTrashDocuments();
			if (searchInDocs(trashDocs, [{ id: 'TRASH', title: 'Trash', type: 'TrashFolder' }])) {
				location = 'trash';
			}
		}

		const metadata: Record<string, unknown> = {};
		if (foundDoc !== null) {
			const doc = foundDoc as ScrivenerDocument;
			metadata.label = doc.label;
			metadata.status = doc.status;
			metadata.synopsis = doc.synopsis;
			metadata.notes = doc.notes;
			metadata.includeInCompile = doc.includeInCompile;
			if (doc.customMetadata) {
				Object.assign(metadata, doc.customMetadata);
			}
		}

		return {
			document: foundDoc,
			path,
			metadata,
			location,
		};
	}

	/**
	 * Get structure with options for limiting response size
	 */
	async getProjectStructureLimited(options?: {
		maxDepth?: number;
		folderId?: string;
		includeTrash?: boolean;
		summaryOnly?: boolean;
	}): Promise<
		| ScrivenerDocument[]
		| { totalDocuments: number; folders: number; texts: number; tree: ScrivenerDocument[] }
	> {
		const {
			maxDepth = Infinity,
			folderId,
			includeTrash = false,
			summaryOnly = false,
		} = options || {};

		let structure = await this.getProjectStructure(includeTrash);

		// If specific folder requested, find and return only that branch
		if (folderId) {
			const findFolder = (docs: ScrivenerDocument[]): ScrivenerDocument | null => {
				for (const doc of docs) {
					if (doc.id === folderId) return doc;
					if (doc.children) {
						const found = findFolder(doc.children);
						if (found) return found;
					}
				}
				return null;
			};

			const folder = findFolder(structure);
			structure = folder ? [folder] : [];
		}

		// Apply depth limit
		if (maxDepth < Infinity) {
			const limitDepth = (
				docs: ScrivenerDocument[],
				currentDepth: number
			): ScrivenerDocument[] => {
				return docs.map((doc) => ({
					...doc,
					children:
						currentDepth < maxDepth && doc.children
							? limitDepth(doc.children, currentDepth + 1)
							: undefined,
				}));
			};
			structure = limitDepth(structure, 1);
		}

		// Return summary if requested
		if (summaryOnly) {
			let totalDocuments = 0;
			let folders = 0;
			let texts = 0;

			const count = (docs: ScrivenerDocument[]) => {
				for (const doc of docs) {
					totalDocuments++;
					if (doc.type === 'Folder') folders++;
					if (doc.type === 'Text') texts++;
					if (doc.children) count(doc.children);
				}
			};

			count(structure);

			return {
				totalDocuments,
				folders,
				texts,
				tree: structure.map((doc) => ({
					...doc,
					children: doc.children ? [] : undefined, // Empty children for summary
				})),
			};
		}

		return structure;
	}

	/**
	 * Helper function to update the modification date of an item.
	 */
	private updateModifiedDate(item: BinderItem): void {
		if (!item.MetaData) {
			item.MetaData = {};
		}
		item.MetaData.Modified = new Date().toISOString();
	}

	/**
	 * Gets Scrivener annotations from a document.
	 * @param documentId The UUID of the document.
	 * @returns A Map of annotation IDs to their content.
	 */
	async getDocumentAnnotations(documentId: string): Promise<Map<string, string>> {
		const docPath = this.getDocumentPath(documentId);
		try {
			const rtfContent = await fs.readFile(docPath, 'utf-8');
			return this.rtfHandler.preserveScrivenerAnnotations(rtfContent);
		} catch (error) {
			const err = error as ErrorWithCode;
			if (err.code === 'ENOENT') {
				throw new Error(
					`Document file not found for ${documentId}. The document may not have content yet.`
				);
			} else {
				throw new Error(
					`Failed to get annotations for document ${documentId}: ${err.message || String(error)}`
				);
			}
		}
	}

	/**
	 * Gets project-level metadata.
	 * @returns Project metadata including title, author, and targets.
	 */
	async getProjectMetadata(): Promise<ScrivenerMetadata> {
		if (!this.projectStructure) await this.loadProject();

		const metadata: ScrivenerMetadata = {};
		const project = this.projectStructure?.ScrivenerProject;

		if (project?.ProjectSettings) {
			const settings = project.ProjectSettings;
			metadata.title = settings.ProjectTitle;
			metadata.author = settings.FullName || settings.Author;
		}

		if (project?.ProjectTargets) {
			const targets = project.ProjectTargets;
			metadata.projectTargets = {
				draft: targets.DraftTarget ? parseInt(targets.DraftTarget) : undefined,
				session: targets.SessionTarget ? parseInt(targets.SessionTarget) : undefined,
				deadline: targets.Deadline,
			};
		}

		return metadata;
	}

	/**
	 * Perform initial sync after project load
	 */
	private async performInitialSync(): Promise<void> {
		try {
			console.log('Performing initial database sync...');

			// Sync all documents to database
			const allDocs = await this.getAllDocuments();
			for (const doc of allDocs) {
				await this.syncDocumentToDatabase(doc);
			}

			// Trigger initial context generation
			if (this.contextSync) {
				await this.contextSync.performSync();
			}

			console.log('Initial sync completed');
		} catch (error) {
			console.error('Initial sync failed:', error);
			// Don't throw - allow project to continue even if sync fails
		}
	}

	/**
	 * Get enhanced analyzer
	 */
	getEnhancedAnalyzer(): EnhancedAnalyzer | undefined {
		return this.enhancedAnalyzer;
	}

	/**
	 * Get context sync service
	 */
	getContextSync(): ContextSyncService | undefined {
		return this.contextSync;
	}

	/**
	 * Analyze chapter with enhanced analysis
	 */
	async analyzeChapterEnhanced(documentId: string): Promise<any> {
		if (!this.enhancedAnalyzer) {
			throw new Error('Enhanced analyzer not initialized');
		}

		const document = await this.getDocumentInfo(documentId);
		if (!document) {
			throw new Error(`Document ${documentId} not found`);
		}

		const content = await this.readDocument(documentId);
		const allDocuments = await this.getAllDocuments();

		return await this.enhancedAnalyzer.analyzeChapter(
			document as any,
			content,
			allDocuments as any[]
		);
	}

	/**
	 * Build complete story context
	 */
	async buildStoryContext(): Promise<any> {
		if (!this.enhancedAnalyzer) {
			throw new Error('Enhanced analyzer not initialized');
		}

		const documents = await this.getAllDocuments();
		const contexts = [];

		for (const doc of documents) {
			if (doc.type === 'Text') {
				const context = await this.enhancedAnalyzer.getChapterContext(doc.id);
				if (context) {
					contexts.push(context);
				}
			}
		}

		return await this.enhancedAnalyzer.buildStoryContext(documents as any[], contexts);
	}

	/**
	 * Get sync status
	 */
	getSyncStatus(): any {
		if (!this.contextSync) {
			return {
				enabled: false,
				message: 'Context sync not initialized',
			};
		}

		return this.contextSync.getSyncStatus();
	}

	/**
	 * Mark document as changed for sync
	 */
	markDocumentChanged(documentId: string): void {
		if (this.contextSync) {
			this.contextSync.markDocumentChanged(documentId);
		}
	}

	/**
	 * Export context files
	 */
	async exportContextFiles(exportPath: string): Promise<void> {
		if (!this.contextSync) {
			throw new Error('Context sync not initialized');
		}

		await this.contextSync.exportContextFiles(exportPath);
	}

	/**
	 * Close project and cleanup
	 */
	async close(): Promise<void> {
		// Stop context sync
		if (this.contextSync) {
			this.contextSync.close();
		}

		// Close database connections
		await this.databaseService.close();

		// Clear cache
		this.documentCache.clear();
	}
}
