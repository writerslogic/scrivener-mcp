import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logger.js';
import { AppError, ErrorCode, ensureDir } from '../../utils/common.js';
import { CachedSQLiteManager } from './keydb-cache.js';

const logger = getLogger('sqlite-manager');

export class SQLiteManager {
	private db: Database.Database | null = null;
	private dbPath: string;
	private transactionDepth: number = 0;
	private isInTransaction: boolean = false;
	private pendingOperations: Array<() => void> = [];
	private cachedManager: CachedSQLiteManager | null = null;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	/**
	 * Initialize the SQLite database
	 */
	async initialize(): Promise<void> {
		// Ensure directory exists
		const dir = path.dirname(this.dbPath);
		await ensureDir(dir);

		// Open database connection
		this.db = new Database(this.dbPath);

		// Enable WAL mode for better performance
		this.db.exec('PRAGMA journal_mode = WAL;');
		this.db.exec('PRAGMA synchronous = NORMAL;');
		this.db.exec('PRAGMA cache_size = 1000;');
		this.db.exec('PRAGMA temp_store = MEMORY;');

		// Initialize database schema
		await this.createTables();

		// Initialize cached manager if KeyDB is available
		this.cachedManager = new CachedSQLiteManager(this);
		await this.cachedManager.initialize();
	}

	/**
	 * Create all necessary tables
	 */
	private async createTables(): Promise<void> {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}

		// Documents table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS documents (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				type TEXT NOT NULL,
				path TEXT NOT NULL,
				synopsis TEXT,
				notes TEXT,
				label TEXT,
				status TEXT,
				word_count INTEGER DEFAULT 0,
				character_count INTEGER DEFAULT 0,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				modified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				include_in_compile BOOLEAN DEFAULT 1
			);
		`);

		// Characters table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS characters (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				role TEXT,
				description TEXT,
				traits TEXT, -- JSON array
				character_arc TEXT,
				appearances TEXT, -- JSON array of document IDs
				relationships TEXT, -- JSON array
				notes TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				modified_at DATETIME DEFAULT CURRENT_TIMESTAMP
			);
		`);

		// Plot threads table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS plot_threads (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT,
				status TEXT DEFAULT 'active',
				documents TEXT, -- JSON array of document IDs
				notes TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				modified_at DATETIME DEFAULT CURRENT_TIMESTAMP
			);
		`);

		// Themes table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS themes (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				description TEXT,
				documents TEXT, -- JSON array of document IDs
				importance INTEGER DEFAULT 1,
				notes TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			);
		`);

		// Writing sessions table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS writing_sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				date TEXT NOT NULL,
				words_written INTEGER DEFAULT 0,
				duration_minutes INTEGER DEFAULT 0,
				documents_worked_on TEXT, -- JSON array of document IDs
				goals_met BOOLEAN DEFAULT 0,
				notes TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			);
		`);

		// Document relationships table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS document_relationships (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_document_id TEXT NOT NULL,
				target_document_id TEXT NOT NULL,
				relationship_type TEXT NOT NULL, -- 'follows', 'references', 'continues', 'flashback', etc.
				notes TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (source_document_id) REFERENCES documents (id),
				FOREIGN KEY (target_document_id) REFERENCES documents (id),
				UNIQUE(source_document_id, target_document_id, relationship_type)
			);
		`);

		// Content analysis table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS content_analysis (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				document_id TEXT NOT NULL,
				analysis_type TEXT NOT NULL, -- 'readability', 'sentiment', 'style', etc.
				analysis_data TEXT NOT NULL, -- JSON
				analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (document_id) REFERENCES documents (id)
			);
		`);

		// Create indexes for better performance
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_type ON documents (type);`);
		this.db.exec(
			`CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents (modified_at);`
		);
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_characters_name ON characters (name);`);
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON writing_sessions (date);`);
		this.db.exec(
			`CREATE INDEX IF NOT EXISTS idx_analysis_document ON content_analysis (document_id);`
		);
		this.db.exec(
			`CREATE INDEX IF NOT EXISTS idx_analysis_type ON content_analysis (analysis_type);`
		);
	}

	/**
	 * Get the database instance
	 */
	getDatabase(): Database.Database {
		if (!this.db) {
			throw new AppError(
				'Database not initialized. Call initialize() first.',
				ErrorCode.DATABASE_ERROR
			);
		}
		return this.db;
	}

	/**
	 * Get cached database manager (if available)
	 */
	getCachedManager(): CachedSQLiteManager | null {
		return this.cachedManager;
	}

	/**
	 * Check if caching is available
	 */
	isCachingAvailable(): boolean {
		return this.cachedManager?.getCacheStats().size !== undefined;
	}

	/**
	 * Execute a query
	 */
	query(sql: string, params: unknown[] = []): unknown[] {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}
		return this.db.prepare(sql).all(params);
	}

	/**
	 * Execute a single row query
	 */
	queryOne(sql: string, params: unknown[] = []): unknown {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}
		return this.db.prepare(sql).get(params);
	}

	/**
	 * Execute an insert/update/delete statement
	 */
	execute(sql: string, params: unknown[] = []): Database.RunResult {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}
		return this.db.prepare(sql).run(params);
	}

	/**
	 * Execute multiple statements in a transaction with retry logic
	 */
	transaction<T>(fn: () => T, retries: number = 3): T {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}

		let lastError: Error | null = null;
		for (let i = 0; i < retries; i++) {
			try {
				this.isInTransaction = true;
				this.transactionDepth++;
				const result = this.db.transaction(fn)();
				this.transactionDepth--;
				if (this.transactionDepth === 0) {
					this.isInTransaction = false;
					this.processPendingOperations();
				}
				return result;
			} catch (error) {
				lastError = error as Error;
				this.transactionDepth = Math.max(0, this.transactionDepth - 1);
				if (this.transactionDepth === 0) {
					this.isInTransaction = false;
				}
				// If it's a busy error, retry
				if ((error as { code?: string }).code === 'SQLITE_BUSY' && i < retries - 1) {
					// Wait a bit before retrying
					const delay = Math.min(100 * Math.pow(2, i), 1000);
					const start = Date.now();
					while (Date.now() - start < delay) {
						// Busy wait
					}
					continue;
				}
				throw error;
			}
		}
		throw (
			lastError || new AppError('Transaction failed after retries', ErrorCode.DATABASE_ERROR)
		);
	}

	/**
	 * Process pending operations after transaction completes
	 */
	private processPendingOperations(): void {
		while (this.pendingOperations.length > 0) {
			const operation = this.pendingOperations.shift();
			if (operation) {
				try {
					operation();
				} catch (_error) {
					// Log but don't throw - these are non-critical operations
					logger.debug('Non-critical operation failed', { error: _error });
				}
			}
		}
	}

	/**
	 * Begin an explicit transaction
	 */
	beginTransaction(): void {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}
		if (!this.isInTransaction) {
			this.db.prepare('BEGIN TRANSACTION').run();
			this.isInTransaction = true;
			this.transactionDepth = 1;
		} else {
			this.transactionDepth++;
		}
	}

	/**
	 * Commit the current transaction
	 */
	commit(): void {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}
		if (this.transactionDepth > 0) {
			this.transactionDepth--;
			if (this.transactionDepth === 0 && this.isInTransaction) {
				this.db.prepare('COMMIT').run();
				this.isInTransaction = false;
				this.processPendingOperations();
			}
		}
	}

	/**
	 * Rollback the current transaction
	 */
	rollback(): void {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}
		if (this.isInTransaction) {
			this.db.prepare('ROLLBACK').run();
			this.isInTransaction = false;
			this.transactionDepth = 0;
			this.pendingOperations = [];
		}
	}

	/**
	 * Check if database is healthy
	 */
	async checkHealth(): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
		try {
			if (!this.db) {
				return { healthy: false, details: { error: 'Database not initialized' } };
			}

			// Run integrity check
			const integrity = this.db.pragma('integrity_check');
			const isHealthy = Array.isArray(integrity) && integrity[0]?.integrity_check === 'ok';

			// Get statistics
			const stats = this.getDatabaseStats();

			return {
				healthy: isHealthy,
				details: {
					integrity,
					stats,
					transactionDepth: this.transactionDepth,
					isInTransaction: this.isInTransaction,
				},
			};
		} catch (error) {
			return {
				healthy: false,
				details: { error: (error as Error).message },
			};
		}
	}

	/**
	 * Close the database connection
	 */
	async close(): Promise<void> {
		if (this.cachedManager) {
			await this.cachedManager.close();
			this.cachedManager = null;
		}

		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	/**
	 * Get database file size
	 */
	getDatabaseStats(): { size: number; pageCount: number; pageSize: number } {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}

		const stats = fs.statSync(this.dbPath);
		const pragma = this.db.pragma('page_count') as { page_count: number };
		const pageSize = this.db.pragma('page_size') as { page_size: number };

		return {
			size: stats.size,
			pageCount: pragma.page_count,
			pageSize: pageSize.page_size,
		};
	}

	/**
	 * Vacuum the database to reclaim space
	 */
	vacuum(): void {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}
		this.db.exec('VACUUM;');
	}

	/**
	 * Backup database to a file
	 */
	backup(backupPath: string): void {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}
		this.db.backup(backupPath);
	}
}
