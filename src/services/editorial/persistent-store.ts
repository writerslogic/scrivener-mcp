import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class PersistentStore {
	private readonly db: Database.Database;

	constructor(filePath: string) {
		const file = resolve(filePath);
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.db = new Database(file);
		chmodSync(file, 0o600);
		this.db.pragma('busy_timeout = 5000');
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('synchronous = FULL');
		const version = this.db.pragma('user_version', { simple: true }) as number;
		if (version > 1) {
			this.db.close();
			throw new Error('Editorial database schema is newer than this server supports');
		}
		this.db.transaction(() => {
			this.db.exec('CREATE TABLE IF NOT EXISTS editorial_state (namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, id))');
			this.db.pragma('user_version = 1');
		})();
	}

	get<T>(namespace: string, id: string): T | undefined {
		const row = this.db.prepare('SELECT value FROM editorial_state WHERE namespace = ? AND id = ?').get(namespace, id) as { value: string } | undefined;
		return row ? JSON.parse(row.value) as T : undefined;
	}

	list<T>(namespace: string): T[] {
		const rows = this.db.prepare('SELECT value FROM editorial_state WHERE namespace = ? ORDER BY id').all(namespace) as Array<{ value: string }>;
		return rows.map((row) => JSON.parse(row.value) as T);
	}

	put<T>(namespace: string, id: string, value: T): void {
		const json = JSON.stringify(value);
		if (json === undefined || Buffer.byteLength(json) > 64 * 1024 * 1024) throw new Error('Editorial state exceeds the storage limit');
		this.db.prepare('INSERT INTO editorial_state(namespace, id, value) VALUES (?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET value = excluded.value').run(namespace, id, json);
	}

	delete(namespace: string, id: string): void {
		this.db.prepare('DELETE FROM editorial_state WHERE namespace = ? AND id = ?').run(namespace, id);
	}

	transaction<T>(operation: () => T): T {
		return this.db.transaction(() => {
			const result = operation();
			if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Persistent transactions must be synchronous');
			return result;
		}).immediate();
	}

	close(): void {
		this.db.close();
	}
}
