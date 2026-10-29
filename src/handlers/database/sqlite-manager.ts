import type { RunResult } from 'better-sqlite3';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logger.js';
import {
	AppError,
	ErrorCode,
	ensureDir,
	formatBytes,
	formatDuration,
	measureExecution,
	retry,
} from '../../utils/common.js';
import { CachedSQLiteManager } from './keydb-cache.js';

const logger = getLogger('sqlite-manager');

export class SQLiteManager {
	private db: Database.Database | null = null;
	private dbPath: string;
	private transactionDepth = 0;
	private readonly callbackDepths: number[] = [];
	private cachedManager: CachedSQLiteManager | null = null;
	private initialized = false;
	private lifecycleTail: Promise<void> = Promise.resolve();

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	initialize(): Promise<void> {
		return this.transition(() => this.initializeDatabase());
	}

	private async initializeDatabase(): Promise<void> {
		if (this.initialized && this.db?.open) return;
		try {
			await this.releaseResources();
			const initResult = await measureExecution(async () => {
				// Ensure directory exists
				const dir = path.dirname(this.dbPath);
				await ensureDir(dir);

				// Open database connection with retry for robustness
				await retry(
					async () => {
						this.db = new Database(this.dbPath);
						try {
							this.db.exec('SELECT 1');
						} catch (error) {
							this.db.close();
							this.db = null;
							throw error;
						}
					},
					{ maxAttempts: 3 }
				);

				// Enable WAL mode and optimizations for better performance
				this.db!.exec('PRAGMA journal_mode = WAL;');
				this.db!.exec('PRAGMA synchronous = NORMAL;');
				this.db!.exec('PRAGMA cache_size = 10000;'); // Increased cache
				this.db!.exec('PRAGMA temp_store = MEMORY;');
				this.db!.exec('PRAGMA mmap_size = 268435456;'); // 256MB mmap
				this.db!.exec('PRAGMA application_id = 0x574C4D43;'); // Schema provider tag

				// Get database size for monitoring
				const stats = fs.statSync(this.dbPath);
				logger.info(`Database file size: ${formatBytes(stats.size)}`);

				await this.createTables();

				// Initialize cached manager if KeyDB is available
				this.cachedManager = new CachedSQLiteManager(this);
				await this.cachedManager.initialize();
			});

			logger.info(`SQLite database initialized in ${formatDuration(initResult.ms)}`);
			this.initialized = true;
		} catch (error) {
			try {
				await this.releaseResources();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					'SQLite initialization and cleanup failed',
					{ cause: cleanupError }
				);
			}
			throw error;
		}
	}

	private async createTables(): Promise<void> {
		if (!this.db) {
			throw new AppError('Database not initialized', ErrorCode.DATABASE_ERROR);
		}

		const createResult = await measureExecution(async () => {
			// Execute all table creation in a transaction for atomicity and performance
			this.db!.transaction(() => {
				// Documents table
				this.db!.exec(`
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
				this.db!.exec(`
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
				this.db!.exec(`
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
				this.db!.exec(`
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
				this.db!.exec(`
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
				this.db!.exec(`
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
				this.db!.exec(`
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
				this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_documents_type ON documents (type);`);
				this.db!.exec(
					`CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents (modified_at);`
				);
				this.db!.exec(
					`CREATE INDEX IF NOT EXISTS idx_characters_name ON characters (name);`
				);
				this.db!.exec(
					`CREATE INDEX IF NOT EXISTS idx_sessions_date ON writing_sessions (date);`
				);
				this.db!.exec(
					`CREATE INDEX IF NOT EXISTS idx_analysis_document ON content_analysis (document_id);`
				);
				this.db!.exec(
					`CREATE INDEX IF NOT EXISTS idx_analysis_type ON content_analysis (analysis_type);`
				);
			})();
		});

		logger.info(`Database tables created in ${formatDuration(createResult.ms)}`);
	}

	getDatabase(): Database.Database {
		if (!this.db?.open) {
			throw new AppError(
				'Database not initialized. Call initialize() first.',
				ErrorCode.DATABASE_ERROR
			);
		}
		if (this.callbackDepths.length && !this.db.inTransaction)
			throw new AppError(
				'Transaction callback was already rolled back',
				ErrorCode.DATABASE_ERROR
			);
		return this.db;
	}

	getCachedManager(): CachedSQLiteManager | null {
		return this.cachedManager;
	}

	isCachingAvailable(): boolean {
		return this.cachedManager?.getCacheStats().size !== undefined;
	}

	/**
	 * Execute a query
	 */
	query(sql: string, params: unknown[] = []): unknown[] {
		return this.getDatabase().prepare(sql).all(params);
	}

	/**
	 * Execute a single row query
	 */
	queryOne(sql: string, params: unknown[] = []): unknown {
		return this.getDatabase().prepare(sql).get(params);
	}

	/**
	 * Execute an insert/update/delete statement
	 */
	execute(sql: string, params: unknown[] = []): RunResult {
		return this.getDatabase().prepare(sql).run(params);
	}

	/**
	 * Execute multiple statements in a transaction with retry logic
	 */
	async transaction<T>(fn: () => T, retries: number = 3): Promise<T> {
		const db = this.getDatabase();
		if (!Number.isSafeInteger(retries) || retries < 1)
			throw new AppError('Retries must be a positive safe integer', ErrorCode.INVALID_INPUT);
		if (
			['[object AsyncFunction]', '[object AsyncGeneratorFunction]'].includes(
				Object.prototype.toString.call(fn)
			)
		)
			throw new AppError(
				'Transaction callbacks must be synchronous',
				ErrorCode.INVALID_INPUT
			);
		const run = db.transaction(() => {
			const depth = this.transactionDepth;
			this.transactionDepth++;
			this.callbackDepths.push(this.transactionDepth);
			try {
				const result = fn();
				if (!db.inTransaction || this.transactionDepth !== depth + 1)
					throw new AppError(
						'Transaction callback changed its transaction scope',
						ErrorCode.DATABASE_ERROR
					);
				return result;
			} finally {
				this.callbackDepths.pop();
				this.transactionDepth = depth;
			}
		});
		for (let i = 0; i < retries; i++) {
			try {
				return run();
			} catch (error) {
				if (!db.open || !db.inTransaction) this.transactionDepth = 0;
				if (
					(error as { code?: string } | null)?.code === 'SQLITE_BUSY' &&
					i < retries - 1 &&
					db.open &&
					!db.inTransaction
				) {
					const delay = Math.min(100 * Math.pow(2, i), 1000);
					await new Promise((resolve) => setTimeout(resolve, delay));
					if (this.db !== db || !db.open)
						throw new AppError(
							'Database closed during transaction retry',
							ErrorCode.DATABASE_ERROR
						);
					if (db.inTransaction)
						throw new AppError(
							'Another transaction started during retry',
							ErrorCode.DATABASE_ERROR
						);
					continue;
				}
				throw error;
			}
		}
		throw new AppError('Transaction retry invariant failed', ErrorCode.DATABASE_ERROR);
	}

	/**
	 * Begin an explicit transaction
	 */
	beginTransaction(): void {
		const db = this.getDatabase();
		if (this.transactionDepth === 0) {
			db.prepare('BEGIN TRANSACTION').run();
			this.transactionDepth = 1;
		} else {
			if (!db.inTransaction) {
				this.transactionDepth = 0;
				throw new AppError(
					'Managed transaction is no longer active',
					ErrorCode.DATABASE_ERROR
				);
			}
			this.transactionDepth++;
		}
	}

	/**
	 * Commit the current transaction
	 */
	commit(): void {
		const db = this.getDatabase();
		if (this.transactionDepth === 0) return;
		if (!db.inTransaction) {
			this.transactionDepth = 0;
			throw new AppError('Managed transaction is no longer active', ErrorCode.DATABASE_ERROR);
		}
		if (this.callbackDepths[this.callbackDepths.length - 1] === this.transactionDepth)
			throw new AppError(
				'Callback transactions cannot be committed explicitly',
				ErrorCode.DATABASE_ERROR
			);
		if (this.transactionDepth === 1) db.prepare('COMMIT').run();
		this.transactionDepth--;
	}

	/**
	 * Rollback the current transaction
	 */
	rollback(): void {
		const db = this.getDatabase();
		if (this.callbackDepths.length)
			throw new AppError(
				'Callback transactions must be rolled back by throwing',
				ErrorCode.DATABASE_ERROR
			);
		if (db.inTransaction) db.prepare('ROLLBACK').run();
		this.transactionDepth = 0;
	}

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
					isInTransaction: this.db.inTransaction,
				},
			};
		} catch (error) {
			return {
				healthy: false,
				details: { error: (error as Error).message },
			};
		}
	}

	close(): Promise<void> {
		return this.transition(() => this.releaseResources());
	}

	private transition(operation: () => Promise<void>): Promise<void> {
		const pending = this.lifecycleTail.then(operation);
		this.lifecycleTail = pending.catch(() => undefined);
		return pending;
	}

	private async releaseResources(): Promise<void> {
		this.initialized = false;
		const failures: unknown[] = [];
		if (this.cachedManager) {
			try {
				await this.cachedManager.close();
				this.cachedManager = null;
			} catch (error) {
				failures.push(error);
			}
		}
		if (this.db) {
			try {
				if (this.db.open) this.db.close();
				this.db = null;
				this.transactionDepth = 0;
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new Error('Multiple SQLite resources failed to close', { cause: failures });
	}

	getDatabaseStats(): { size: number; pageCount: number; pageSize: number } {
		const db = this.getDatabase();

		const stats = fs.statSync(this.dbPath);
		const pageCount = db.pragma('page_count', { simple: true }) as number;
		const pageSize = db.pragma('page_size', { simple: true }) as number;

		return {
			size: stats.size,
			pageCount,
			pageSize,
		};
	}

	/**
	 * Vacuum the database to reclaim space
	 */
	vacuum(): void {
		this.getDatabase().exec('VACUUM;');
	}

	/**
	 * Resolve after the backup is complete; queued shutdown waits for this copy
	 */
	backup(backupPath: string): Promise<void> {
		this.getDatabase();
		return this.transition(() =>
			this.getDatabase()
				.backup(backupPath)
				.then(() => undefined)
		);
	}
}
