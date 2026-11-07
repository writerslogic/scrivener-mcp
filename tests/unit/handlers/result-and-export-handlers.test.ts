/**
 * Tests for the read_result and export_manuscript handlers. Argument validation
 * and dispatch are exercised directly; the project is mocked, so no .scriv
 * project or export engine is touched.
 */

import { readResultHandler } from '../../../src/handlers/result-handlers.js';
import { exportManuscriptHandler } from '../../../src/handlers/export-preset-handlers.js';
import { formatPayload, disposeSpool } from '../../../src/core/response-formatter.js';
import type { HandlerContext, HandlerResult } from '../../../src/handlers/types.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function ctx(overrides: Partial<HandlerContext> = {}): HandlerContext {
	return overrides as HandlerContext;
}

function structured<T = unknown>(result: HandlerResult): T {
	return result.structuredContent as T;
}

function textOf(result: HandlerResult): string {
	return result.content[0]?.text ?? '';
}

/** Spill a payload larger than the inline threshold and return its resultId. */
function spoolPayload(data: unknown): string {
	const ref = JSON.parse(formatPayload(data, 'test'))._ref;
	expect(typeof ref).toBe('string');
	return ref;
}

describe('read_result', () => {
	afterAll(() => disposeSpool());

	it('returns the full result when it fits in one chunk', async () => {
		const payload = { items: 'x'.repeat(5000) };
		const id = spoolPayload(payload);

		const result = await readResultHandler.handler({ resultId: id }, ctx());
		const chunk = structured<Record<string, unknown>>(result);

		expect(chunk.resultId).toBe(id);
		expect(chunk.offset).toBe(0);
		expect(chunk.nextOffset).toBeNull();
		expect(JSON.parse(chunk.text as string)).toEqual(payload);
		expect(textOf(result)).toBe(JSON.stringify(chunk));
	});

	it('pages through a result with offset/limit and reassembles it exactly', async () => {
		const payload = { items: 'y'.repeat(5000) };
		const id = spoolPayload(payload);

		let offset: number | null = 0;
		let text = '';
		let pages = 0;
		while (offset !== null) {
			const result = await readResultHandler.handler(
				{ resultId: id, offset, limit: 1024 },
				ctx()
			);
			const chunk = structured<{ text: string; nextOffset: number | null }>(result);
			text += chunk.text;
			offset = chunk.nextOffset;
			pages++;
		}

		expect(pages).toBeGreaterThan(1);
		expect(JSON.parse(text)).toEqual(payload);
	});

	it('rejects a missing resultId', async () => {
		await expect(readResultHandler.handler({}, ctx())).rejects.toThrow(/string for resultId/i);
	});

	it('rejects a non-string resultId', async () => {
		await expect(readResultHandler.handler({ resultId: 42 }, ctx())).rejects.toThrow(
			/string for resultId/i
		);
	});

	it('rejects a malformed resultId', async () => {
		await expect(
			readResultHandler.handler({ resultId: '../../etc/passwd' }, ctx())
		).rejects.toThrow(/invalid result identifier/i);
	});

	it('rejects a well-formed but unknown resultId', async () => {
		await expect(readResultHandler.handler({ resultId: UUID }, ctx())).rejects.toThrow(
			/not found or has expired/i
		);
	});

	it('rejects a non-numeric offset or limit', async () => {
		await expect(
			readResultHandler.handler({ resultId: UUID, offset: '0' }, ctx())
		).rejects.toThrow(/number for offset/i);
		await expect(
			readResultHandler.handler({ resultId: UUID, limit: '10' }, ctx())
		).rejects.toThrow(/number for limit/i);
	});

	it('rejects out-of-range offset and limit values', async () => {
		await expect(
			readResultHandler.handler({ resultId: UUID, offset: -1 }, ctx())
		).rejects.toThrow(/non-negative safe integer/i);
		await expect(
			readResultHandler.handler({ resultId: UUID, limit: 3 }, ctx())
		).rejects.toThrow(/4–65536/);
		await expect(
			readResultHandler.handler({ resultId: UUID, limit: 65537 }, ctx())
		).rejects.toThrow(/4–65536/);
	});

	it('rejects an offset beyond the end of the result', async () => {
		const id = spoolPayload({ items: 'z'.repeat(5000) });
		await expect(
			readResultHandler.handler({ resultId: id, offset: 1_000_000 }, ctx())
		).rejects.toThrow(/exceeds its byte length/i);
	});

	it('is declared read-only and requires resultId', () => {
		expect(readResultHandler.name).toBe('read_result');
		expect(readResultHandler.annotations?.readOnlyHint).toBe(true);
		expect(readResultHandler.inputSchema.required).toEqual(['resultId']);
	});
});

describe('export_manuscript', () => {
	function mockProject() {
		return {
			preflightExport: jest.fn().mockResolvedValue({ ready: true }),
			exportManuscript: jest.fn().mockResolvedValue({ path: '/tmp/out.docx', bytes: 10 }),
		};
	}

	function withProject(project: ReturnType<typeof mockProject>) {
		return ctx({ project: project as never });
	}

	it('defaults to a preflight and does not write an export', async () => {
		const project = mockProject();

		const result = await exportManuscriptHandler.handler(
			{ preset: 'beta-reader' },
			withProject(project)
		);

		expect(project.preflightExport).toHaveBeenCalledWith({ preset: 'beta-reader' });
		expect(project.exportManuscript).not.toHaveBeenCalled();
		expect(structured(result)).toEqual({
			result: { ready: true },
		});
		expect(JSON.parse(textOf(result))).toEqual({ ready: true });
	});

	it('exports with the options and outputPath passed separately', async () => {
		const project = mockProject();

		const result = await exportManuscriptHandler.handler(
			{
				action: 'export',
				preset: 'ebook',
				documentIds: [UUID],
				frontMatterIds: [UUID],
				includeAnnotations: true,
				allowWarnings: true,
				outputPath: '/tmp/out.epub',
			},
			withProject(project)
		);

		expect(project.preflightExport).not.toHaveBeenCalled();
		expect(project.exportManuscript).toHaveBeenCalledWith(
			{
				preset: 'ebook',
				documentIds: [UUID],
				frontMatterIds: [UUID],
				includeAnnotations: true,
				allowWarnings: true,
			},
			'/tmp/out.epub'
		);
		expect(structured(result)).toEqual({
			result: { path: '/tmp/out.docx', bytes: 10 },
		});
	});

	it('exports to the default location when outputPath is omitted', async () => {
		const project = mockProject();

		await exportManuscriptHandler.handler(
			{ action: 'export', preset: 'submission-manuscript' },
			withProject(project)
		);

		expect(project.exportManuscript).toHaveBeenCalledWith(
			{ preset: 'submission-manuscript' },
			undefined
		);
	});

	it('fails with a clear error when no project is open', async () => {
		await expect(exportManuscriptHandler.handler({ preset: 'ebook' }, ctx())).rejects.toThrow(
			/no project is currently open/i
		);
	});

	it.each([
		['a missing preset', {}],
		['an unknown preset', { preset: 'pdf' }],
		['an unknown action', { preset: 'ebook', action: 'delete' }],
		['a non-UUID document id', { preset: 'ebook', documentIds: ['not-a-uuid'] }],
		['a non-UUID front-matter id', { preset: 'ebook', frontMatterIds: ['nope'] }],
		['an empty outputPath', { preset: 'ebook', outputPath: '' }],
		['a non-boolean includeAnnotations', { preset: 'ebook', includeAnnotations: 'yes' }],
		['an unexpected extra property', { preset: 'ebook', unexpected: true }],
	])('rejects %s before touching the project', async (_label, args) => {
		const project = mockProject();

		await expect(exportManuscriptHandler.handler(args, withProject(project))).rejects.toThrow();

		expect(project.preflightExport).not.toHaveBeenCalled();
		expect(project.exportManuscript).not.toHaveBeenCalled();
	});

	it('propagates failures from the project', async () => {
		const project = mockProject();
		project.preflightExport.mockRejectedValue(new Error('unsupported layout'));

		await expect(
			exportManuscriptHandler.handler({ preset: 'ebook' }, withProject(project))
		).rejects.toThrow('unsupported layout');
	});

	it('requires preset in its input schema', () => {
		expect(exportManuscriptHandler.name).toBe('export_manuscript');
		expect(exportManuscriptHandler.inputSchema.required).toEqual(['preset']);
	});
});
