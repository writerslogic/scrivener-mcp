import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';
import { MigrationManager, type Migration } from '../../../../src/handlers/database/migrations.js';
import { ApplicationError as AppError, ErrorCode } from '../../../../src/core/errors.js';
import { toDatabaseError } from '../../../../src/utils/database.js';

// Mock the logger
jest.mock('../../../../src/core/logger.js', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

// Mock the database utilities
jest.mock('../../../../src/utils/database.js', () => ({
  toDatabaseError: jest.fn((error, operation) => {
    if (error instanceof AppError) return error;
    return new AppError(
      `Database error during ${operation}`,
      ErrorCode.DATABASE_ERROR,
      { operation, originalError: error }
    );
  }),
}));

describe('MigrationManager', () => {
  let mockSQLiteManager: any;
  let mockNeo4jManager: any;
  let migrationManager: MigrationManager;
  let mockDatabase: any;

  beforeEach(() => {
    mockDatabase = {
      exec: jest.fn(),
    };

    mockSQLiteManager = {
      getDatabase: jest.fn(() => mockDatabase),
      queryOne: jest.fn(),
      execute: jest.fn(),
    };

    mockNeo4jManager = {
      isAvailable: jest.fn(() => true),
      query: jest.fn(),
    };

    migrationManager = new MigrationManager(mockSQLiteManager, mockNeo4jManager);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create migration manager with both databases', () => {
      expect(migrationManager).toBeInstanceOf(MigrationManager);
      expect(migrationManager['sqliteManager']).toBe(mockSQLiteManager);
      expect(migrationManager['neo4jManager']).toBe(mockNeo4jManager);
    });

    it('should create migration manager with only SQLite', () => {
      const manager = new MigrationManager(mockSQLiteManager, null);
      expect(manager['sqliteManager']).toBe(mockSQLiteManager);
      expect(manager['neo4jManager']).toBeNull();
    });

    it('should create migration manager with only Neo4j', () => {
      const manager = new MigrationManager(null, mockNeo4jManager);
      expect(manager['sqliteManager']).toBeNull();
      expect(manager['neo4jManager']).toBe(mockNeo4jManager);
    });

    it('should initialize with predefined migrations', () => {
      expect(migrationManager['migrations']).toBeDefined();
      expect(migrationManager['migrations'].length).toBeGreaterThan(0);
      
      // Check specific migrations exist
      const migrationNames = migrationManager['migrations'].map(m => m.name);
      expect(migrationNames).toContain('initial_schema');
      expect(migrationNames).toContain('add_locations_table');
      expect(migrationNames).toContain('add_full_text_search');
    });
  });

  describe('initialize', () => {
    it('should create migrations table and set current version', async () => {
      mockSQLiteManager.queryOne.mockReturnValue({ version: 3 });

      await migrationManager.initialize();

      expect(mockDatabase.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS migrations')
      );
      expect(mockSQLiteManager.queryOne).toHaveBeenCalledWith(
        'SELECT MAX(version) as version FROM migrations'
      );
      expect(migrationManager['currentVersion']).toBe(3);
    });

    it('should handle null current version', async () => {
      mockSQLiteManager.queryOne.mockReturnValue({ version: null });

      await migrationManager.initialize();

      expect(migrationManager['currentVersion']).toBe(0);
    });

    it('should handle no SQLite manager', async () => {
      const manager = new MigrationManager(null, mockNeo4jManager);
      
      await manager.initialize();

      expect(manager['currentVersion']).toBe(0);
      expect(mockDatabase.exec).not.toHaveBeenCalled();
    });
  });

  describe('migrate', () => {
    beforeEach(async () => {
      mockSQLiteManager.queryOne.mockReturnValue({ version: 1 });
      await migrationManager.initialize();
    });

    it('should run pending migrations', async () => {
      const mockMigration: Migration = {
        version: 2,
        name: 'test_migration',
        up: jest.fn().mockResolvedValue(undefined),
      };

      // Override migrations for testing
      migrationManager['migrations'] = [
        { version: 1, name: 'completed', up: jest.fn() },
        mockMigration,
      ];

      await migrationManager.migrate();

      expect(mockMigration.up).toHaveBeenCalledWith(mockSQLiteManager, mockNeo4jManager);
      expect(mockSQLiteManager.execute).toHaveBeenCalledWith(
        'INSERT INTO migrations (version, name) VALUES (?, ?)',
        [2, 'test_migration']
      );
      expect(mockDatabase.exec).toHaveBeenCalledWith('BEGIN TRANSACTION');
      expect(mockDatabase.exec).toHaveBeenCalledWith('COMMIT');
    });

    it('should skip if no pending migrations', async () => {
      migrationManager['currentVersion'] = 10;
      
      await migrationManager.migrate();

      expect(mockDatabase.exec).not.toHaveBeenCalledWith('BEGIN TRANSACTION');
    });

    it('should rollback on migration failure', async () => {
      const failingMigration: Migration = {
        version: 2,
        name: 'failing_migration',
        up: jest.fn().mockRejectedValue(new Error('Migration failed')),
      };

      migrationManager['migrations'] = [failingMigration];
      migrationManager['currentVersion'] = 1;

      await expect(migrationManager.migrate()).rejects.toThrow();

      expect(mockDatabase.exec).toHaveBeenCalledWith('ROLLBACK');
      expect(toDatabaseError).toHaveBeenCalledWith(
        expect.any(Error),
        'migration 2'
      );
    });

    it('should handle SQLite-specific migrations', async () => {
      const sqlMigration: Migration = {
        version: 2,
        name: 'sql_migration',
        sql: 'CREATE TABLE test (id INTEGER);',
        up: jest.fn().mockResolvedValue(undefined),
      };

      migrationManager['migrations'] = [sqlMigration];
      migrationManager['currentVersion'] = 1;

      await migrationManager.migrate();

      expect(sqlMigration.up).toHaveBeenCalledWith(mockSQLiteManager, mockNeo4jManager);
    });

    it('should handle Neo4j-specific migrations', async () => {
      const cypherMigration: Migration = {
        version: 2,
        name: 'neo4j_migration',
        cypher: 'CREATE CONSTRAINT unique_test FOR (n:Test) REQUIRE n.id IS UNIQUE;',
        up: jest.fn().mockResolvedValue(undefined),
      };

      migrationManager['migrations'] = [cypherMigration];
      migrationManager['currentVersion'] = 1;

      await migrationManager.migrate();

      expect(cypherMigration.up).toHaveBeenCalledWith(mockSQLiteManager, mockNeo4jManager);
    });
  });

  describe('rollbackTo', () => {
    beforeEach(() => {
      migrationManager['currentVersion'] = 3;
    });

    it('should rollback migrations with down methods', async () => {
      const migration: Migration = {
        version: 2,
        name: 'rollback_test',
        up: jest.fn(),
        down: jest.fn().mockResolvedValue(undefined),
      };

      migrationManager['migrations'] = [migration];

      await migrationManager.rollbackTo(1);

      expect(migration.down).toHaveBeenCalledWith(mockSQLiteManager, mockNeo4jManager);
      expect(mockSQLiteManager.execute).toHaveBeenCalledWith(
        'DELETE FROM migrations WHERE version = ?',
        [2]
      );
      expect(migrationManager['currentVersion']).toBe(1);
    });

    it('should skip migrations without down methods', async () => {
      const migrationWithoutDown: Migration = {
        version: 2,
        name: 'no_down_method',
        up: jest.fn(),
      };

      migrationManager['migrations'] = [migrationWithoutDown];

      await migrationManager.rollbackTo(1);

      expect(mockSQLiteManager.execute).not.toHaveBeenCalled();
    });

    it('should handle rollback failures', async () => {
      const failingRollback: Migration = {
        version: 2,
        name: 'failing_rollback',
        up: jest.fn(),
        down: jest.fn().mockRejectedValue(new Error('Rollback failed')),
      };

      migrationManager['migrations'] = [failingRollback];

      await expect(migrationManager.rollbackTo(1)).rejects.toThrow('Rollback failed');
    });

    it('should rollback multiple migrations in reverse order', async () => {
      const migration2: Migration = {
        version: 2,
        name: 'second',
        up: jest.fn(),
        down: jest.fn().mockResolvedValue(undefined),
      };

      const migration3: Migration = {
        version: 3,
        name: 'third',
        up: jest.fn(),
        down: jest.fn().mockResolvedValue(undefined),
      };

      migrationManager['migrations'] = [migration2, migration3];

      await migrationManager.rollbackTo(1);

      // Should rollback in reverse order: 3 first, then 2
      expect(migration3.down).toHaveBeenCalledBefore(migration2.down as any);
    });
  });

  describe('getStatus', () => {
    it('should return correct migration status', () => {
      migrationManager['currentVersion'] = 2;
      migrationManager['migrations'] = [
        { version: 1, name: 'first', up: jest.fn() },
        { version: 2, name: 'second', up: jest.fn() },
        { version: 3, name: 'third', up: jest.fn() },
      ];

      const status = migrationManager.getStatus();

      expect(status).toEqual({
        currentVersion: 2,
        latestVersion: 3,
        pendingMigrations: 1,
        appliedMigrations: ['1: first', '2: second'],
      });
    });

    it('should handle no migrations', () => {
      migrationManager['migrations'] = [];
      migrationManager['currentVersion'] = 0;

      const status = migrationManager.getStatus();

      expect(status.latestVersion).toBe(-Infinity);
      expect(status.pendingMigrations).toBe(0);
      expect(status.appliedMigrations).toEqual([]);
    });
  });

  describe('exportSchema', () => {
    it('should export SQLite schema', async () => {
      const mockTables = [
        { sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY)' },
        { sql: 'CREATE TABLE posts (id INTEGER, user_id INTEGER)' },
      ];

      const mockIndexes = [
        { sql: 'CREATE INDEX idx_posts_user ON posts (user_id)' },
        { sql: null }, // Should be filtered out
      ];

      mockSQLiteManager.query
        .mockReturnValueOnce(mockTables)
        .mockReturnValueOnce(mockIndexes);

      const result = await migrationManager.exportSchema();

      expect(result.sql).toContain('CREATE TABLE users');
      expect(result.sql).toContain('CREATE TABLE posts');
      expect(result.sql).toContain('CREATE INDEX idx_posts_user');
      expect(mockSQLiteManager.query).toHaveBeenCalledWith(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      );
    });

    it('should export Neo4j schema', async () => {
      const mockConstraints = {
        records: [
          {
            get: jest.fn()
              .mockReturnValueOnce('unique_user_email')
              .mockReturnValueOnce(['User']),
          },
        ],
      };

      mockNeo4jManager.query.mockResolvedValue(mockConstraints);

      const result = await migrationManager.exportSchema();

      expect(result.cypher).toContain('Constraint: unique_user_email on User');
      expect(mockNeo4jManager.query).toHaveBeenCalledWith(
        'SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties RETURN *'
      );
    });

    it('should handle unavailable Neo4j', async () => {
      mockNeo4jManager.isAvailable.mockReturnValue(false);

      const result = await migrationManager.exportSchema();

      expect(result.cypher).toBe('');
      expect(mockNeo4jManager.query).not.toHaveBeenCalled();
    });

    it('should handle missing databases', async () => {
      const manager = new MigrationManager(null, null);

      const result = await manager.exportSchema();

      expect(result.sql).toBe('');
      expect(result.cypher).toBe('');
    });
  });

  describe('Specific Migration Tests', () => {
    it('should have locations table migration', () => {
      const locationsMigration = migrationManager['migrations'].find(
        m => m.name === 'add_locations_table'
      );

      expect(locationsMigration).toBeDefined();
      expect(locationsMigration?.sql).toContain('CREATE TABLE IF NOT EXISTS locations');
      expect(locationsMigration?.sql).toContain('significance TEXT DEFAULT \'minor\'');
    });

    it('should have full-text search migration', () => {
      const ftsMigration = migrationManager['migrations'].find(
        m => m.name === 'add_full_text_search'
      );

      expect(ftsMigration).toBeDefined();
      expect(ftsMigration?.sql).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts');
      expect(ftsMigration?.sql).toContain('USING fts5');
    });

    it('should have character arcs migration', () => {
      const arcsMigration = migrationManager['migrations'].find(
        m => m.name === 'add_character_arcs_table'
      );

      expect(arcsMigration).toBeDefined();
      expect(arcsMigration?.sql).toContain('CREATE TABLE IF NOT EXISTS character_arcs');
      expect(arcsMigration?.sql).toContain('emotional_state TEXT');
    });

    it('should have Neo4j constraints migration', () => {
      const neo4jMigration = migrationManager['migrations'].find(
        m => m.name === 'neo4j_constraints'
      );

      expect(neo4jMigration).toBeDefined();
      expect(neo4jMigration?.cypher).toContain('CREATE CONSTRAINT unique_character_id');
      expect(neo4jMigration?.cypher).toContain('FOR (c:Character) REQUIRE c.id IS UNIQUE');
    });
  });
});