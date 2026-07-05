/**
 * Shared schema definitions to reduce token overhead in MCP tool schemas.
 * Import and reference these instead of repeating property definitions.
 */

export const SHARED_DEFS = {
	docId: {
		type: 'string' as const,
		description: 'Scrivener document UUID, as returned by get_structure (a binder item "id").',
	},
	content: {
		type: 'string' as const,
		description: 'Document body as plain text. May be empty.',
	},
	query: {
		type: 'string' as const,
		description:
			'Search query: keywords for full-text search, or a natural-language phrase for ' +
			'semantic search, depending on the tool.',
	},
	maxResults: {
		type: 'number' as const,
		description: 'Maximum number of results to return.',
	},
	threshold: { type: 'number' as const, description: 'Min score 0-1' },
	format: { type: 'string' as const, enum: ['text', 'rtf', 'html', 'markdown'] as const },
	documentIds: { type: 'array' as const, items: { type: 'string' as const } },
	chapterId: { type: 'string' as const },
	folderId: {
		type: 'string' as const,
		description: 'UUID of a binder folder, as returned by get_structure.',
	},
	includeTrash: {
		type: 'boolean' as const,
		description: 'Set true to include trashed items in the result. Default false.',
	},
} as const;
