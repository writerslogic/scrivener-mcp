import { AppError, ErrorCode, safeStringify } from '../../utils/common.js';
import { generateScrivenerUUID } from '../../utils/scrivener-utils.js';
import type {
	FeedbackInput,
	FeedbackRecord,
	WritingPreferences,
} from '../../services/personalization/types.js';
import { DEFAULT_PREFERENCES } from '../../services/personalization/types.js';
import type { SQLiteManager } from './sqlite-manager.js';

/** A writing goal row as stored in the `writing_goals` table (camelCase). */
export interface WritingGoalRecord {
	id: string;
	type: string;
	targetWords: number;
	targetDate: string | null;
	actualWords: number;
	status: string;
	createdAt: string;
	completedAt: string | null;
}

export interface RawWritingGoalRow {
	id: string;
	type: string;
	target_words: number | null;
	target_date: string | null;
	actual_words: number | null;
	status: string;
	created_at: string;
	completed_at: string | null;
}

export function mapWritingGoalRow(row: RawWritingGoalRow): WritingGoalRecord {
	return {
		id: row.id,
		type: row.type,
		targetWords: row.target_words ?? 0,
		targetDate: row.target_date,
		actualWords: row.actual_words ?? 0,
		status: row.status,
		createdAt: row.created_at,
		completedAt: row.completed_at,
	};
}

/** A writing-preferences row as stored in the `writing_preferences` table. */
export interface RawPreferencesRow {
	enabled: number;
	tone: string;
	complexity: string;
	length: string;
	point_of_view: string | null;
	style_guides: string | null;
	custom_instructions: string | null;
	updated_at: string | null;
}

export function mapPreferencesRow(row: RawPreferencesRow): WritingPreferences {
	let styleGuides: string[] = [];
	if (row.style_guides) {
		try {
			const parsed: unknown = JSON.parse(row.style_guides);
			if (Array.isArray(parsed))
				styleGuides = parsed.filter((g): g is string => typeof g === 'string');
		} catch {
			styleGuides = [];
		}
	}
	return {
		enabled: row.enabled !== 0,
		tone: row.tone as WritingPreferences['tone'],
		complexity: row.complexity as WritingPreferences['complexity'],
		length: row.length as WritingPreferences['length'],
		pointOfView: row.point_of_view ?? undefined,
		styleGuides,
		customInstructions: row.custom_instructions ?? undefined,
		updatedAt: row.updated_at ?? undefined,
	};
}

/** A feedback row as stored in the `writing_feedback` table. */
export interface RawFeedbackRow {
	id: string;
	operation: string;
	rating: number | null;
	accepted: number | null;
	comment: string | null;
	created_at: string;
}

export function mapFeedbackRow(row: RawFeedbackRow): FeedbackRecord {
	return {
		id: row.id,
		operation: row.operation,
		rating: row.rating ?? undefined,
		accepted: row.accepted === null ? undefined : row.accepted !== 0,
		comment: row.comment ?? undefined,
		createdAt: row.created_at,
	};
}

export interface WritingGoalInput {
	type: string;
	targetWords: number;
	targetDate?: string | null;
}

/**
 * Create or update the active writing goal of the given type.
 *
 * At most one goal per type is kept active: if an active goal of `input.type`
 * already exists it is updated in place, otherwise a new goal is inserted.
 * The returned record reflects the stored row (camelCase fields).
 */
export function setWritingGoal(
	sqlite: SQLiteManager | null,
	input: WritingGoalInput
): WritingGoalRecord {
	if (!sqlite) {
		throw new AppError(
			'SQLite not initialized. Call initialize() first.',
			ErrorCode.DATABASE_ERROR
		);
	}

	const targetDate = input.targetDate ?? null;
	const existing = sqlite.queryOne(
		`SELECT id FROM writing_goals WHERE type = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
		[input.type]
	) as { id: string } | undefined;

	let id: string;
	if (existing) {
		id = existing.id;
		sqlite.execute(
			`UPDATE writing_goals SET target_words = ?, target_date = ?, status = 'active', completed_at = NULL WHERE id = ?`,
			[input.targetWords, targetDate, id]
		);
	} else {
		id = generateScrivenerUUID();
		sqlite.execute(
			`INSERT INTO writing_goals (id, type, target_words, target_date, status) VALUES (?, ?, ?, ?, 'active')`,
			[id, input.type, input.targetWords, targetDate]
		);
	}

	const row = sqlite.queryOne(
		`SELECT id, type, target_words, target_date, actual_words, status, created_at, completed_at FROM writing_goals WHERE id = ?`,
		[id]
	) as RawWritingGoalRow | undefined;
	if (!row) {
		throw new AppError('Failed to persist writing goal', ErrorCode.DATABASE_ERROR);
	}
	return mapWritingGoalRow(row);
}

/**
 * List writing goals, most recent first. Pass `status` to filter
 * (e.g. 'active'); omit it to return goals of every status.
 */
export function getWritingGoals(
	sqlite: SQLiteManager | null,
	status?: string
): WritingGoalRecord[] {
	if (!sqlite) {
		return [];
	}

	let sql = `SELECT id, type, target_words, target_date, actual_words, status, created_at, completed_at FROM writing_goals`;
	const params: unknown[] = [];
	if (status) {
		sql += ` WHERE status = ?`;
		params.push(status);
	}
	sql += ` ORDER BY created_at DESC`;

	const rows = sqlite.query(sql, params) as RawWritingGoalRow[];
	return rows.map(mapWritingGoalRow);
}

/**
 * Read the single per-project writing-preferences profile. Returns the
 * defaults when none has been saved yet.
 */
export function getWritingPreferences(sqlite: SQLiteManager | null): WritingPreferences {
	if (!sqlite) {
		return { ...DEFAULT_PREFERENCES };
	}
	const row = sqlite.queryOne(
		`SELECT enabled, tone, complexity, length, point_of_view, style_guides, custom_instructions, updated_at FROM writing_preferences WHERE id = 1`
	) as RawPreferencesRow | undefined;
	return row ? mapPreferencesRow(row) : { ...DEFAULT_PREFERENCES };
}

/**
 * Upsert the single writing-preferences profile. Callers pass a fully
 * resolved profile (merge partial updates before calling).
 */
export function saveWritingPreferences(
	sqlite: SQLiteManager | null,
	prefs: WritingPreferences
): WritingPreferences {
	if (!sqlite) {
		throw new AppError(
			'SQLite not initialized. Open a project before setting writing preferences.',
			ErrorCode.DATABASE_ERROR
		);
	}
	sqlite.execute(
		`INSERT INTO writing_preferences (id, enabled, tone, complexity, length, point_of_view, style_guides, custom_instructions, updated_at)
			VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(id) DO UPDATE SET
				enabled = excluded.enabled, tone = excluded.tone, complexity = excluded.complexity,
				length = excluded.length, point_of_view = excluded.point_of_view,
				style_guides = excluded.style_guides, custom_instructions = excluded.custom_instructions,
				updated_at = CURRENT_TIMESTAMP`,
		[
			prefs.enabled ? 1 : 0,
			prefs.tone,
			prefs.complexity,
			prefs.length,
			prefs.pointOfView ?? null,
			safeStringify(prefs.styleGuides) ?? '[]',
			prefs.customInstructions ?? null,
		]
	);
	return getWritingPreferences(sqlite);
}

/** Record one feedback event for an AI operation. */
export function recordFeedback(sqlite: SQLiteManager | null, input: FeedbackInput): FeedbackRecord {
	if (!sqlite) {
		throw new AppError(
			'SQLite not initialized. Open a project before recording feedback.',
			ErrorCode.DATABASE_ERROR
		);
	}
	const id = generateScrivenerUUID();
	const accepted = input.accepted === undefined ? null : input.accepted ? 1 : 0;
	const rating = input.rating ?? null;
	sqlite.execute(
		`INSERT INTO writing_feedback (id, operation, rating, accepted, comment) VALUES (?, ?, ?, ?, ?)`,
		[id, input.operation, rating, accepted, input.comment ?? null]
	);
	const row = sqlite.queryOne(
		`SELECT id, operation, rating, accepted, comment, created_at FROM writing_feedback WHERE id = ?`,
		[id]
	) as RawFeedbackRow | undefined;
	if (!row) {
		throw new AppError('Failed to persist feedback', ErrorCode.DATABASE_ERROR);
	}
	return mapFeedbackRow(row);
}

/** Return recorded feedback, most recent first. */
export function getFeedbackRecords(sqlite: SQLiteManager | null, limit = 500): FeedbackRecord[] {
	if (!sqlite) {
		return [];
	}
	const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 5000);
	const rows = sqlite.query(
		`SELECT id, operation, rating, accepted, comment, created_at FROM writing_feedback ORDER BY created_at DESC LIMIT ?`,
		[safeLimit]
	) as RawFeedbackRow[];
	return rows.map(mapFeedbackRow);
}
