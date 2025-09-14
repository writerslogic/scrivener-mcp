/**
 * Database Migration System
 * Manages schema versions and migrations for SQLite and Neo4j
 */

import { getLogger } from '../../core/logger.js';
import { toDatabaseError } from '../../utils/database.js';
import type { Neo4jManager } from './neo4j-manager.js';
import type { SQLiteManager } from './sqlite-manager.js';

const logger = getLogger('migrations');

export interface Migration {
	version: number;
	name: string;
	sql?: string;
	cypher?: string;
	up: (sqlite?: SQLiteManager, neo4j?: Neo4jManager) => Promise<void>;
	down?: (sqlite?: SQLiteManager, neo4j?: Neo4jManager) => Promise<void>;
}

export class MigrationManager {
	private migrations: Migration[] = [];
	private currentVersion: number = 0;

	constructor(
		private sqliteManager: SQLiteManager | null,
		private neo4jManager: Neo4jManager | null
	) {
		this.initializeMigrations();
	}

	/**
	 * Define all migrations
	 */
	private initializeMigrations(): void {
		this.migrations = [
			{
				version: 1,
				name: 'initial_schema',
				up: async () => {
					// Already handled in SQLiteManager initialization
				},
			},
			{
				version: 2,
				name: 'add_locations_table',
				sql: `
					CREATE TABLE IF NOT EXISTS locations (
						id TEXT PRIMARY KEY,
						name TEXT NOT NULL,
						description TEXT,
						type TEXT DEFAULT 'general',
						significance TEXT DEFAULT 'minor',
						first_appearance TEXT,
						created_at TEXT DEFAULT CURRENT_TIMESTAMP,
						updated_at TEXT DEFAULT CURRENT_TIMESTAMP
					);
					CREATE INDEX IF NOT EXISTS idx_locations_name ON locations (name);
					CREATE INDEX IF NOT EXISTS idx_locations_type ON locations (type);
				`,
				up: async (sqlite) => {
					if (sqlite) {
						sqlite.getDatabase().exec(this.migrations[1].sql!);
					}
				},
			},
			{
				version: 3,
				name: 'add_full_text_search',
				sql: `
					CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
						id UNINDEXED,
						title,
						synopsis,
						notes,
						content='documents',
						content_rowid='rowid'
					);

					-- Triggers to keep FTS index updated
					CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
					BEGIN
						INSERT INTO documents_fts(rowid, id, title, synopsis, notes)
						VALUES (new.rowid, new.id, new.title, new.synopsis, new.notes);
					END;

					CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents
					BEGIN
						DELETE FROM documents_fts WHERE rowid = old.rowid;
					END;

					CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
					BEGIN
						DELETE FROM documents_fts WHERE rowid = old.rowid;
						INSERT INTO documents_fts(rowid, id, title, synopsis, notes)
						VALUES (new.rowid, new.id, new.title, new.synopsis, new.notes);
					END;
				`,
				up: async (sqlite) => {
					if (sqlite) {
						sqlite.getDatabase().exec(this.migrations[2].sql!);
						// Populate FTS table with existing data
						sqlite.execute(`
							INSERT INTO documents_fts(rowid, id, title, synopsis, notes)
							SELECT rowid, id, title, synopsis, notes FROM documents
						`);
					}
				},
			},
			{
				version: 4,
				name: 'add_character_arcs_table',
				sql: `
					CREATE TABLE IF NOT EXISTS character_arcs (
						id TEXT PRIMARY KEY,
						character_id TEXT NOT NULL,
						stage TEXT NOT NULL,
						chapter_id TEXT,
						description TEXT,
						emotional_state TEXT,
						goal TEXT,
						conflict TEXT,
						resolution TEXT,
						order_index INTEGER DEFAULT 0,
						created_at TEXT DEFAULT CURRENT_TIMESTAMP,
						FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
					);
					CREATE INDEX IF NOT EXISTS idx_arcs_character ON character_arcs (character_id);
					CREATE INDEX IF NOT EXISTS idx_arcs_chapter ON character_arcs (chapter_id);
				`,
				up: async (sqlite) => {
					if (sqlite) {
						sqlite.getDatabase().exec(this.migrations[3].sql!);
					}
				},
			},
			{
				version: 5,
				name: 'add_writing_goals_table',
				sql: `
					CREATE TABLE IF NOT EXISTS writing_goals (
						id TEXT PRIMARY KEY,
						type TEXT NOT NULL, -- daily, weekly, project
						target_words INTEGER,
						target_date TEXT,
						actual_words INTEGER DEFAULT 0,
						status TEXT DEFAULT 'active', -- active, completed, missed
						created_at TEXT DEFAULT CURRENT_TIMESTAMP,
						completed_at TEXT
					);
					CREATE INDEX IF NOT EXISTS idx_goals_status ON writing_goals (status);
					CREATE INDEX IF NOT EXISTS idx_goals_date ON writing_goals (target_date);
				`,
				up: async (sqlite) => {
					if (sqlite) {
						sqlite.getDatabase().exec(this.migrations[4].sql!);
					}
				},
			},
			{
				version: 6,
				name: 'add_revision_tracking',
				sql: `
					CREATE TABLE IF NOT EXISTS document_revisions (
						id TEXT PRIMARY KEY,
						document_id TEXT NOT NULL,
						version INTEGER DEFAULT 1,
						content TEXT,
						word_count INTEGER,
						character_count INTEGER,
						change_summary TEXT,
						created_at TEXT DEFAULT CURRENT_TIMESTAMP,
						FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
					);
					CREATE INDEX IF NOT EXISTS idx_revisions_document ON document_revisions (document_id);
					CREATE INDEX IF NOT EXISTS idx_revisions_created ON document_revisions (created_at);
				`,
				up: async (sqlite) => {
					if (sqlite) {
						sqlite.getDatabase().exec(this.migrations[5].sql!);
					}
				},
			},
			{
				version: 7,
				name: 'neo4j_constraints',
				cypher: `
					CREATE CONSTRAINT unique_character_id IF NOT EXISTS
					FOR (c:Character) REQUIRE c.id IS UNIQUE;

					CREATE CONSTRAINT unique_document_id IF NOT EXISTS
					FOR (d:Document) REQUIRE d.id IS UNIQUE;

					CREATE CONSTRAINT unique_plotthread_id IF NOT EXISTS
					FOR (p:PlotThread) REQUIRE p.id IS UNIQUE;
				`,
				up: async (_sqlite, neo4j) => {
					if (neo4j && neo4j.isAvailable()) {
						const constraints = this.migrations[6]
							.cypher!.split(';')
							.filter((c) => c.trim());
						for (const constraint of constraints) {
							await neo4j.query(constraint);
						}
					}
				},
			},
			{
				version: 8,
				name: 'add_scene_beats_table',
				sql: `
					CREATE TABLE IF NOT EXISTS scene_beats (
						id TEXT PRIMARY KEY,
						document_id TEXT NOT NULL,
						beat_type TEXT NOT NULL, -- action, dialogue, description, transition
						content TEXT,
						emotion TEXT,
						tension_level INTEGER DEFAULT 5, -- 1-10
						order_index INTEGER DEFAULT 0,
						created_at TEXT DEFAULT CURRENT_TIMESTAMP,
						FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
					);
					CREATE INDEX IF NOT EXISTS idx_beats_document ON scene_beats (document_id);
					CREATE INDEX IF NOT EXISTS idx_beats_type ON scene_beats (beat_type);
				`,
				up: async (sqlite) => {
					if (sqlite) {
						sqlite.getDatabase().exec(this.migrations[7].sql!);
					}
				},
			},
		];
	}

	/**
	 * Initialize migration tracking
	 */
	async initialize(): Promise<void> {
		if (this.sqliteManager) {
			// Create migrations table
			this.sqliteManager.getDatabase().exec(`
				CREATE TABLE IF NOT EXISTS migrations (
					version INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					applied_at TEXT DEFAULT CURRENT_TIMESTAMP
				)
			`);

			// Get current version
			const result = this.sqliteManager.queryOne(
				'SELECT MAX(version) as version FROM migrations'
			) as { version: number | null };

			this.currentVersion = result?.version || 0;
		}
	}

	/**
	 * Run pending migrations
	 */
	async migrate(): Promise<void> {
		await this.initialize();

		const pending = this.migrations.filter((m) => m.version > this.currentVersion);

		if (pending.length === 0) {
			return;
		}

		logger.info(`Running ${pending.length} migrations`);

		for (const migration of pending) {
			try {
				await this.runMigration(migration);
				logger.info(`Migration ${migration.version} completed: ${migration.name}`);
			} catch (error) {
				logger.error(`Migration ${migration.version} failed`, {
					name: migration.name,
					error: (error as Error).message,
				});
				throw toDatabaseError(error, `migration ${migration.version}`);
			}
		}
	}

	/**
	 * Run a single migration
	 */
	private async runMigration(migration: Migration): Promise<void> {
		// Start transaction
		if (this.sqliteManager) {
			this.sqliteManager.getDatabase().exec('BEGIN TRANSACTION');
		}

		try {
			// Run migration
			await migration.up(this.sqliteManager || undefined, this.neo4jManager || undefined);

			// Record migration
			if (this.sqliteManager) {
				this.sqliteManager.execute('INSERT INTO migrations (version, name) VALUES (?, ?)', [
					migration.version,
					migration.name,
				]);

				this.sqliteManager.getDatabase().exec('COMMIT');
			}

			this.currentVersion = migration.version;
		} catch (error) {
			// Rollback on error
			if (this.sqliteManager) {
				this.sqliteManager.getDatabase().exec('ROLLBACK');
			}
			throw error;
		}
	}

	/**
	 * Rollback to a specific version
	 */
	async rollbackTo(targetVersion: number): Promise<void> {
		const toRollback = this.migrations
			.filter((m) => m.version > targetVersion && m.version <= this.currentVersion)
			.reverse();

		for (const migration of toRollback) {
			if (migration.down) {
				try {
					await migration.down(
						this.sqliteManager || undefined,
						this.neo4jManager || undefined
					);

					if (this.sqliteManager) {
						this.sqliteManager.execute('DELETE FROM migrations WHERE version = ?', [
							migration.version,
						]);
					}

					logger.info(`Rolled back migration ${migration.version}: ${migration.name}`);
				} catch (error) {
					logger.error(`Failed to rollback migration ${migration.version}`, {
						name: migration.name,
						error: (error as Error).message,
					});
					throw error;
				}
			}
		}

		this.currentVersion = targetVersion;
	}

	/**
	 * Get migration status
	 */
	getStatus(): {
		currentVersion: number;
		latestVersion: number;
		pendingMigrations: number;
		appliedMigrations: string[];
	} {
		const applied = this.migrations
			.filter((m) => m.version <= this.currentVersion)
			.map((m) => `${m.version}: ${m.name}`);

		return {
			currentVersion: this.currentVersion,
			latestVersion: Math.max(...this.migrations.map((m) => m.version)),
			pendingMigrations: this.migrations.filter((m) => m.version > this.currentVersion)
				.length,
			appliedMigrations: applied,
		};
	}

	/**
	 * Export schema for backup
	 */
	async exportSchema(): Promise<{ sql: string; cypher: string }> {
		let sqlSchema = '';
		let cypherSchema = '';

		if (this.sqliteManager) {
			const tables = this.sqliteManager.query(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
			) as Array<{ sql: string }>;

			sqlSchema = tables.map((t) => t.sql).join(';\n\n');

			const indexes = this.sqliteManager.query(
				"SELECT sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
			) as Array<{ sql: string }>;

			sqlSchema += `\n\n${indexes
				.map((i) => i.sql)
				.filter(Boolean)
				.join(';\n')}`;
		}

		if (this.neo4jManager && this.neo4jManager.isAvailable()) {
			const constraints = await this.neo4jManager.query(
				'SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties RETURN *'
			);

			cypherSchema = constraints.records
				.map((r) => `Constraint: ${r.get('name')} on ${r.get('labelsOrTypes')}`)
				.join('\n');
		}

		return { sql: sqlSchema, cypher: cypherSchema };
	}
}
