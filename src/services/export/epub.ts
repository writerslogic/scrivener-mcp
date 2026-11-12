import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Builder } from 'xml2js';
import { publicationLanguage } from './language.js';
import type { ExportMeta } from './manuscript-exporters.js';

const XHTML = 'http://www.w3.org/1999/xhtml';
const EPUB = 'http://www.idpf.org/2007/ops';
const MAX_EPUB_BYTES = 128 * 1024 * 1024;
const xml = new Builder({
	renderOpts: { pretty: false },
	xmldec: { version: '1.0', encoding: 'UTF-8' },
});

export function validateEpubText(value: string): void {
	if (typeof value !== 'string')
		throw new Error('EPUB text must contain only valid XML characters');
	for (let offset = 0; offset < value.length; offset++) {
		const point = value.codePointAt(offset)!;
		if (
			point === 0x09 ||
			point === 0x0a ||
			point === 0x0d ||
			(point >= 0x20 && point <= 0xd7ff) ||
			(point >= 0xe000 && point <= 0xfffd)
		)
			continue;
		if (point >= 0x10000) {
			offset++;
			continue;
		}
		throw new Error('EPUB text must contain only valid XML characters');
	}
}

export function escapeEpubText(value: string): string {
	validateEpubText(value);
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function createEpub(
	chapters: Array<{ title: string; content: string; language?: string }>,
	meta: ExportMeta
): Promise<Buffer> {
	const language = publicationLanguage(meta.language);
	const title = meta.title || 'Untitled';
	const author = meta.author || 'Unknown';
	validateEpubText(title);
	validateEpubText(author);
	const identifier = `urn:uuid:${randomUUID()}`;
	const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
	const resources = chapters.map((chapter, index) => ({
		...chapter,
		language: publicationLanguage(chapter.language ?? language),
		title: chapter.title || `Section ${index + 1}`,
		id: `chapter-${index + 1}`,
		href: `chapter-${index + 1}.xhtml`,
	}));
	const archive = new JSZip();
	let bytes = 0;
	const add = (
		name: string,
		content: string,
		compression: 'STORE' | 'DEFLATE' = 'DEFLATE'
	): void => {
		bytes += Buffer.byteLength(content);
		if (bytes > MAX_EPUB_BYTES) throw new Error('EPUB resources exceed the 128 MiB size limit');
		archive.file(name, content, { createFolders: false, compression });
	};

	// EPUB requires this exact first entry, stored without a ZIP extra field.
	add('mimetype', 'application/epub+zip', 'STORE');
	add(
		'META-INF/container.xml',
		xml.buildObject({
			container: {
				$: { version: '1.0', xmlns: 'urn:oasis:names:tc:opendocument:xmlns:container' },
				rootfiles: {
					rootfile: {
						$: {
							'full-path': 'OEBPS/content.opf',
							'media-type': 'application/oebps-package+xml',
						},
					},
				},
			},
		})
	);
	add(
		'OEBPS/content.opf',
		xml.buildObject({
			package: {
				$: {
					version: '3.0',
					xmlns: 'http://www.idpf.org/2007/opf',
					'unique-identifier': 'book-id',
				},
				metadata: {
					$: { 'xmlns:dc': 'http://purl.org/dc/elements/1.1/' },
					'dc:identifier': { $: { id: 'book-id' }, _: identifier },
					'dc:title': title,
					'dc:language': [
						...new Set([language, ...resources.map((resource) => resource.language)]),
					],
					'dc:creator': author,
					'dc:description': `Manuscript export: ${title}`,
					meta: { $: { property: 'dcterms:modified' }, _: modified },
				},
				manifest: {
					item: [
						{
							$: {
								id: 'nav',
								href: 'toc.xhtml',
								'media-type': 'application/xhtml+xml',
								properties: 'nav',
							},
						},
						{
							$: {
								id: 'ncx',
								href: 'toc.ncx',
								'media-type': 'application/x-dtbncx+xml',
							},
						},
						{ $: { id: 'style', href: 'style.css', 'media-type': 'text/css' } },
						...resources.map(({ id, href }) => ({
							$: { id, href, 'media-type': 'application/xhtml+xml' },
						})),
					],
				},
				spine: {
					$: { toc: 'ncx' },
					itemref: [
						{ $: { idref: 'nav' } },
						...resources.map(({ id }) => ({ $: { idref: id } })),
					],
				},
			},
		})
	);
	add(
		'OEBPS/toc.xhtml',
		xml.buildObject({
			html: {
				$: { xmlns: XHTML, 'xmlns:epub': EPUB, lang: language, 'xml:lang': language },
				head: {
					title,
					link: { $: { rel: 'stylesheet', type: 'text/css', href: 'style.css' } },
				},
				body: {
					nav: {
						$: { 'epub:type': 'toc', id: 'toc' },
						h1: { $: { lang: 'en', 'xml:lang': 'en' }, _: 'Table of Contents' },
						ol: {
							li: resources.map(({ title: chapterTitle, href }) => ({
								a: { $: { href }, _: chapterTitle },
							})),
						},
					},
				},
			},
		})
	);
	add(
		'OEBPS/toc.ncx',
		xml.buildObject({
			ncx: {
				$: { xmlns: 'http://www.daisy.org/z3986/2005/ncx/', version: '2005-1' },
				head: {
					meta: [
						{ $: { name: 'dtb:uid', content: identifier } },
						{ $: { name: 'dtb:depth', content: '1' } },
						{ $: { name: 'dtb:totalPageCount', content: '0' } },
						{ $: { name: 'dtb:maxPageNumber', content: '0' } },
					],
				},
				docTitle: { text: title },
				docAuthor: { text: author },
				navMap: {
					navPoint: resources.map(({ id, title: chapterTitle, href }, index) => ({
						$: { id, playOrder: index + 1 },
						navLabel: { text: chapterTitle },
						content: { $: { src: href } },
					})),
				},
			},
		})
	);
	const paragraphStyle = 'p { white-space: pre-wrap; min-height: 1em; }';
	add(
		'OEBPS/style.css',
		meta.preset === 'ebook'
			? `${paragraphStyle} body { font-family: serif; line-height: 1.5; margin: 5%; } p { text-indent: 1.2em; margin: 0 0 .5em; } h1, h2, h3 { text-align: center; break-after: avoid; } aside { font-size: .9em; margin: 1em; }`
			: paragraphStyle
	);
	for (const chapter of resources) {
		const chapterTitle = escapeEpubText(chapter.title);
		add(
			`OEBPS/${chapter.href}`,
			`<?xml version="1.0" encoding="UTF-8"?><html xmlns="${XHTML}" lang="${chapter.language}" xml:lang="${chapter.language}"><head><title>${chapterTitle}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${chapter.content}</body></html>`
		);
	}
	const result = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
	if (result.length > MAX_EPUB_BYTES)
		throw new Error('EPUB archive exceeds the 128 MiB size limit');
	return result;
}
