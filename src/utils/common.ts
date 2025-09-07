import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Error Handling
// ============================================================================

/** Error codes for standardized error handling */
export enum ErrorCode {
	// File & Resource Errors
	NOT_FOUND = 'NOT_FOUND',
	PERMISSION_DENIED = 'PERMISSION_DENIED',
	IO_ERROR = 'IO_ERROR',

	// Validation & Input Errors
	INVALID_INPUT = 'INVALID_INPUT',
	VALIDATION_ERROR = 'VALIDATION_ERROR',

	// System & Runtime Errors
	PROJECT_ERROR = 'PROJECT_ERROR',
	INITIALIZATION_ERROR = 'INITIALIZATION_ERROR',
	CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
	RUNTIME_ERROR = 'RUNTIME_ERROR',

	// Database & Sync Errors
	DATABASE_ERROR = 'DATABASE_ERROR',
	SYNC_ERROR = 'SYNC_ERROR',
	CONNECTION_ERROR = 'CONNECTION_ERROR',
	TRANSACTION_ERROR = 'TRANSACTION_ERROR',

	// API & Network Errors
	API_ERROR = 'API_ERROR',
	NETWORK_ERROR = 'NETWORK_ERROR',
	TIMEOUT_ERROR = 'TIMEOUT_ERROR',
	RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',

	// Cache & Memory Errors
	CACHE_ERROR = 'CACHE_ERROR',
	MEMORY_ERROR = 'MEMORY_ERROR',

	// Authentication & Authorization
	AUTH_ERROR = 'AUTH_ERROR',
	UNAUTHORIZED = 'UNAUTHORIZED',
	FORBIDDEN = 'FORBIDDEN',
}

/** Standard application error */
export class AppError extends Error {
	constructor(
		message: string,
		public code: ErrorCode,
		public details?: unknown,
		public statusCode: number = 500
	) {
		super(message);
		this.name = 'AppError';
		Error.captureStackTrace?.(this, this.constructor);
	}
}

/** Wrap unknown errors into AppError */
export function handleError(error: unknown, context?: string): AppError {
	if (error instanceof AppError) return error;

	if (error instanceof Error) {
		const { code, message, stack } = error as NodeJS.ErrnoException;
		switch (code) {
			case 'ENOENT':
				return new AppError(
					`Not found${context ? ` in ${context}` : ''}`,
					ErrorCode.NOT_FOUND,
					{ originalError: message },
					404
				);
			case 'EACCES':
			case 'EPERM':
				return new AppError(
					`Permission denied${context ? ` for ${context}` : ''}`,
					ErrorCode.PERMISSION_DENIED,
					{ originalError: message },
					403
				);
			case 'EEXIST':
				return new AppError(
					`Already exists${context ? ` in ${context}` : ''}`,
					ErrorCode.IO_ERROR,
					{ originalError: message },
					409
				);
			default:
				return new AppError(
					message || 'Unknown error',
					ErrorCode.PROJECT_ERROR,
					{ context, stack },
					500
				);
		}
	}

	return new AppError(
		'Unexpected error',
		ErrorCode.PROJECT_ERROR,
		{ error: String(error), context },
		500
	);
}

/** Higher-order async error wrapper */
export function withErrorHandling<T extends (...args: any[]) => Promise<unknown>>(
	fn: T,
	context?: string
): T {
	return (async (...args: Parameters<T>) => {
		try {
			return await fn(...args);
		} catch (e) {
			throw handleError(e, context);
		}
	}) as T;
}

/** Validation rule schema */
export interface ValidationRule {
	type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: RegExp;
	enum?: ReadonlyArray<unknown>;
	custom?: (value: unknown) => boolean | string;
}
export type ValidationSchema = Record<string, ValidationRule>;

/** Validate input against schema */
export function validateInput(
	input: Record<string, unknown>,
	schema: ValidationSchema,
	throwOnError = true
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	for (const [field, rules] of Object.entries(schema)) {
		const value = input[field];

		if (rules.required && (value === undefined || value === null || value === '')) {
			errors.push(`${field} is required`);
			continue;
		}

		if (value === undefined || value === null) continue;

		const type = Array.isArray(value) ? 'array' : typeof value;
		if (rules.type && type !== rules.type) {
			errors.push(`${field} must be ${rules.type}, got ${type}`);
			continue;
		}

		if (typeof value === 'string') {
			if (rules.minLength && value.length < rules.minLength)
				errors.push(`${field} min length ${rules.minLength}`);
			if (rules.maxLength && value.length > rules.maxLength)
				errors.push(`${field} max length ${rules.maxLength}`);
			if (rules.pattern && !rules.pattern.test(value))
				errors.push(`${field} pattern mismatch`);
		}

		if (typeof value === 'number') {
			if (rules.min !== undefined && value < rules.min)
				errors.push(`${field} >= ${rules.min}`);
			if (rules.max !== undefined && value > rules.max)
				errors.push(`${field} <= ${rules.max}`);
		}

		if (Array.isArray(value)) {
			if (rules.minLength && value.length < rules.minLength)
				errors.push(`${field} requires ${rules.minLength}+ items`);
			if (rules.maxLength && value.length > rules.maxLength)
				errors.push(`${field} max ${rules.maxLength} items`);
		}

		if (rules.enum && !rules.enum.includes(value))
			errors.push(`${field} must be one of: ${rules.enum.join(', ')}`);

		if (rules.custom) {
			const result = rules.custom(value);
			if (result !== true)
				errors.push(typeof result === 'string' ? result : `${field} invalid`);
		}
	}

	if (throwOnError && errors.length)
		throw new AppError('Validation failed', ErrorCode.VALIDATION_ERROR, { errors }, 400);

	return { valid: errors.length === 0, errors };
}

/** Sanitize and normalize a filesystem path */
export function sanitizePath(inputPath: string): string {
	return path
		.normalize(inputPath.replace(/\0/g, ''))
		.split(path.sep)
		.filter((p) => p && p !== '.' && p !== '..')
		.join(path.sep);
}

/** Validate UUID v4 */
export const isValidUUID = (uuid: string): boolean =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);

// ============================================================================
// API Response Utilities
// ============================================================================

export interface ApiResponse<T = unknown> {
	success: boolean;
	data?: T;
	error?: { code: string; message: string; details?: unknown };
	metadata?: { timestamp: number; duration?: number; [k: string]: unknown };
}

export function createApiResponse<T>(data?: T, metadata?: Record<string, unknown>): ApiResponse<T> {
	return { success: true, data, metadata: { timestamp: Date.now(), ...metadata } };
}

export function createErrorResponse(
	error: Error | AppError,
	metadata?: Record<string, unknown>
): ApiResponse {
	const appError = error instanceof AppError ? error : handleError(error);
	return {
		success: false,
		error: { code: appError.code, message: appError.message, details: appError.details },
		metadata: { timestamp: Date.now(), ...metadata },
	};
}

export function validateApiResponse(resp: unknown): resp is ApiResponse {
	if (!resp || typeof resp !== 'object') return false;
	const r = resp as ApiResponse;
	return typeof r.success === 'boolean' && (r.success || !!r.error);
}

// ============================================================================
// File System Utilities
// ============================================================================

export async function ensureDir(dirPath: string): Promise<void> {
	try {
		await fs.promises.mkdir(dirPath, { recursive: true });
	} catch (e) {
		throw handleError(e, `ensureDir ${dirPath}`);
	}
}

export async function safeReadFile(
	filePath: string,
	encoding: BufferEncoding = 'utf-8'
): Promise<string> {
	try {
		return await fs.promises.readFile(filePath, encoding);
	} catch (e) {
		throw handleError(e, `readFile ${filePath}`);
	}
}

export async function safeWriteFile(
	filePath: string,
	data: string | Buffer,
	options?: fs.WriteFileOptions
): Promise<void> {
	try {
		await ensureDir(path.dirname(filePath));
		await fs.promises.writeFile(filePath, data, options);
	} catch (e) {
		throw handleError(e, `writeFile ${filePath}`);
	}
}

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

	/** Register a cleanup task */
	register(task: () => Promise<void>): void {
		this.cleanupTasks.push(task);
	}

	/** Execute all registered cleanup tasks */
	async cleanup(): Promise<void> {
		if (this.isCleaningUp) return;
		this.isCleaningUp = true;

		const errors: Error[] = [];

		for (const task of this.cleanupTasks) {
			try {
				await task();
			} catch (err) {
				errors.push(err as Error);
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

	/** Setup process signal handlers */
	setupProcessHandlers(): void {
		const handler = async () => {
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

export const truncate = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max - 3)}...`;

export const generateHash = (s: string): string =>
	crypto.createHash('sha256').update(s).digest('hex');

export const toSlug = (s: string): string =>
	s
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '');

// ============================================================================
// Async Utilities
// ============================================================================

export async function retry<T>(
	fn: () => Promise<T>,
	{
		maxAttempts = 3,
		initialDelay = 1000,
		maxDelay = 10000,
		factor = 2,
		onRetry,
	}: {
		maxAttempts?: number;
		initialDelay?: number;
		maxDelay?: number;
		factor?: number;
		onRetry?: (attempt: number, e: Error) => void;
	} = {}
): Promise<T> {
	let last: Error;
	let delay = initialDelay;
	for (let i = 1; i <= maxAttempts; i++) {
		try {
			return await fn();
		} catch (e) {
			last = e as Error;
			if (i === maxAttempts) break;
			onRetry?.(i, last);
			await sleep(delay);
			delay = Math.min(delay * factor, maxDelay);
		}
	}
	throw last!;
}

export const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

export function debounce<T extends (...a: any[]) => void>(fn: T, delay: number) {
	let id: NodeJS.Timeout;
	return (...args: Parameters<T>) => {
		clearTimeout(id);
		id = setTimeout(() => fn(...args), delay);
	};
}

export function throttle<T extends (...a: any[]) => void>(fn: T, limit: number) {
	let inThrottle = false;
	return (...args: Parameters<T>) => {
		if (!inThrottle) {
			fn(...args);
			inThrottle = true;
			setTimeout(() => (inThrottle = false), limit);
		}
	};
}

// ============================================================================
// Batch Processing Utilities
// ============================================================================

export async function processBatch<T, R>(
	items: T[],
	processor: (batch: T[]) => Promise<R[]>,
	size = 10
): Promise<R[]> {
	const results: R[] = [];
	for (let i = 0; i < items.length; i += size) {
		results.push(...(await processor(items.slice(i, i + size))));
	}
	return results;
}

export async function processParallel<T, R>(
	items: T[],
	processor: (item: T) => Promise<R>,
	concurrency = 5
): Promise<R[]> {
	const results: R[] = [];
	const executing: Promise<void>[] = [];
	for (const item of items) {
		const p = processor(item).then((r) => {
			results.push(r);
		});
		executing.push(p);
		if (executing.length >= concurrency) {
			await Promise.race(executing);
			executing.splice(0, executing.length - concurrency + 1);
		}
	}
	await Promise.all(executing);
	return results;
}

// ============================================================================
// JSON & Object Utilities
// ============================================================================

/** Safe JSON parse */
export const safeParse = <T>(s: string, fallback: T): T => {
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

/** Safe JSON stringify */
export const safeStringify = (v: unknown): string => {
	try {
		return JSON.stringify(v);
	} catch {
		return '';
	}
};

/** Deep clone object */
export const deepClone = <T>(obj: T): T => structuredClone(obj);

/** Deep merge objects */
export function deepMerge<T extends object, U extends object>(a: T, b: U): T & U {
	const out: any = { ...a };
	for (const [k, v] of Object.entries(b)) {
		out[k] =
			v && typeof v === 'object' && !Array.isArray(v) ? deepMerge((a as any)[k] ?? {}, v) : v;
	}
	return out;
}

/** Get nested property safely */
export function getNested(obj: any, path: string, def?: unknown): unknown {
	return path.split('.').reduce((o, k) => (o && k in o ? o[k] : def), obj);
}

/** Set nested property safely */
export function setNested(obj: any, path: string, value: unknown): void {
	const keys = path.split('.');
	let cur = obj;
	for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] ??= {};
	cur[keys.at(-1)!] = value;
}

/** Check if object is empty */
export const isEmpty = (obj: any): boolean => {
	if (obj == null) return true;
	if (Array.isArray(obj) || typeof obj === 'string') return obj.length === 0;
	if (obj instanceof Map || obj instanceof Set) return obj.size === 0;
	return Object.keys(obj).length === 0;
};

/** Pick specific keys from object */
export const pick = <T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> => {
	const result = {} as Pick<T, K>;
	for (const key of keys) {
		if (key in obj) result[key] = obj[key];
	}
	return result;
};

/** Omit specific keys from object */
export const omit = <T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> => {
	const result = { ...obj };
	for (const key of keys) {
		delete result[key];
	}
	return result as Omit<T, K>;
};

// ============================================================================
// Array Utilities
// ============================================================================

/** Remove duplicates from array */
export const unique = <T>(arr: T[]): T[] => [...new Set(arr)];

/** Chunk array into smaller arrays */
export const chunk = <T>(arr: T[], size: number): T[][] => {
	const chunks: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
};

/** Group array by key */
export const groupBy = <T>(arr: T[], key: keyof T): Record<string, T[]> => {
	return arr.reduce(
		(acc, item) => {
			const group = String(item[key]);
			(acc[group] = acc[group] || []).push(item);
			return acc;
		},
		{} as Record<string, T[]>
	);
};

// ============================================================================
// Performance & Environment Utilities
// ============================================================================

/** Measure execution time */
export async function measureExecution<T>(
	fn: () => Promise<T>
): Promise<{ result: T; ms: number }> {
	const start = Date.now();
	const result = await fn();
	return { result, ms: Date.now() - start };
}

/** Simple token-bucket rate limiter */
export class RateLimiter {
	private tokens: number;
	private last = Date.now();
	constructor(
		private rate: number,
		private perMs: number
	) {
		this.tokens = rate;
	}
	tryRemove(): boolean {
		const now = Date.now();
		const delta = ((now - this.last) / this.perMs) * this.rate;
		this.tokens = Math.min(this.rate, this.tokens + delta);
		this.last = now;
		if (this.tokens >= 1) {
			this.tokens--;
			return true;
		}
		return false;
	}
}

/** Require environment variable */
export const requireEnv = (key: string): string => {
	const val = process.env[key];
	if (!val) throw new AppError(`Missing env ${key}`, ErrorCode.CONFIGURATION_ERROR);
	return val;
};

/** Is production env */
export const isProduction = (): boolean => process.env.NODE_ENV === 'production';

// ============================================================================
// Date & Time Utilities
// ============================================================================

/** Format duration in ms to human-readable string */
export const formatDuration = (ms: number): string => {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
};

/** Format bytes to human-readable size */
export const formatBytes = (bytes: number, decimals = 2): string => {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

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

	// JSON & Objects
	safeParse,
	safeStringify,
	deepClone,
	deepMerge,
	getNested,
	setNested,
	isEmpty,
	pick,
	omit,

	// Arrays
	unique,
	chunk,
	groupBy,

	// Performance & Environment
	measureExecution,
	RateLimiter,
	requireEnv,
	isProduction,

	// Date & Time
	formatDuration,
	formatBytes,
};
