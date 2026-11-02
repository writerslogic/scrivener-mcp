import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteManager } from '../../src/handlers/database/sqlite-manager.js';
import { CachedSQLiteManager } from '../../src/handlers/database/keydb-cache.js';
import {
	getContentAnalysisHistory,
	storeContentAnalysis,
} from '../../src/handlers/database/session-analytics.js';
import { safeStringify } from '../../src/utils/common.js';

describe('persistent content analysis history', () => {
	let root: string;
	let sqlite: SQLiteManager;
	beforeEach(async () => {
		jest.spyOn(CachedSQLiteManager.prototype, 'initialize').mockResolvedValue(undefined);
		root = await mkdtemp(join(tmpdir(), 'scrivener-analysis-history-'));
		sqlite = new SQLiteManager(join(root, 'history.sqlite'));
		await sqlite.initialize();
		sqlite.execute(
			"INSERT INTO documents (id, title, type, path) VALUES ('scene', 'Scene', 'Text', 'Draft/Scene')"
		);
	});
	afterEach(async () => {
		await sqlite.close();
		await rm(root, { recursive: true, force: true });
		jest.restoreAllMocks();
	});
	it('stores large analyses compactly without losing Unicode or structured values', () => {
		const data = {
			text: 'Café 東京 🌙 — "quoted"\n'.repeat(1000),
			entities: new Map([['Mira', 3]]),
			tags: new Set(['harbor', 'moon']),
		};
		storeContentAnalysis(sqlite, 'scene', 'document', data);
		const saved = sqlite.queryOne('SELECT analysis_data FROM content_analysis') as {
			analysis_data: string;
		};
		expect(Buffer.byteLength(saved.analysis_data)).toBeLessThan(
			Buffer.byteLength(safeStringify(data)) / 2
		);
		expect(getContentAnalysisHistory(sqlite, 'scene')[0].analysisData).toEqual(data);
	});
	it('returns the most recently inserted result when timestamps are equal', () => {
		storeContentAnalysis(sqlite, 'scene', 'chapter_context', { revision: 1 });
		storeContentAnalysis(sqlite, 'scene', 'chapter_context', { revision: 2 });
		sqlite.execute("UPDATE content_analysis SET analyzed_at = '2040-01-01 00:00:00'");
		expect(
			getContentAnalysisHistory(sqlite, 'scene', 'chapter_context').map(
				(row) => row.analysisData
			)
		).toEqual([{ revision: 2 }, { revision: 1 }]);
	});
	it('does not insert a record when serialization fails', () => {
		expect(() => storeContentAnalysis(sqlite, 'scene', 'document', BigInt(1))).toThrow(
			/not serializable/
		);
		expect(sqlite.queryOne('SELECT COUNT(*) AS count FROM content_analysis')).toEqual({
			count: 0,
		});
	});
	it('reads legacy JSON alongside compressed records after reopening without rewriting either', async () => {
		const legacy = { text: 'Legacy café 東京', revision: 1 };
		const current = { text: 'Current café 東京'.repeat(1000), revision: 2 };
		sqlite.execute(
			'INSERT INTO content_analysis (document_id, analysis_type, analysis_data) VALUES (?, ?, ?)',
			['scene', 'document', JSON.stringify(legacy)]
		);
		storeContentAnalysis(sqlite, 'scene', 'document', current);
		const raw = sqlite.query('SELECT analysis_data FROM content_analysis ORDER BY id');
		await sqlite.close();
		sqlite = new SQLiteManager(join(root, 'history.sqlite'));
		await sqlite.initialize();
		expect(
			getContentAnalysisHistory(sqlite, 'scene', 'document').map((row) => row.analysisData)
		).toEqual([current, legacy]);
		expect(sqlite.query('SELECT analysis_data FROM content_analysis ORDER BY id')).toEqual(raw);
	});
	it('requires explicit pages for more than 1000 records while preserving the complete history', () => {
		const db = sqlite.getDatabase();
		const insert = db.prepare(
			"INSERT INTO content_analysis (document_id, analysis_type, analysis_data, analyzed_at) VALUES ('scene', 'document', ?, '2040-01-01 00:00:00')"
		);
		db.transaction(() => {
			for (let i = 0; i < 1001; i++) insert.run(JSON.stringify(i));
		})();
		expect(() => getContentAnalysisHistory(sqlite, 'scene')).toThrow(/request a page/);
		expect(getContentAnalysisHistory(sqlite, 'scene', undefined, { limit: 999 })).toHaveLength(
			999
		);
		const first = getContentAnalysisHistory(sqlite, 'scene', undefined, { limit: 1000 });
		const last = getContentAnalysisHistory(sqlite, 'scene', undefined, {
			limit: 1000,
			offset: 1000,
		});
		expect([...first, ...last].map((row) => row.analysisData)).toEqual(
			Array.from({ length: 1001 }, (_, index) => 1000 - index)
		);
		expect(getContentAnalysisHistory(sqlite, 'absent', undefined, { limit: 1 })).toEqual([]);
		expect(sqlite.queryOne('SELECT COUNT(*) AS count FROM content_analysis')).toEqual({
			count: 1001,
		});
	});
	it.each([0, -1, 1.5, 1001])('rejects invalid page limit %i', (limit) => {
		expect(() => getContentAnalysisHistory(sqlite, 'scene', undefined, { limit })).toThrow(
			/limit/
		);
	});
	it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid history offset %i',
		(offset) => {
			expect(() => getContentAnalysisHistory(sqlite, 'scene', undefined, { offset })).toThrow(
				/offset/
			);
		}
	);
	it('bounds aggregate decompression and releases the iterator when a read fails', () => {
		const large = 'x'.repeat(33 * 1024 * 1024);
		storeContentAnalysis(sqlite, 'scene', 'document', large);
		storeContentAnalysis(sqlite, 'scene', 'document', large);
		expect(() => getContentAnalysisHistory(sqlite, 'scene')).toThrow(/decoding budget/);
		expect(
			(
				getContentAnalysisHistory(sqlite, 'scene', undefined, { limit: 1 })[0]
					.analysisData as string
			).length
		).toBe(large.length);
		storeContentAnalysis(sqlite, 'scene', 'document', { recovered: true });
		expect(
			getContentAnalysisHistory(sqlite, 'scene', undefined, { limit: 1 })[0].analysisData
		).toEqual({ recovered: true });
	});
});
