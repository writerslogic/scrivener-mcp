/**
 * Centralized validation system
 */

import { ErrorCode, createError } from './errors.js';
import type { ValidationRule, ValidationSchema } from '../types/index.js';

/**
 * Validate value against rule
 */
function validateValue(value: unknown, rule: ValidationRule, field: string): string | true {
	// Check required
	if (rule.required && (value === undefined || value === null)) {
		return `${field} is required`;
	}

	// Allow undefined for optional fields
	if (!rule.required && (value === undefined || value === null)) {
		return true;
	}

	// Type validation
	const actualType = Array.isArray(value) ? 'array' : typeof value;
	if (rule.type && actualType !== rule.type) {
		return `${field} must be ${rule.type}, got ${actualType}`;
	}

	// String validation
	if (rule.type === 'string' && typeof value === 'string') {
		if (rule.minLength !== undefined && value.length < rule.minLength) {
			return `${field} must be at least ${rule.minLength} characters`;
		}
		if (rule.maxLength !== undefined && value.length > rule.maxLength) {
			return `${field} must be at most ${rule.maxLength} characters`;
		}
		if (rule.pattern && !rule.pattern.test(value)) {
			return `${field} format is invalid`;
		}
	}

	// Number validation
	if (rule.type === 'number' && typeof value === 'number') {
		if (rule.min !== undefined && value < rule.min) {
			return `${field} must be at least ${rule.min}`;
		}
		if (rule.max !== undefined && value > rule.max) {
			return `${field} must be at most ${rule.max}`;
		}
	}

	// Array validation
	if (rule.type === 'array' && Array.isArray(value)) {
		if (rule.minLength !== undefined && value.length < rule.minLength) {
			return `${field} must have at least ${rule.minLength} items`;
		}
		if (rule.maxLength !== undefined && value.length > rule.maxLength) {
			return `${field} must have at most ${rule.maxLength} items`;
		}
	}

	// Enum validation
	if (rule.enum && !rule.enum.includes(value)) {
		return `${field} must be one of: ${rule.enum.join(', ')}`;
	}

	// Custom validation
	if (rule.custom) {
		const result = rule.custom(value);
		if (result !== true) {
			return typeof result === 'string' ? result : `${field} validation failed`;
		}
	}

	return true;
}

/**
 * Validate object against schema
 */
export function validate(data: unknown, schema: ValidationSchema): void {
	if (!data || typeof data !== 'object') {
		throw createError(ErrorCode.INVALID_INPUT, { data }, 'Input must be an object');
	}

	const errors: string[] = [];
	const obj = data as Record<string, unknown>;

	for (const [field, rule] of Object.entries(schema)) {
		const result = validateValue(obj[field], rule, field);
		if (result !== true) {
			errors.push(result);
		}
	}

	if (errors.length > 0) {
		throw createError(ErrorCode.VALIDATION_FAILED, { errors, data }, errors.join('; '));
	}
}

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
 * Sanitize string input
 */
export function sanitizeString(input: string, maxLength: number = 1000): string {
	return input
		.substring(0, maxLength)
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
 * Validate and sanitize file path
 */
export function validatePath(path: string): string {
	// Check for path traversal attempts
	if (path.includes('..')) {
		throw createError(ErrorCode.PATH_INVALID, { path }, 'Path traversal detected');
	}

	// Remove dangerous characters
	const sanitized = path
		.replace(/[<>:"|?*]/g, '')
		.replace(/\/+/g, '/') // Normalize slashes
		.trim();

	if (!sanitized || sanitized.length === 0) {
		throw createError(ErrorCode.PATH_INVALID, { path });
	}

	return sanitized;
}

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
