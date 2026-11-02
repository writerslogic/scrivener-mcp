/**
 * Helper functions for DocumentManager to reduce code repetition
 */

import { createError, ErrorCode } from '../core/errors.js';
import { validateInput, type ValidationSchema } from '../utils/common.js';
import type { BinderItem, BinderContainer, ProjectStructure } from '../types/internal.js';
import { getDocumentType } from '../utils/scrivener-utils.js';

export function validateProjectStructure(
	projectStructure?: ProjectStructure
): asserts projectStructure is ProjectStructure & {
	ScrivenerProject: { Binder: BinderContainer };
} {
	if (!projectStructure?.ScrivenerProject?.Binder) {
		throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
	}
}

export function validateDocumentOperation(
	operation: string,
	params: Record<string, unknown>
): void {
	const schemas: Record<string, ValidationSchema> = {
		createDocument: {
			title: {
				type: 'string',
				required: true,
				minLength: 1,
				maxLength: 255,
			},
			content: {
				type: 'string',
				required: false,
			},
			parentId: {
				type: 'string',
				required: false,
				pattern: /^[A-Za-z0-9-]+$/,
			},
			type: {
				type: 'string',
				required: false,
				enum: ['Text', 'Folder'],
			},
		},
		renameDocument: {
			documentId: {
				type: 'string',
				required: true,
				pattern: /^[A-Za-z0-9-]+$/,
			},
			newTitle: {
				type: 'string',
				required: true,
				minLength: 1,
				maxLength: 255,
			},
		},
		deleteDocument: {
			documentId: {
				type: 'string',
				required: true,
				pattern: /^[A-Za-z0-9-]+$/,
			},
		},
		moveDocument: {
			documentId: {
				type: 'string',
				required: true,
				pattern: /^[A-Za-z0-9-]+$/,
			},
			newParentId: {
				type: 'string',
				required: false,
				pattern: /^[A-Za-z0-9-]+$/,
			},
		},
	};

	const schema = schemas[operation];
	if (schema) {
		validateInput(params, schema);
	}
}

/**
 * Iterate through binder items safely
 */
export function* iterateBinderItems(container: BinderContainer): Generator<BinderItem> {
	if (!container.BinderItem) return;

	const items = Array.isArray(container.BinderItem)
		? container.BinderItem
		: [container.BinderItem];

	for (const item of items) {
		yield item;
	}
}

/**
 * Recursively iterate through all binder items including children
 */
export function* iterateAllBinderItems(container: BinderContainer): Generator<BinderItem> {
	for (const item of iterateBinderItems(container)) {
		yield item;
		if (item.Children) {
			yield* iterateAllBinderItems(item.Children);
		}
	}
}

export function findBinderItemById(container: BinderContainer, id: string): BinderItem | undefined {
	for (const item of iterateAllBinderItems(container)) {
		if (item.UUID === id || (item as { ID?: string }).ID === id) {
			return item;
		}
	}
	return undefined;
}

export function findParentOfBinderItem(
	container: BinderContainer,
	childId: string
): { parent: BinderItem | null; container: BinderContainer } {
	for (const item of iterateBinderItems(container)) {
		if (item.UUID === childId || (item as { ID?: string }).ID === childId) {
			return { parent: null, container };
		}
	}

	// Search in children
	for (const item of iterateBinderItems(container)) {
		if (item.Children) {
			const found = findBinderItemById(item.Children, childId);
			if (found) {
				return { parent: item, container: item.Children };
			}
		}
	}

	return { parent: null, container };
}

export function removeBinderItem(container: BinderContainer, id: string): BinderItem | undefined {
	if (!container.BinderItem) return undefined;

	const items = Array.isArray(container.BinderItem)
		? container.BinderItem
		: [container.BinderItem];

	const index = items.findIndex(
		(item: BinderItem) => item.UUID === id || (item as { ID?: string }).ID === id
	);

	if (index >= 0) {
		const [removed] = items.splice(index, 1);

		if (Array.isArray(container.BinderItem)) {
			container.BinderItem = items;
		} else {
			container.BinderItem = items[0] || null;
		}

		return removed;
	}

	// Search in children
	for (const item of items) {
		if (item.Children) {
			const removed = removeBinderItem(item.Children, id);
			if (removed) return removed;
		}
	}

	return undefined;
}

export function addBinderItem(
	container: BinderContainer,
	item: BinderItem,
	position?: number
): void {
	if (!container.BinderItem) {
		container.BinderItem = item;
		return;
	}

	if (Array.isArray(container.BinderItem)) {
		if (position !== undefined && position >= 0 && position <= container.BinderItem.length) {
			container.BinderItem.splice(position, 0, item);
		} else {
			container.BinderItem.push(item);
		}
	} else {
		container.BinderItem =
			position === 0 ? [item, container.BinderItem] : [container.BinderItem, item];
	}
}

export function addBinderChild(parent: BinderItem, item: BinderItem, position?: number): void {
	if (!parent.Children) {
		parent.Children = { BinderItem: [] };
	}
	const existing = parent.Children.BinderItem;
	parent.Children.BinderItem = Array.isArray(existing) ? existing : existing ? [existing] : [];
	addBinderItem(parent.Children, item, position);
}

/**
 * Resolve a folder by UUID, or undefined if it is missing or not a folder.
 */
export function findParentFolder(container: BinderContainer, id: string): BinderItem | undefined {
	const parent = findBinderItemById(container, id);
	return parent && getDocumentType(parent.Type) === 'Folder' ? parent : undefined;
}

export function countBinderItems(container: BinderContainer): number {
	let count = 0;
	for (const _item of iterateAllBinderItems(container)) {
		count++;
	}
	return count;
}

export function getBinderItemsByType(
	container: BinderContainer,
	type: 'Text' | 'Folder'
): BinderItem[] {
	const items: BinderItem[] = [];
	for (const item of iterateAllBinderItems(container)) {
		if (item.Type === type) {
			items.push(item);
		}
	}
	return items;
}

export function validateBinderItem(item: unknown): asserts item is BinderItem {
	if (!item || typeof item !== 'object') {
		throw createError(ErrorCode.INVALID_INPUT, undefined, 'Invalid binder item');
	}

	const binderItem = item as BinderItem;

	if (!binderItem.UUID || typeof binderItem.UUID !== 'string') {
		throw createError(ErrorCode.INVALID_INPUT, undefined, 'Binder item missing UUID');
	}

	if (!binderItem.Type || (binderItem.Type !== 'Text' && binderItem.Type !== 'Folder')) {
		throw createError(ErrorCode.INVALID_INPUT, undefined, 'Invalid binder item type');
	}

	if (binderItem.Title !== undefined && typeof binderItem.Title !== 'string') {
		throw createError(ErrorCode.INVALID_INPUT, undefined, 'Invalid binder item title');
	}
}
