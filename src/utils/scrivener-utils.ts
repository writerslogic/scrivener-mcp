import * as path from 'path';
import * as crypto from 'crypto';
import { validateInput, isValidUUID } from './common.js';
import type { BinderItem, BinderContainer, MetaDataItem } from '../types/internal.js';

/**
 * Scrivener-specific utility functions
 */

// ============================================================================
// Document Path Utilities
// ============================================================================

/**
 * Generate document path from ID
 */
export function getDocumentPath(projectPath: string, documentId: string): string {
	validateInput(
		{ documentId },
		{
			documentId: {
				type: 'string',
				required: true,
				custom: (id) => isValidScrivenerDocumentId(id) || 'Invalid document ID',
			},
		}
	);

	return path.join(projectPath, 'Files', 'Data', documentId, 'content.rtf');
}

/**
 * Generate synopsis path from ID
 */
export function getSynopsisPath(projectPath: string, documentId: string): string {
	return path.join(projectPath, 'Files', 'Data', documentId, 'synopsis.txt');
}

/**
 * Generate notes path from ID
 */
export function getNotesPath(projectPath: string, documentId: string): string {
	return path.join(projectPath, 'Files', 'Data', documentId, 'notes.rtf');
}

/**
 * Get all document paths for a given ID
 */
export function getDocumentPaths(
	projectPath: string,
	documentId: string
): {
	content: string;
	synopsis: string;
	notes: string;
	directory: string;
} {
	const directory = path.join(projectPath, 'Files', 'Data', documentId);

	return {
		content: path.join(directory, 'content.rtf'),
		synopsis: path.join(directory, 'synopsis.txt'),
		notes: path.join(directory, 'notes.rtf'),
		directory,
	};
}

// ============================================================================
// UUID Utilities
// ============================================================================

/**
 * Generate a Scrivener-compatible UUID (uppercase)
 */
export function generateScrivenerUUID(): string {
	return crypto.randomUUID().toUpperCase();
}

/**
 * Validate Scrivener document ID (UUID or numeric)
 */
export function isValidScrivenerDocumentId(id: string): boolean {
	// Scrivener uses uppercase UUIDs or simple numeric IDs
	const uppercaseUUID = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;
	const numericId = /^\d+$/;

	return uppercaseUUID.test(id) || numericId.test(id) || isValidUUID(id);
}

// ============================================================================
// Binder Traversal Utilities
// ============================================================================

/**
 * Find a binder item recursively
 */
export function findBinderItem(
	container: BinderContainer | undefined,
	documentId: string
): BinderItem | null {
	if (!container || !container.BinderItem) {
		return null;
	}

	const items = Array.isArray(container.BinderItem)
		? container.BinderItem
		: [container.BinderItem];

	for (const item of items) {
		if (item.UUID === documentId) {
			return item;
		}

		// Recursively search children
		if (item.Children) {
			const found = findBinderItem(item.Children, documentId);
			if (found) {
				return found;
			}
		}
	}

	return null;
}

/**
 * Traverse binder and apply callback to each item
 */
export function traverseBinder(
	container: BinderContainer | undefined,
	callback: (item: BinderItem, depth: number, parent?: BinderItem) => void,
	depth = 0,
	parent?: BinderItem
): void {
	if (!container || !container.BinderItem) {
		return;
	}

	const items = Array.isArray(container.BinderItem)
		? container.BinderItem
		: [container.BinderItem];

	for (const item of items) {
		callback(item, depth, parent);

		if (item.Children) {
			traverseBinder(item.Children, callback, depth + 1, item);
		}
	}
}

/**
 * Get all binder items as flat array
 */
export function flattenBinder(container: BinderContainer | undefined): BinderItem[] {
	const items: BinderItem[] = [];

	traverseBinder(container, (item) => {
		items.push(item);
	});

	return items;
}

/**
 * Find parent of a binder item
 */
export function findBinderParent(
	container: BinderContainer | undefined,
	documentId: string
): BinderItem | null {
	let foundParent: BinderItem | null = null;

	traverseBinder(container, (item, _depth, parent) => {
		if (item.UUID === documentId && parent) {
			foundParent = parent;
		}
	});

	return foundParent;
}

/**
 * Get binder path (breadcrumb) for an item
 */
export function getBinderPath(
	container: BinderContainer | undefined,
	documentId: string
): BinderItem[] {
	const path: BinderItem[] = [];
	let current = findBinderItem(container, documentId);

	while (current) {
		path.unshift(current);
		const currentUUID = current.UUID;
		if (!currentUUID) break;
		const parent = findBinderParent(container, currentUUID);
		current = parent;
	}

	return path;
}

// ============================================================================
// Metadata Utilities
// ============================================================================

/**
 * Find metadata item by field ID
 */
export function findMetadataField(
	metadataItems: MetaDataItem[] | MetaDataItem | undefined,
	fieldId: string
): MetaDataItem | undefined {
	if (!metadataItems) {
		return undefined;
	}

	const items = Array.isArray(metadataItems) ? metadataItems : [metadataItems];
	return items.find((item) => item.ID === fieldId || item.id === fieldId);
}

/**
 * Extract metadata value
 */
export function getMetadataValue(
	metadataItems: MetaDataItem[] | MetaDataItem | undefined,
	fieldId: string
): string | undefined {
	const item = findMetadataField(metadataItems, fieldId);
	return item?.Value;
}

/**
 * Parse metadata into key-value pairs
 */
export function parseMetadata(
	metadataItems: MetaDataItem[] | MetaDataItem | undefined
): Record<string, string> {
	const metadata: Record<string, string> = {};

	if (!metadataItems) {
		return metadata;
	}

	const items = Array.isArray(metadataItems) ? metadataItems : [metadataItems];

	for (const item of items) {
		const fieldId = item.ID || item.id;
		if (fieldId && item.Value) {
			metadata[fieldId] = item.Value;
		}
	}

	return metadata;
}

/**
 * Build metadata items from key-value pairs
 */
export function buildMetadataItems(metadata: Record<string, string | undefined>): MetaDataItem[] {
	const items: MetaDataItem[] = [];

	for (const [fieldId, value] of Object.entries(metadata)) {
		if (value !== undefined) {
			items.push({
				ID: fieldId,
				Value: value,
			});
		}
	}

	return items;
}

// ============================================================================
// Document Type Utilities
// ============================================================================

/**
 * Determine document type from Scrivener type code
 */
export function getDocumentType(typeCode?: string): 'Text' | 'Folder' | 'Other' {
	switch (typeCode) {
		case 'Text':
		case 'Document':
			return 'Text';
		case 'Folder':
		case 'DraftFolder':
		case 'ResearchFolder':
		case 'TrashFolder':
			return 'Folder';
		default:
			return 'Other';
	}
}

/**
 * Check if item is in trash
 */
export function isInTrash(item: BinderItem): boolean {
	// Check if item or any of its parents is trash
	return item.Type === 'TrashFolder' || item.Title === 'Trash' || item.UUID === 'Trash';
}

/**
 * Check if item should be included in compile
 */
export function shouldIncludeInCompile(item: BinderItem): boolean {
	// Check IncludeInCompile flag
	if (item.MetaData?.IncludeInCompile === 'No') {
		return false;
	}

	// Exclude trash items
	if (isInTrash(item)) {
		return false;
	}

	// Exclude research folder
	if (item.Type === 'ResearchFolder') {
		return false;
	}

	return true;
}

// ============================================================================
// Search Utilities
// ============================================================================

/**
 * Search binder items by predicate
 */
export function searchBinder(
	container: BinderContainer | undefined,
	predicate: (item: BinderItem) => boolean
): BinderItem[] {
	const results: BinderItem[] = [];

	traverseBinder(container, (item) => {
		if (predicate(item)) {
			results.push(item);
		}
	});

	return results;
}

/**
 * Find documents by type
 */
export function findDocumentsByType(
	container: BinderContainer | undefined,
	type: 'Text' | 'Folder' | 'Other'
): BinderItem[] {
	return searchBinder(container, (item) => getDocumentType(item.Type) === type);
}

/**
 * Find documents by title (case-insensitive)
 */
export function findDocumentsByTitle(
	container: BinderContainer | undefined,
	searchTerm: string,
	exact = false
): BinderItem[] {
	const term = searchTerm.toLowerCase();

	return searchBinder(container, (item) => {
		const title = item.Title?.toLowerCase() || '';
		return exact ? title === term : title.includes(term);
	});
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validation schema for document operations
 */
export const documentValidationSchema = {
	documentId: {
		type: 'string' as const,
		required: true,
		custom: (id: string) => isValidScrivenerDocumentId(id) || 'Invalid document ID format',
	},
	title: {
		type: 'string' as const,
		required: true,
		minLength: 1,
		maxLength: 255,
	},
	content: {
		type: 'string' as const,
		required: false,
		maxLength: 10000000, // 10MB limit
	},
};

/**
 * Validate document operation input
 */
export function validateDocumentInput(input: any): void {
	validateInput(input, documentValidationSchema);
}

// ============================================================================
// Export all utilities
// ============================================================================

export default {
	// Path utilities
	getDocumentPath,
	getSynopsisPath,
	getNotesPath,
	getDocumentPaths,

	// UUID utilities
	generateScrivenerUUID,
	isValidScrivenerDocumentId,

	// Binder utilities
	findBinderItem,
	traverseBinder,
	flattenBinder,
	findBinderParent,
	getBinderPath,

	// Metadata utilities
	findMetadataField,
	getMetadataValue,
	parseMetadata,
	buildMetadataItems,

	// Document type utilities
	getDocumentType,
	isInTrash,
	shouldIncludeInCompile,

	// Search utilities
	searchBinder,
	findDocumentsByType,
	findDocumentsByTitle,

	// Validation
	documentValidationSchema,
	validateDocumentInput,
};
