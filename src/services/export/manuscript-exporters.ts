/**
 * Binary manuscript exporters — produce DOCX, EPUB, and PDF Buffers from an
 * ordered list of manuscript sections. Pure functions (no filesystem); the
 * caller writes the returned Buffer to disk. All three libraries are pure-JS
 * (docx, epub-gen-memory, pdf-lib), so this works cross-platform under npx and
 * in minimal containers without an external binary (e.g. Pandoc).
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import * as epubGenMemory from 'epub-gen-memory';

type EpubFn = (
	options: { title: string; author?: string },
	content: Array<{ title: string; content: string }>
) => Promise<Buffer>;

// epub-gen-memory is CJS with `export default`; under Node's ESM/CJS interop the
// callable ends up nested (namespace.default.default), so walk `.default` until
// we reach the function.
function resolveCallable(mod: unknown): EpubFn {
	let candidate: unknown = mod;
	for (let i = 0; i < 3 && candidate && typeof candidate !== 'function'; i++) {
		candidate = (candidate as { default?: unknown }).default;
	}
	return candidate as EpubFn;
}
const generateEpub = resolveCallable(epubGenMemory);

export interface ExportSection {
	/** Document or folder title, used as a heading. */
	title: string;
	/** Plain-text body of the document ('' for folders). */
	text: string;
	/** Nesting depth in the binder (0 = top level), used to pick heading level. */
	depth: number;
	/** True for folder/group items, which contribute a heading but no body. */
	isFolder: boolean;
}

export interface ExportMeta {
	title: string;
	author?: string;
}

/** Split a plain-text body into non-empty paragraphs on blank lines / newlines. */
function splitParagraphs(text: string): string[] {
	return text
		.split(/\n{2,}|\r\n{2,}|\n/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

/** Minimal HTML escape for EPUB chapter content. */
function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

const DOCX_HEADINGS = [
	HeadingLevel.HEADING_1,
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_3,
	HeadingLevel.HEADING_4,
];

export async function toDocx(sections: ExportSection[], meta: ExportMeta): Promise<Buffer> {
	const children: Paragraph[] = [
		new Paragraph({
			text: meta.title,
			heading: HeadingLevel.TITLE,
			alignment: AlignmentType.CENTER,
		}),
	];
	if (meta.author) {
		children.push(
			new Paragraph({ text: `by ${meta.author}`, alignment: AlignmentType.CENTER })
		);
	}

	for (const section of sections) {
		children.push(
			new Paragraph({
				text: section.title,
				heading: DOCX_HEADINGS[Math.min(section.depth, DOCX_HEADINGS.length - 1)],
			})
		);
		for (const para of splitParagraphs(section.text)) {
			children.push(new Paragraph({ children: [new TextRun(para)] }));
		}
	}

	const doc = new Document({ sections: [{ children }] });
	return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

export async function toEpub(sections: ExportSection[], meta: ExportMeta): Promise<Buffer> {
	const chapters = sections
		.filter((s) => !s.isFolder || s.text.trim().length > 0)
		.map((s) => ({
			title: s.title,
			content:
				splitParagraphs(s.text)
					.map((p) => `<p>${escapeHtml(p)}</p>`)
					.join('\n') || '<p></p>',
		}));

	const result = await generateEpub(
		{ title: meta.title, author: meta.author || 'Unknown' },
		chapters.length > 0 ? chapters : [{ title: meta.title, content: '<p></p>' }]
	);
	return Buffer.isBuffer(result) ? result : Buffer.from(result as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// PDF (pdf-lib is low-level: we wrap and paginate text ourselves)
// ---------------------------------------------------------------------------

/** pdf-lib StandardFonts only encode WinAnsi; map common typographic chars and
 * drop anything else so drawText never throws on smart quotes / em-dashes. */
function sanitizeForPdf(text: string): string {
	return (
		text
			.replace(/[‘’‚′]/g, "'")
			.replace(/[“”„″]/g, '"')
			.replace(/[–—]/g, '-')
			.replace(/…/g, '...')
			.replace(/\u00A0/g, ' ')
			// eslint-disable-next-line no-control-regex
			.replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '')
	);
}

function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [''];
}

export async function toPdf(sections: ExportSection[], meta: ExportMeta): Promise<Buffer> {
	const pdf = await PDFDocument.create();
	const body = await pdf.embedFont(StandardFonts.TimesRoman);
	const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);

	const pageWidth = 612;
	const pageHeight = 792;
	const margin = 72;
	const lineHeight = 18;
	const maxWidth = pageWidth - margin * 2;

	let page = pdf.addPage([pageWidth, pageHeight]);
	let y = pageHeight - margin;

	const draw = (text: string, font: PDFFont, size: number): void => {
		for (const line of wrapLine(sanitizeForPdf(text), font, size, maxWidth)) {
			if (y < margin) {
				page = pdf.addPage([pageWidth, pageHeight]);
				y = pageHeight - margin;
			}
			page.drawText(line, { x: margin, y, size, font });
			y -= lineHeight;
		}
	};

	draw(meta.title, bold, 20);
	if (meta.author) draw(`by ${meta.author}`, body, 12);
	y -= lineHeight;

	for (const section of sections) {
		y -= lineHeight;
		draw(section.title, bold, 14);
		for (const para of splitParagraphs(section.text)) {
			draw(para, body, 12);
			y -= lineHeight / 2;
		}
	}

	const bytes = await pdf.save();
	return Buffer.from(bytes);
}

/** Format extension for a binary export format. */
export const BINARY_FORMATS: Record<string, string> = {
	docx: 'docx',
	epub: 'epub',
	pdf: 'pdf',
};

export async function exportBinary(
	format: 'docx' | 'epub' | 'pdf',
	sections: ExportSection[],
	meta: ExportMeta
): Promise<Buffer> {
	switch (format) {
		case 'docx':
			return toDocx(sections, meta);
		case 'epub':
			return toEpub(sections, meta);
		case 'pdf':
			return toPdf(sections, meta);
	}
}
