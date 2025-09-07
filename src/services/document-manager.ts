/**
 * Document management service for Scrivener projects
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { RTFContent } from './parsers/rtf-handler.js';
import { RTFHandler } from './parsers/rtf-handler.js';
import { LRUCache } from '../core/cache.js';
import { getLogger } from '../core/logger.js';
import { getDocumentPath, generateScrivenerUUID } from '../utils/scrivener-utils.js';
import type {
	ProjectStructure,
	BinderItem,
	BinderContainer,
	MetaDataItem,
} from '../types/internal.js';
import type { ScrivenerDocument } from '../types/index.js';
import { createError, ErrorCode } from '../core/errors.js';
import { DOCUMENT_TYPES } from '../core/constants.js';

const logger = getLogger('document-manager');

export class DocumentManager {
	private projectPath: string;
	private rtfHandler: RTFHandler;
	private documentCache: LRUCache<RTFContent>;
	private projectStructure?: ProjectStructure;

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
	}

	setProjectStructure(structure: ProjectStructure): void {
		this.projectStructure = structure;
	}

	/**
	 * Read document content
	 */
	async readDocument(documentId: string): Promise<string> {
		const rtfContent = await this.readDocumentFormatted(documentId);
		return rtfContent.plainText || '';
	}

	/**
	 * Read document with formatting preserved
	 */
	async readDocumentFormatted(documentId: string): Promise<RTFContent> {
		const cacheKey = `doc:${documentId}`;
		const cached = this.documentCache.get(cacheKey);

		if (cached) {
			logger.debug(`Cache hit for document ${documentId}`);
			return cached;
		}

		const filePath = getDocumentPath(this.projectPath, documentId);
		logger.debug(`Reading document from ${filePath}`);

		try {
			const rtfString = await fs.readFile(filePath, 'utf-8');
			const rtfContent = await this.rtfHandler.parseRTF(rtfString);
			this.documentCache.set(cacheKey, rtfContent);
			return rtfContent;
		} catch (error: any) {
			if (error.code === 'ENOENT') {
				logger.warn(`Document ${documentId} not found at ${filePath}`);
				return {
					plainText: '',
					formattedText: [],
					metadata: {},
				};
			}
			throw error;
		}
	}

	/**
	 * Write document content
	 */
	async writeDocument(documentId: string, content: string | RTFContent): Promise<void> {
		const filePath = getDocumentPath(this.projectPath, documentId);
		logger.debug(`Writing document to ${filePath}`);

		// Ensure the directory exists
		const dir = path.dirname(filePath);
		await fs.mkdir(dir, { recursive: true });

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
		return; // writeRTF handles the file writing
		// File writing handled by writeRTF

		// Invalidate cache
		this.documentCache.delete(`doc:${documentId}`);
		logger.debug(`Document ${documentId} written successfully`);
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
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as any;
		const id = generateScrivenerUUID();

		// Create the document file if it's a text document
		if (type === DOCUMENT_TYPES.TEXT) {
			await this.writeDocument(id, content);
		}

		// Create the binder item
		const newItem: BinderItem = {
			UUID: id,
			Type: type,
			Title: title,
			MetaData: {},
		};

		// Find parent container
		let targetContainer: BinderContainer | undefined;
		if (parentId) {
			const parent = this.findBinderItem(parentId, binder);
			if (!parent || parent?.Type !== DOCUMENT_TYPES.FOLDER) {
				throw createError(ErrorCode.NOT_FOUND, `Parent folder ${parentId} not found`);
			}
			if (!parent.Children) {
				parent.Children = { BinderItem: [] };
			}
			targetContainer = parent.Children;
		} else {
			targetContainer = binder.BinderItem?.[0]?.Children;
		}

		if (!targetContainer) {
			throw createError(ErrorCode.INVALID_STATE, 'Could not find target container');
		}

		if (!targetContainer.BinderItem) {
			targetContainer.BinderItem = [];
		}

		if (Array.isArray(targetContainer.BinderItem)) {
			targetContainer.BinderItem.push(newItem);
		} else {
			targetContainer.BinderItem = [targetContainer.BinderItem, newItem];
		}
		logger.info(`Created document ${id} with title "${title}"`);
		return id;
	}

	/**
	 * Delete a document (move to trash)
	 */
	async deleteDocument(documentId: string): Promise<void> {
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as any;
		const removed = this.removeBinderItem(documentId, binder);

		if (!removed) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		// Move to trash
		if (!binder.SearchResults?.[0]?.Children) {
			if (!binder.SearchResults) {
				binder.SearchResults = [{ Children: { BinderItem: [] } }];
			} else if (!binder.SearchResults[0].Children) {
				binder.SearchResults[0].Children = { BinderItem: [] };
			}
		}

		if (!binder.SearchResults[0].Children.BinderItem) {
			binder.SearchResults[0].Children.BinderItem = [];
		}

		binder.SearchResults[0].Children.BinderItem.push(removed);
		logger.info(`Document ${documentId} moved to trash`);
	}

	/**
	 * Rename a document
	 */
	async renameDocument(documentId: string, newTitle: string): Promise<void> {
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as any;
		const item = this.findBinderItem(documentId, binder);

		if (!item) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		item.Title = newTitle;
		logger.info(`Document ${documentId} renamed to "${newTitle}"`);
	}

	/**
	 * Move a document to a different parent
	 */
	async moveDocument(documentId: string, newParentId: string | null): Promise<void> {
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as any;

		if (documentId === newParentId) {
			throw createError(ErrorCode.INVALID_INPUT, 'Cannot move document to itself');
		}

		const extractedItem = this.removeBinderItem(documentId, binder);
		if (!extractedItem) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		if (newParentId) {
			const newParent = this.findBinderItem(newParentId, binder);
			if (!newParent || newParent?.Type !== DOCUMENT_TYPES.FOLDER) {
				throw createError(ErrorCode.NOT_FOUND, `Parent folder ${newParentId} not found`);
			}
			if (!newParent.Children) {
				newParent.Children = { BinderItem: [] };
			}
			if (!newParent.Children.BinderItem) {
				newParent.Children.BinderItem = [];
			}
			if (Array.isArray(newParent.Children.BinderItem)) {
				newParent.Children.BinderItem.push(extractedItem);
			} else {
				newParent.Children.BinderItem = [newParent.Children.BinderItem, extractedItem];
			}
		} else {
			// Move to root
			if (!binder.BinderItem?.[0]?.Children?.BinderItem) {
				throw createError(ErrorCode.INVALID_STATE, 'Root container not found');
			}
			binder.BinderItem[0].Children.BinderItem.push(extractedItem);
		}

		logger.info(`Document ${documentId} moved to parent ${newParentId || 'root'}`);
	}

	/**
	 * Get word count for a document
	 */
	async getWordCount(documentId?: string): Promise<{ words: number; characters: number }> {
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
			// Count all documents
			const documents = await this.getAllDocuments();
			for (const doc of documents) {
				if (doc.type === DOCUMENT_TYPES.TEXT && doc.id) {
					const content = await this.readDocument(doc.id);
					const words = content
						.trim()
						.split(/\s+/)
						.filter((w) => w.length > 0);
					totalWords += words.length;
					totalChars += content.length;
				}
			}
		}

		return { words: totalWords, characters: totalChars };
	}

	/**
	 * Get all documents in the project
	 */
	async getAllDocuments(includeTrash = false): Promise<ScrivenerDocument[]> {
		const structure = await this.getProjectStructure(includeTrash);
		const flatList: ScrivenerDocument[] = [];

		const flatten = (docs: ScrivenerDocument[]) => {
			for (const doc of docs) {
				flatList.push(doc);
				if (doc.children) {
					flatten(doc.children);
				}
			}
		};

		flatten(structure);
		return flatList;
	}

	/**
	 * Get project structure as hierarchical documents
	 */
	async getProjectStructure(includeTrash = false): Promise<ScrivenerDocument[]> {
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as any;
		const documents: ScrivenerDocument[] = [];

		if (binder.BinderItem?.[0]?.Children?.BinderItem) {
			this.buildDocumentTree(binder.BinderItem[0].Children, documents, '');
		}

		if (includeTrash && binder.SearchResults?.[0]?.Children?.BinderItem) {
			this.buildDocumentTree(binder.SearchResults[0].Children, documents, 'Trash/');
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

	private findBinderItem(id: string, container: any): BinderItem | undefined {
		if (!container) return undefined;

		const searchContainer = (cont: any): BinderItem | undefined => {
			const items = cont.BinderItem || cont.Children?.BinderItem;
			if (!items) return undefined;

			const itemArray = Array.isArray(items) ? items : [items];
			for (const item of itemArray) {
				if (item.UUID === id) return item;
				if (item.Children?.BinderItem) {
					const found = searchContainer(item.Children);
					if (found) return found;
				}
			}
			return undefined;
		};

		if (container.BinderItem) {
			return searchContainer(container);
		} else if (container.Children?.BinderItem) {
			return searchContainer(container.Children);
		}

		return undefined;
	}

	private removeBinderItem(id: string, container: any): BinderItem | undefined {
		if (!container) return undefined;

		const removeFromContainer = (cont: any, isRoot = false): BinderItem | undefined => {
			const items = cont.BinderItem || cont.Children?.BinderItem;
			if (!items) return undefined;

			const index = items.findIndex((item: BinderItem) => item.UUID === id);
			if (index !== -1) {
				const removed = items.splice(index, 1)[0];
				if (items.length === 0 && !isRoot) {
					delete cont.BinderItem;
				}
				return removed;
			}

			const itemArray = Array.isArray(items) ? items : [items];
			for (const item of itemArray) {
				if (item.Children?.BinderItem) {
					const removed = removeFromContainer(item.Children);
					if (removed) return removed;
				}
			}

			return undefined;
		};

		if (container.BinderItem) {
			return removeFromContainer(container, true);
		} else if (container.Children?.BinderItem) {
			return removeFromContainer(container.Children, true);
		}

		return undefined;
	}
}
