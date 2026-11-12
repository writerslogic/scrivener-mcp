import { describe, expect, it, jest } from '@jest/globals';
import { readDocumentHandler } from '../../../src/handlers/document-handlers.js';
import { getHHMSystem } from '../../../src/handlers/memory-handlers.js';
import type { HandlerContext } from '../../../src/handlers/types.js';
import { createProjectSchemaValidator } from '../../../src/utils/json-schema-validator.js';
import type { JsonSchemaType } from '@modelcontextprotocol/server';

jest.mock('../../../src/handlers/memory-handlers.js', () => ({ getHHMSystem: jest.fn() }));

const documentId = '12345678-1234-4234-8234-123456789abc';
const revision = 'a'.repeat(64);
const validate = createProjectSchemaValidator().getValidator(
	readDocumentHandler.inputSchema as unknown as JsonSchemaType
);
function fixture(text = 'one two three') {
	const project = {
		getDocumentInfo: jest.fn(async () => ({ document: { id: documentId } })),
		readDocumentVersion: jest.fn(async () => ({ text, revision })),
		readDocumentFormatted: jest.fn(async () => ({ plainText: text, formattedText: [] })),
	};
	const context = { project } as unknown as HandlerContext;
	return { project, context };
}

it.each([
	{ offset: -1 },
	{ offset: 0.5 },
	{ offset: Number.MAX_SAFE_INTEGER + 1 },
	{ offset: NaN },
	{ offset: Infinity },
	{ offset: null },
	{ limit: -1 },
	{ limit: 0 },
	{ limit: 0.5 },
	{ limit: 10001 },
	{ limit: null },
])('rejects invalid paging before reading content: %j', async (paging) => {
	const { project, context } = fixture();
	const args = { documentId, ...paging };
	expect(validate(args).valid).toBe(false);
	await expect(readDocumentHandler.handler(args, context)).rejects.toMatchObject({
		code: 'INVALID_INPUT',
	});
	expect(project.getDocumentInfo).not.toHaveBeenCalled();
	expect(project.readDocumentVersion).not.toHaveBeenCalled();
});

it.each([0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER])(
	'accepts a bounded whole-number offset %j',
	async (offset) => {
		const { context } = fixture();
		const args = { documentId, offset, limit: 1 };
		expect(validate(args).valid).toBe(true);
		const result = await readDocumentHandler.handler(args, context);
		expect(result.structuredContent).toMatchObject({
			documentId,
			revision,
			text: offset === 0 ? 'one ' : offset === 1 ? 'two ' : '',
			pagination: { offset, totalWords: 3, nextOffset: offset < 2 ? offset + 1 : null },
		});
	}
);

it.each([1, 9999, 10000])(
	'accepts page limit %j and reports continuation accurately',
	async (limit) => {
		const text = Array.from({ length: 10001 }, (_, index) => `w${index}`).join('\n');
		const { context } = fixture(text);
		const args = { documentId, limit };
		expect(validate(args).valid).toBe(true);
		const result = await readDocumentHandler.handler(args, context);
		expect(result.structuredContent).toMatchObject({
			revision,
			pagination: { offset: 0, limit, totalWords: 10001, nextOffset: limit },
		});
		expect((result.structuredContent!.text as string).match(/\S+/gu)).toHaveLength(limit);
	}
);

it('reconstructs exact whitespace and Unicode from successive revision-bound pages without global retention', async () => {
	const text = ' \tFirst\u00a0second\n\n😀é\tlast \n';
	const { context } = fixture(text);
	let offset: number | null = 0;
	let combined = '';
	while (offset !== null) {
		const result = await readDocumentHandler.handler({ documentId, offset, limit: 1 }, context);
		const page = result.structuredContent as {
			text: string;
			revision: string;
			pagination: { nextOffset: number | null; sourceStart: number; sourceEnd: number };
		};
		expect(page.revision).toBe(revision);
		expect(page.text).toBe(text.slice(page.pagination.sourceStart, page.pagination.sourceEnd));
		combined += page.text;
		offset = page.pagination.nextOffset;
	}
	expect(combined).toBe(text);
	expect(getHHMSystem).not.toHaveBeenCalled();
});

it.each(['', ' \n\t', 'one\n'])(
	'handles empty and terminal whitespace without phantom words: %j',
	async (text) => {
		const { context } = fixture(text);
		const result = await readDocumentHandler.handler({ documentId, limit: 1 }, context);
		expect(result.structuredContent).toMatchObject({
			text,
			pagination: {
				totalWords: text.startsWith('one') ? 1 : 0,
				nextOffset: null,
				sourceStart: 0,
				sourceEnd: text.length,
			},
		});
	}
);

it('preserves the unpaged plain response and rejects paging for formatted reads', async () => {
	const text = '  original\n\ttext\n';
	const { project, context } = fixture(text);
	const result = await readDocumentHandler.handler({ documentId }, context);
	expect(result.structuredContent).toEqual({ documentId, text, revision });
	expect(result.content).toEqual([{ type: 'text', text }]);
	await expect(
		readDocumentHandler.handler({ documentId, format: 'formatted', offset: 0 }, context)
	).rejects.toThrow('require plain format');
	expect(project.readDocumentFormatted).not.toHaveBeenCalled();
});
