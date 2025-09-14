import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';
import { Neo4jManager } from '../../../../src/handlers/database/neo4j-manager.js';
import { ApplicationError as AppError, ErrorCode } from '../../../../src/core/errors.js';
import { isTransientDatabaseError, toDatabaseError } from '../../../../src/utils/database.js';

// Mock neo4j driver
const mockSession = {
  run: jest.fn(),
  close: jest.fn(),
  executeRead: jest.fn(),
  executeWrite: jest.fn(),
};

const mockDriver = {
  session: jest.fn(() => mockSession),
  close: jest.fn(),
  verifyConnectivity: jest.fn(),
};

jest.mock('neo4j-driver', () => ({
  driver: jest.fn(() => mockDriver),
  auth: {
    basic: jest.fn((username, password) => ({ username, password })),
  },
}));

// Mock logger
jest.mock('../../../../src/core/logger.js', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

// Mock database utilities
jest.mock('../../../../src/utils/database.js', () => ({
  isTransientDatabaseError: jest.fn((error) => {
    return error.code === 'ServiceUnavailable' || 
           error.code === 'SessionExpired' ||
           error.message?.includes('timeout');
  }),
  toDatabaseError: jest.fn((error, operation) => {
    if (error instanceof AppError) return error;
    return new AppError(
      `Database error during ${operation}: ${error.message}`,
      ErrorCode.DATABASE_ERROR,
      { operation, originalError: error }
    );
  }),
}));

describe('Neo4jManager Enhanced Error Handling', () => {
  let neo4jManager: Neo4jManager;
  let mockConfig: any;

  beforeEach(() => {
    mockConfig = {
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'password',
      database: 'neo4j',
    };

    neo4jManager = new Neo4jManager(mockConfig);
    
    // Reset all mocks
    jest.clearAllMocks();
    mockSession.run.mockClear();
    mockSession.close.mockClear();
    mockDriver.session.mockReturnValue(mockSession);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Connection Management', () => {
    it('should handle connection failures with proper error handling', async () => {
      const connectionError = new Error('Connection failed');
      connectionError.code = 'ServiceUnavailable';
      
      mockDriver.verifyConnectivity.mockRejectedValue(connectionError);

      await expect(neo4jManager.testConnection()).rejects.toThrow(AppError);
      
      expect(toDatabaseError).toHaveBeenCalledWith(connectionError, 'connection test');
    });

    it('should identify transient connection errors', async () => {
      const transientError = new Error('Session expired');
      transientError.code = 'SessionExpired';
      
      mockSession.run.mockRejectedValue(transientError);

      try {
        await neo4jManager.query('MATCH (n) RETURN count(n)');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(isTransientDatabaseError).toHaveBeenCalledWith(transientError);
      }
    });

    it('should handle timeout errors as transient', async () => {
      const timeoutError = new Error('Query timeout');
      
      mockSession.run.mockRejectedValue(timeoutError);

      try {
        await neo4jManager.query('MATCH (n) RETURN count(n)');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(isTransientDatabaseError).toHaveBeenCalledWith(timeoutError);
      }
    });
  });

  describe('Query Execution with Enhanced Error Handling', () => {
    it('should handle successful queries', async () => {
      const mockResult = {
        records: [
          { get: jest.fn(() => 5) }
        ],
      };

      mockSession.run.mockResolvedValue(mockResult);

      const result = await neo4jManager.query('MATCH (n) RETURN count(n) as count');

      expect(result).toBe(mockResult);
      expect(mockSession.run).toHaveBeenCalledWith('MATCH (n) RETURN count(n) as count', {});
    });

    it('should handle parametrized queries', async () => {
      const mockResult = {
        records: [
          { get: jest.fn(() => ({ id: '123', name: 'Test Character' })) }
        ],
      };

      mockSession.run.mockResolvedValue(mockResult);

      const result = await neo4jManager.query(
        'MATCH (c:Character {id: $id}) RETURN c',
        { id: '123' }
      );

      expect(result).toBe(mockResult);
      expect(mockSession.run).toHaveBeenCalledWith(
        'MATCH (c:Character {id: $id}) RETURN c',
        { id: '123' }
      );
    });

    it('should convert database errors to AppError', async () => {
      const dbError = new Error('Syntax error in query');
      dbError.code = 'Neo.ClientError.Statement.SyntaxError';
      
      mockSession.run.mockRejectedValue(dbError);

      try {
        await neo4jManager.query('INVALID QUERY');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(toDatabaseError).toHaveBeenCalledWith(dbError, 'query execution');
        expect(error).toBeInstanceOf(AppError);
      }
    });

    it('should handle constraint violations', async () => {
      const constraintError = new Error('Node already exists');
      constraintError.code = 'Neo.ClientError.Schema.ConstraintValidationFailed';
      
      mockSession.run.mockRejectedValue(constraintError);

      try {
        await neo4jManager.query('CREATE (c:Character {id: "existing"})');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(toDatabaseError).toHaveBeenCalledWith(constraintError, 'query execution');
      }
    });

    it('should handle authorization errors', async () => {
      const authError = new Error('Access denied');
      authError.code = 'Neo.ClientError.Security.Unauthorized';
      
      mockSession.run.mockRejectedValue(authError);

      try {
        await neo4jManager.query('MATCH (n) RETURN n');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(toDatabaseError).toHaveBeenCalledWith(authError, 'query execution');
      }
    });

    it('should properly close sessions after errors', async () => {
      const dbError = new Error('Database error');
      mockSession.run.mockRejectedValue(dbError);

      try {
        await neo4jManager.query('MATCH (n) RETURN n');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(mockSession.close).toHaveBeenCalled();
      }
    });
  });

  describe('Write Operations with Error Handling', () => {
    it('should handle successful write operations', async () => {
      const mockResult = {
        records: [],
        summary: {
          counters: {
            nodesCreated: 1,
            propertiesSet: 3,
          },
        },
      };

      mockSession.executeWrite.mockResolvedValue(mockResult);

      const result = await neo4jManager.write(
        'CREATE (c:Character {id: $id, name: $name}) RETURN c',
        { id: '123', name: 'Test Character' }
      );

      expect(result).toBe(mockResult);
      expect(mockSession.executeWrite).toHaveBeenCalled();
    });

    it('should handle write transaction failures', async () => {
      const transactionError = new Error('Transaction rolled back');
      transactionError.code = 'Neo.TransientError.Transaction.TransactionMarkedAsFailed';
      
      mockSession.executeWrite.mockRejectedValue(transactionError);

      try {
        await neo4jManager.write('CREATE (c:Character {id: "test"})');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(isTransientDatabaseError).toHaveBeenCalledWith(transactionError);
        expect(toDatabaseError).toHaveBeenCalledWith(transactionError, 'write transaction');
      }
    });

    it('should handle deadlock errors as transient', async () => {
      const deadlockError = new Error('Deadlock detected');
      deadlockError.code = 'Neo.TransientError.Transaction.DeadlockDetected';
      
      mockSession.executeWrite.mockRejectedValue(deadlockError);

      try {
        await neo4jManager.write('CREATE (c:Character {id: "test"})');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(isTransientDatabaseError).toHaveBeenCalledWith(deadlockError);
      }
    });
  });

  describe('Read Operations with Error Handling', () => {
    it('should handle successful read operations', async () => {
      const mockResult = {
        records: [
          { get: jest.fn(() => ({ id: '123', name: 'Test Character' })) }
        ],
      };

      mockSession.executeRead.mockResolvedValue(mockResult);

      const result = await neo4jManager.read(
        'MATCH (c:Character {id: $id}) RETURN c',
        { id: '123' }
      );

      expect(result).toBe(mockResult);
      expect(mockSession.executeRead).toHaveBeenCalled();
    });

    it('should handle read transaction failures', async () => {
      const readError = new Error('Unable to route read request');
      readError.code = 'Neo.ClientError.Cluster.NotALeader';
      
      mockSession.executeRead.mockRejectedValue(readError);

      try {
        await neo4jManager.read('MATCH (n) RETURN count(n)');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(toDatabaseError).toHaveBeenCalledWith(readError, 'read transaction');
      }
    });
  });

  describe('Batch Operations with Error Handling', () => {
    it('should handle successful batch operations', async () => {
      const queries = [
        { query: 'CREATE (c1:Character {id: "1", name: "Alice"})', params: {} },
        { query: 'CREATE (c2:Character {id: "2", name: "Bob"})', params: {} },
      ];

      mockSession.executeWrite.mockResolvedValue({ records: [], summary: {} });

      await neo4jManager.executeBatch(queries);

      expect(mockSession.executeWrite).toHaveBeenCalledTimes(2);
    });

    it('should handle partial batch failures', async () => {
      const queries = [
        { query: 'CREATE (c1:Character {id: "1", name: "Alice"})', params: {} },
        { query: 'INVALID QUERY', params: {} },
      ];

      mockSession.executeWrite
        .mockResolvedValueOnce({ records: [], summary: {} })
        .mockRejectedValueOnce(new Error('Syntax error'));

      try {
        await neo4jManager.executeBatch(queries);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(toDatabaseError).toHaveBeenCalledWith(
          expect.any(Error),
          'batch execution'
        );
      }
    });

    it('should handle transaction rollback in batch operations', async () => {
      const queries = [
        { query: 'CREATE (c1:Character {id: "1"})', params: {} },
        { query: 'CREATE (c2:Character {id: "1"})', params: {} }, // Duplicate ID
      ];

      const constraintError = new Error('Constraint violation');
      constraintError.code = 'Neo.ClientError.Schema.ConstraintValidationFailed';

      mockSession.executeWrite
        .mockResolvedValueOnce({ records: [], summary: {} })
        .mockRejectedValueOnce(constraintError);

      try {
        await neo4jManager.executeBatch(queries);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(toDatabaseError).toHaveBeenCalledWith(constraintError, 'batch execution');
      }
    });
  });

  describe('Connection Health Monitoring', () => {
    it('should properly test database availability', () => {
      expect(neo4jManager.isAvailable()).toBe(true);
    });

    it('should handle unavailable database', () => {
      neo4jManager['driver'] = null;
      expect(neo4jManager.isAvailable()).toBe(false);
    });

    it('should verify connectivity with proper error handling', async () => {
      mockDriver.verifyConnectivity.mockResolvedValue(undefined);

      await expect(neo4jManager.testConnection()).resolves.not.toThrow();
      expect(mockDriver.verifyConnectivity).toHaveBeenCalled();
    });

    it('should handle connectivity verification failures', async () => {
      const connectivityError = new Error('Cannot connect to database');
      connectivityError.code = 'ServiceUnavailable';
      
      mockDriver.verifyConnectivity.mockRejectedValue(connectivityError);

      try {
        await neo4jManager.testConnection();
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(toDatabaseError).toHaveBeenCalledWith(connectivityError, 'connection test');
        expect(error).toBeInstanceOf(AppError);
      }
    });
  });

  describe('Resource Cleanup', () => {
    it('should close driver properly', async () => {
      await neo4jManager.close();
      expect(mockDriver.close).toHaveBeenCalled();
    });

    it('should handle close errors gracefully', async () => {
      mockDriver.close.mockRejectedValue(new Error('Close failed'));

      // Should not throw, but log the error
      await expect(neo4jManager.close()).resolves.not.toThrow();
    });

    it('should ensure sessions are closed after operations', async () => {
      const mockResult = { records: [] };
      mockSession.run.mockResolvedValue(mockResult);

      await neo4jManager.query('MATCH (n) RETURN count(n)');

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('Error Classification', () => {
    it('should correctly identify transient errors', () => {
      const transientCodes = [
        'ServiceUnavailable',
        'SessionExpired',
        'Neo.TransientError.Transaction.TransactionMarkedAsFailed',
        'Neo.TransientError.Transaction.DeadlockDetected',
      ];

      transientCodes.forEach(code => {
        const error = new Error('Test error');
        error.code = code;
        
        expect(isTransientDatabaseError(error)).toBe(true);
      });
    });

    it('should correctly identify non-transient errors', () => {
      const nonTransientCodes = [
        'Neo.ClientError.Statement.SyntaxError',
        'Neo.ClientError.Schema.ConstraintValidationFailed',
        'Neo.ClientError.Security.Unauthorized',
      ];

      nonTransientCodes.forEach(code => {
        const error = new Error('Test error');
        error.code = code;
        
        expect(isTransientDatabaseError(error)).toBe(false);
      });
    });

    it('should handle timeout errors as transient', () => {
      const timeoutError = new Error('Query execution timeout');
      
      expect(isTransientDatabaseError(timeoutError)).toBe(true);
    });
  });

  describe('Integration with Database Utilities', () => {
    it('should use toDatabaseError for consistent error formatting', async () => {
      const originalError = new Error('Original database error');
      mockSession.run.mockRejectedValue(originalError);

      try {
        await neo4jManager.query('MATCH (n) RETURN n');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(toDatabaseError).toHaveBeenCalledWith(originalError, 'query execution');
      }
    });

    it('should preserve AppError instances', async () => {
      const appError = new AppError('Custom app error', ErrorCode.VALIDATION_ERROR);
      mockSession.run.mockRejectedValue(appError);

      try {
        await neo4jManager.query('MATCH (n) RETURN n');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBe(appError);
        expect(toDatabaseError).toHaveBeenCalledWith(appError, 'query execution');
      }
    });
  });
});