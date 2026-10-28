/**
 * Binary manuscript exporters — produce DOCX, EPUB, and PDF Buffers from an
 * ordered list of manuscript sections. Pure functions (no filesystem); the
 * caller writes the returned Buffer to disk. All three libraries are pure-JS
 * (docx, epub-gen-memory, pdf-lib), so this works cross-platform under npx and
 * in minimal containers without an external binary (e.g. Pandoc).
 */

import {
	Document,
	Packer,
	Paragraph,
	TextRun,
	HeadingLevel,
	AlignmentType,
	Header,
	Footer,
	PageNumber,
} from 'docx';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import * as epubGenMemory from 'epub-gen-memory';
import type { RTFContent } from '../parsers/rtf-handler.js';
import { EXPORT_PRESETS, type ExportPreset } from './export-presets.js';

type EpubFn = (
	options: {
		title: string;
		author?: string;
		description?: string;
		version?: number;
		css?: string;
		prependChapterTitles?: boolean;
		numberChaptersInTOC?: boolean;
	},
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
	id?: string;
	/** Document or folder title, used as a heading. */
	title: string;
	/** Plain-text body of the document ('' for folders). */
	text: string;
	/** Nesting depth in the binder (0 = top level), used to pick heading level. */
	depth: number;
	/** True for folder/group items, which contribute a heading but no body. */
	isFolder: boolean;
	sectionType?: 'part' | 'chapter' | 'scene' | 'front-matter';
	formattedText?: RTFContent['formattedText'];
	notes?: string[];
}

export interface ExportMeta {
	title: string;
	author?: string;
	preset?: ExportPreset;
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

function styledParagraphs(section: ExportSection): Array<RTFContent['formattedText']> {
	const runs =
		section.formattedText?.map((run) => run.text).join('') === section.text
			? section.formattedText
			: [{ text: section.text }];
	const paragraphs: Array<RTFContent['formattedText']> = [[]];
	for (const run of runs ?? []) {
		const parts = run.text.split(/\r?\n/);
		for (let index = 0; index < parts.length; index++) {
			if (index) paragraphs.push([]);
			if (parts[index])
				paragraphs[paragraphs.length - 1].push({ text: parts[index], style: run.style });
		}
	}
	return paragraphs.filter((paragraph) => paragraph.some((run) => run.text.trim()));
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
	const preset = meta.preset ? EXPORT_PRESETS[meta.preset] : undefined;
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
		if (section.sectionType !== 'scene' || !meta.preset)
			children.push(
				new Paragraph({
					text: section.title,
					heading: DOCX_HEADINGS[Math.min(section.depth, DOCX_HEADINGS.length - 1)],
					pageBreakBefore:
						!!meta.preset &&
						(section.sectionType === 'chapter' || section.sectionType === 'part'),
				})
			);
		if (section.sectionType === 'scene' && meta.preset)
			children.push(new Paragraph({ text: '#', alignment: AlignmentType.CENTER }));
		for (const para of styledParagraphs(section)) {
			children.push(
				new Paragraph({
					children: para.map(
						(run) =>
							new TextRun({
								text: run.text,
								bold: run.style?.bold,
								italics: run.style?.italic,
								underline: run.style?.underline ? {} : undefined,
								strike: run.style?.strikethrough,
							})
					),
				})
			);
		}
		for (const note of section.notes ?? [])
			children.push(
				new Paragraph({
					children: [new TextRun({ text: note, italics: true })],
					style: 'EditorialNote',
				})
			);
	}

	const doc = new Document({
		creator: meta.author,
		title: meta.title,
		styles: preset
			? {
					default: {
						document: {
							run: { font: preset.font, size: preset.fontSize },
							paragraph: {
								spacing: { line: preset.line, after: preset.paragraphAfter },
								indent: { firstLine: preset.firstLine },
							},
						},
					},
					paragraphStyles: [
						{
							id: 'EditorialNote',
							name: 'Editorial note',
							basedOn: 'Normal',
							run: { italics: true },
							paragraph: { indent: { firstLine: 0 } },
						},
					],
				}
			: undefined,
		sections: [
			{
				properties: preset
					? {
							page: {
								size: { width: 12240, height: 15840 },
								margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
							},
						}
					: undefined,
				headers: preset
					? {
							default: new Header({
								children: [
									new Paragraph({
										alignment: AlignmentType.RIGHT,
										children: [
											new TextRun(
												`${meta.author || 'Author'} / ${meta.title}`
											),
										],
									}),
								],
							}),
						}
					: undefined,
				footers: preset
					? {
							default: new Footer({
								children: [
									new Paragraph({
										alignment: AlignmentType.RIGHT,
										children: [new TextRun({ children: [PageNumber.CURRENT] })],
									}),
								],
							}),
						}
					: undefined,
				children,
			},
		],
	});
	return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

export async function toEpub(sections: ExportSection[], meta: ExportMeta): Promise<Buffer> {
	const chapters = sections
		.filter((s) => !!meta.preset || !s.isFolder || s.text.trim().length > 0)
		.map((s) => {
			const paragraphs =
				styledParagraphs(s)
					.map(
						(paragraph) =>
							`<p>${paragraph
								.map((run) => {
									let text = escapeHtml(run.text);
									if (run.style?.bold) text = `<strong>${text}</strong>`;
									if (run.style?.italic) text = `<em>${text}</em>`;
									if (run.style?.underline)
										text = `<span style="text-decoration:underline">${text}</span>`;
									if (run.style?.strikethrough) text = `<s>${text}</s>`;
									return text;
								})
								.join('')}</p>`
					)
					.join('\n') || '<p></p>';
			const notes = (s.notes ?? [])
				.map((note) => `<aside><p>${escapeHtml(note)}</p></aside>`)
				.join('');
			const level = Math.min(s.depth + 1, 6);
			return {
				title: s.title,
				content: `<h${level}>${escapeHtml(s.title)}</h${level}>${paragraphs}${notes}`,
			};
		});

	const result = await generateEpub(
		{
			title: meta.title,
			author: meta.author || 'Unknown',
			description: `Manuscript export: ${meta.title}`,
			version: 3,
			prependChapterTitles: false,
			numberChaptersInTOC: false,
			css:
				meta.preset === 'ebook'
					? 'body { font-family: serif; line-height: 1.5; margin: 5%; } p { text-indent: 1.2em; margin: 0 0 .5em; } h1, h2, h3 { text-align: center; break-after: avoid; } aside { font-size: .9em; margin: 1em; }'
					: undefined,
		},
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
