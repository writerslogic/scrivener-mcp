import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Common utility functions for the Scrivener MCP server
 */

// ============================================================================
// Error Handling Utilities
// ============================================================================

export enum ErrorCode {
	NOT_FOUND = 'NOT_FOUND',
	INVALID_INPUT = 'INVALID_INPUT',
	PERMISSION_DENIED = 'PERMISSION_DENIED',
	PROJECT_ERROR = 'PROJECT_ERROR',
	DATABASE_ERROR = 'DATABASE_ERROR',
	SYNC_ERROR = 'SYNC_ERROR',
	IO_ERROR = 'IO_ERROR',
	VALIDATION_ERROR = 'VALIDATION_ERROR',
	API_ERROR = 'API_ERROR',
	CACHE_ERROR = 'CACHE_ERROR',
	INITIALIZATION_ERROR = 'INITIALIZATION_ERROR',
	CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
	RUNTIME_ERROR = 'RUNTIME_ERROR',
}

export class AppError extends Error {
	constructor(
		message: string,
		public code: ErrorCode,
		public details?: any,
		public statusCode: number = 500
	) {
		super(message);
		this.name = 'AppError';
	}
}

/**
 * Standardized error handler
 */
export function handleError(error: unknown, context?: string): AppError {
	if (error instanceof AppError) {
		return error;
	}

	if (error instanceof Error) {
		// Handle Node.js system errors
		const nodeError = error as any;

		if (nodeError.code === 'ENOENT') {
			return new AppError(
				`File or directory not found${context ? ` in ${context}` : ''}`,
				ErrorCode.NOT_FOUND,
				{ originalError: error.message },
				404
			);
		}

		if (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') {
			return new AppError(
				`Permission denied${context ? ` for ${context}` : ''}`,
				ErrorCode.PERMISSION_DENIED,
				{ originalError: error.message },
				403
			);
		}

		if (nodeError.code === 'EEXIST') {
			return new AppError(
				`File already exists${context ? ` in ${context}` : ''}`,
				ErrorCode.IO_ERROR,
				{ originalError: error.message },
				409
			);
		}

		return new AppError(
			error.message || 'An unknown error occurred',
			ErrorCode.PROJECT_ERROR,
			{ context, stack: error.stack },
			500
		);
	}

	return new AppError(
		'An unexpected error occurred',
		ErrorCode.PROJECT_ERROR,
		{ error: String(error), context },
		500
	);
}

/**
 * Wrap async functions with error handling
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
	fn: T,
	context?: string
): T {
	return (async (...args: Parameters<T>) => {
		try {
			return await fn(...args);
		} catch (error) {
			throw handleError(error, context);
		}
	}) as T;
}

// ============================================================================
// Input Validation Utilities
// ============================================================================

export interface ValidationRule {
	type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: RegExp;
	enum?: any[];
	custom?: (value: any) => boolean | string;
}

export interface ValidationSchema {
	[key: string]: ValidationRule;
}

/**
 * Validate input against a schema
 */
export function validateInput(
	input: any,
	schema: ValidationSchema,
	throwOnError = true
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	for (const [field, rules] of Object.entries(schema)) {
		const value = input[field];

		// Check required
		if (rules.required && (value === undefined || value === null || value === '')) {
			errors.push(`${field} is required`);
			continue;
		}

		// Skip validation if not required and not provided
		if (!rules.required && (value === undefined || value === null)) {
			continue;
		}

		// Type validation
		if (rules.type) {
			const actualType = Array.isArray(value) ? 'array' : typeof value;
			if (actualType !== rules.type) {
				errors.push(`${field} must be of type ${rules.type}, got ${actualType}`);
				continue;
			}
		}

		// String validations
		if (typeof value === 'string') {
			if (rules.minLength && value.length < rules.minLength) {
				errors.push(`${field} must be at least ${rules.minLength} characters`);
			}
			if (rules.maxLength && value.length > rules.maxLength) {
				errors.push(`${field} must be at most ${rules.maxLength} characters`);
			}
			if (rules.pattern && !rules.pattern.test(value)) {
				errors.push(`${field} does not match the required pattern`);
			}
		}

		// Number validations
		if (typeof value === 'number') {
			if (rules.min !== undefined && value < rules.min) {
				errors.push(`${field} must be at least ${rules.min}`);
			}
			if (rules.max !== undefined && value > rules.max) {
				errors.push(`${field} must be at most ${rules.max}`);
			}
		}

		// Array validations
		if (Array.isArray(value)) {
			if (rules.minLength && value.length < rules.minLength) {
				errors.push(`${field} must have at least ${rules.minLength} items`);
			}
			if (rules.maxLength && value.length > rules.maxLength) {
				errors.push(`${field} must have at most ${rules.maxLength} items`);
			}
		}

		// Enum validation
		if (rules.enum && !rules.enum.includes(value)) {
			errors.push(`${field} must be one of: ${rules.enum.join(', ')}`);
		}

		// Custom validation
		if (rules.custom) {
			const result = rules.custom(value);
			if (result !== true) {
				errors.push(typeof result === 'string' ? result : `${field} is invalid`);
			}
		}
	}

	if (throwOnError && errors.length > 0) {
		throw new AppError('Validation failed', ErrorCode.VALIDATION_ERROR, { errors }, 400);
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Sanitize file paths
 */
export function sanitizePath(inputPath: string): string {
	// Remove any null bytes
	let sanitized = inputPath.replace(/\0/g, '');

	// Normalize the path
	sanitized = path.normalize(sanitized);

	// Prevent directory traversal
	const parts = sanitized.split(path.sep);
	const filtered = parts.filter((part) => part !== '..' && part !== '.');

	return filtered.join(path.sep);
}

/**
 * Validate UUID format
 */
export function isValidUUID(uuid: string): boolean {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

/**
 * Validate Scrivener document ID
 */
export function isValidDocumentId(id: string): boolean {
	// Scrivener uses UUIDs or simple numeric IDs
	return isValidUUID(id) || /^\d+$/.test(id);
}

// ============================================================================
// Cache Management Utilities
// ============================================================================

export interface CacheOptions {
	ttl?: number; // Time to live in milliseconds
	maxSize?: number; // Maximum number of items
	onEvict?: (key: string, value: any) => void;
}

export class Cache<T> {
	private cache: Map<string, { value: T; timestamp: number }> = new Map();
	private accessOrder: string[] = [];

	constructor(private options: CacheOptions = {}) {
		this.options.ttl = options.ttl || 5 * 60 * 1000; // 5 minutes default
		this.options.maxSize = options.maxSize || 100;
	}

	/**
	 * Get item from cache
	 */
	get(key: string): T | undefined {
		const item = this.cache.get(key);

		if (!item) {
			return undefined;
		}

		// Check if expired
		if (this.options.ttl && Date.now() - item.timestamp > this.options.ttl) {
			this.delete(key);
			return undefined;
		}

		// Update access order for LRU
		this.updateAccessOrder(key);

		return item.value;
	}

	/**
	 * Set item in cache
	 */
	set(key: string, value: T): void {
		// Check size limit
		if (
			this.options.maxSize &&
			this.cache.size >= this.options.maxSize &&
			!this.cache.has(key)
		) {
			// Evict least recently used
			const lru = this.accessOrder[0];
			if (lru) {
				this.delete(lru);
			}
		}

		this.cache.set(key, {
			value,
			timestamp: Date.now(),
		});

		this.updateAccessOrder(key);
	}

	/**
	 * Delete item from cache
	 */
	delete(key: string): boolean {
		const item = this.cache.get(key);
		const deleted = this.cache.delete(key);

		if (deleted) {
			// Remove from access order
			const index = this.accessOrder.indexOf(key);
			if (index > -1) {
				this.accessOrder.splice(index, 1);
			}

			// Call eviction callback
			if (this.options.onEvict && item) {
				this.options.onEvict(key, item.value);
			}
		}

		return deleted;
	}

	/**
	 * Clear entire cache
	 */
	clear(): void {
		if (this.options.onEvict) {
			for (const [key, item] of this.cache.entries()) {
				this.options.onEvict(key, item.value);
			}
		}

		this.cache.clear();
		this.accessOrder = [];
	}

	/**
	 * Get cache size
	 */
	size(): number {
		return this.cache.size;
	}

	/**
	 * Clean expired items
	 */
	cleanExpired(): number {
		if (!this.options.ttl) return 0;

		const now = Date.now();
		let cleaned = 0;

		for (const [key, item] of this.cache.entries()) {
			if (now - item.timestamp > this.options.ttl) {
				this.delete(key);
				cleaned++;
			}
		}

		return cleaned;
	}

	/**
	 * Update access order for LRU
	 */
	private updateAccessOrder(key: string): void {
		const index = this.accessOrder.indexOf(key);
		if (index > -1) {
			this.accessOrder.splice(index, 1);
		}
		this.accessOrder.push(key);
	}
}

// ============================================================================
// API Response Utilities
// ============================================================================

export interface ApiResponse<T = any> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: any;
	};
	metadata?: {
		timestamp: number;
		duration?: number;
		[key: string]: any;
	};
}

/**
 * Create standardized API response
 */
export function createApiResponse<T>(data?: T, metadata?: Record<string, any>): ApiResponse<T> {
	return {
		success: true,
		data,
		metadata: {
			timestamp: Date.now(),
			...metadata,
		},
	};
}

/**
 * Create error API response
 */
export function createErrorResponse(
	error: Error | AppError,
	metadata?: Record<string, any>
): ApiResponse {
	const appError = error instanceof AppError ? error : handleError(error);

	return {
		success: false,
		error: {
			code: appError.code,
			message: appError.message,
			details: appError.details,
		},
		metadata: {
			timestamp: Date.now(),
			...metadata,
		},
	};
}

/**
 * Validate API response format
 */
export function validateApiResponse(response: any): response is ApiResponse {
	if (!response || typeof response !== 'object') {
		return false;
	}

	if (typeof response.success !== 'boolean') {
		return false;
	}

	if (!response.success && (!response.error || typeof response.error !== 'object')) {
		return false;
	}

	return true;
}

// ============================================================================
// File System Utilities
// ============================================================================

/**
 * Ensure directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
	try {
		await fs.promises.mkdir(dirPath, { recursive: true });
	} catch (error) {
		throw handleError(error, `ensuring directory ${dirPath}`);
	}
}

/**
 * Safe file read with error handling
 */
export async function safeReadFile(
	filePath: string,
	encoding: BufferEncoding = 'utf-8'
): Promise<string> {
	try {
		return await fs.promises.readFile(filePath, encoding);
	} catch (error) {
		throw handleError(error, `reading file ${filePath}`);
	}
}

/**
 * Safe file write with error handling
 */
export async function safeWriteFile(
	filePath: string,
	data: string | Buffer,
	options?: fs.WriteFileOptions
): Promise<void> {
	try {
		// Ensure directory exists
		const dir = path.dirname(filePath);
		await ensureDir(dir);

		// Write file
		await fs.promises.writeFile(filePath, data, options);
	} catch (error) {
		throw handleError(error, `writing file ${filePath}`);
	}
}

/**
 * Check if path exists
 */
export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Cleanup Utilities
// ============================================================================

export class CleanupManager {
	private cleanupTasks: Array<() => Promise<void>> = [];
	private isCleaningUp = false;

	/**
	 * Register a cleanup task
	 */
	register(task: () => Promise<void>): void {
		this.cleanupTasks.push(task);
	}

	/**
	 * Execute all cleanup tasks
	 */
	async cleanup(): Promise<void> {
		if (this.isCleaningUp) {
			return;
		}

		this.isCleaningUp = true;
		const errors: Error[] = [];

		for (const task of this.cleanupTasks) {
			try {
				await task();
			} catch (error) {
				errors.push(error as Error);
			}
		}

		this.cleanupTasks = [];
		this.isCleaningUp = false;

		if (errors.length > 0) {
			throw new AppError('Cleanup failed with errors', ErrorCode.IO_ERROR, {
				errors: errors.map((e) => e.message),
			});
		}
	}

	/**
	 * Setup process cleanup handlers
	 */
	setupProcessHandlers(): void {
		const handler = async () => {
			console.log('Cleaning up...');
			await this.cleanup();
			process.exit(0);
		};

		process.on('SIGINT', handler);
		process.on('SIGTERM', handler);
		process.on('beforeExit', handler);
	}
}

// ============================================================================
// String Utilities
// ============================================================================

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
	if (str.length <= maxLength) {
		return str;
	}
	return `${str.substring(0, maxLength - 3)}...`;
}

/**
 * Generate hash for content
 */
export function generateHash(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Convert to slug format
 */
export function toSlug(str: string): string {
	return str
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// ============================================================================
// Async Utilities
// ============================================================================

/**
 * Retry async operation with exponential backoff
 */
export async function retry<T>(
	fn: () => Promise<T>,
	options: {
		maxAttempts?: number;
		initialDelay?: number;
		maxDelay?: number;
		factor?: number;
		onRetry?: (attempt: number, error: Error) => void;
	} = {}
): Promise<T> {
	const { maxAttempts = 3, initialDelay = 1000, maxDelay = 10000, factor = 2, onRetry } = options;

	let lastError: Error;
	let delay = initialDelay;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;

			if (attempt === maxAttempts) {
				break;
			}

			if (onRetry) {
				onRetry(attempt, lastError);
			}

			await sleep(delay);
			delay = Math.min(delay * factor, maxDelay);
		}
	}

	throw lastError!;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Debounce function calls
 */
export function debounce<T extends (...args: any[]) => any>(
	fn: T,
	delay: number
): (...args: Parameters<T>) => void {
	let timeoutId: NodeJS.Timeout;

	return (...args: Parameters<T>) => {
		clearTimeout(timeoutId);
		timeoutId = setTimeout(() => fn(...args), delay);
	};
}

/**
 * Throttle function calls
 */
export function throttle<T extends (...args: any[]) => any>(
	fn: T,
	limit: number
): (...args: Parameters<T>) => void {
	let inThrottle = false;

	return (...args: Parameters<T>) => {
		if (!inThrottle) {
			fn(...args);
			inThrottle = true;
			setTimeout(() => {
				inThrottle = false;
			}, limit);
		}
	};
}

// ============================================================================
// Batch Processing Utilities
// ============================================================================

/**
 * Process items in batches
 */
export async function processBatch<T, R>(
	items: T[],
	processor: (batch: T[]) => Promise<R[]>,
	batchSize = 10
): Promise<R[]> {
	const results: R[] = [];

	for (let i = 0; i < items.length; i += batchSize) {
		const batch = items.slice(i, i + batchSize);
		const batchResults = await processor(batch);
		results.push(...batchResults);
	}

	return results;
}

/**
 * Process items in parallel with concurrency limit
 */
export async function processParallel<T, R>(
	items: T[],
	processor: (item: T) => Promise<R>,
	concurrency = 5
): Promise<R[]> {
	const results: R[] = [];
	const executing: Promise<void>[] = [];

	for (const item of items) {
		const promise = processor(item).then((result) => {
			results.push(result);
		});

		executing.push(promise);

		if (executing.length >= concurrency) {
			await Promise.race(executing);
			executing.splice(
				executing.findIndex((p) => p === promise),
				1
			);
		}
	}

	await Promise.all(executing);
	return results;
}

// ============================================================================
// Export all utilities
// ============================================================================

export default {
	// Error handling
	ErrorCode,
	AppError,
	handleError,
	withErrorHandling,

	// Validation
	validateInput,
	sanitizePath,
	isValidUUID,
	isValidDocumentId,

	// Cache
	Cache,

	// API
	createApiResponse,
	createErrorResponse,
	validateApiResponse,

	// File system
	ensureDir,
	safeReadFile,
	safeWriteFile,
	pathExists,

	// Cleanup
	CleanupManager,

	// String
	truncate,
	generateHash,
	toSlug,

	// Async
	retry,
	sleep,
	debounce,
	throttle,

	// Batch
	processBatch,
	processParallel,
};
