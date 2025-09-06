import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export class SQLiteManager {
	private db: Database.Database | null = null;
	private dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	/**
	 * Initialize the SQLite database
	 */
	async initialize(): Promise<void> {
		// Ensure directory exists
		const dir = path.dirname(this.dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		// Open database connection
		this.db = new Database(this.dbPath);

		// Enable WAL mode for better performance
		this.db.exec('PRAGMA journal_mode = WAL;');
		this.db.exec('PRAGMA synchronous = NORMAL;');
		this.db.exec('PRAGMA cache_size = 1000;');
		this.db.exec('PRAGMA temp_store = MEMORY;');

		// Initialize database schema
		await this.createTables();
	}

	/**
	 * Create all necessary tables
	 */
	private async createTables(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

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
			throw new Error('Database not initialized. Call initialize() first.');
		}
		return this.db;
	}

	/**
	 * Execute a query
	 */
	query(sql: string, params: unknown[] = []): unknown[] {
		if (!this.db) throw new Error('Database not initialized');
		return this.db.prepare(sql).all(params);
	}

	/**
	 * Execute a single row query
	 */
	queryOne(sql: string, params: unknown[] = []): unknown {
		if (!this.db) throw new Error('Database not initialized');
		return this.db.prepare(sql).get(params);
	}

	/**
	 * Execute an insert/update/delete statement
	 */
	execute(sql: string, params: unknown[] = []): Database.RunResult {
		if (!this.db) throw new Error('Database not initialized');
		return this.db.prepare(sql).run(params);
	}

	/**
	 * Execute multiple statements in a transaction
	 */
	transaction<T>(fn: () => T): T {
		if (!this.db) throw new Error('Database not initialized');
		return this.db.transaction(fn)();
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	/**
	 * Get database file size
	 */
	getDatabaseStats(): { size: number; pageCount: number; pageSize: number } {
		if (!this.db) throw new Error('Database not initialized');

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
		if (!this.db) throw new Error('Database not initialized');
		this.db.exec('VACUUM;');
	}

	/**
	 * Backup database to a file
	 */
	backup(backupPath: string): void {
		if (!this.db) throw new Error('Database not initialized');
		this.db.backup(backupPath);
	}
}
