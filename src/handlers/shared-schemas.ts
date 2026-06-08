/**
 * Shared schema definitions to reduce token overhead in MCP tool schemas.
 * Import and reference these instead of repeating property definitions.
 */

export const SHARED_DEFS = {
	docId: { type: 'string' as const },
	content: { type: 'string' as const },
	query: { type: 'string' as const },
	maxResults: { type: 'number' as const },
	threshold: { type: 'number' as const, description: 'Min score 0-1' },
	format: { type: 'string' as const, enum: ['text', 'rtf', 'html', 'markdown'] as const },
	documentIds: { type: 'array' as const, items: { type: 'string' as const } },
	chapterId: { type: 'string' as const },
	folderId: { type: 'string' as const },
	includeTrash: { type: 'boolean' as const },
} as const;
