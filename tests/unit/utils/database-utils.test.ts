import { describe, it, expect, beforeEach } from '@jest/globals';
import { ApplicationError as AppError, ErrorCode } from '../../../src/core/errors.js';
import { toDatabaseError, isTransientDatabaseError } from '../../../src/utils/database.js';

describe('Database Utils', () => {
  describe('toDatabaseError', () => {
    it('should convert generic Error to AppError', () => {
      const originalError = new Error('Connection failed');
      const result = toDatabaseError(originalError, 'test operation');

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toContain('Database error during test operation');
      expect(result.code).toBe(ErrorCode.DATABASE_ERROR);
      expect(result.details).toEqual({
        operation: 'test operation',
        originalMessage: 'Connection failed',
        originalError: originalError,
      });
    });

    it('should preserve AppError as is', () => {
      const appError = new AppError(
        'Already an AppError',
        ErrorCode.CONFIGURATION_ERROR,
        { custom: 'data' }
      );
      
      const result = toDatabaseError(appError, 'test operation');
      
      expect(result).toBe(appError);
      expect(result.message).toBe('Already an AppError');
      expect(result.code).toBe(ErrorCode.CONFIGURATION_ERROR);
    });

    it('should handle string errors', () => {
      const stringError = 'String error message';
      const result = toDatabaseError(stringError, 'string operation');

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toContain('Database error during string operation');
      expect(result.code).toBe(ErrorCode.DATABASE_ERROR);
      expect(result.details).toEqual({
        operation: 'string operation',
        originalMessage: 'String error message',
        originalError: stringError,
      });
    });

    it('should handle undefined errors', () => {
      const result = toDatabaseError(undefined, 'undefined operation');

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toContain('Database error during undefined operation');
      expect(result.code).toBe(ErrorCode.DATABASE_ERROR);
      expect(result.details).toEqual({
        operation: 'undefined operation',
        originalMessage: 'Unknown error',
        originalError: undefined,
      });
    });

    it('should handle errors with additional context', () => {
      const error = new Error('Query failed');
      const result = toDatabaseError(error, 'SQL query', { table: 'users', action: 'SELECT' });

      expect(result.details).toEqual({
        operation: 'SQL query',
        originalMessage: 'Query failed',
        originalError: error,
        table: 'users',
        action: 'SELECT',
      });
    });

    it('should handle null errors', () => {
      const result = toDatabaseError(null, 'null operation');

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toContain('Database error during null operation');
      expect(result.details.originalMessage).toBe('Unknown error');
    });
  });

  describe('isTransientDatabaseError', () => {
    it('should identify connection timeout errors as transient', () => {
      const timeoutError = new Error('Connection timeout');
      expect(isTransientDatabaseError(timeoutError)).toBe(true);
    });

    it('should identify connection refused errors as transient', () => {
      const connectionError = new Error('ECONNREFUSED');
      expect(isTransientDatabaseError(connectionError)).toBe(true);
    });

    it('should identify network unreachable errors as transient', () => {
      const networkError = new Error('Network is unreachable');
      expect(isTransientDatabaseError(networkError)).toBe(true);
    });

    it('should identify temporary failure errors as transient', () => {
      const tempFailure = new Error('Temporary failure in name resolution');
      expect(isTransientDatabaseError(tempFailure)).toBe(true);
    });

    it('should identify lock timeout errors as transient', () => {
      const lockError = new Error('Lock wait timeout exceeded');
      expect(isTransientDatabaseError(lockError)).toBe(true);
    });

    it('should identify deadlock errors as transient', () => {
      const deadlockError = new Error('Deadlock found when trying to get lock');
      expect(isTransientDatabaseError(deadlockError)).toBe(true);
    });

    it('should identify server unavailable errors as transient', () => {
      const serverError = new Error('Server unavailable');
      expect(isTransientDatabaseError(serverError)).toBe(true);
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

    it('should handle errors with codes', () => {
      const errorWithCode = new Error('Connection failed') as Error & { code: string };
      errorWithCode.code = 'ECONNRESET';
      expect(isTransientDatabaseError(errorWithCode)).toBe(true);
    });

    it('should handle Neo4j transient errors', () => {
      const neo4jTransientError = new Error('Neo4j transient error: routing table outdated');
      expect(isTransientDatabaseError(neo4jTransientError)).toBe(true);
    });

    it('should handle SQLite busy errors', () => {
      const sqliteBusyError = new Error('SQLITE_BUSY: database is busy');
      expect(isTransientDatabaseError(sqliteBusyError)).toBe(true);
    });

    it('should handle string errors', () => {
      const stringError = 'Connection timeout occurred';
      expect(isTransientDatabaseError(stringError)).toBe(true);
    });

    it('should handle undefined/null errors safely', () => {
      expect(isTransientDatabaseError(undefined)).toBe(false);
      expect(isTransientDatabaseError(null)).toBe(false);
    });

    it('should be case insensitive', () => {
      const upperCaseError = new Error('CONNECTION TIMEOUT');
      expect(isTransientDatabaseError(upperCaseError)).toBe(true);

      const mixedCaseError = new Error('Temporary Failure');
      expect(isTransientDatabaseError(mixedCaseError)).toBe(true);
    });

    it('should handle errors with nested messages', () => {
      const nestedError = new Error('Database operation failed: Connection timeout occurred while executing query');
      expect(isTransientDatabaseError(nestedError)).toBe(true);
    });

    it('should identify specific error codes as transient', () => {
      const transientCodes = [
        'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 
        'EAI_AGAIN', 'SQLITE_BUSY', 'SQLITE_LOCKED'
      ];

      transientCodes.forEach(code => {
        const error = new Error('Test error') as Error & { code: string };
        error.code = code;
        expect(isTransientDatabaseError(error)).toBe(true);
      });
    });

    it('should not identify non-transient error codes', () => {
      const nonTransientCodes = [
        'SQLITE_CONSTRAINT', 'SQLITE_MISUSE', 'EACCES', 'EPERM'
      ];

      nonTransientCodes.forEach(code => {
        const error = new Error('Test error') as Error & { code: string };
        error.code = code;
        expect(isTransientDatabaseError(error)).toBe(false);
      });
    });
  });
});