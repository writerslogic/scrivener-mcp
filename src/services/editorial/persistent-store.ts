import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface StorePageOptions {
	after?: string;
	limit?: number;
}

export interface StorePage<T> {
	items: T[];
	nextCursor: string | null;
}

export class PersistentStore {
	private readonly db: Database.Database;
	private readonly statements: {
		get: Database.Statement;
		list: Database.Statement;
		put: Database.Statement;
		delete: Database.Statement;
	};

	constructor(filePath: string) {
		const file = resolve(filePath);
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.db = new Database(file);
		try {
			chmodSync(file, 0o600);
			this.db.pragma('busy_timeout = 5000');
			const version = this.db.pragma('user_version', { simple: true }) as number;
			if (version > 1)
				throw new Error('Editorial database schema is newer than this server supports');
			this.db.pragma('journal_mode = WAL');
			this.db.pragma('synchronous = FULL');
			if (version === 0) {
				this.db
					.transaction(() => {
						const current = this.db.pragma('user_version', { simple: true }) as number;
						if (current > 1)
							throw new Error(
								'Editorial database schema is newer than this server supports'
							);
						this.db.exec(
							'CREATE TABLE IF NOT EXISTS editorial_state (namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, id))'
						);
						this.db.pragma('user_version = 1');
					})
					.immediate();
			}
			this.statements = {
				get: this.db.prepare(
					'SELECT value FROM editorial_state WHERE namespace = ? AND id = ?'
				),
				list: this.db.prepare(
					'SELECT value FROM editorial_state WHERE namespace = ? ORDER BY id'
				),
				put: this.db.prepare(
					'INSERT INTO editorial_state(namespace, id, value) VALUES (?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET value = excluded.value'
				),
				delete: this.db.prepare(
					'DELETE FROM editorial_state WHERE namespace = ? AND id = ?'
				),
			};
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	get<T>(namespace: string, id: string): T | undefined {
		const row = this.statements.get.get(namespace, id) as { value: string } | undefined;
		return row ? (JSON.parse(row.value) as T) : undefined;
	}

	list<T>(namespace: string): T[] {
		const rows = this.statements.list.all(namespace) as Array<{ value: string }>;
		return rows.map((row) => JSON.parse(row.value) as T);
	}

	page<T>(
		namespace: string,
		options: StorePageOptions = {},
		fields?: readonly string[],
		filter?: { field: string; values: readonly string[] }
	): StorePage<T> {
		const limit = options.limit ?? 20;
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			(options.after !== undefined &&
				(typeof options.after !== 'string' ||
					!options.after.length ||
					options.after.length > 160))
		)
			throw new Error('History pages require a 1–100 item limit and a valid cursor');
		const validField = (field: string) =>
			typeof field === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field);
		if (
			fields &&
			(!fields.length || fields.length > 32 || fields.some((field) => !validField(field)))
		)
			throw new Error('Invalid history projection');
		if (
			filter &&
			(!validField(filter.field) ||
				!filter.values.length ||
				filter.values.length > 10 ||
				filter.values.some((value) => typeof value !== 'string' || value.length > 256))
		)
			throw new Error('Invalid history filter');
		const projection = fields
			? `json_object(${fields.map((field) => `'${field}', json_extract(value, '$.${field}')`).join(',')})`
			: 'value';
		const predicate = filter
			? ` AND json_extract(value, '$.${filter.field}') IN (${filter.values.map(() => '?').join(',')})`
			: '';
		const rows = this.db
			.prepare(
				`SELECT id, ${projection} AS value FROM editorial_state WHERE namespace = ? AND id > ?${predicate} ORDER BY id LIMIT ?`
			)
			.all(namespace, options.after ?? '', ...(filter?.values ?? []), limit + 1) as Array<{
			id: string;
			value: string;
		}>;
		return {
			items: rows.slice(0, limit).map((row) => JSON.parse(row.value) as T),
			nextCursor: rows.length > limit ? rows[limit - 1].id : null,
		};
	}

	put<T>(namespace: string, id: string, value: T): void {
		const json = JSON.stringify(value);
		if (json === undefined || Buffer.byteLength(json) > 64 * 1024 * 1024)
			throw new Error('Editorial state exceeds the storage limit');
		this.statements.put.run(namespace, id, json);
	}

	delete(namespace: string, id: string): void {
		this.statements.delete.run(namespace, id);
	}

	transaction<T>(operation: () => T): T {
		if (
			['[object AsyncFunction]', '[object AsyncGeneratorFunction]'].includes(
				Object.prototype.toString.call(operation)
			)
		)
			throw new Error('Persistent transactions must be synchronous');
		return this.db
			.transaction(() => {
				const result = operation();
				if (result && typeof (result as { then?: unknown }).then === 'function')
					throw new Error('Persistent transactions must be synchronous');
				return result;
			})
			.immediate();
	}

	close(): void {
		if (this.db.open) this.db.close();
	}
}
