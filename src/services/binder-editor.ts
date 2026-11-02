import { DOCUMENT_TYPES } from '../core/constants.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { BinderContainer, BinderItem, ProjectStructure } from '../types/internal.js';
import { handleError, isValidUUID, truncate, validateInput } from '../utils/common.js';
import { generateScrivenerUUID } from '../utils/scrivener-utils.js';
import {
	addBinderItem,
	addBinderChild,
	findBinderItemById,
	findParentFolder,
	removeBinderItem,
	validateProjectStructure,
} from './document-manager-helpers.js';

const logger = getLogger('document-manager');

function binderItems(container: BinderContainer): BinderItem[] {
	if (!container.BinderItem) return [];
	return Array.isArray(container.BinderItem) ? container.BinderItem : [container.BinderItem];
}

function findNativeTrash(binder: BinderContainer): BinderItem | undefined {
	return binderItems(binder).find((item) => item.Type === 'TrashFolder');
}

function ensureNativeTrash(binder: BinderContainer): BinderItem {
	let trash = findNativeTrash(binder);
	if (trash) return trash;
	trash = {
		UUID: generateScrivenerUUID(),
		Type: 'TrashFolder',
		Title: 'Trash',
		Children: { BinderItem: [] },
	};
	const legacy = Array.isArray(binder.SearchResults)
		? binder.SearchResults
		: binder.SearchResults
			? [binder.SearchResults]
			: [];
	for (const container of legacy)
		for (const item of binderItems(container.Children ?? {})) addBinderChild(trash, item);
	delete binder.SearchResults;
	addBinderItem(binder, trash);
	return trash;
}

function ensureChildren(item: BinderItem): BinderContainer {
	if (!item.Children) item.Children = { BinderItem: [] };
	if (!item.Children.BinderItem) item.Children.BinderItem = [];
	else if (!Array.isArray(item.Children.BinderItem))
		item.Children.BinderItem = [item.Children.BinderItem];
	return item.Children;
}

function legacyTrashContainer(binder: BinderContainer): BinderContainer | undefined {
	const searchResults = Array.isArray(binder.SearchResults)
		? binder.SearchResults
		: binder.SearchResults
			? [binder.SearchResults]
			: [];
	return searchResults[0]?.Children;
}

function defaultRestoreParent(binder: BinderContainer): BinderItem | undefined {
	return binderItems(binder).find((item) => item.Type === 'DraftFolder');
}

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

			if (type === DOCUMENT_TYPES.TEXT) {
				await this.writeDocument(id, content);
			}

			const newItem: BinderItem = {
				UUID: id,
				Type: type,
				Title: sanitizedTitle,
				MetaData: {},
			};

			// Use utility function to add binder item
			if (parentFolder) {
				addBinderChild(parentFolder, newItem);
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
			const item = findBinderItemById(binder, documentId);
			if (!item) throw createError(ErrorCode.NOT_FOUND, { documentId }, 'Document not found');
			if (['DraftFolder', 'ResearchFolder', 'TrashFolder'].includes(item.Type ?? ''))
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Cannot delete a native root folder'
				);
			const trash = ensureNativeTrash(binder);
			const trashId = trash.UUID ?? trash.ID;
			if (trashId === documentId)
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Cannot delete the Trash folder'
				);
			if (trash.Children && findBinderItemById(trash.Children, documentId)) return;

			const removed = removeBinderItem(binder, documentId);
			if (!removed) {
				throw createError(
					ErrorCode.NOT_FOUND,
					{ documentId },
					`Document ${documentId} not found`
				);
			}

			addBinderChild(trash, removed);
			logger.info(`Document ${documentId} moved to native trash`);
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
	async moveDocument(
		documentId: string,
		newParentId: string | null,
		position?: number
	): Promise<void> {
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

			const movingItem = findBinderItemById(binder, documentId);
			if (
				movingItem &&
				['DraftFolder', 'ResearchFolder', 'TrashFolder'].includes(movingItem.Type ?? '')
			)
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ documentId },
					'Cannot move a native root folder'
				);
			const targetItems = newParent ? newParent.Children?.BinderItem : binder.BinderItem;
			const siblings = Array.isArray(targetItems)
				? targetItems
				: targetItems
					? [targetItems]
					: [];
			const maximumPosition = siblings.filter(
				(item) => item.UUID !== documentId && item.ID !== documentId
			).length;
			if (
				position !== undefined &&
				(!Number.isSafeInteger(position) || position < 0 || position > maximumPosition)
			) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ position, maximumPosition },
					'Document position is outside the target folder bounds'
				);
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
				addBinderChild(newParent, extractedItem, position);
			} else {
				addBinderItem(binder, extractedItem, position);
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
		if (
			!isValidUUID(documentId) ||
			(targetParentId !== undefined && !isValidUUID(targetParentId))
		)
			throw createError(ErrorCode.INVALID_INPUT, undefined, 'Invalid document or parent ID');
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;
		const nativeTrash = findNativeTrash(binder);
		const nativeChildren = nativeTrash?.Children;
		const legacyChildren = nativeTrash ? undefined : legacyTrashContainer(binder);
		const trashContainer = nativeChildren ?? legacyChildren;

		if (!trashContainer?.BinderItem) {
			throw createError(ErrorCode.NOT_FOUND, undefined, 'Trash is empty');
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
			if (
				targetParent === nativeTrash ||
				(nativeTrash?.Children && findBinderItemById(nativeTrash.Children, targetParentId))
			) {
				throw createError(
					ErrorCode.INVALID_INPUT,
					{ targetParentId },
					'Cannot restore a document into the trash subtree'
				);
			}
		}

		const recoveredItem = removeBinderItem(trashContainer, documentId);
		if (!recoveredItem) {
			throw createError(
				ErrorCode.NOT_FOUND,
				undefined,
				`Document ${documentId} not found in trash`
			);
		}

		if (targetParent) {
			addBinderChild(targetParent, recoveredItem);
		} else {
			const draftFolder = defaultRestoreParent(binder);
			if (draftFolder) addBinderChild(draftFolder, recoveredItem);
			else addBinderItem(binder, recoveredItem);
		}

		if (nativeTrash) ensureChildren(nativeTrash);
		logger.info(
			`Document ${documentId} recovered from trash to parent ${targetParentId || 'root'}`
		);
	}
}
