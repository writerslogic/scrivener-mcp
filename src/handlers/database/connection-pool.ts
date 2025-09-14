/**
 * Database connection pooling and optimization
 */

import Database from 'better-sqlite3';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { createError, ErrorCode, withRetry } from '../../core/errors.js';
import { waitForCondition } from '../../utils/condition-waiter.js';

interface PoolConfig {
	maxConnections?: number;
	minConnections?: number;
	acquireTimeout?: number;
	idleTimeout?: number;
	connectionRetryLimit?: number;
	connectionRetryDelay?: number;
}

/**
 * SQLite connection pool
 */
export class SQLitePool {
	private connections: Database.Database[] = [];
	private available: Database.Database[] = [];
	private readonly config: Required<PoolConfig>;

	constructor(
		private readonly dbPath: string,
		config: PoolConfig = {}
	) {
		this.config = {
			maxConnections: config.maxConnections || 5,
			minConnections: config.minConnections || 1,
			acquireTimeout: config.acquireTimeout || 5000,
			idleTimeout: config.idleTimeout || 30000,
			connectionRetryLimit: config.connectionRetryLimit || 3,
			connectionRetryDelay: config.connectionRetryDelay || 100,
		};

		// Initialize minimum connections
		this.initialize();
	}

	private initialize(): void {
		for (let i = 0; i < this.config.minConnections; i++) {
			const conn = this.createConnection();
			this.connections.push(conn);
			this.available.push(conn);
		}
	}

	private createConnection(): Database.Database {
		const conn = new Database(this.dbPath);

		// Optimize SQLite settings
		conn.pragma('journal_mode = WAL');
		conn.pragma('synchronous = NORMAL');
		conn.pragma('cache_size = -64000'); // 64MB cache
		conn.pragma('temp_store = MEMORY');
		conn.pragma('mmap_size = 268435456'); // 256MB memory map
		conn.pragma('page_size = 4096');
		conn.pragma('optimize');

		return conn;
	}

	async acquire(): Promise<Database.Database> {
		// Use condition-based waiting instead of polling with fixed delays
		await waitForCondition({
			condition: async () => {
				// Return available connection
				if (this.available.length > 0) {
					return true;
				}

				// Create new connection if under limit
				if (this.connections.length < this.config.maxConnections) {
					return true;
				}

				return false; // No connection available, keep waiting
			},
			description: 'Database connection acquisition',
			timeout: this.config.acquireTimeout || 5000,
			pollInterval: 10, // Very short interval for connection pools
		});

		// After condition is met, actually acquire the connection
		if (this.available.length > 0) {
			return this.available.pop()!;
		}

		// Create new connection if under limit
		if (this.connections.length < this.config.maxConnections) {
			const conn = this.createConnection();
			this.connections.push(conn);
			return conn;
		}

		throw createError(ErrorCode.TIMEOUT_ERROR, null, 'Failed to acquire database connection');
	}

	release(conn: Database.Database): void {
		if (!this.connections.includes(conn)) {
			return; // Connection not from this pool
		}

		// Return to available pool
		if (!this.available.includes(conn)) {
			this.available.push(conn);
		}
	}

	async execute<T>(fn: (db: Database.Database) => T): Promise<T> {
		const conn = await this.acquire();
		try {
			return fn(conn);
		} finally {
			this.release(conn);
		}
	}

	async transaction<T>(fn: (db: Database.Database) => T): Promise<T> {
		return this.execute((db) => {
			const transaction = db.transaction(() => fn(db));
			return transaction();
		});
	}

	close(): void {
		for (const conn of this.connections) {
			conn.close();
		}
		this.connections = [];
		this.available = [];
	}

	getStats() {
		return {
			total: this.connections.length,
			available: this.available.length,
			inUse: this.connections.length - this.available.length,
			maxConnections: this.config.maxConnections,
		};
	}
}

/**
 * Neo4j session pool
 */
export class Neo4jSessionPool {
	private driver: Driver | null = null;
	private sessions: Set<Session> = new Set();
	private readonly config: Required<PoolConfig>;

	constructor(
		private readonly uri: string,
		private readonly auth: { user: string; password: string },
		private readonly database: string = 'neo4j',
		config: PoolConfig = {}
	) {
		this.config = {
			maxConnections: config.maxConnections || 50,
			minConnections: config.minConnections || 5,
			acquireTimeout: config.acquireTimeout || 10000,
			idleTimeout: config.idleTimeout || 60000,
			connectionRetryLimit: config.connectionRetryLimit || 3,
			connectionRetryDelay: config.connectionRetryDelay || 1000,
		};
	}

	async initialize(): Promise<void> {
		await withRetry(
			async () => {
				this.driver = neo4j.driver(
					this.uri,
					neo4j.auth.basic(this.auth.user, this.auth.password),
					{
						maxConnectionPoolSize: this.config.maxConnections,
						connectionAcquisitionTimeout: this.config.acquireTimeout,
						connectionTimeout: 30000,
						maxTransactionRetryTime: 30000,
						logging: {
							level: 'error',
							logger: (level, message) => {
								if (level === 'error') {
									console.error('Neo4j:', message);
								}
							},
						},
					}
				);

				// Verify connectivity
				await this.driver.verifyConnectivity();
			},
			{
				maxAttempts: this.config.connectionRetryLimit,
				initialDelay: this.config.connectionRetryDelay,
			}
		);
	}

	async getSession(): Promise<Session> {
		if (!this.driver) {
			await this.initialize();
		}

		const session = this.driver!.session({
			database: this.database,
			defaultAccessMode: neo4j.session.WRITE,
		});

		this.sessions.add(session);
		return session;
	}

	async releaseSession(session: Session): Promise<void> {
		await session.close();
		this.sessions.delete(session);
	}

	async execute<T>(fn: (session: Session) => Promise<T>): Promise<T> {
		const session = await this.getSession();
		try {
			return await fn(session);
		} finally {
			await this.releaseSession(session);
		}
	}

	async readTransaction<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
		return this.execute((session) => session.executeRead(fn));
	}

	async writeTransaction<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
		return this.execute((session) => session.executeWrite(fn));
	}

	async close(): Promise<void> {
		// Close all sessions
		for (const session of this.sessions) {
			await session.close();
		}
		this.sessions.clear();

		// Close driver
		if (this.driver) {
			await this.driver.close();
			this.driver = null;
		}
	}

	isConnected(): boolean {
		return this.driver !== null;
	}

	getStats() {
		return {
			connected: this.isConnected(),
			activeSessions: this.sessions.size,
			maxConnections: this.config.maxConnections,
		};
	}
}

/**
 * Query optimizer for batch operations
 */
export class QueryOptimizer {
	/**
	 * Batch insert with prepared statements
	 */
	static batchInsert(
		db: Database.Database,
		table: string,
		records: Record<string, unknown>[],
		batchSize: number = 100
	): void {
		if (records.length === 0) return;

		const columns = Object.keys(records[0]);
		const placeholders = columns.map(() => '?').join(', ');
		const stmt = db.prepare(
			`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
		);

		const insertMany = db.transaction((batch: typeof records) => {
			for (const record of batch) {
				stmt.run(...columns.map((col) => record[col]));
			}
		});

		// Process in batches
		for (let i = 0; i < records.length; i += batchSize) {
			const batch = records.slice(i, i + batchSize);
			insertMany(batch);
		}
	}

	/**
	 * Optimized query with indexing hints
	 */
	static optimizedSelect(
		db: Database.Database,
		query: string,
		params: unknown[] = []
	): unknown[] {
		// Analyze query plan
		const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params) as Array<{
			detail?: string;
		}>;

		// Check if indexes are being used
		const usesIndex = plan.some((step) => step.detail?.includes('USING INDEX'));

		if (!usesIndex && process.env.NODE_ENV === 'development') {
			console.warn('Query may benefit from indexing:', query);
		}

		// Execute with prepared statement
		const stmt = db.prepare(query);
		return stmt.all(...params);
	}

	/**
	 * Create missing indexes
	 */
	static createIndexes(
		db: Database.Database,
		indexes: Array<{
			table: string;
			columns: string[];
			unique?: boolean;
		}>
	): void {
		for (const index of indexes) {
			const indexName = `idx_${index.table}_${index.columns.join('_')}`;
			const unique = index.unique ? 'UNIQUE' : '';
			const sql = `CREATE ${unique} INDEX IF NOT EXISTS ${indexName}
						ON ${index.table} (${index.columns.join(', ')})`;

			db.prepare(sql).run();
		}
	}
}
