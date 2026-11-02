/**
 * Locks the pure-JS binary exporters for issue #37: DOCX, EPUB, and PDF must
 * each produce a non-empty buffer with the correct file magic, headings for
 * every section, and graceful handling of empty/Unicode/folder-only input.
 */

import {
	toDocx,
	toEpub,
	toPdf,
	exportBinary,
	BINARY_FORMATS,
	type ExportSection,
	type ExportMeta,
} from '../../../src/services/export/manuscript-exporters.js';
import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';

const META: ExportMeta = { title: 'The Test Manuscript', author: 'A. Writer' };

const SECTIONS: ExportSection[] = [
	{ title: 'Part One', text: '', depth: 0, isFolder: true },
	{
		title: 'Chapter 1',
		text: 'It was a bright cold day.\n\nThe clocks were striking thirteen.',
		depth: 1,
		isFolder: false,
	},
	{
		title: 'Chapter 2',
		// Smart quotes, em dash, ellipsis, and a non-WinAnsi char to exercise sanitization.
		text: 'She said, “Goodbye”—then… vanished. ❤',
		depth: 1,
		isFolder: false,
	},
];

// PK zip magic (DOCX and EPUB are both zip containers).
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('manuscript binary exporters', () => {
	it('BINARY_FORMATS enumerates exactly the three binary formats', () => {
		expect(Object.keys(BINARY_FORMATS).sort()).toEqual(['docx', 'epub', 'pdf']);
	});

	it('toDocx emits a valid (PK-zip) OOXML buffer', async () => {
		const buf = await toDocx(SECTIONS, META);
		expect(buf.length).toBeGreaterThan(0);
		expect(buf.subarray(0, 4)).toEqual(ZIP_MAGIC);
	});

	it('toEpub emits a valid (PK-zip) EPUB buffer', async () => {
		const buf = await toEpub(SECTIONS, META);
		expect(buf.length).toBeGreaterThan(0);
		expect(buf.subarray(0, 4)).toEqual(ZIP_MAGIC);
	});

	it('treats template syntax in manuscript and metadata as text, with no user-supplied EJS options', async () => {
		const payload = '<%= (() => { throw new Error("must not execute"); })() %>';
		const archive = await JSZip.loadAsync(
			await toEpub(
				[{ title: payload, text: payload, depth: 0, isFolder: false, notes: [payload] }],
				{ title: payload, author: payload }
			)
		);
		const pages = await Promise.all(
			Object.values(archive.files)
				.filter((file) => /\.xhtml$/u.test(file.name))
				.map((file) => file.async('string'))
		);
		expect(pages.some((page) => page.includes('&lt;%='))).toBe(true);
	});

	it('toPdf emits a %PDF- buffer for supported text and rejects unsupported Unicode before publication', async () => {
		const supported = SECTIONS.map((section) => ({
			...section,
			text: section.text.replace('❤', 'heart'),
		}));
		const buf = await toPdf(supported, META);
		expect(buf.length).toBeGreaterThan(0);
		expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		await expect(toPdf(SECTIONS, META)).rejects.toThrow(/unsupported characters.*❤/i);
	});

	it('excludes injected template bodies and engine options from the EPUB generator', async () => {
		const injected = '<% throw new Error("untrusted template executed"); %>';
		const meta = {
			...META,
			chapterXHTML: injected,
			contentOPF: injected,
			tocXHTML: injected,
			tocNCX: injected,
			closeDelimiter: injected,
			client: true,
			escapeFunction: injected,
			settings: { 'view options': { client: true, escapeFunction: injected } },
		};
		const archive = await JSZip.loadAsync(await toEpub(SECTIONS, meta));
		const metadata = await archive.file('OEBPS/content.opf')!.async('string');
		expect(metadata).toContain(META.title);
		expect(metadata).toContain(META.author);
		expect(metadata).not.toContain('untrusted template executed');
	});

	it('exportBinary dispatches each format to a valid buffer', async () => {
		const pdfSections = SECTIONS.map((section) => ({
			...section,
			text: section.text.replace('❤', 'heart'),
		}));
		const docx = await exportBinary('docx', SECTIONS, META);
		const epub = await exportBinary('epub', SECTIONS, META);
		const pdf = await exportBinary('pdf', pdfSections, META);
		expect(docx.subarray(0, 4)).toEqual(ZIP_MAGIC);
		expect(epub.subarray(0, 4)).toEqual(ZIP_MAGIC);
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
	});

	it('handles an empty manuscript without throwing', async () => {
		const empty: ExportSection[] = [];
		await expect(toDocx(empty, META)).resolves.toBeInstanceOf(Buffer);
		await expect(toEpub(empty, META)).resolves.toBeInstanceOf(Buffer);
		await expect(toPdf(empty, META)).resolves.toBeInstanceOf(Buffer);
	});

	it('handles a manuscript with no author', async () => {
		const buf = await toDocx(SECTIONS, { title: 'Untitled' });
		expect(buf.subarray(0, 4)).toEqual(ZIP_MAGIC);
	});
});

test.each(['漢字', 'e\u0301', '😀'])(
	'preserves %s in DOCX and EPUB, and refuses PDF without silently deleting it',
	async (text) => {
		const sections = [{ title: 'Unicode scene', text, depth: 0, isFolder: false }];
		for (const format of ['docx', 'epub'] as const) {
			const archive = await JSZip.loadAsync(await exportBinary(format, sections, META));
			const content = (
				await Promise.all(
					Object.values(archive.files)
						.filter((file) => /(?:document\.xml|\.xhtml)$/.test(file.name))
						.map(async (file) =>
							JSON.stringify(await parseStringPromise(await file.async('string')))
						)
				)
			).join('');
			expect(content).toContain(text);
		}
		await expect(toPdf(sections, META)).rejects.toThrow(/unsupported characters/);
	}
);
