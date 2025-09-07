/**
 * Centralized error handling
 */

export enum ErrorCode {
	// Project errors
	PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
	PROJECT_NOT_OPEN = 'PROJECT_NOT_OPEN',
	PROJECT_INVALID = 'PROJECT_INVALID',
	PROJECT_LOCKED = 'PROJECT_LOCKED',
	PROJECT_ERROR = 'PROJECT_ERROR',

	// Document errors
	DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
	DOCUMENT_INVALID = 'DOCUMENT_INVALID',
	DOCUMENT_LOCKED = 'DOCUMENT_LOCKED',
	DOCUMENT_TOO_LARGE = 'DOCUMENT_TOO_LARGE',
	NOT_FOUND = 'NOT_FOUND',

	// Validation errors
	VALIDATION_FAILED = 'VALIDATION_FAILED',
	INVALID_INPUT = 'INVALID_INPUT',
	MISSING_REQUIRED = 'MISSING_REQUIRED',
	TYPE_MISMATCH = 'TYPE_MISMATCH',
	VALIDATION_ERROR = 'VALIDATION_ERROR',

	// Database errors
	DATABASE_ERROR = 'DATABASE_ERROR',
	CONNECTION_ERROR = 'CONNECTION_ERROR',
	TRANSACTION_ERROR = 'TRANSACTION_ERROR',
	QUERY_ERROR = 'QUERY_ERROR',
	SYNC_ERROR = 'SYNC_ERROR',

	// File system errors
	FILE_NOT_FOUND = 'FILE_NOT_FOUND',
	FILE_ACCESS_DENIED = 'FILE_ACCESS_DENIED',
	FILE_WRITE_ERROR = 'FILE_WRITE_ERROR',
	PATH_INVALID = 'PATH_INVALID',
	IO_ERROR = 'IO_ERROR',
	INVALID_FORMAT = 'INVALID_FORMAT',

	// Memory/cache errors
	MEMORY_ERROR = 'MEMORY_ERROR',
	CACHE_FULL = 'CACHE_FULL',
	CACHE_MISS = 'CACHE_MISS',

	// Analysis errors
	ANALYSIS_ERROR = 'ANALYSIS_ERROR',
	ENHANCEMENT_ERROR = 'ENHANCEMENT_ERROR',
	AI_SERVICE_ERROR = 'AI_SERVICE_ERROR',
	INITIALIZATION_ERROR = 'INITIALIZATION_ERROR',

	// State errors
	INVALID_STATE = 'INVALID_STATE',
	NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',

	// General errors
	UNKNOWN_ERROR = 'UNKNOWN_ERROR',
	TIMEOUT_ERROR = 'TIMEOUT_ERROR',
	NETWORK_ERROR = 'NETWORK_ERROR',
	PERMISSION_DENIED = 'PERMISSION_DENIED',
	CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

export class ApplicationError extends Error {
	constructor(
		message: string,
		public readonly code: ErrorCode,
		public readonly details?: unknown,
		public readonly isRetryable: boolean = false
	) {
		super(message);
		this.name = 'ApplicationError';
	}

	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			details: this.details,
			isRetryable: this.isRetryable,
			stack: this.stack,
		};
	}
}

// Error message constants
export const ErrorMessages = {
	// Project messages
	[ErrorCode.PROJECT_NOT_FOUND]: 'Project not found at specified path',
	[ErrorCode.PROJECT_NOT_OPEN]: 'No project is currently open',
	[ErrorCode.PROJECT_INVALID]: 'Invalid project structure',
	[ErrorCode.PROJECT_LOCKED]: 'Project is locked by another process',
	[ErrorCode.PROJECT_ERROR]: 'Project operation failed',

	// Document messages
	[ErrorCode.DOCUMENT_NOT_FOUND]: 'Document not found',
	[ErrorCode.DOCUMENT_INVALID]: 'Invalid document format',
	[ErrorCode.DOCUMENT_LOCKED]: 'Document is locked for editing',
	[ErrorCode.DOCUMENT_TOO_LARGE]: 'Document exceeds maximum size',
	[ErrorCode.NOT_FOUND]: 'Resource not found',

	// Validation messages
	[ErrorCode.VALIDATION_FAILED]: 'Validation failed',
	[ErrorCode.INVALID_INPUT]: 'Invalid input provided',
	[ErrorCode.MISSING_REQUIRED]: 'Required field missing',
	[ErrorCode.TYPE_MISMATCH]: 'Type mismatch in input',
	[ErrorCode.VALIDATION_ERROR]: 'Validation error',

	// Database messages
	[ErrorCode.DATABASE_ERROR]: 'Database operation failed',
	[ErrorCode.CONNECTION_ERROR]: 'Database connection failed',
	[ErrorCode.TRANSACTION_ERROR]: 'Transaction failed',
	[ErrorCode.QUERY_ERROR]: 'Query execution failed',
	[ErrorCode.SYNC_ERROR]: 'Synchronization failed',

	// File system messages
	[ErrorCode.FILE_NOT_FOUND]: 'File not found',
	[ErrorCode.FILE_ACCESS_DENIED]: 'File access denied',
	[ErrorCode.FILE_WRITE_ERROR]: 'Failed to write file',
	[ErrorCode.PATH_INVALID]: 'Invalid file path',
	[ErrorCode.IO_ERROR]: 'I/O operation failed',
	[ErrorCode.INVALID_FORMAT]: 'Invalid format',

	// Memory/cache messages
	[ErrorCode.MEMORY_ERROR]: 'Memory operation failed',
	[ErrorCode.CACHE_FULL]: 'Cache is full',
	[ErrorCode.CACHE_MISS]: 'Item not found in cache',

	// Analysis messages
	[ErrorCode.ANALYSIS_ERROR]: 'Content analysis failed',
	[ErrorCode.ENHANCEMENT_ERROR]: 'Content enhancement failed',
	[ErrorCode.AI_SERVICE_ERROR]: 'AI service error',
	[ErrorCode.INITIALIZATION_ERROR]: 'Initialization failed',

	// State messages
	[ErrorCode.INVALID_STATE]: 'Invalid state',
	[ErrorCode.NOT_IMPLEMENTED]: 'Not implemented',

	// General messages
	[ErrorCode.UNKNOWN_ERROR]: 'An unknown error occurred',
	[ErrorCode.TIMEOUT_ERROR]: 'Operation timed out',
	[ErrorCode.NETWORK_ERROR]: 'Network error',
	[ErrorCode.PERMISSION_DENIED]: 'Permission denied',
	[ErrorCode.CONFIGURATION_ERROR]: 'Configuration error',
} as const;

/**
 * Create error with standard message
 */
export function createError(
	code: ErrorCode,
	details?: unknown,
	customMessage?: string
): ApplicationError {
	const message = customMessage || ErrorMessages[code] || 'An error occurred';
	const isRetryable = [
		ErrorCode.CONNECTION_ERROR,
		ErrorCode.TIMEOUT_ERROR,
		ErrorCode.NETWORK_ERROR,
		ErrorCode.TRANSACTION_ERROR,
	].includes(code);

	return new ApplicationError(message, code, details, isRetryable);
}

/**
 * Wrap unknown error
 */
export function wrapError(
	error: unknown,
	code: ErrorCode = ErrorCode.UNKNOWN_ERROR
): ApplicationError {
	if (error instanceof ApplicationError) {
		return error;
	}

	const message = error instanceof Error ? error.message : String(error);
	const details =
		error instanceof Error ? { originalError: error.stack } : { originalError: error };

	return new ApplicationError(message, code, details);
}

/**
 * Error handler for async operations
 */
export async function withErrorHandling<T>(
	operation: () => Promise<T>,
	errorCode: ErrorCode = ErrorCode.UNKNOWN_ERROR
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw wrapError(error, errorCode);
	}
}

/**
 * Retry logic for retryable errors
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	maxRetries: number = 3,
	delayMs: number = 1000
): Promise<T> {
	let lastError: ApplicationError | undefined;

	for (let i = 0; i < maxRetries; i++) {
		try {
			return await operation();
		} catch (error) {
			lastError = wrapError(error);

			if (!lastError.isRetryable || i === maxRetries - 1) {
				throw lastError;
			}

			await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
		}
	}

	throw lastError || createError(ErrorCode.UNKNOWN_ERROR);
}
