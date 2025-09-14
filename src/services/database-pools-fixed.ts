/**
 * Fixed Database Connection Pools with Proper Concurrency Control
 * Addresses race conditions, connection leaks, and resource management
 */

import Database from 'better-sqlite3';
import type { Driver, Session } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getLogger } from '../core/logger.js';
import { AppError, ErrorCode } from '../utils/common.js';

const logger = getLogger('database-pools');

// Mutex implementation for critical sections
class Mutex {
	private queue: Array<() => void> = [];
	private locked = false;

	async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
		const release = await this.acquire();
		try {
			return await Promise.resolve(fn());
		} finally {
			release();
		}
	}

	private acquire(): Promise<() => void> {
		return new Promise<() => void>((resolve) => {
			const tryAcquire = () => {
				if (!this.locked) {
					this.locked = true;
					resolve(() => {
						this.locked = false;
						const next = this.queue.shift();
						if (next) next();
					});
				} else {
					this.queue.push(tryAcquire);
				}
			};
			tryAcquire();
		});
	}
}

interface SQLitePoolConfig {
	dbPath: string;
	minConnections: number;
	maxConnections: number;
	idleTimeout: number;
	acquireTimeout: number;
	healthCheckInterval: number;
}

interface ConnectionInfo {
	connection: Database.Database;
	createdAt: number;
	lastUsed: number;
	inUse: boolean;
	healthy: boolean;
}

export class SQLiteConnectionPool {
	private readonly config: SQLitePoolConfig;
	private readonly connections = new Map<Database.Database, ConnectionInfo>();
	private readonly waitQueue: Array<(conn: Database.Database) => void> = [];
	private readonly acquireMutex = new Mutex();
	private healthCheckTimer?: NodeJS.Timeout;
	private shuttingDown = false;

	constructor(config: Partial<SQLitePoolConfig> & { dbPath: string }) {
		this.config = {
			dbPath: config.dbPath,
			minConnections: config.minConnections ?? 2,
			maxConnections: config.maxConnections ?? 10,
			idleTimeout: config.idleTimeout ?? 30000,
			acquireTimeout: config.acquireTimeout ?? 5000,
			healthCheckInterval: config.healthCheckInterval ?? 60000,
		};

		this.initialize();
	}

	private initialize(): void {
		// Create minimum connections
		for (let i = 0; i < this.config.minConnections; i++) {
			try {
				const conn = this.createConnection();
				const info: ConnectionInfo = {
					connection: conn,
					createdAt: Date.now(),
					lastUsed: Date.now(),
					inUse: false,
					healthy: true,
				};
				this.connections.set(conn, info);
			} catch (error) {
				logger.error('Failed to create initial connection', { error });
			}
		}

		// Start health check timer
		this.startHealthChecks();
	}

	private createConnection(): Database.Database {
		const conn = new Database(this.config.dbPath);

		// Validate connection works
		try {
			conn.prepare('SELECT 1').get();
		} catch (error) {
			conn.close();
			throw new AppError(
				`Failed to create valid SQLite connection: ${error}`,
				ErrorCode.CONNECTION_ERROR
			);
		}

		// Set pragmas for performance and safety
		conn.pragma('journal_mode = WAL');
		conn.pragma('synchronous = NORMAL');
		conn.pragma('cache_size = -64000'); // 64MB
		conn.pragma('foreign_keys = ON');
		conn.pragma('busy_timeout = 5000');

		return conn;
	}

	private isConnectionHealthy(conn: Database.Database): boolean {
		try {
			const info = this.connections.get(conn);
			if (!info) return false;

			// Check if connection is too old (1 hour)
			const age = Date.now() - info.createdAt;
			if (age > 3600000) return false;

			// Test connection
			conn.prepare('SELECT 1').get();
			return true;
		} catch {
			return false;
		}
	}

	private startHealthChecks(): void {
		this.healthCheckTimer = setInterval(() => {
			this.performHealthCheck().catch((err) =>
				logger.error('Health check failed', { error: err })
			);
		}, this.config.healthCheckInterval);

		// Don't block shutdown
		this.healthCheckTimer.unref();
	}

	private async performHealthCheck(): Promise<void> {
		if (this.shuttingDown) return;

		const unhealthy: Database.Database[] = [];

		for (const [conn, info] of this.connections) {
			if (info.inUse) continue;

			if (!this.isConnectionHealthy(conn)) {
				unhealthy.push(conn);
				info.healthy = false;
			} else {
				info.healthy = true;

				// Check for idle timeout
				const idleTime = Date.now() - info.lastUsed;
				if (
					idleTime > this.config.idleTimeout &&
					this.connections.size > this.config.minConnections
				) {
					unhealthy.push(conn);
				}
			}
		}

		// Remove unhealthy connections
		for (const conn of unhealthy) {
			this.connections.delete(conn);
			try {
				conn.close();
			} catch {
				// Ignore close errors
			}
		}

		// Ensure minimum connections
		while (this.connections.size < this.config.minConnections && !this.shuttingDown) {
			try {
				const conn = this.createConnection();
				const info: ConnectionInfo = {
					connection: conn,
					createdAt: Date.now(),
					lastUsed: Date.now(),
					inUse: false,
					healthy: true,
				};
				this.connections.set(conn, info);
			} catch (error) {
				logger.error('Failed to create replacement connection', { error });
				break;
			}
		}
	}

	async acquire(): Promise<Database.Database> {
		if (this.shuttingDown) {
			throw new AppError('Pool is shutting down', ErrorCode.INVALID_STATE);
		}

		return this.acquireMutex.runExclusive(async () => {
			const deadline = Date.now() + this.config.acquireTimeout;

			while (Date.now() < deadline) {
				// Find available healthy connection
				for (const [conn, info] of this.connections) {
					if (!info.inUse && info.healthy) {
						info.inUse = true;
						info.lastUsed = Date.now();
						return conn;
					}
				}

				// Create new connection if under limit
				if (this.connections.size < this.config.maxConnections) {
					try {
						const conn = this.createConnection();
						const info: ConnectionInfo = {
							connection: conn,
							createdAt: Date.now(),
							lastUsed: Date.now(),
							inUse: true,
							healthy: true,
						};
						this.connections.set(conn, info);
						return conn;
					} catch (error) {
						logger.error('Failed to create connection', { error });
					}
				}

				// Wait for a connection to be released
				await new Promise<void>((resolve) => {
					const timer = setTimeout(
						() => {
							const index = this.waitQueue.indexOf(resolver);
							if (index >= 0) {
								this.waitQueue.splice(index, 1);
							}
							resolve();
						},
						Math.min(1000, deadline - Date.now())
					);

					const resolver = (conn: Database.Database) => {
						clearTimeout(timer);
						const info = this.connections.get(conn);
						if (info) {
							info.inUse = true;
							info.lastUsed = Date.now();
						}
						resolve();
					};

					this.waitQueue.push(resolver);
				});
			}

			throw new AppError(
				'Failed to acquire connection within timeout',
				ErrorCode.TIMEOUT_ERROR
			);
		});
	}

	release(conn: Database.Database): void {
		const info = this.connections.get(conn);
		if (!info) return;

		info.inUse = false;
		info.lastUsed = Date.now();

		// Notify waiting requests
		const waiter = this.waitQueue.shift();
		if (waiter) {
			waiter(conn);
		}
	}

	async execute<T>(fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
		const conn = await this.acquire();
		let completed = false;

		try {
			const result = await Promise.resolve(fn(conn));
			completed = true;
			return result;
		} catch (error) {
			// Log the error for debugging
			logger.error('Execute failed', { error });
			throw error;
		} finally {
			if (!completed) {
				// Connection might be corrupted, remove it
				const info = this.connections.get(conn);
				if (info) {
					info.healthy = false;
				}
				this.connections.delete(conn);

				try {
					conn.close();
				} catch {
					// Ignore close errors
				}

				// Create replacement if needed
				if (this.connections.size < this.config.minConnections && !this.shuttingDown) {
					try {
						const newConn = this.createConnection();
						const newInfo: ConnectionInfo = {
							connection: newConn,
							createdAt: Date.now(),
							lastUsed: Date.now(),
							inUse: false,
							healthy: true,
						};
						this.connections.set(newConn, newInfo);
					} catch (error) {
						logger.error('Failed to create replacement connection', { error });
					}
				}
			} else {
				this.release(conn);
			}
		}
	}

	async transaction<T>(fn: (db: Database.Database) => T): Promise<T> {
		// Ensure fn is synchronous for better-sqlite3
		if (fn.constructor.name === 'AsyncFunction') {
			throw new AppError('SQLite transactions must be synchronous', ErrorCode.INVALID_INPUT);
		}

		return this.execute((db) => {
			// Use IMMEDIATE to acquire write lock immediately
			db.exec('BEGIN IMMEDIATE');
			try {
				const result = fn(db);
				db.exec('COMMIT');
				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;

		// Clear health check timer
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = undefined;
		}

		// Reject all waiting requests
		while (this.waitQueue.length > 0) {
			this.waitQueue.shift();
		}

		// Close all connections
		for (const [conn] of this.connections) {
			try {
				conn.close();
			} catch {
				// Ignore close errors
			}
		}

		this.connections.clear();
		logger.info('SQLite pool shutdown complete');
	}
}

interface Neo4jPoolConfig {
	uri: string;
	user: string;
	password: string;
	maxSessions: number;
	idleTimeout: number;
	acquireTimeout: number;
}

interface SessionInfo {
	session: Session;
	createdAt: number;
	lastUsed: number;
	inUse: boolean;
}

export class Neo4jConnectionPool {
	private driver: Driver;
	private readonly config: Neo4jPoolConfig;
	private readonly sessions = new Map<Session, SessionInfo>();
	private readonly waitQueue: Array<(session: Session) => void> = [];
	private readonly acquireMutex = new Mutex();
	private cleanupTimer?: NodeJS.Timeout;
	private shuttingDown = false;

	constructor(config: Neo4jPoolConfig) {
		this.config = config;
		this.driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), {
			maxConnectionPoolSize: config.maxSessions,
			connectionAcquisitionTimeout: config.acquireTimeout,
		});

		this.startCleanup();
	}

	private startCleanup(): void {
		this.cleanupTimer = setInterval(() => {
			this.cleanupIdleSessions().catch((err) =>
				logger.error('Session cleanup failed', { error: err })
			);
		}, 30000); // Every 30 seconds

		this.cleanupTimer.unref();
	}

	private async cleanupIdleSessions(): Promise<void> {
		if (this.shuttingDown) return;

		const now = Date.now();
		const toClose: Session[] = [];

		for (const [session, info] of this.sessions) {
			if (!info.inUse) {
				const idleTime = now - info.lastUsed;
				if (idleTime > this.config.idleTimeout) {
					toClose.push(session);
				}
			}
		}

		for (const session of toClose) {
			this.sessions.delete(session);
			try {
				await session.close();
			} catch {
				// Ignore close errors
			}
		}
	}

	async getSession(): Promise<Session> {
		if (this.shuttingDown) {
			throw new AppError('Pool is shutting down', ErrorCode.INVALID_STATE);
		}

		return this.acquireMutex.runExclusive(async () => {
			// Find available session
			for (const [session, info] of this.sessions) {
				if (!info.inUse) {
					info.inUse = true;
					info.lastUsed = Date.now();
					return session;
				}
			}

			// Create new session if under limit
			if (this.sessions.size < this.config.maxSessions) {
				const session = this.driver.session();
				const info: SessionInfo = {
					session,
					createdAt: Date.now(),
					lastUsed: Date.now(),
					inUse: true,
				};
				this.sessions.set(session, info);
				return session;
			}

			// Wait for a session to be released
			return new Promise<Session>((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = this.waitQueue.indexOf(resolver);
					if (index >= 0) {
						this.waitQueue.splice(index, 1);
					}
					reject(
						new AppError(
							'Failed to acquire session within timeout',
							ErrorCode.TIMEOUT_ERROR
						)
					);
				}, this.config.acquireTimeout);

				const resolver = (session: Session) => {
					clearTimeout(timer);
					const info = this.sessions.get(session);
					if (info) {
						info.inUse = true;
						info.lastUsed = Date.now();
					}
					resolve(session);
				};

				this.waitQueue.push(resolver);
			});
		});
	}

	async releaseSession(session: Session): Promise<void> {
		const info = this.sessions.get(session);
		if (!info) return;

		info.inUse = false;
		info.lastUsed = Date.now();

		// Notify waiting requests
		const waiter = this.waitQueue.shift();
		if (waiter) {
			waiter(session);
		}
	}

	async execute<T>(fn: (session: Session) => Promise<T>): Promise<T> {
		const session = await this.getSession();

		// Set timeout for force cleanup
		const timeout = setTimeout(() => {
			// Force close after timeout
			session.close().catch(() => {});
			this.sessions.delete(session);
			logger.error('Session forcefully closed due to timeout');
		}, this.config.idleTimeout);

		try {
			const result = await fn(session);
			return result;
		} catch (error) {
			// Remove potentially corrupted session
			this.sessions.delete(session);
			try {
				await session.close();
			} catch {
				// Ignore close errors
			}
			throw error;
		} finally {
			clearTimeout(timeout);

			// Try to release normally
			try {
				await this.releaseSession(session);
			} catch (error) {
				// Force cleanup on release error
				this.sessions.delete(session);
				logger.error('Failed to release session:', error as Record<string, unknown>);
			}
		}
	}

	async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
		return this.execute(async (session) => {
			return session.executeWrite(fn);
		});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;

		// Clear cleanup timer
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}

		// Reject all waiting requests
		while (this.waitQueue.length > 0) {
			this.waitQueue.shift();
		}

		// Close all sessions
		const closePromises: Promise<void>[] = [];
		for (const [session] of this.sessions) {
			closePromises.push(session.close().catch(() => {}));
		}

		await Promise.all(closePromises);
		this.sessions.clear();

		// Close driver
		await this.driver.close();

		logger.info('Neo4j pool shutdown complete');
	}
}

/**
 * Query optimizer with SQL injection prevention
 */
export class QueryOptimizer {
	private static readonly IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

	/**
	 * Validate SQL identifier (table/column name)
	 */
	private static validateIdentifier(name: string): string {
		if (!this.IDENTIFIER_PATTERN.test(name)) {
			throw new AppError(`Invalid SQL identifier: ${name}`, ErrorCode.INVALID_INPUT);
		}
		return name;
	}

	/**
	 * Batch insert with validation
	 */
	static batchInsert(
		db: Database.Database,
		table: string,
		records: Record<string, unknown>[]
	): void {
		if (records.length === 0) return;

		// Validate table name
		const safeTable = this.validateIdentifier(table);

		// Get and validate column names
		const columns = Object.keys(records[0]);
		const safeColumns = columns.map((c) => this.validateIdentifier(c));

		// Prepare statement with parameterized values
		const placeholders = safeColumns.map(() => '?').join(', ');
		const columnList = safeColumns.join(', ');

		const stmt = db.prepare(
			`INSERT OR REPLACE INTO ${safeTable} (${columnList}) VALUES (${placeholders})`
		);

		// Use transaction for batch insert
		const insertMany = db.transaction((items: Record<string, unknown>[]) => {
			for (const item of items) {
				const values = safeColumns.map((col) => item[col]);
				stmt.run(...values);
			}
		});

		insertMany(records);
	}

	/**
	 * Create index with validation
	 */
	static createIndex(
		db: Database.Database,
		table: string,
		columns: string[],
		unique = false
	): void {
		const safeTable = this.validateIdentifier(table);
		const safeColumns = columns.map((c) => this.validateIdentifier(c));

		const indexName = `idx_${safeTable}_${safeColumns.join('_')}`;
		const uniqueClause = unique ? 'UNIQUE' : '';

		db.exec(
			`CREATE ${uniqueClause} INDEX IF NOT EXISTS ${indexName} 
			ON ${safeTable} (${safeColumns.join(', ')})`
		);
	}

	/**
	 * Analyze query performance
	 */
	static analyzeQuery(db: Database.Database, sql: string): Record<string, unknown> {
		const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
		const result = stmt.all();
		// Convert array result to a record format
		return { queryPlan: result } as Record<string, unknown>;
	}
}
