/**
 * Proves the writing-personalization schema (migration v9) applies to a real
 * SQLite database and that the exact statements used by DatabaseService execute:
 * the single-row preferences upsert (CHECK id = 1, ON CONFLICT) and the feedback
 * insert/select. This is the guard the fake-DB unit tests cannot give -- it
 * catches SQL typos and schema mistakes.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteManager } from '../../src/handlers/database/sqlite-manager.js';
import { MigrationManager } from '../../src/handlers/database/migrations.js';

describe('writing-personalization persistence (real SQLite)', () => {
	let dir: string;
	let sqlite: SQLiteManager;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), 'scriv-personalization-'));
		sqlite = new SQLiteManager(join(dir, 'test.db'));
		await sqlite.initialize();
		const migrations = new MigrationManager(sqlite, null);
		await migrations.initialize();
		await migrations.migrate();
	});

	afterEach(async () => {
		await sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('creates the writing_preferences and writing_feedback tables', () => {
		const tables = sqlite.query(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('writing_preferences', 'writing_feedback')`
		) as Array<{ name: string }>;
		expect(tables.map((t) => t.name).sort()).toEqual([
			'writing_feedback',
			'writing_preferences',
		]);
	});

	it('upserts the single-row preferences profile', () => {
		const upsert = `INSERT INTO writing_preferences (id, enabled, tone, complexity, length, point_of_view, style_guides, custom_instructions, updated_at)
			VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(id) DO UPDATE SET
				enabled = excluded.enabled, tone = excluded.tone, complexity = excluded.complexity,
				length = excluded.length, point_of_view = excluded.point_of_view,
				style_guides = excluded.style_guides, custom_instructions = excluded.custom_instructions,
				updated_at = CURRENT_TIMESTAMP`;

		sqlite.execute(upsert, [1, 'formal', 'advanced', 'concise', null, '["Chicago"]', null]);
		sqlite.execute(upsert, [
			1,
			'casual',
			'balanced',
			'balanced',
			'first person',
			'[]',
			'Be bold',
		]);

		const rows = sqlite.query(
			`SELECT id, tone, point_of_view FROM writing_preferences`
		) as Array<{
			id: number;
			tone: string;
			point_of_view: string | null;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: 1, tone: 'casual', point_of_view: 'first person' });
	});

	it('rejects a second preferences row via the CHECK constraint', () => {
		sqlite.execute(
			`INSERT INTO writing_preferences (id, enabled, tone, complexity, length, style_guides) VALUES (1, 1, 'neutral', 'balanced', 'balanced', '[]')`
		);
		expect(() =>
			sqlite.execute(
				`INSERT INTO writing_preferences (id, enabled, tone, complexity, length, style_guides) VALUES (2, 1, 'neutral', 'balanced', 'balanced', '[]')`
			)
		).toThrow();
	});

	it('inserts and reads back feedback rows', () => {
		sqlite.execute(
			`INSERT INTO writing_feedback (id, operation, rating, accepted, comment) VALUES (?, ?, ?, ?, ?)`,
			['fb1', 'enhance_content', 4, 1, 'good']
		);
		sqlite.execute(
			`INSERT INTO writing_feedback (id, operation, rating, accepted, comment) VALUES (?, ?, ?, ?, ?)`,
			['fb2', 'generate_content', null, 0, null]
		);
		const rows = sqlite.query(
			`SELECT id, operation, rating, accepted FROM writing_feedback ORDER BY operation`
		) as Array<{
			id: string;
			operation: string;
			rating: number | null;
			accepted: number | null;
		}>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ operation: 'enhance_content', rating: 4, accepted: 1 });
		expect(rows[1]).toMatchObject({ operation: 'generate_content', rating: null, accepted: 0 });
	});
});
