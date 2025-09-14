/**
 * Centralized validation system - utilizes utils/common.ts
 */

import { ErrorCode, createError, validateInput, sanitizePath, truncate } from '../utils/common.js';

/**
 * Validate object against schema - re-export from utils/common.ts
 */
export const validate = validateInput;

/**
 * Common validation schemas
 */
export const CommonSchemas = {
	documentId: {
		documentId: {
			type: 'string' as const,
			required: true,
			pattern: /^[A-F0-9-]+$/i,
		},
	},

	title: {
		title: {
			type: 'string' as const,
			required: true,
			minLength: 1,
			maxLength: 255,
		},
	},

	content: {
		content: {
			type: 'string' as const,
			required: true,
			maxLength: 10_000_000, // 10MB limit
		},
	},

	path: {
		path: {
			type: 'string' as const,
			required: true,
			pattern: /^[^<>:"|?*]+$/,
			custom: (value: unknown) => {
				if (typeof value !== 'string') return false;
				// Prevent path traversal
				if (value.includes('..')) return 'Path traversal not allowed';
				return true;
			},
		},
	},

	pagination: {
		page: {
			type: 'number' as const,
			required: false,
			min: 1,
		},
		pageSize: {
			type: 'number' as const,
			required: false,
			min: 1,
			max: 100,
		},
	},
};

/**
 * Sanitize string input - utilizes truncate from utils
 */
export function sanitizeString(input: string, maxLength: number = 1000): string {
	return truncate(input, maxLength)
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // eslint-disable-line no-control-regex
		.trim();
}

/**
 * Sanitize HTML content
 */
export function sanitizeHtml(html: string): string {
	// Basic HTML sanitization - in production, use a library like DOMPurify
	return html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
		.replace(/on\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/on\w+\s*=\s*'[^']*'/gi, '')
		.replace(/javascript:/gi, '');
}

/**
 * Validate and sanitize file path - re-export from utils/common.ts
 */
export const validatePath = sanitizePath;

/**
 * Type guards
 */
export function isString(value: unknown): value is string {
	return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
	return typeof value === 'number' && !isNaN(value);
}

export function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

export function isArray<T = unknown>(value: unknown): value is T[] {
	return Array.isArray(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isDefined<T>(value: T | undefined | null): value is T {
	return value !== undefined && value !== null;
}

/**
 * Assert type with error
 */
export function assertType<T>(
	value: unknown,
	guard: (value: unknown) => value is T,
	field: string
): T {
	if (!guard(value)) {
		throw createError(ErrorCode.TYPE_MISMATCH, { field, value }, `Invalid type for ${field}`);
	}
	return value;
}
