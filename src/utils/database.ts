/**
 * Database-specific utility functions
 * Helpers for SQLite, Neo4j, and general database operations
 */

import { ApplicationError as AppError, ErrorCode } from '../core/errors.js';
import { ERROR_MESSAGES } from '../core/constants.js';
import type { QueryResult, Record as Neo4jRecord } from 'neo4j-driver';
import type Database from 'better-sqlite3';

// ============================================================================
// Database Error Handling
// ============================================================================

/**
 * Database error types
 */
export enum DatabaseErrorType {
	CONNECTION = 'CONNECTION',
	TRANSACTION = 'TRANSACTION',
	CONSTRAINT = 'CONSTRAINT',
	TIMEOUT = 'TIMEOUT',
	LOCK = 'LOCK',
	SYNTAX = 'SYNTAX',
	UNKNOWN = 'UNKNOWN',
}

/**
 * Classify database error
 */
export function classifyDatabaseError(error: unknown): DatabaseErrorType {
	if (!error || typeof error !== 'object') return DatabaseErrorType.UNKNOWN;

	const err = error as Error & { code?: string };
	const message = err.message?.toLowerCase() || '';
	const code = err.code?.toLowerCase() || '';

	// Connection errors
	if (code.includes('econnrefused') || message.includes('connection refused')) {
		return DatabaseErrorType.CONNECTION;
	}
	if (code.includes('serviceunavailable') || message.includes('service unavailable')) {
		return DatabaseErrorType.CONNECTION;
	}

	// Transaction errors
	if (code.includes('deadlock') || message.includes('deadlock')) {
		return DatabaseErrorType.TRANSACTION;
	}
	if (message.includes('transaction') && message.includes('aborted')) {
		return DatabaseErrorType.TRANSACTION;
	}

	// Constraint errors
	if (code.includes('constraint') || message.includes('constraint')) {
		return DatabaseErrorType.CONSTRAINT;
	}
	if (code.includes('unique') || message.includes('unique')) {
		return DatabaseErrorType.CONSTRAINT;
	}

	// Timeout errors
	if (code.includes('timeout') || message.includes('timeout')) {
		return DatabaseErrorType.TIMEOUT;
	}

	// Lock errors
	if (code.includes('lock') || message.includes('locked')) {
		return DatabaseErrorType.LOCK;
	}

	// Syntax errors
	if (code.includes('syntax') || message.includes('syntax error')) {
		return DatabaseErrorType.SYNTAX;
	}

	return DatabaseErrorType.UNKNOWN;
}

/**
 * Check if error is transient and should be retried
 */
export function isTransientDatabaseError(error: unknown): boolean {
	const type = classifyDatabaseError(error);
	return [
		DatabaseErrorType.LOCK,
		DatabaseErrorType.TIMEOUT,
		DatabaseErrorType.TRANSACTION,
	].includes(type);
}

/**
 * Convert database error to AppError
 */
export function toDatabaseError(error: unknown, context?: string): AppError {
	const type = classifyDatabaseError(error);
	const err = error as Error & { code?: string };

	const errorMessages: Record<DatabaseErrorType, string> = {
		[DatabaseErrorType.CONNECTION]: 'Database connection failed',
		[DatabaseErrorType.TRANSACTION]: 'Transaction failed',
		[DatabaseErrorType.CONSTRAINT]: 'Database constraint violation',
		[DatabaseErrorType.TIMEOUT]: 'Database operation timed out',
		[DatabaseErrorType.LOCK]: 'Database is locked',
		[DatabaseErrorType.SYNTAX]: 'Invalid database query syntax',
		[DatabaseErrorType.UNKNOWN]: ERROR_MESSAGES.DATABASE_ERROR,
	};

	const errorCodes: Record<DatabaseErrorType, ErrorCode> = {
		[DatabaseErrorType.CONNECTION]: ErrorCode.CONNECTION_ERROR,
		[DatabaseErrorType.TRANSACTION]: ErrorCode.TRANSACTION_ERROR,
		[DatabaseErrorType.CONSTRAINT]: ErrorCode.VALIDATION_ERROR,
		[DatabaseErrorType.TIMEOUT]: ErrorCode.TIMEOUT_ERROR,
		[DatabaseErrorType.LOCK]: ErrorCode.DATABASE_ERROR,
		[DatabaseErrorType.SYNTAX]: ErrorCode.INVALID_INPUT,
		[DatabaseErrorType.UNKNOWN]: ErrorCode.DATABASE_ERROR,
	};

	return new AppError(
		`${errorMessages[type]}${context ? ` in ${context}` : ''}`,
		errorCodes[type],
		{ originalError: err.message, type }
	);
}

// ============================================================================
// Neo4j Utilities
// ============================================================================

/**
 * Extract single value from Neo4j result
 */
export function extractSingleValue<T = unknown>(result: QueryResult, key: string): T | null {
	if (!result.records.length) return null;
	return result.records[0].get(key) as T;
}

/**
 * Extract values from Neo4j result
 */
export function extractValues<T = unknown>(result: QueryResult, key: string): T[] {
	return result.records.map((record) => record.get(key) as T);
}

/**
 * Map Neo4j records to objects
 */
export function mapNeo4jRecords<T>(result: QueryResult, mapper: (record: Neo4jRecord) => T): T[] {
	return result.records.map(mapper);
}

/**
 * Convert Neo4j node to plain object
 */
export function nodeToObject(node: unknown): Record<string, unknown> {
	if (!node) return {};

	// Neo4j nodes have properties object
	const nodeWithProps = node as
		| { properties?: Record<string, unknown> }
		| Record<string, unknown>;
	const props =
		nodeWithProps && typeof nodeWithProps === 'object' && 'properties' in nodeWithProps
			? nodeWithProps.properties
			: (nodeWithProps as Record<string, unknown>);

	// Convert Neo4j integers to JavaScript numbers
	const converted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
		if (value && typeof value === 'object' && 'toNumber' in value) {
			converted[key] = (value as { toNumber(): number }).toNumber();
		} else {
			converted[key] = value;
		}
	}

	return converted;
}

/**
 * Build Cypher parameter object with null handling
 */
export function buildCypherParams(params: Record<string, unknown>): Record<string, unknown> {
	const cleaned: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(params)) {
		// Skip undefined values
		if (value === undefined) continue;

		// Convert dates to ISO strings
		if (value instanceof Date) {
			cleaned[key] = value.toISOString();
		} else if (Array.isArray(value)) {
			// Filter undefined from arrays
			cleaned[key] = value.filter((v) => v !== undefined);
		} else {
			cleaned[key] = value;
		}
	}

	return cleaned;
}

// ============================================================================
// SQLite Utilities
// ============================================================================

/**
 * Build parameterized SQL query
 */
export interface SqlQuery {
	sql: string;
	params: unknown[];
}

/**
 * Build INSERT query
 */
export function buildInsertQuery(
	table: string,
	data: Record<string, unknown>,
	onConflict?: 'REPLACE' | 'IGNORE' | 'UPDATE'
): SqlQuery {
	const keys = Object.keys(data).filter((k) => data[k] !== undefined);
	const values = keys.map((k) => data[k]);
	const placeholders = keys.map(() => '?').join(', ');

	let sql = `INSERT`;
	if (onConflict === 'REPLACE') {
		sql = `INSERT OR REPLACE`;
	} else if (onConflict === 'IGNORE') {
		sql = `INSERT OR IGNORE`;
	}

	sql += ` INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;

	if (onConflict === 'UPDATE') {
		const updates = keys.map((k) => `${k} = excluded.${k}`).join(', ');
		sql += ` ON CONFLICT DO UPDATE SET ${updates}`;
	}

	return { sql, params: values };
}

/**
 * Build UPDATE query
 */
export function buildUpdateQuery(
	table: string,
	data: Record<string, unknown>,
	where: Record<string, unknown>
): SqlQuery {
	const dataKeys = Object.keys(data).filter((k) => data[k] !== undefined);
	const whereKeys = Object.keys(where);

	if (!dataKeys.length || !whereKeys.length) {
		throw new AppError('Invalid UPDATE query parameters', ErrorCode.INVALID_INPUT);
	}

	const setSql = dataKeys.map((k) => `${k} = ?`).join(', ');
	const whereSql = whereKeys.map((k) => `${k} = ?`).join(' AND ');

	const sql = `UPDATE ${table} SET ${setSql} WHERE ${whereSql}`;
	const params = [...dataKeys.map((k) => data[k]), ...whereKeys.map((k) => where[k])];

	return { sql, params };
}

/**
 * Build SELECT query with filters
 */
export function buildSelectQuery(
	table: string,
	filters?: Record<string, unknown>,
	options?: {
		columns?: string[];
		orderBy?: string;
		limit?: number;
		offset?: number;
	}
): SqlQuery {
	const columns = options?.columns?.join(', ') || '*';
	let sql = `SELECT ${columns} FROM ${table}`;
	const params: unknown[] = [];

	if (filters && Object.keys(filters).length > 0) {
		const whereConditions: string[] = [];
		for (const [key, value] of Object.entries(filters)) {
			if (value === null) {
				whereConditions.push(`${key} IS NULL`);
			} else if (value === undefined) {
				// Skip undefined values
				continue;
			} else if (Array.isArray(value)) {
				const placeholders = value.map(() => '?').join(', ');
				whereConditions.push(`${key} IN (${placeholders})`);
				params.push(...value);
			} else {
				whereConditions.push(`${key} = ?`);
				params.push(value);
			}
		}

		if (whereConditions.length > 0) {
			sql += ` WHERE ${whereConditions.join(' AND ')}`;
		}
	}

	if (options?.orderBy) {
		sql += ` ORDER BY ${options.orderBy}`;
	}

	if (options?.limit) {
		sql += ` LIMIT ${options.limit}`;
		if (options.offset) {
			sql += ` OFFSET ${options.offset}`;
		}
	}

	return { sql, params };
}

/**
 * Escape SQL identifier (table/column name)
 */
export function escapeIdentifier(identifier: string): string {
	// SQLite uses double quotes for identifiers
	return `"${identifier.replace(/"/g, '""')}"`;
}

// ============================================================================
// Transaction Utilities
// ============================================================================

/**
 * Transaction wrapper for SQLite
 */
export async function withSqliteTransaction<T>(
	db: Database.Database,
	fn: () => Promise<T>
): Promise<T> {
	const _transaction = db.prepare('BEGIN').run();
	try {
		const result = await fn();
		db.prepare('COMMIT').run();
		return result;
	} catch (error) {
		db.prepare('ROLLBACK').run();
		throw error;
	}
}

/**
 * Batch insert for SQLite
 */
export function batchInsert(
	db: Database.Database,
	table: string,
	items: Record<string, unknown>[],
	batchSize = 100
): void {
	if (!items.length) return;

	// Get columns from first item
	const columns = Object.keys(items[0]);
	const placeholders = columns.map(() => '?').join(', ');
	const stmt = db.prepare(
		`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
	);

	const insertMany = db.transaction((batch: Record<string, unknown>[]) => {
		for (const item of batch) {
			stmt.run(...columns.map((col) => item[col]));
		}
	});

	// Process in batches
	for (let i = 0; i < items.length; i += batchSize) {
		const batch = items.slice(i, i + batchSize);
		insertMany(batch);
	}
}

// ============================================================================
// Connection Utilities
// ============================================================================

/**
 * Parse database connection string
 */
export function parseConnectionString(connectionString: string): {
	protocol: string;
	host: string;
	port: number;
	database?: string;
	username?: string;
	password?: string;
} {
	const url = new URL(connectionString);

	return {
		protocol: url.protocol.replace(':', ''),
		host: url.hostname,
		port: parseInt(url.port) || getDefaultPort(url.protocol),
		database: url.pathname.slice(1) || undefined,
		username: url.username || undefined,
		password: url.password || undefined,
	};
}

/**
 * Get default port for database protocol
 */
function getDefaultPort(protocol: string): number {
	const defaults: Record<string, number> = {
		'bolt:': 7687,
		'neo4j:': 7687,
		'neo4j+s:': 7687,
		'postgresql:': 5432,
		'mysql:': 3306,
		'mongodb:': 27017,
	};

	return defaults[protocol] || 0;
}

/**
 * Build connection string from parts
 */
export function buildConnectionString(parts: {
	protocol: string;
	host: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
}): string {
	let url = `${parts.protocol}://`;

	if (parts.username) {
		url += parts.username;
		if (parts.password) {
			url += `:${parts.password}`;
		}
		url += '@';
	}

	url += parts.host;

	if (parts.port) {
		url += `:${parts.port}`;
	}

	if (parts.database) {
		url += `/${parts.database}`;
	}

	return url;
}

// ============================================================================
// Query Result Utilities
// ============================================================================

/**
 * Paginate results
 */
export function paginate<T>(
	items: T[],
	page: number,
	pageSize: number
): {
	items: T[];
	page: number;
	pageSize: number;
	totalItems: number;
	totalPages: number;
	hasNext: boolean;
	hasPrev: boolean;
} {
	const totalItems = items.length;
	const totalPages = Math.ceil(totalItems / pageSize);
	const start = (page - 1) * pageSize;
	const end = start + pageSize;

	return {
		items: items.slice(start, end),
		page,
		pageSize,
		totalItems,
		totalPages,
		hasNext: page < totalPages,
		hasPrev: page > 1,
	};
}

/**
 * Convert database rows to nested structure
 */
export function rowsToNested<T>(
	rows: any[],
	parentKey: string,
	childKey: string,
	childrenProp = 'children'
): T[] {
	const map = new Map<any, any>();
	const roots: T[] = [];

	// First pass: create all objects
	for (const row of rows) {
		if (!map.has(row[parentKey])) {
			map.set(row[parentKey], { ...row, [childrenProp]: [] });
		}
	}

	// Second pass: build hierarchy
	for (const row of rows) {
		const parent = map.get(row[parentKey]);
		const child = map.get(row[childKey]);

		if (child && parent && parent !== child) {
			parent[childrenProp].push(child);
		} else if (!row[childKey]) {
			roots.push(parent);
		}
	}

	return roots;
}

// ============================================================================
// Export
// ============================================================================

export default {
	// Error handling
	DatabaseErrorType,
	classifyDatabaseError,
	isTransientDatabaseError,
	toDatabaseError,

	// Neo4j utilities
	extractSingleValue,
	extractValues,
	mapNeo4jRecords,
	nodeToObject,
	buildCypherParams,

	// SQLite utilities
	buildInsertQuery,
	buildUpdateQuery,
	buildSelectQuery,
	escapeIdentifier,
	withSqliteTransaction,
	batchInsert,

	// Connection utilities
	parseConnectionString,
	buildConnectionString,

	// Query result utilities
	paginate,
	rowsToNested,
};
