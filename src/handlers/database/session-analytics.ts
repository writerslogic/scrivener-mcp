import { safeParse, safeStringify } from '../../utils/common.js';
import type { SQLiteManager } from './sqlite-manager.js';

export interface ContentAnalysisEntry {
	id: number;
	analysisType: string;
	analysisData: unknown;
	analyzedAt: string;
}

export interface WritingSessionInput {
	date: string;
	wordsWritten: number;
	durationMinutes: number;
	documentsWorkedOn: string[];
	notes?: string;
}

export interface WritingStatistics {
	totalWords: number;
	totalSessions: number;
	averageWordsPerSession: number;
	dailyStats: Array<{ date: string; words: number; sessions: number; duration: number }>;
}

const STATISTICS_TIMEOUT_MS = 10000;

export function storeContentAnalysis(
	sqlite: SQLiteManager | null,
	documentId: string,
	analysisType: string,
	analysisData: unknown
): void {
	if (!sqlite) return;

	const stmt = sqlite.getDatabase().prepare(`
		INSERT INTO content_analysis (document_id, analysis_type, analysis_data)
		VALUES (?, ?, ?)
	`);

	stmt.run([documentId, analysisType, safeStringify(analysisData)]);
}

export function getContentAnalysisHistory(
	sqlite: SQLiteManager | null,
	documentId: string,
	analysisType?: string
): ContentAnalysisEntry[] {
	if (!sqlite) return [];

	let sql = `
		SELECT id, analysis_type, analysis_data, analyzed_at
		FROM content_analysis
		WHERE document_id = ?
	`;
	const params = [documentId];

	if (analysisType) {
		sql += ` AND analysis_type = ?`;
		params.push(analysisType);
	}

	sql += ` ORDER BY analyzed_at DESC`;

	const results = sqlite.query(sql, params) as Array<{
		id: number;
		analysis_type: string;
		analysis_data: string;
		analyzed_at: string;
	}>;

	return results.map((row) => ({
		id: row.id,
		analysisType: row.analysis_type,
		analysisData: safeParse(row.analysis_data, {}),
		analyzedAt: row.analyzed_at,
	}));
}

export function recordWritingSession(
	sqlite: SQLiteManager | null,
	sessionData: WritingSessionInput
): void {
	if (!sqlite) return;

	const stmt = sqlite.getDatabase().prepare(`
		INSERT INTO writing_sessions
		(date, words_written, duration_minutes, documents_worked_on, notes)
		VALUES (?, ?, ?, ?, ?)
	`);

	stmt.run([
		sessionData.date,
		sessionData.wordsWritten,
		sessionData.durationMinutes,
		safeStringify(sessionData.documentsWorkedOn),
		sessionData.notes || null,
	]);
}

export function getWritingStatistics(
	sqlite: SQLiteManager | null,
	days = 30
): Promise<WritingStatistics> {
	if (!sqlite) {
		return Promise.resolve({
			totalWords: 0,
			totalSessions: 0,
			averageWordsPerSession: 0,
			dailyStats: [],
		});
	}

	// Clamp to a safe integer; this value is interpolated into SQL date math
	// (SQLite can't parametrize the "-N days" modifier), so it must not be raw.
	const safeDays = Math.max(1, Math.min(3650, Math.floor(Number(days) || 30)));

	const queryPromise = new Promise<WritingStatistics>((resolve) => {
		const totalResult = sqlite.queryOne(`
			SELECT
				SUM(words_written) as total_words,
				COUNT(*) as total_sessions
			FROM writing_sessions
			WHERE date >= date('now', '-${safeDays} days')
		`) as { total_words: number; total_sessions: number } | undefined;

		const dailyResults = sqlite.query(`
			SELECT
				date,
				SUM(words_written) as words,
				COUNT(*) as sessions,
				SUM(duration_minutes) as duration
			FROM writing_sessions
			WHERE date >= date('now', '-${safeDays} days')
			GROUP BY date
			ORDER BY date DESC
		`) as WritingStatistics['dailyStats'];

		resolve({
			totalWords: totalResult?.total_words || 0,
			totalSessions: totalResult?.total_sessions || 0,
			averageWordsPerSession: totalResult?.total_sessions
				? Math.round((totalResult.total_words || 0) / totalResult.total_sessions)
				: 0,
			dailyStats: dailyResults,
		});
	});

	const timeoutPromise = new Promise<never>((_, reject) =>
		setTimeout(
			() => reject(new Error('Query timeout: getWritingStatistics exceeded 10s')),
			STATISTICS_TIMEOUT_MS
		)
	);

	return Promise.race([queryPromise, timeoutPromise]);
}

export function trackWritingSession(
	sqlite: SQLiteManager | null,
	wordsWritten: number,
	duration: number
): void {
	if (!sqlite) return;

	sqlite.execute(
		`
		INSERT INTO writing_sessions (date, words_written, duration_minutes)
		VALUES (datetime('now'), ?, ?)
	`,
		[wordsWritten, duration]
	);
}

export function createDocumentVersion(
	sqlite: SQLiteManager | null,
	documentId: string,
	content: string,
	summary?: string
): void {
	if (!sqlite) return;

	const wordCount = content.split(/\s+/).length;
	const charCount = content.length;

	sqlite.execute(
		`
		INSERT INTO document_revisions
		(id, document_id, content, word_count, character_count, change_summary)
		VALUES (?, ?, ?, ?, ?, ?)
	`,
		[
			`rev-${documentId}-${Date.now()}`,
			documentId,
			content,
			wordCount,
			charCount,
			summary || 'Auto-saved version',
		]
	);
}
