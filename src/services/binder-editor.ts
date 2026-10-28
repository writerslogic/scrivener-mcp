import { DOCUMENT_TYPES } from '../core/constants.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { BinderContainer, BinderItem, ProjectStructure } from '../types/internal.js';
import { handleError, isValidUUID, truncate, validateInput } from '../utils/common.js';
import { generateScrivenerUUID } from '../utils/scrivener-utils.js';
import {
	addBinderItem,
	appendBinderChild,
	findBinderItemById,
	findParentFolder,
	removeBinderItem,
	validateProjectStructure,
} from './document-manager-helpers.js';

const logger = getLogger('document-manager');

/** Structural binder edits: create, rename, move, trash and recover. */
export class BinderEditor {
	constructor(
		private readonly getStructure: () => ProjectStructure | undefined,
		private readonly writeDocument: (id: string, content: string) => Promise<void>
	) {}

	private get projectStructure(): ProjectStructure | undefined {
		return this.getStructure();
	}

	async createDocument(
		title: string,
		content = '',
		parentId?: string,
		type: 'Text' | 'Folder' = DOCUMENT_TYPES.TEXT
	): Promise<string> {
		try {
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
			let parentFolder: BinderItem | undefined;
			if (parentId) {
				parentFolder = findParentFolder(binder as BinderContainer, parentId);
				if (!parentFolder) {
					throw createError(
						ErrorCode.NOT_FOUND,
						{ parentId },
						`Parent folder ${parentId} not found`
					);
				}
			}

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
			if (parentFolder) {
				appendBinderChild(parentFolder, newItem);
			} else {
				addBinderItem(binder, newItem);
			}

			logger.info('Created document', { documentId: id });
			return id;
		} catch (error) {
			throw handleError(error, 'createDocument');
		}
	}

	async deleteDocument(documentId: string): Promise<void> {
		try {
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

			// Validate the destination before detaching, so a bad parent cannot drop the item.
			let newParent: BinderItem | undefined;
			if (newParentId) {
				newParent = findParentFolder(binder, newParentId);
				if (!newParent) {
					throw createError(
						ErrorCode.NOT_FOUND,
						{ newParentId },
						`Target parent folder ${newParentId} not found`
					);
				}
				const moving = findBinderItemById(binder, documentId);
				if (
					moving &&
					findBinderItemById(
						{ BinderItem: moving.Children?.BinderItem } as BinderContainer,
						newParentId
					)
				) {
					throw createError(
						ErrorCode.INVALID_INPUT,
						{ documentId, newParentId },
						'Cannot move a document into its own descendant'
					);
				}
			}

			const extractedItem = removeBinderItem(binder, documentId);
			if (!extractedItem) {
				throw createError(
					ErrorCode.NOT_FOUND,
					{ documentId },
					`Document ${documentId} not found`
				);
			}

			// Use utility function to add to new location
			if (newParent) {
				appendBinderChild(newParent, extractedItem);
			} else {
				addBinderItem(binder, extractedItem);
			}

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

		let targetParent: BinderItem | undefined;
		if (targetParentId) {
			targetParent = findParentFolder(binder, targetParentId);
			if (!targetParent) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Target parent folder ${targetParentId} not found`
				);
			}
		}

		const recoveredItem = trashArray.splice(itemIndex, 1)[0];
		// Update the trash with the modified array
		searchResults[0].Children!.BinderItem = trashArray;

		// Place in target location or root
		if (targetParent) {
			appendBinderChild(targetParent, recoveredItem as BinderItem);
		} else {
			// Restore into the Draft/Manuscript folder, or at the binder top level if
			// there is none. (This previously assumed binderItems[0] was the container
			// and threw whenever the binder led with a leaf document — the common case,
			// since real projects open with a template/front-matter doc.)
			const binderItems = Array.isArray(binder.BinderItem)
				? binder.BinderItem
				: binder.BinderItem
					? [binder.BinderItem]
					: [];

			const draftFolder = binderItems.find((it) => it.Type === 'DraftFolder');
			if (draftFolder) {
				if (!draftFolder.Children) {
					draftFolder.Children = { BinderItem: [] };
				}
				if (!draftFolder.Children.BinderItem) {
					draftFolder.Children.BinderItem = [];
				} else if (!Array.isArray(draftFolder.Children.BinderItem)) {
					draftFolder.Children.BinderItem = [draftFolder.Children.BinderItem];
				}
				(draftFolder.Children.BinderItem as BinderItem[]).push(recoveredItem);
			} else {
				binderItems.push(recoveredItem);
				binder.BinderItem = binderItems;
			}
		}

		logger.info(
			`Document ${documentId} recovered from trash to parent ${targetParentId || 'root'}`
		);
	}
}
