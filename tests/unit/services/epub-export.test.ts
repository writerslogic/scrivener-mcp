import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { toEpub, type ExportSection } from '../../../src/services/export/manuscript-exporters.js';
import { validateExport } from '../../../src/services/export/export-presets.js';

const metadata = { title: 'A book — 東京 🌙', author: 'A. Writer & Co.', preset: 'ebook' as const };
const scene = (changes: Partial<ExportSection> = {}): ExportSection => ({
	title: 'Scene',
	text: 'Original text.',
	depth: 0,
	isFolder: false,
	...changes,
});

async function read(zip: JSZip, name: string): Promise<string> {
	const file = zip.file(name);
	if (!file) throw new Error(`Missing EPUB resource: ${name}`);
	return file.async('string');
}

async function xml(zip: JSZip, name: string) {
	return parseStringPromise(await read(zip, name), { explicitArray: false });
}

test('writes a stored first mimetype and complete EPUB3 metadata with matching identifiers', async () => {
	const result = await toEpub([scene()], metadata);
	expect(result.readUInt32LE(0)).toBe(0x04034b50);
	expect(result.readUInt16LE(8)).toBe(0);
	expect(result.readUInt16LE(26)).toBe(8);
	expect(result.readUInt16LE(28)).toBe(0);
	expect(result.subarray(30, 58).toString()).toBe('mimetypeapplication/epub+zip');
	await expect(validateExport(result, 'epub')).resolves.toContain('XHTML syntax');
	const zip = await JSZip.loadAsync(result, { checkCRC32: true });
	const container = await xml(zip, 'META-INF/container.xml');
	expect(container.container.$.xmlns).toBe('urn:oasis:names:tc:opendocument:xmlns:container');
	const pkg = (await xml(zip, container.container.rootfiles.rootfile.$['full-path'])).package;
	expect(pkg.$).toMatchObject({ version: '3.0', xmlns: 'http://www.idpf.org/2007/opf' });
	expect(pkg.metadata['dc:title']).toBe(metadata.title);
	expect(pkg.metadata['dc:creator']).toBe(metadata.author);
	expect(pkg.metadata['dc:description']).toBe(`Manuscript export: ${metadata.title}`);
	expect(pkg.metadata['dc:language']).toBe('en');
	expect(pkg.metadata['dc:identifier'].$.id).toBe(pkg.$['unique-identifier']);
	expect(pkg.metadata['dc:identifier']._).toMatch(/^urn:uuid:[a-f0-9-]{36}$/);
	expect(pkg.metadata.meta.$.property).toBe('dcterms:modified');
	expect(pkg.metadata.meta._).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
	const ncx = (await xml(zip, 'OEBPS/toc.ncx')).ncx;
	expect(
		ncx.head.meta.find((entry: { $: { name: string } }) => entry.$.name === 'dtb:uid').$.content
	).toBe(pkg.metadata['dc:identifier']._);
});

test('keeps chapter identities and reading order independent of duplicate or hostile titles', async () => {
	const title = '../toc.xhtml?query#fragment & <element> " 😀';
	const sections = [
		scene({ title, text: 'First body.' }),
		scene({ title, text: 'Second body.' }),
	];
	const zip = await JSZip.loadAsync(await toEpub(sections, { ...metadata, title }));
	expect(Object.keys(zip.files)).toEqual([
		'mimetype',
		'META-INF/container.xml',
		'OEBPS/content.opf',
		'OEBPS/toc.xhtml',
		'OEBPS/toc.ncx',
		'OEBPS/style.css',
		'OEBPS/chapter-1.xhtml',
		'OEBPS/chapter-2.xhtml',
	]);
	const pkg = (await xml(zip, 'OEBPS/content.opf')).package;
	const items = new Map(
		pkg.manifest.item.map((entry: { $: { id: string; href: string } }) => [
			entry.$.id,
			entry.$.href,
		])
	);
	expect(
		pkg.spine.itemref.map((entry: { $: { idref: string } }) => items.get(entry.$.idref))
	).toEqual(['toc.xhtml', 'chapter-1.xhtml', 'chapter-2.xhtml']);
	const nav = (await xml(zip, 'OEBPS/toc.xhtml')).html.body.nav;
	expect(nav.$['epub:type']).toBe('toc');
	expect(
		nav.ol.li.map((entry: { a: { _: string; $: { href: string } } }) => [
			entry.a._,
			entry.a.$.href,
		])
	).toEqual([
		[title, 'chapter-1.xhtml'],
		[title, 'chapter-2.xhtml'],
	]);
	const ncx = (await xml(zip, 'OEBPS/toc.ncx')).ncx;
	expect(
		ncx.navMap.navPoint.map(
			(entry: { content: { $: { src: string } }; navLabel: { text: string } }) => [
				entry.navLabel.text,
				entry.content.$.src,
			]
		)
	).toEqual([
		[title, 'chapter-1.xhtml'],
		[title, 'chapter-2.xhtml'],
	]);
	expect((await xml(zip, 'OEBPS/chapter-1.xhtml')).html.body.p).toBe('First body.');
	expect((await xml(zip, 'OEBPS/chapter-2.xhtml')).html.body.p).toBe('Second body.');
});

test('preserves supported inline styles, notes and heading depth without interpreting manuscript markup', async () => {
	const payload = '<img src="file:///private/file"/><script>throw 1</script>&';
	const text = `BoldItalicUnderlineStrike\n${payload}`;
	const fetch = jest
		.spyOn(globalThis, 'fetch')
		.mockRejectedValue(new Error('Unexpected network access'));
	try {
		const zip = await JSZip.loadAsync(
			await toEpub(
				[
					scene({
						text,
						depth: 2,
						notes: [`Note: ${payload}`],
						formattedText: [
							{ text: 'Bold', style: { bold: true } },
							{ text: 'Italic', style: { italic: true } },
							{ text: 'Underline', style: { underline: true } },
							{ text: 'Strike', style: { strikethrough: true } },
							{ text: `\n${payload}` },
						],
					}),
				],
				metadata
			)
		);
		const content = await read(zip, 'OEBPS/chapter-1.xhtml');
		expect(content).toContain('<h3>Scene</h3>');
		expect(content).toContain('<strong>Bold</strong><em>Italic</em>');
		expect(content).toContain(
			'<span style="text-decoration:underline">Underline</span><s>Strike</s>'
		);
		expect(content).not.toContain('<img');
		expect(content).not.toContain('<script');
		const body = (await xml(zip, 'OEBPS/chapter-1.xhtml')).html.body;
		expect(body.p[1]).toBe(payload);
		expect(body.aside.p).toBe(`Note: ${payload}`);
		expect(await read(zip, 'OEBPS/style.css')).toContain('line-height: 1.5');
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

test.each([4, 5, 6])('caps heading depth %i at the supported XHTML level', async (depth) => {
	const zip = await JSZip.loadAsync(await toEpub([scene({ depth })], metadata));
	const body = (await xml(zip, 'OEBPS/chapter-1.xhtml')).html.body;
	expect(body[`h${Math.min(depth + 1, 6)}`]).toBe('Scene');
});

test.each([-1, 0.5, NaN, Infinity])('rejects invalid heading depth %s', async (depth) => {
	await expect(toEpub([scene({ depth })], metadata)).rejects.toThrow('section depth');
});

test.each([
	{ sections: [] as ExportSection[] },
	{ sections: [scene({ title: 'Empty folder', isFolder: true, text: '' })] },
])('keeps empty and folder-only manuscripts readable', async ({ sections }) => {
	const result = await toEpub(sections, { title: 'Empty book' });
	await expect(validateExport(result, 'epub')).resolves.toContain('spine references');
	const zip = await JSZip.loadAsync(result);
	expect(zip.file(/^OEBPS\/chapter-\d+\.xhtml$/)).toHaveLength(1);
	expect((await xml(zip, 'OEBPS/content.opf')).package.metadata['dc:creator']).toBe('Unknown');
});

test('includes structural folders for presets and retains their heading hierarchy', async () => {
	const sections = [scene({ title: 'Part', isFolder: true, text: '' }), scene({ depth: 1 })];
	const zip = await JSZip.loadAsync(await toEpub(sections, metadata));
	expect((await xml(zip, 'OEBPS/chapter-1.xhtml')).html.body.h1).toBe('Part');
	expect((await xml(zip, 'OEBPS/chapter-2.xhtml')).html.body.h2).toBe('Scene');
});

test.each([
	'\u0000',
	'\u0008',
	'\u000b',
	'\u000c',
	'\u000e',
	'\u001f',
	'\ud800',
	'\udfff',
	'\ufffe',
	'\uffff',
])('rejects XML-invalid text %j before creating an EPUB', async (text) => {
	await expect(toEpub([scene({ text })], metadata)).rejects.toThrow('valid XML characters');
	await expect(toEpub([scene()], { ...metadata, title: text })).rejects.toThrow(
		'valid XML characters'
	);
	await expect(toEpub([scene()], { ...metadata, author: text })).rejects.toThrow(
		'valid XML characters'
	);
});

test('preserves XML character boundaries and multilingual text', async () => {
	const text = '\t\n\r \ud7ff\ue000\ufffd\u{10000}\u{10ffff} cafe\u0301 東京 🌙';
	const result = await toEpub([scene({ text })], metadata);
	await expect(validateExport(result, 'epub')).resolves.toContain('XHTML syntax');
	const zip = await JSZip.loadAsync(result);
	expect(await read(zip, 'OEBPS/chapter-1.xhtml')).toContain(
		'\ud7ff\ue000\ufffd\u{10000}\u{10ffff} cafe\u0301 東京 🌙'
	);
});

test('bounds uncompressed EPUB resources at 128 MiB even when text compresses well', async () => {
	const maximum = 128 * 1024 * 1024;
	const baseline = await JSZip.loadAsync(await toEpub([scene({ text: '' })], metadata));
	const overhead = (
		await Promise.all(
			Object.values(baseline.files).map(
				async (file) => (await file.async('uint8array')).byteLength
			)
		)
	).reduce((sum, length) => sum + length, 0);
	for (const delta of [-1, 0, 1]) {
		const text = 'x'.repeat(maximum - overhead + delta);
		const operation = toEpub([scene({ text })], metadata);
		if (delta <= 0) await expect(operation).resolves.toBeInstanceOf(Buffer);
		else await expect(operation).rejects.toThrow('resources exceed the 128 MiB size limit');
	}
}, 60000);
