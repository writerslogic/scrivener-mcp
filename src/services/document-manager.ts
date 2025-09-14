/**
 * Document management service for Scrivener projects
 */

import * as path from 'path';
import { LRUCache } from '../core/cache.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { ScrivenerDocument } from '../types/index.js';
import type {
	BinderContainer,
	BinderItem,
	MetaDataItem,
	ProjectStructure,
} from '../types/internal.js';
import {
	ensureDir,
	handleError,
	isValidUUID,
	safeReadFile,
	truncate,
	validateInput,
} from '../utils/common.js';
import { generateScrivenerUUID, getDocumentPath } from '../utils/scrivener-utils.js';
import { FileUtils, PathUtils } from '../utils/shared-patterns.js';
import {
	addBinderItem,
	findBinderItemById,
	iterateBinderItems,
	removeBinderItem,
	validateProjectStructure,
} from './document-manager-helpers.js';
import type { RTFContent } from './parsers/rtf-handler.js';
import { RTFHandler } from './parsers/rtf-handler.js';

const logger = getLogger('document-manager');

export class DocumentManager {
	private projectPath: string;
	private rtfHandler: RTFHandler;
	private documentCache: LRUCache<RTFContent>;
	private projectStructure?: ProjectStructure;
	private operationQueue: Map<string, Promise<unknown>>;
	private readonly batchSize = 10;
	private pendingWrites: Map<string, { content: RTFContent | string; timestamp: number }>;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
		this.rtfHandler = new RTFHandler();
		this.documentCache = new LRUCache<RTFContent>({
			ttl: 5 * 60 * 1000, // 5 minutes
			maxEntries: 50,
			onEvict: (key, _value) => {
				logger.debug(`Document ${key} evicted from cache`);
			},
		});
		this.operationQueue = new Map();
		this.pendingWrites = new Map();

		// Auto-flush pending writes every 5 seconds
		setInterval(() => this.flushPendingWrites(), 5000);
	}

	setProjectStructure(structure: ProjectStructure): void {
		this.projectStructure = structure;
	}

	getProjectStructureData(): ProjectStructure | undefined {
		return this.projectStructure;
	}

	/**
	 * Read document content with deduplication
	 */
	async readDocument(documentId: string): Promise<string> {
		try {
			// Validate input
			validateInput(
				{ documentId },
				{
					documentId: { type: 'string', required: true },
				}
			);

			if (!isValidUUID(documentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Invalid document ID format'
				);
			}

			return this.dedupedOperation(`read:${documentId}`, async () => {
				const rtfContent = await this.readDocumentFormatted(documentId);
				return rtfContent.plainText || '';
			});
		} catch (error) {
			throw handleError(error, 'readDocument');
		}
	}

	/**
	 * Deduplicate operations to prevent redundant work
	 */
	private async dedupedOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
		if (this.operationQueue.has(key)) {
			return this.operationQueue.get(key) as Promise<T>;
		}

		const promise = operation().finally(() => {
			this.operationQueue.delete(key);
		});

		this.operationQueue.set(key, promise);
		return promise;
	}

	/**
	 * Read raw RTF document content (for annotation extraction)
	 */
	async readDocumentRaw(documentId: string): Promise<string> {
		const filePath = getDocumentPath(this.projectPath, documentId);
		logger.debug(`Reading raw document from ${filePath}`);

		try {
			if (await FileUtils.exists(filePath)) {
				return await safeReadFile(filePath, 'utf-8');
			} else {
				logger.warn(`Document ${documentId} not found at ${filePath}`);
				return '';
			}
		} catch (error) {
			logger.error(`Error reading document ${documentId}:`, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * Read document with formatting preserved
	 */
	async readDocumentFormatted(documentId: string): Promise<RTFContent> {
		try {
			// Validate input
			validateInput(
				{ documentId },
				{
					documentId: { type: 'string', required: true },
				}
			);

			if (!isValidUUID(documentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Invalid document ID format'
				);
			}

			const cacheKey = `doc:${documentId}`;
			const cached = this.documentCache.get(cacheKey);

			if (cached) {
				logger.debug(`Cache hit for document ${documentId}`);
				return cached;
			}

			// Use PathUtils for path operations
			const filePath = PathUtils.build(
				this.projectPath,
				'Files',
				'Data',
				`${documentId}`,
				'content.rtf'
			);
			logger.debug(`Reading document from ${filePath}`);

			const rtfString = await safeReadFile(filePath, 'utf-8');
			const rtfContent = await this.rtfHandler.parseRTF(rtfString);
			this.documentCache.set(cacheKey, rtfContent);
			return rtfContent;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				logger.warn(`Document ${documentId} not found`);
				return {
					plainText: '',
					formattedText: [],
					metadata: {},
				};
			}
			throw handleError(error, 'readDocumentFormatted');
		}
	}

	/**
	 * Write document content with batching and deduplication
	 */
	async writeDocument(
		documentId: string,
		content: string | RTFContent,
		immediate = false
	): Promise<void> {
		if (immediate) {
			return this.writeDocumentImmediate(documentId, content);
		}

		// Queue for batch writing
		this.pendingWrites.set(documentId, {
			content,
			timestamp: Date.now(),
		});

		// Flush if queue is full
		if (this.pendingWrites.size >= this.batchSize) {
			await this.flushPendingWrites();
		}
	}

	/**
	 * Write document immediately
	 */
	private async writeDocumentImmediate(
		documentId: string,
		content: string | RTFContent
	): Promise<void> {
		return this.dedupedOperation(`write:${documentId}`, async () => {
			const filePath = getDocumentPath(this.projectPath, documentId);
			logger.debug(`Writing document to ${filePath}`);

			// Ensure the directory exists
			const dir = path.dirname(filePath);
			await ensureDir(dir);

			// Convert to RTF if needed
			let rtfContent: RTFContent;
			if (typeof content === 'string') {
				rtfContent = {
					plainText: content,
					formattedText: [],
					metadata: {},
				};
			} else {
				rtfContent = content;
			}

			await this.rtfHandler.writeRTF(filePath, rtfContent);

			// Update cache
			const cacheKey = `doc:${documentId}`;
			this.documentCache.set(cacheKey, rtfContent);
		});
	}

	/**
	 * Flush pending writes in batches
	 */
	private async flushPendingWrites(): Promise<void> {
		if (this.pendingWrites.size === 0) return;

		const writes = Array.from(this.pendingWrites.entries());
		this.pendingWrites.clear();

		// Process in parallel batches
		const batches = [];
		for (let i = 0; i < writes.length; i += this.batchSize) {
			batches.push(writes.slice(i, i + this.batchSize));
		}

		for (const batch of batches) {
			await Promise.all(
				batch.map(([documentId, { content }]) =>
					this.writeDocumentImmediate(documentId, content)
				)
			);
		}
	}

	/**
	 * Create a new document
	 */
	async createDocument(
		title: string,
		content = '',
		parentId?: string,
		type: 'Text' | 'Folder' = DOCUMENT_TYPES.TEXT
	): Promise<string> {
		try {
			// Validate input using utility functions
			validateInput(
				{ title, content, parentId, type },
				{
					title: { type: 'string', required: true, minLength: 1, maxLength: 255 },
					content: { type: 'string', required: false, maxLength: 10000000 },
					parentId: { type: 'string', required: false },
					type: { type: 'string', required: false },
				}
			);

			// Validate project structure
			validateProjectStructure(this.projectStructure);

			const binder = this.projectStructure!.ScrivenerProject.Binder;
			const id = generateScrivenerUUID();
			const sanitizedTitle = truncate(title, 255);

			// Create the document file if it's a text document
			if (type === DOCUMENT_TYPES.TEXT) {
				await this.writeDocument(id, content);
			}

			// Create the binder item
			const newItem: BinderItem = {
				UUID: id,
				Type: type,
				Title: sanitizedTitle,
				MetaData: {},
			};

			// Use utility function to add binder item
			addBinderItem(binder, newItem, parentId ? parseInt(parentId, 10) : undefined);

			logger.info(`Created document ${id} with title "${sanitizedTitle}"`);
			return id;
		} catch (error) {
			throw handleError(error, 'createDocument');
		}
	}

	/**
	 * Delete a document (move to trash)
	 */
	async deleteDocument(documentId: string): Promise<void> {
		try {
			// Validate input
			validateInput(
				{ documentId },
				{
					documentId: { type: 'string', required: true },
				}
			);

			if (!isValidUUID(documentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Invalid document ID format'
				);
			}

			if (!this.projectStructure?.ScrivenerProject?.Binder) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
			}

			const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;

			// Use utility function to remove binder item
			const removed = removeBinderItem(binder, documentId);

			if (!removed) {
				throw createError(
					ErrorCode.NOT_FOUND,
					{ documentId },
					`Document ${documentId} not found`
				);
			}

			// Move to trash - ensure SearchResults is an array
			const searchResults = Array.isArray(binder.SearchResults)
				? binder.SearchResults
				: binder.SearchResults
					? [binder.SearchResults]
					: [];

			if (searchResults.length === 0) {
				searchResults.push({ Children: { BinderItem: [] } });
				binder.SearchResults = searchResults;
			} else if (!searchResults[0].Children) {
				searchResults[0].Children = { BinderItem: [] };
			}

			const trashContainer = searchResults[0].Children!;
			if (!trashContainer.BinderItem) {
				trashContainer.BinderItem = [];
			} else if (!Array.isArray(trashContainer.BinderItem)) {
				trashContainer.BinderItem = [trashContainer.BinderItem];
			}

			(trashContainer.BinderItem as BinderItem[]).push(removed);
			logger.info(`Document ${documentId} moved to trash`);
		} catch (error) {
			throw handleError(error, 'deleteDocument');
		}
	}

	/**
	 * Rename a document
	 */
	async renameDocument(documentId: string, newTitle: string): Promise<void> {
		try {
			// Validate input
			validateInput(
				{ documentId, newTitle },
				{
					documentId: { type: 'string', required: true },
					newTitle: { type: 'string', required: true, minLength: 1, maxLength: 255 },
				}
			);

			if (!isValidUUID(documentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Invalid document ID format'
				);
			}

			if (!this.projectStructure?.ScrivenerProject?.Binder) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
			}

			const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;

			// Use utility function to find binder item
			const item = findBinderItemById(binder, documentId);

			if (!item) {
				throw createError(
					ErrorCode.NOT_FOUND,
					{ documentId },
					`Document ${documentId} not found`
				);
			}

			const sanitizedTitle = truncate(newTitle, 255);
			item.Title = sanitizedTitle;
			logger.info(`Document ${documentId} renamed to "${sanitizedTitle}"`);
		} catch (error) {
			throw handleError(error, 'renameDocument');
		}
	}

	/**
	 * Move a document to a different parent
	 */
	async moveDocument(documentId: string, newParentId: string | null): Promise<void> {
		try {
			// Validate input
			validateInput(
				{ documentId, newParentId },
				{
					documentId: { type: 'string', required: true },
					newParentId: { type: 'string', required: false },
				}
			);

			if (!isValidUUID(documentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Invalid document ID format'
				);
			}

			if (newParentId && !isValidUUID(newParentId)) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ newParentId },
					'Invalid parent ID format'
				);
			}

			if (!this.projectStructure?.ScrivenerProject?.Binder) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
			}

			const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;

			if (documentId === newParentId) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId, newParentId },
					'Cannot move document to itself'
				);
			}

			// Use utility function to remove and add binder item
			const extractedItem = removeBinderItem(binder, documentId);
			if (!extractedItem) {
				throw createError(
					ErrorCode.NOT_FOUND,
					{ documentId },
					`Document ${documentId} not found`
				);
			}

			// Use utility function to add to new location
			addBinderItem(
				binder,
				extractedItem,
				newParentId ? parseInt(newParentId, 10) : undefined
			);

			logger.info(`Document ${documentId} moved to parent ${newParentId || 'root'}`);
		} catch (error) {
			throw handleError(error, 'moveDocument');
		}
	}

	/**
	 * Recover a document from trash
	 */
	async recoverFromTrash(documentId: string, targetParentId?: string): Promise<void> {
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;

		// Find and remove from trash
		const searchResults = Array.isArray(binder.SearchResults)
			? binder.SearchResults
			: binder.SearchResults
				? [binder.SearchResults]
				: [];

		if (!searchResults[0]?.Children?.BinderItem) {
			throw createError(ErrorCode.NOT_FOUND, undefined, 'Trash is empty');
		}

		const trashItems = searchResults[0].Children.BinderItem;
		// Ensure trashItems is an array
		const trashArray = Array.isArray(trashItems) ? trashItems : [trashItems];

		// Check if trash is empty
		if (trashArray.length === 0) {
			throw createError(ErrorCode.NOT_FOUND, undefined, 'Trash is empty');
		}

		const itemIndex = trashArray.findIndex(
			(item) =>
				(item as BinderItem).UUID === documentId || (item as BinderItem).ID === documentId
		);

		if (itemIndex === -1) {
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Document ${documentId} not found in trash`
			);
		}

		const recoveredItem = trashArray.splice(itemIndex, 1)[0];
		// Update the trash with the modified array
		searchResults[0].Children!.BinderItem = trashArray;

		// Place in target location or root
		if (targetParentId) {
			const targetParent = findBinderItemById(binder, targetParentId);
			if (!targetParent || targetParent.Type !== DOCUMENT_TYPES.FOLDER) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Target parent folder ${targetParentId} not found`
				);
			}
			if (!targetParent.Children) {
				targetParent.Children = { BinderItem: [] };
			}
			if (!targetParent.Children.BinderItem) {
				targetParent.Children.BinderItem = [];
			} else if (!Array.isArray(targetParent.Children.BinderItem)) {
				// Convert single item to array
				targetParent.Children.BinderItem = [targetParent.Children.BinderItem];
			}
			(targetParent.Children.BinderItem as BinderItem[]).push(recoveredItem);
		} else {
			// Restore to root level
			const binderItems = Array.isArray(binder.BinderItem)
				? binder.BinderItem
				: binder.BinderItem
					? [binder.BinderItem]
					: [];

			if (!binderItems[0]?.Children?.BinderItem) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Root container not found');
			}
			// Ensure BinderItem is an array
			if (!Array.isArray(binderItems[0].Children.BinderItem)) {
				binderItems[0].Children.BinderItem = [binderItems[0].Children.BinderItem];
			}
			(binderItems[0].Children.BinderItem as BinderItem[]).push(recoveredItem);
		}

		logger.info(
			`Document ${documentId} recovered from trash to parent ${targetParentId || 'root'}`
		);
	}

	/**
	 * Get word count for a document
	 */
	async getWordCount(documentId?: string): Promise<{ words: number; characters: number }> {
		try {
			// Validate input if provided
			if (documentId) {
				validateInput(
					{ documentId },
					{
						documentId: { type: 'string', required: true },
					}
				);

				if (!isValidUUID(documentId)) {
					throw createError(
						ErrorCode.INVALID_INPUT,
						{ documentId },
						'Invalid document ID format'
					);
				}
			}

			let totalWords = 0;
			let totalChars = 0;

			if (documentId) {
				const content = await this.readDocument(documentId);
				const words = content
					.trim()
					.split(/\s+/)
					.filter((w) => w.length > 0);
				totalWords = words.length;
				totalChars = content.length;
			} else {
				// Count all documents using AsyncUtils for better performance
				const documents = await this.getAllDocuments();
				const textDocuments = documents.filter(
					(doc) => doc.type === DOCUMENT_TYPES.TEXT && doc.id
				);

				// Process documents in batches
				const results: Array<{ words: number; characters: number }> = [];
				for (let i = 0; i < textDocuments.length; i += this.batchSize) {
					const batch = textDocuments.slice(i, i + this.batchSize);
					const batchPromises = batch.map(async (doc: ScrivenerDocument) => {
						const content = await this.readDocument(doc.id!);
						const words = content
							.trim()
							.split(/\s+/)
							.filter((w) => w.length > 0);
						return { words: words.length, characters: content.length };
					});
					const batchResults = await Promise.all(batchPromises);
					results.push(...batchResults);
				}

				// Sum up results
				for (const result of results) {
					totalWords += result.words;
					totalChars += result.characters;
				}
			}

			return { words: totalWords, characters: totalChars };
		} catch (error) {
			throw handleError(error, 'getWordCount');
		}
	}

	/**
	 * Get all documents in the project
	 */
	async getAllDocuments(includeTrash = false): Promise<ScrivenerDocument[]> {
		try {
			await this.getProjectStructure(includeTrash);
			const flatList: ScrivenerDocument[] = [];

			// Use utility function to iterate through binder items
			if (this.projectStructure?.ScrivenerProject?.Binder) {
				const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;

				// Iterate through all binder items using utility function
				const generator = iterateBinderItems(binder);
				let result = generator.next();
				while (!result.done) {
					const item = result.value;
					const doc = this.binderItemToDocument(item, '');
					flatList.push(doc);
					result = generator.next();
				}

				// Include trash if requested
				if (includeTrash && binder.SearchResults) {
					const searchResults = Array.isArray(binder.SearchResults)
						? binder.SearchResults
						: [binder.SearchResults];

					for (const searchResult of searchResults) {
						if (searchResult.Children) {
							const trashGenerator = iterateBinderItems(searchResult.Children);
							let trashResult = trashGenerator.next();
							while (!trashResult.done) {
								const item = trashResult.value;
								const doc = this.binderItemToDocument(item, 'Trash/');
								flatList.push(doc);
								trashResult = trashGenerator.next();
							}
						}
					}
				}
			}

			return flatList;
		} catch (error) {
			throw handleError(error, 'getAllDocuments');
		}
	}

	/**
	 * Get project structure as hierarchical documents
	 */
	async getProjectStructure(includeTrash = false): Promise<ScrivenerDocument[]> {
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;
		const documents: ScrivenerDocument[] = [];

		const binderItems = Array.isArray(binder.BinderItem)
			? binder.BinderItem
			: binder.BinderItem
				? [binder.BinderItem]
				: [];

		if (binderItems[0]?.Children?.BinderItem) {
			this.buildDocumentTree(binderItems[0].Children, documents, '');
		}

		if (includeTrash) {
			const searchResults = Array.isArray(binder.SearchResults)
				? binder.SearchResults
				: binder.SearchResults
					? [binder.SearchResults]
					: [];

			if (searchResults[0]?.Children?.BinderItem) {
				this.buildDocumentTree(searchResults[0].Children, documents, 'Trash/');
			}
		}

		return documents;
	}

	/**
	 * Clear document cache
	 */
	clearCache(documentId?: string): void {
		if (documentId) {
			this.documentCache.delete(`doc:${documentId}`);
		} else {
			this.documentCache.clear();
		}
	}

	/**
	 * Clean up resources
	 */
	async close(): Promise<void> {
		this.documentCache.clear();
	}

	// Private helper methods
	private buildDocumentTree(
		container: BinderContainer,
		documents: ScrivenerDocument[],
		parentPath: string
	): void {
		if (!container.BinderItem) return;

		const items = Array.isArray(container.BinderItem)
			? container.BinderItem
			: [container.BinderItem];
		for (const item of items) {
			const doc = this.binderItemToDocument(item, parentPath);
			documents.push(doc);

			if (item.Children?.BinderItem) {
				const childPath = `${parentPath}${item.Title}/`;
				doc.children = [];
				this.buildDocumentTree(item.Children, doc.children, childPath);
			}
		}
	}

	private binderItemToDocument(item: BinderItem, parentPath: string): ScrivenerDocument {
		const doc: ScrivenerDocument = {
			id: item.UUID || '',
			title: item.Title || 'Untitled',
			type: item.Type as
				| typeof DOCUMENT_TYPES.TEXT
				| typeof DOCUMENT_TYPES.FOLDER
				| typeof DOCUMENT_TYPES.OTHER,
			path: `${parentPath}${item.Title}`,
		};

		if (item.MetaData) {
			const metadata = Array.isArray(item.MetaData)
				? item.MetaData[0]
				: (item.MetaData as MetaDataItem);

			if (metadata.Synopsis) {
				doc.synopsis = metadata.Synopsis;
			}

			if (metadata.Notes) {
				doc.notes = metadata.Notes;
			}

			if (metadata.Keywords) {
				doc.keywords =
					typeof metadata.Keywords === 'string' ? [metadata.Keywords] : metadata.Keywords;
			}

			if (metadata.CustomMetaData?.MetaDataItem) {
				doc.customMetadata = {};
				const items = Array.isArray(metadata.CustomMetaData.MetaDataItem)
					? metadata.CustomMetaData.MetaDataItem
					: [metadata.CustomMetaData.MetaDataItem];

				for (const customItem of items) {
					const itemId = customItem.ID;
					const itemValue = customItem.Value;
					if (itemId && itemValue && typeof itemValue === 'string') {
						doc.customMetadata[itemId] = itemValue;
					}
				}
			}
		}

		return doc;
	}

	// Removed private findBinderItem - now using utility function findBinderItemById

	// Removed private removeBinderItem - now using utility function removeBinderItem
}
