import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { ProjectExporter } from '../../../src/services/project-exporter.js';
import { CompilationService } from '../../../src/services/compilation-service.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import { validateExport } from '../../../src/services/export/export-presets.js';
import type { CompileMetadata } from '../../../src/services/compile-settings.js';
import type { ScrivenerDocument } from '../../../src/types/index.js';

const DRAFT = '10000000-0000-4000-8000-000000000001';
const CHAPTER = '10000000-0000-4000-8000-000000000002';
const FIRST = '10000000-0000-4000-8000-000000000003';
const SECOND = '10000000-0000-4000-8000-000000000004';
const EXCLUDED = '10000000-0000-4000-8000-000000000005';
const RESEARCH = '10000000-0000-4000-8000-000000000006';
const FRONT = '10000000-0000-4000-8000-000000000007';
let root: string;
let projectPath: string;
let raw: Map<string, string>;
let exporter: ProjectExporter;

function item(
	id: string,
	title: string,
	properties: Partial<ScrivenerDocument> = {}
): ScrivenerDocument {
	return { id, title, type: 'Text', path: title, ...properties };
}
function rtf(text: string): string {
	return `{\\rtf1\\ansi{\\fonttbl{\\f0 Times New Roman;}}\\f0 ${text}}`;
}
async function xml(zip: JSZip, name: string): Promise<string> {
	const file = zip.file(name);
	if (!file) throw new Error(`Expected archive resource ${name}`);
	return file.async('string');
}
function attributes(xmlText: string, element: string): Record<string, string> {
	const match = new RegExp(`<${element}\\b([^>]*)>`).exec(xmlText);
	if (!match) throw new Error(`Expected XML element ${element}`);
	return Object.fromEntries(
		[...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((attribute) => [
			attribute[1],
			attribute[2],
		])
	);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'scrivener-export-presets-'));
	projectPath = join(root, 'Fictional-Unicode.scriv');
	await mkdir(projectPath);
	raw = new Map([
		[FIRST, rtf('First scene: {\\b bold} and {\\i italic} at the harbor.')],
		[SECOND, rtf('Second scene: the lantern returns.')],
		[EXCLUDED, rtf('Excluded rough draft material.')],
		[RESEARCH, rtf('PRIVATE RESEARCH MUST STAY OUT.')],
		[FRONT, rtf('A dedication for beta readers.')],
	]);
	const draft = item(DRAFT, 'Manuscript', {
		type: 'Folder',
		children: [
			item(CHAPTER, 'Chapter One', {
				type: 'Folder',
				sectionTypeId: 'chapter',
				children: [
					item(FIRST, 'First Scene', { sectionTypeId: 'scene' }),
					item(SECOND, 'Second Scene', { sectionTypeId: 'scene' }),
					item(EXCLUDED, 'Rough draft', { includeInCompile: false }),
				],
			}),
		],
	});
	(draft as { type: string }).type = 'DraftFolder';
	const structure = [
		draft,
		item(RESEARCH, 'Research notes'),
		item(FRONT, 'Dedication', { includeInCompile: false }),
	];
	const taxonomy: CompileMetadata = {
		hasCompileSettings: true,
		compileFormats: [],
		sectionTypes: [
			{ id: 'chapter', name: 'Chapter' },
			{ id: 'scene', name: 'Scene' },
		],
		labels: [],
		statuses: [],
		collections: [],
	};
	const parser = new RTFHandler();
	exporter = new ProjectExporter(
		new CompilationService(),
		async () => structure,
		async () => ({ title: 'Lantern — café', author: 'A. Writer' }),
		async (id) => (await parser.parseRTF(raw.get(id) ?? '')).plainText,
		projectPath,
		async (id) => raw.get(id) ?? '',
		async () => taxonomy
	);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it('writes submission DOCX with 12pt Times New Roman, double spacing, one-inch margins and page numbering', async () => {
	const result = await exporter.exportPreset({ preset: 'submission-manuscript' });
	const buffer = await readFile(result.path as string);
	const zip = await JSZip.loadAsync(buffer);
	const document = await xml(zip, 'word/document.xml');
	const styles = await xml(zip, 'word/styles.xml');
	expect(attributes(styles, 'w:rFonts')).toMatchObject({ 'w:ascii': 'Times New Roman' });
	expect(attributes(styles, 'w:sz')).toMatchObject({ 'w:val': '24' });
	expect(attributes(styles, 'w:spacing')).toMatchObject({ 'w:line': '480', 'w:after': '0' });
	expect(attributes(document, 'w:pgMar')).toMatchObject({
		'w:top': '1440',
		'w:bottom': '1440',
		'w:left': '1440',
		'w:right': '1440',
	});
	const footers = zip.file(/^word\/footer\d+\.xml$/);
	expect(footers.length).toBeGreaterThan(0);
	expect((await Promise.all(footers.map((file) => file.async('string')))).join('')).toMatch(
		/\bPAGE\b/
	);
	expect(document).toContain('w:pageBreakBefore');
	expect(await validateExport(buffer, 'docx')).toContain('styles XML');
});

it('keeps beta-reader front matter and scenes in scope and binder order while preserving supported style runs', async () => {
	const options = {
		preset: 'beta-reader' as const,
		documentIds: [SECOND, FIRST],
		frontMatterIds: [FRONT],
	};
	const preflight = await exporter.preflight(options);
	expect(preflight.ready).toBe(true);
	expect(preflight.documentIds).toEqual([FRONT, FIRST, SECOND]);
	const result = await exporter.exportPreset(options);
	const zip = await JSZip.loadAsync(await readFile(result.path as string));
	const document = await xml(zip, 'word/document.xml');
	expect(document.indexOf('A dedication for beta readers.')).toBeLessThan(
		document.indexOf('First scene:')
	);
	expect(document.indexOf('Chapter One')).toBeLessThan(document.indexOf('First scene:'));
	expect(document.indexOf('First scene:')).toBeLessThan(document.indexOf('Second scene:'));
	expect(document).not.toContain('PRIVATE RESEARCH');
	expect(document).not.toContain('Excluded rough draft');
	expect(document).toMatch(
		/<w:r>\s*<w:rPr>\s*<w:b\b[^>]*\/>[\s\S]*?<w:t[^>]*>bold<\/w:t>\s*<\/w:r>/
	);
	expect(document).toMatch(
		/<w:r>\s*<w:rPr>\s*<w:i\b[^>]*\/>[\s\S]*?<w:t[^>]*>italic<\/w:t>\s*<\/w:r>/
	);
});

it('preflights unsupported constructs before requiring explicit warning acknowledgment', async () => {
	raw.set(
		FIRST,
		rtf('A scene. {\\pict\\pngblip 89504e47}{\\footnote Native anchored footnote.}')
	);
	const before = raw.get(FIRST);
	const preflight = await exporter.preflight({ preset: 'beta-reader' });
	expect(preflight.findings.map((finding) => finding.code)).toEqual(
		expect.arrayContaining(['embedded-media', 'native-footnote'])
	);
	expect(preflight.ready).toBe(false);
	await expect(exporter.exportPreset({ preset: 'beta-reader' })).rejects.toThrow(/preflight/);
	expect(raw.get(FIRST)).toBe(before);
	const accepted = await exporter.exportPreset({ preset: 'beta-reader', allowWarnings: true });
	expect(accepted.findings).toEqual(
		expect.arrayContaining([expect.objectContaining({ code: 'embedded-media' })])
	);
	expect((await readFile(accepted.path as string)).subarray(0, 2).toString()).toBe('PK');
});

it('places supported note markers after their scene and excludes editorial annotations unless requested', async () => {
	raw.set(
		FIRST,
		rtf(
			'Scene body. {\\Scrv_fn\\id1}A source note.{\\Scrv_fn_end}{\\Scrv_annot\\id2}EDITOR ONLY QUESTION{\\Scrv_annot_end}'
		)
	);
	const preflight = await exporter.preflight({ preset: 'beta-reader' });
	expect(preflight.findings.some((finding) => finding.code === 'note-placement')).toBe(true);
	const defaultResult = await exporter.exportPreset({
		preset: 'beta-reader',
		allowWarnings: true,
	});
	const defaultXml = await xml(
		await JSZip.loadAsync(await readFile(defaultResult.path as string)),
		'word/document.xml'
	);
	expect(defaultXml).toContain('Note: A source note.');
	expect(defaultXml).not.toContain('EDITOR ONLY QUESTION');
	expect(defaultXml.indexOf('Note: A source note.')).toBeGreaterThan(
		defaultXml.indexOf('Scene body.')
	);
	expect(defaultXml.indexOf('Note: A source note.')).toBeLessThan(
		defaultXml.indexOf('Second scene:')
	);
	const included = await exporter.exportPreset({
		preset: 'beta-reader',
		includeAnnotations: true,
		allowWarnings: true,
	});
	const includedXml = await xml(
		await JSZip.loadAsync(await readFile(included.path as string)),
		'word/document.xml'
	);
	expect(includedXml).toContain('Editorial annotation: EDITOR ONLY QUESTION');
	expect(includedXml.match(/EDITOR ONLY QUESTION/g)).toHaveLength(1);
});

it('generates an ebook with valid archive resources, ordered spine and escaped styled text', async () => {
	const result = await exporter.exportPreset({ preset: 'ebook' });
	const buffer = await readFile(result.path as string);
	const checks = await validateExport(buffer, 'epub');
	expect(checks).toEqual(
		expect.arrayContaining([
			'first stored mimetype',
			'manifest resources',
			'spine references',
			'XHTML syntax',
		])
	);
	const zip = await JSZip.loadAsync(buffer);
	const chapters = await Promise.all(zip.file(/\.xhtml$/).map((file) => file.async('string')));
	const prose = chapters.find((chapter) => chapter.includes('First scene:'));
	expect(prose).toContain('<strong>bold</strong>');
	expect(prose).toContain('<em>italic</em>');
	expect(chapters.join('')).not.toContain('PRIVATE RESEARCH');
});

it('refuses manuscript destinations and unknown or excluded requested documents without altering source files', async () => {
	const sourceDir = join(projectPath, 'Files', 'Data', FIRST);
	await mkdir(sourceDir, { recursive: true });
	const sourceFile = join(sourceDir, 'content.rtf');
	await writeFile(sourceFile, raw.get(FIRST)!);
	await expect(
		exporter.exportPreset({ preset: 'beta-reader' }, join(sourceDir, 'manuscript.docx'))
	).rejects.toThrow(/Scrivener project|exports/);
	expect(await readFile(sourceFile, 'utf8')).toBe(raw.get(FIRST));
	expect(await readdir(sourceDir)).toEqual(['content.rtf']);
	await expect(
		exporter.preflight({ preset: 'beta-reader', documentIds: [RESEARCH] })
	).rejects.toThrow(/unknown or excluded/);
	await expect(
		exporter.preflight({ preset: 'beta-reader', documentIds: [EXCLUDED] })
	).rejects.toThrow(/unknown or excluded/);
});

it.each(['inside-export-directory', 'external-alias'])(
	'rejects a %s directory symlink into manuscript storage',
	async (kind) => {
		const sourceDir = join(projectPath, 'Files', 'Data', FIRST);
		await mkdir(sourceDir, { recursive: true });
		const sourceFile = join(sourceDir, 'content.rtf');
		await writeFile(sourceFile, raw.get(FIRST)!);
		const alias =
			kind === 'inside-export-directory'
				? join(projectPath, '.scrivener-mcp', 'exports')
				: join(root, 'export-alias');
		if (kind === 'inside-export-directory')
			await mkdir(join(projectPath, '.scrivener-mcp'), { recursive: true });
		await symlink(sourceDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
		await expect(
			exporter.exportPreset({ preset: 'beta-reader' }, join(alias, 'manuscript.docx'))
		).rejects.toThrow(/symlink|Scrivener project|exports|manuscript/i);
		expect(await readFile(sourceFile, 'utf8')).toBe(raw.get(FIRST));
		expect(await readdir(sourceDir)).toEqual(['content.rtf']);
	}
);

const PACKAGE =
	'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture</dc:title></metadata><manifest><item id="scene" href="scene.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="scene"/></spine></package>';
async function minimalEpub(change: (zip: JSZip) => void): Promise<Buffer> {
	const zip = new JSZip();
	zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
	zip.file(
		'META-INF/container.xml',
		'<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
		{ createFolders: false }
	);
	zip.file('OEBPS/content.opf', PACKAGE, { createFolders: false });
	zip.file(
		'OEBPS/scene.xhtml',
		'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Scene</title></head><body><p>Readable scene</p></body></html>',
		{ createFolders: false }
	);
	change(zip);
	return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}
const damagedCases: Array<[string, (zip: JSZip) => void, RegExp]> = [
	[
		'missing resource',
		(zip) => {
			zip.remove('OEBPS/scene.xhtml');
		},
		/missing/,
	],
	[
		'unknown spine reference',
		(zip) => {
			zip.file('OEBPS/content.opf', PACKAGE.replace('idref="scene"', 'idref="missing"'));
		},
		/spine/,
	],
	[
		'malformed XHTML',
		(zip) => {
			zip.file('OEBPS/scene.xhtml', '<html><p>Unclosed</html>');
		},
		/Unexpected close|Unclosed|mismatch/i,
	],
	[
		'wrong mimetype',
		(zip) => {
			zip.file('mimetype', 'application/zip');
		},
		/mimetype/,
	],
	[
		'unsafe package path',
		(zip) => {
			zip.file(
				'META-INF/container.xml',
				'<container><rootfiles><rootfile full-path="../outside.opf"/></rootfiles></container>'
			);
		},
		/package location/,
	],
];
it.each(damagedCases)('rejects an ebook with %s', async (_name, mutate, error) => {
	await expect(validateExport(await minimalEpub(mutate), 'epub')).rejects.toThrow(error);
});
it('rejects damaged ZIP data even when the EPUB resource names remain intact', async () => {
	const buffer = await minimalEpub(() => undefined);
	expect(await validateExport(buffer, 'epub')).toContain('ZIP CRC');
	const offset = buffer.indexOf('Readable scene');
	expect(offset).toBeGreaterThan(0);
	buffer[offset] ^= 1;
	await expect(validateExport(buffer, 'epub')).rejects.toThrow(/CRC/i);
});
