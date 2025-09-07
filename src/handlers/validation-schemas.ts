/**
 * Common validation schemas for handlers
 */

import type { ValidationSchema } from '../types/index.js';

// Document-related schemas
export const documentIdSchema: ValidationSchema = {
	documentId: {
		type: 'string',
		required: true,
		pattern: /^[A-F0-9-]+$/i,
	},
};

export const titleSchema: ValidationSchema = {
	title: { type: 'string', required: true, minLength: 1 },
};

export const contentSchema: ValidationSchema = {
	content: { type: 'string', required: true },
};

export const querySchema: ValidationSchema = {
	query: { type: 'string', required: true, minLength: 1 },
};

// Complex schemas
export const documentContentSchema: ValidationSchema = {
	documentId: { type: 'string', required: true },
	content: { type: 'string', required: true },
};

export const documentTitleSchema: ValidationSchema = {
	documentId: { type: 'string', required: true },
	newTitle: { type: 'string', required: true, minLength: 1 },
};

export const documentMoveSchema: ValidationSchema = {
	documentId: { type: 'string', required: true },
	targetFolderId: { type: 'string', required: true },
	position: { type: 'number', required: false },
};

export const analysisSchema: ValidationSchema = {
	documentId: { type: 'string', required: true },
	analysisTypes: { type: 'array', required: false },
};

export const enhancementSchema: ValidationSchema = {
	documentId: { type: 'string', required: true },
	enhancementType: { type: 'string', required: true },
	options: { type: 'object', required: false },
};

export const promptSchema: ValidationSchema = {
	prompt: { type: 'string', required: true, minLength: 1 },
	context: { type: 'object', required: false },
	length: { type: 'number', required: false },
};

export const memorySchema: ValidationSchema = {
	memoryType: { type: 'string', required: true },
	data: { type: 'object', required: true },
};

export const searchSchema: ValidationSchema = {
	documentId: { type: 'string', required: true },
	includeComments: { type: 'boolean', required: false },
};

export const moveDocumentSchema: ValidationSchema = {
	documentId: { type: 'string', required: true },
	targetFolderId: { type: 'string', required: false },
};

export const searchContentSchema: ValidationSchema = {
	query: { type: 'string', required: true, minLength: 1 },
	caseSensitive: { type: 'boolean', required: false },
	regex: { type: 'boolean', required: false },
	includeTrash: { type: 'boolean', required: false },
	searchIn: { type: 'array', required: false },
};

export const searchTrashSchema: ValidationSchema = {
	query: { type: 'string', required: true, minLength: 1 },
	searchType: { type: 'string', required: false },
};

export const documentDetailsSchema: ValidationSchema = {
	documentId: { type: 'string', required: true },
	includeComments: { type: 'boolean', required: false },
	includeFootnotes: { type: 'boolean', required: false },
};

export const compileSchema: ValidationSchema = {
	format: { type: 'string', required: false },
	rootFolderId: { type: 'string', required: false },
	includeSynopsis: { type: 'boolean', required: false },
	includeNotes: { type: 'boolean', required: false },
	separator: { type: 'string', required: false },
	hierarchical: { type: 'boolean', required: false },
};

export const exportSchema: ValidationSchema = {
	format: { type: 'string', required: true },
	outputPath: { type: 'string', required: false },
	options: { type: 'object', required: false },
};
