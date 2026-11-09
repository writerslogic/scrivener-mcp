/**
 * SQLite connections backed by @photostructure/sqlite, which bundles a current SQLite.
 *
 * Connections keep the strict binding the server relied on under better-sqlite3: only numbers,
 * strings, bigints, byte arrays, null and undefined bind. The underlying driver otherwise stores
 * a Date or other object as NULL and coerces booleans, which would silently lose data.
 */

import { DatabaseSync, enhance } from '@photostructure/sqlite';
import type { DatabaseSyncOptions, StatementSyncInstance } from '@photostructure/sqlite';

const SQLITE_BUSY = 5;
const BOUND_METHODS = ['run', 'get', 'all', 'iterate'] as const;

function assertBindable(value: unknown): void {
	if (
		value === null ||
		value === undefined ||
		typeof value === 'number' ||
		typeof value === 'string' ||
		typeof value === 'bigint' ||
		ArrayBuffer.isView(value)
	)
		return;
	throw new TypeError('SQLite can only bind numbers, strings, bigints, byte arrays and null');
}

function assertBindableArguments(args: readonly unknown[]): void {
	args.forEach((arg, index) => {
		const prototype =
			arg !== null && typeof arg === 'object' ? Object.getPrototypeOf(arg) : undefined;
		if (index === 0 && (prototype === Object.prototype || prototype === null)) {
			for (const value of Object.values(arg as object)) assertBindable(value);
			return;
		}
		assertBindable(arg);
	});
}

// better-sqlite3 returned BLOB columns as Buffer; the driver returns plain Uint8Array.
function bufferBlobs<R>(row: R): R {
	if (row === null || typeof row !== 'object') return row;
	const record = row as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		const value = record[key];
		if (value instanceof Uint8Array && !Buffer.isBuffer(value))
			record[key] = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	}
	return row;
}

function bufferResult(method: (typeof BOUND_METHODS)[number], result: unknown): unknown {
	if (method === 'get') return bufferBlobs(result);
	if (method === 'all') return Array.isArray(result) ? result.map(bufferBlobs) : result;
	return result;
}

function strictStatement<T extends StatementSyncInstance>(statement: T): T {
	for (const method of BOUND_METHODS) {
		const call = statement[method] as (...args: unknown[]) => unknown;
		Object.defineProperty(statement, method, {
			value: (...args: unknown[]) => {
				assertBindableArguments(args);
				return bufferResult(method, call.apply(statement, args));
			},
		});
	}
	return statement;
}

export function openSqliteDatabase(location: string, options: DatabaseSyncOptions = {}) {
	const db = enhance(new DatabaseSync(location, { timeout: 5000, ...options }));
	const prepare = db.prepare.bind(db);
	const backup = (db as unknown as { backup(destination: string): Promise<number> }).backup.bind(
		db
	);
	// Own writable properties shadow the native read-only methods and stay replaceable in tests.
	Object.defineProperties(db, {
		prepare: {
			value: (...args: Parameters<typeof prepare>) => strictStatement(prepare(...args)),
			writable: true,
			configurable: true,
		},
		backup: {
			value: (destination: string): Promise<number> => backup(destination),
			writable: true,
			configurable: true,
		},
	});
	return db as typeof db & {
		/** Copy the database to `destination` with SQLite's online backup API. */
		backup(destination: string): Promise<number>;
	};
}

export type SqliteDatabase = ReturnType<typeof openSqliteDatabase>;
export type SqliteStatement = StatementSyncInstance;
export type SqliteRunResult = ReturnType<StatementSyncInstance['run']>;

/** True for SQLITE_BUSY and its extended codes. */
export function isSqliteBusy(error: unknown): boolean {
	const code = (error as { errcode?: unknown } | null)?.errcode;
	return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY;
}
