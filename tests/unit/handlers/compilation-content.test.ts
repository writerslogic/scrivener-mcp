import { CompilationService } from '../../../src/services/compilation-service.js';
import { AICompilationService } from '../../../src/services/compilation/ai-compiler.js';
import { compileDocumentsHandler } from '../../../src/handlers/compilation-handlers.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import type { HandlerContext } from '../../../src/handlers/types.js';

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';

test.each(['text', 'markdown', 'html'])(
	'standard %s compilation reads real formatted bodies, preserves source state and includes requested binder notes',
	async (format) => {
		const parser = new RTFHandler();
		const contents = new Map([
			[
				FIRST,
				await parser.parseRTF(parser.convertToRTF('First saved body: Café — 東京 🌙.')),
			],
			[SECOND, await parser.parseRTF(parser.convertToRTF('Second saved body.'))],
		]);
		const before = JSON.stringify([...contents]);
		const documents = [
			{
				id: FIRST,
				title: 'First scene',
				type: 'Text',
				synopsis: 'Synopsis evidence.',
				notes: 'Editorial note.',
			},
			{ id: SECOND, title: 'Second scene', type: 'Text' },
		];
		const context = {
			project: {
				getAllDocuments: async () => documents,
				readDocumentFormatted: async (id: string) => {
					const content = contents.get(id);
					if (!content) throw new Error('Unknown fixture document');
					return content;
				},
			},
		} as unknown as HandlerContext;
		const provider = jest
			.spyOn(AICompilationService.prototype, 'initialize')
			.mockRejectedValue(new Error('Standard compilation must stay local'));
		try {
			const result = await compileDocumentsHandler.handler(
				{
					mode: 'standard',
					format,
					includeSynopsis: true,
					includeNotes: true,
					separator: '\nSCENE BREAK\n',
				},
				context
			);
			const text = result.structuredContent?.text as string;
			expect(text).toContain('First saved body: Café — 東京 🌙.');
			expect(text).toContain('Second saved body.');
			expect(text.indexOf('First saved body')).toBeLessThan(
				text.indexOf('Second saved body')
			);
			expect(text).toContain('Synopsis evidence.');
			expect(text).toContain('Editorial note.');
			expect(result.structuredContent?.sections).toBe(2);
			expect(JSON.stringify([...contents])).toBe(before);
		} finally {
			provider.mockRestore();
		}
	}
);

test('compilation rejects incomplete scopes and failed reads without partial success', async () => {
	const context = {
		project: {
			getAllDocuments: async () => [{ id: FIRST, title: 'Saved', type: 'Text' }],
			readDocumentFormatted: async () => {
				throw new Error('Saved file is unreadable');
			},
		},
	} as unknown as HandlerContext;
	for (const documentIds of [
		[FIRST, SECOND],
		[FIRST, FIRST],
	])
		await expect(compileDocumentsHandler.handler({ documentIds }, context)).rejects.toThrow(
			/scope/
		);
	await expect(compileDocumentsHandler.handler({}, context)).rejects.toThrow(
		'Saved file is unreadable'
	);
});

test('requested notes are added to cloned styled spans', async () => {
	const content = {
		plainText: 'Styled prose.',
		formattedText: [{ text: 'Styled prose.', style: { bold: true } }],
		metadata: { notes: 'Keep the ending.' },
	};
	const result = await new CompilationService().compileDocuments(
		[{ id: FIRST, title: 'Scene', content }],
		{ outputFormat: 'markdown', includeNotes: true }
	);
	expect(result).toContain('**Styled prose.**');
	expect(result).toContain('Notes: Keep the ending.');
	expect(content.formattedText).toHaveLength(1);
});
