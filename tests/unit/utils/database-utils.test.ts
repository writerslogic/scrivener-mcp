import { describe, it, expect } from '@jest/globals';
import { ApplicationError as AppError, ErrorCode } from '../../../src/core/errors.js';
import { toDatabaseError, isTransientDatabaseError } from '../../../src/utils/database.js';

describe('Database Utils', () => {
	describe('toDatabaseError', () => {
		it('should convert a generic Error to an AppError', () => {
			const originalError = new Error('Connection failed');
			const result = toDatabaseError(originalError, 'test operation');

			expect(result).toBeInstanceOf(AppError);
			// Unrecognized messages classify as UNKNOWN -> generic database message + context.
			expect(result.message).toContain('Database operation failed in test operation');
			expect(result.code).toBe(ErrorCode.DATABASE_ERROR);
			expect(result.details).toEqual({
				originalError: 'Connection failed',
				type: 'UNKNOWN',
			});
		});

		it('should normalize an existing AppError into a database error', () => {
			// Current contract: toDatabaseError always produces a fresh DATABASE_ERROR.
			// It does not pass an existing AppError through unchanged.
			const appError = new AppError('Already an AppError', ErrorCode.CONFIGURATION_ERROR, {
				custom: 'data',
			});

			const result = toDatabaseError(appError, 'test operation');

			expect(result).toBeInstanceOf(AppError);
			expect(result.code).toBe(ErrorCode.DATABASE_ERROR);
			expect(result.message).toContain('Database operation failed in test operation');
			expect(result.details).toEqual({
				originalError: 'Already an AppError',
				type: 'UNKNOWN',
			});
		});

		it('should handle string errors', () => {
			const stringError = 'String error message';
			const result = toDatabaseError(stringError, 'string operation');

			expect(result).toBeInstanceOf(AppError);
			expect(result.message).toContain('Database operation failed in string operation');
			expect(result.code).toBe(ErrorCode.DATABASE_ERROR);
			// Non-Error inputs are stringified so their content is preserved.
			expect(result.details).toEqual({
				originalError: 'String error message',
				type: 'UNKNOWN',
			});
		});

		it('should expose the classification type and original message in details', () => {
			const error = new Error('Query failed');
			const result = toDatabaseError(error, 'SQL query');

			expect(result.message).toContain('SQL query');
			expect(result.details).toEqual({
				originalError: 'Query failed',
				type: 'UNKNOWN',
			});
		});

		it('should map a timeout error to the timeout code', () => {
			const result = toDatabaseError(new Error('Connection timeout'), 'read');

			expect(result.code).toBe(ErrorCode.TIMEOUT_ERROR);
			expect(result.message).toContain('Database operation timed out in read');
			expect(result.details).toEqual({
				originalError: 'Connection timeout',
				type: 'TIMEOUT',
			});
		});

		it('should handle undefined errors gracefully', () => {
			// undefined/null inputs are normalized into an AppError (not dereferenced).
			const result = toDatabaseError(undefined, 'undefined operation');

			expect(result).toBeInstanceOf(AppError);
			expect(result.code).toBe(ErrorCode.DATABASE_ERROR);
			expect(result.message).toContain('undefined operation');
		});

		it('should handle null errors gracefully', () => {
			// As above: null input is normalized rather than dereferenced.
			const result = toDatabaseError(null, 'null operation');

			expect(result).toBeInstanceOf(AppError);
			expect(result.code).toBe(ErrorCode.DATABASE_ERROR);
			expect(result.message).toContain('null operation');
		});
	});

	describe('isTransientDatabaseError', () => {
		// Transient policy: only TIMEOUT, LOCK and TRANSACTION (deadlock/abort)
		// classifications are retried. Connection/network errors are not.

		it('should identify connection timeout errors as transient', () => {
			const timeoutError = new Error('Connection timeout');
			expect(isTransientDatabaseError(timeoutError)).toBe(true);
		});

		it('should not treat connection-refused errors as transient', () => {
			const connectionError = new Error('ECONNREFUSED');
			expect(isTransientDatabaseError(connectionError)).toBe(false);
		});

		it('should not treat network-unreachable errors as transient', () => {
			const networkError = new Error('Network is unreachable');
			expect(isTransientDatabaseError(networkError)).toBe(false);
		});

		it('should not treat temporary-failure name-resolution errors as transient', () => {
			const tempFailure = new Error('Temporary failure in name resolution');
			expect(isTransientDatabaseError(tempFailure)).toBe(false);
		});

		it('should identify lock timeout errors as transient', () => {
			const lockError = new Error('Lock wait timeout exceeded');
			expect(isTransientDatabaseError(lockError)).toBe(true);
		});

		it('should identify deadlock errors as transient', () => {
			const deadlockError = new Error('Deadlock found when trying to get lock');
			expect(isTransientDatabaseError(deadlockError)).toBe(true);
		});

		it('should not treat generic server-unavailable errors as transient', () => {
			const serverError = new Error('Server unavailable');
			expect(isTransientDatabaseError(serverError)).toBe(false);
		});

		it('should identify database locked errors as transient', () => {
			const lockedError = new Error('database is locked');
			expect(isTransientDatabaseError(lockedError)).toBe(true);
		});

		it('should not identify syntax errors as transient', () => {
			const syntaxError = new Error('Syntax error in SQL statement');
			expect(isTransientDatabaseError(syntaxError)).toBe(false);
		});

		it('should not identify constraint violation errors as transient', () => {
			const constraintError = new Error('UNIQUE constraint failed');
			expect(isTransientDatabaseError(constraintError)).toBe(false);
		});

		it('should not identify permission errors as transient', () => {
			const permissionError = new Error('Access denied for user');
			expect(isTransientDatabaseError(permissionError)).toBe(false);
		});

		it('should not identify table not found errors as transient', () => {
			const notFoundError = new Error('Table users does not exist');
			expect(isTransientDatabaseError(notFoundError)).toBe(false);
		});

		it('should classify errors via their code property', () => {
			// A code containing "lock" classifies as LOCK -> transient.
			const errorWithCode = new Error('Connection failed') as Error & { code: string };
			errorWithCode.code = 'SQLITE_LOCKED';
			expect(isTransientDatabaseError(errorWithCode)).toBe(true);
		});

		it('should not treat an unrecognized Neo4j transient message as transient', () => {
			// The classifier keys off specific substrings; a bare "transient" is not one.
			const neo4jTransientError = new Error('Neo4j transient error: routing table outdated');
			expect(isTransientDatabaseError(neo4jTransientError)).toBe(false);
		});

		it('should not treat SQLITE_BUSY messages as transient', () => {
			// "busy" is not a recognized transient pattern; "locked" would be.
			const sqliteBusyError = new Error('SQLITE_BUSY: database is busy');
			expect(isTransientDatabaseError(sqliteBusyError)).toBe(false);
		});

		it('should not classify string errors (only Error objects are inspected)', () => {
			const stringError = 'Connection timeout occurred';
			expect(isTransientDatabaseError(stringError)).toBe(false);
		});

		it('should handle undefined/null errors safely', () => {
			expect(isTransientDatabaseError(undefined)).toBe(false);
			expect(isTransientDatabaseError(null)).toBe(false);
		});

		it('should be case insensitive', () => {
			const upperCaseError = new Error('CONNECTION TIMEOUT');
			expect(isTransientDatabaseError(upperCaseError)).toBe(true);

			const mixedCaseError = new Error('Database Is LOCKED');
			expect(isTransientDatabaseError(mixedCaseError)).toBe(true);
		});

		it('should handle errors with nested messages', () => {
			const nestedError = new Error(
				'Database operation failed: Connection timeout occurred while executing query'
			);
			expect(isTransientDatabaseError(nestedError)).toBe(true);
		});

		it('should treat a lock-bearing error code as transient', () => {
			const error = new Error('Test error') as Error & { code: string };
			error.code = 'SQLITE_LOCKED';
			expect(isTransientDatabaseError(error)).toBe(true);
		});

		it('should not treat connection/timeout error codes as transient', () => {
			// Only codes whose text contains a recognized pattern (deadlock/timeout/locked)
			// are transient. These do not, so they are not retried.
			const nonMatchingCodes = [
				'ECONNRESET',
				'ECONNREFUSED',
				'ETIMEDOUT',
				'ENOTFOUND',
				'EAI_AGAIN',
				'SQLITE_BUSY',
			];

			nonMatchingCodes.forEach((code) => {
				const error = new Error('Test error') as Error & { code: string };
				error.code = code;
				expect(isTransientDatabaseError(error)).toBe(false);
			});
		});

		it('should not identify non-transient error codes', () => {
			const nonTransientCodes = ['SQLITE_CONSTRAINT', 'SQLITE_MISUSE', 'EACCES', 'EPERM'];

			nonTransientCodes.forEach((code) => {
				const error = new Error('Test error') as Error & { code: string };
				error.code = code;
				expect(isTransientDatabaseError(error)).toBe(false);
			});
		});
	});
});
