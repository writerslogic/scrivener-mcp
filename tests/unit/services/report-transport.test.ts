import { RESULT_METADATA_BYTE_RESERVE } from '../../../src/core/response-formatter.js';
import { ReportTransport } from '../../../src/services/editorial/report-transport.js';
import { manuscriptAnalysisHandlers } from '../../../src/handlers/manuscript-analysis-handlers.js';
import type { HandlerContext, HandlerResult } from '../../../src/handlers/types.js';

function payload(page: HandlerResult) {
	return page.structuredContent!.result as {
		reportId: string;
		encoding?: string;
		data: string;
		pagination?: { start: number; end: number; total: number; nextCursor: string | null };
	};
}

describe('bounded immutable report transport', () => {
	it('delivers pending cancellation before indexing a new analysis report', async () => {
		const transport = new ReportTransport();
		const page = jest.spyOn(transport, 'pageSerialized');
		const controller = new AbortController();
		const value = { findings: [{ quote: '🌙'.repeat(12000) }] };
		const context = {
			project: {
				getEditorialServices: () => ({
					narrative: {
						transport,
						serializedAnalysis: async () => {
							setTimeout(() => controller.abort(), 0);
							return JSON.stringify(value);
						},
					},
				}),
			},
		} as unknown as HandlerContext;
		await expect(
			manuscriptAnalysisHandlers[0].handler({}, context, { signal: controller.signal })
		).rejects.toThrow(/aborted/i);
		expect(page).not.toHaveBeenCalled();
		const result = await manuscriptAnalysisHandlers[0].handler({}, context);
		expect(result.structuredContent!.result).toEqual({
			...value,
			reportId: expect.any(String),
		});
	});
	it('yields continuation requests and preserves the cached report after cancellation', async () => {
		const transport = new ReportTransport();
		const initial = transport.page(
			'analyze',
			{ pageByteLimit: 16384 },
			{ findings: ['x'.repeat(40000)] }
		);
		const part = payload(initial);
		const args = {
			action: 'read_report',
			reportId: part.reportId,
			pageCursor: part.pagination!.nextCursor,
			pageByteLimit: 16384,
		};
		const context = {
			project: { getEditorialServices: () => ({ narrative: { transport } }) },
		} as unknown as HandlerContext;
		const controller = new AbortController();
		const pending = manuscriptAnalysisHandlers[0].handler(args, context, {
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/i);
		let ticked = false;
		setImmediate(() => {
			ticked = true;
		});
		const next = await manuscriptAnalysisHandlers[0].handler(args, context);
		expect(ticked).toBe(true);
		expect(payload(next).pagination!.start).toBe(part.pagination!.end);
		expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(16384);
	});
	it('accounts for text, structured content, escaping and multibyte Unicode at exact limits', () => {
		const value = { findings: [{ quote: 'x'.repeat(9000) }] };
		const full = new ReportTransport().page('analyze', { pageByteLimit: 65536 }, value);
		const bytes = Buffer.byteLength(JSON.stringify(full)) + RESULT_METADATA_BYTE_RESERVE;
		for (const limit of [bytes - 1, bytes, bytes + 1]) {
			const page = new ReportTransport().page('analyze', { pageByteLimit: limit }, value);
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(limit);
			expect(payload(page).encoding === 'json-fragment').toBe(limit < bytes);
		}
	});

	it.each(['object', 'serialized'])(
		'reconstructs every %s finding and oversized metadata exactly once after the source changes',
		(input) => {
			const transport = new ReportTransport();
			const value = {
				envelope: { revision: 'before', sources: '🌙'.repeat(12000) },
				findings: Array.from({ length: 45 }, (_, id) => ({
					id,
					quote: '\\"🌙\n'.repeat(300),
				})),
				comparison: { resolved: ['saved'] },
			};
			const expected = structuredClone(value);
			let page =
				input === 'object'
					? transport.page('analyze', { pageByteLimit: 16384 }, value)
					: transport.pageSerialized(
							'analyze',
							{ pageByteLimit: 16384 },
							JSON.stringify(value)
						);
			value.findings.pop();
			value.envelope.revision = 'after';
			let serialized = '',
				end = 0;
			const id = payload(page).reportId;
			for (;;) {
				expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16384);
				expect(JSON.parse(page.content[0].text!)).toEqual(page.structuredContent);
				const part = payload(page);
				expect(part.reportId).toBe(id);
				expect(part.pagination!.start).toBe(end);
				expect(part.pagination!.end).toBeGreaterThan(end);
				expect(part.data).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
				serialized += part.data;
				end = part.pagination!.end;
				if (part.pagination!.nextCursor === null) break;
				page = transport.page('read_report', {
					reportId: id,
					pageCursor: part.pagination!.nextCursor,
					pageByteLimit: 16384,
				});
			}
			expect(JSON.parse(serialized)).toEqual(expected);
			transport.clear();
			expect(() => transport.page('read_report', { reportId: id })).toThrow(/expired/);
		}
	);

	it.each([16384, 32768, 4194304])(
		'fills %i-byte pages within reserved dispatch metadata across escapes and Unicode',
		(limit) => {
			const transport = new ReportTransport();
			const alphabet = '\\"\b\f\n\r\t\u0000\u001f é漢🌙\ud800 \udfff';
			const value = { text: alphabet.repeat(Math.ceil(limit / 40)) };
			const serialized = JSON.stringify(value);
			let page = transport.page('analyze', { pageByteLimit: limit }, value);
			let text = '';
			for (;;) {
				const part = payload(page);
				expect(part.encoding).toBe('json-fragment');
				expect(
					Buffer.byteLength(
						JSON.stringify({
							...page,
							_meta: {
								'com.writerslogic/project': '10000000-0000-4000-8000-000000000001',
								'com.writerslogic/operation': {
									id: '20000000-0000-4000-8000-000000000001',
									durationMs: Number.MAX_SAFE_INTEGER,
								},
							},
						})
					)
				).toBeLessThanOrEqual(limit);
				expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(limit);
				expect(JSON.parse(page.content[0].text!)).toEqual(page.structuredContent);
				text += part.data;
				if (part.pagination!.nextCursor === null) break;
				const end =
					part.pagination!.end +
					(serialized.codePointAt(part.pagination!.end)! > 0xffff ? 2 : 1);
				const enlarged = {
					...page.structuredContent,
					result: {
						...part,
						data: serialized.slice(part.pagination!.start, end),
						pagination: {
							...part.pagination,
							end,
							nextCursor: end < serialized.length ? String(end) : null,
						},
					},
				};
				expect(
					Buffer.byteLength(
						JSON.stringify({
							content: [{ type: 'text', text: JSON.stringify(enlarged) }],
							structuredContent: enlarged,
						})
					)
				).toBeGreaterThan(limit - RESULT_METADATA_BYTE_RESERVE);
				page = transport.page('read_report', {
					reportId: part.reportId,
					pageCursor: part.pagination!.nextCursor,
					pageByteLimit: limit,
				});
			}
			expect(text).toBe(serialized);
			expect(JSON.parse(text)).toEqual(value);
		}
	);

	it.each([4095, 4096, 4097])(
		'preserves arbitrary UTF-16 cursors near cache checkpoint %i',
		(position) => {
			const transport = new ReportTransport();
			const value = {
				text:
					'a'.repeat(position - JSON.stringify({ text: '' }).indexOf('"}')) +
					'🌙' +
					'b'.repeat(20000),
			};
			const serialized = JSON.stringify(value);
			expect(serialized.indexOf('🌙')).toBe(position);
			const first = payload(transport.page('analyze', { pageByteLimit: 16384 }, value));
			for (const cursor of [
				position - 1,
				position,
				position + 1,
				position + 2,
				serialized.length,
				serialized.length + 1,
			]) {
				const read = () =>
					transport.page('read_report', {
						reportId: first.reportId,
						pageCursor: String(cursor),
						pageByteLimit: 16384,
					});
				if (cursor === position + 1 || cursor > serialized.length)
					expect(read).toThrow(/pageCursor/);
				else {
					const page = payload(read());
					expect(page.pagination!.start).toBe(cursor);
					expect(page.data).toBe(serialized.slice(cursor, page.pagination!.end));
				}
			}
		}
	);

	it.each([null, true, '16384', 16383, 4194305, NaN])(
		'rejects invalid byte limits: %s',
		(limit) => {
			expect(() =>
				new ReportTransport().page('analyze', { pageByteLimit: limit }, {})
			).toThrow(/pageByteLimit/);
		}
	);
	it.each(['', '-1', '1.2', '01', 1, null])('rejects invalid cursors: %s', (cursor) => {
		expect(() => new ReportTransport().page('analyze', { pageCursor: cursor }, {})).toThrow(
			/pageCursor/
		);
	});
});
