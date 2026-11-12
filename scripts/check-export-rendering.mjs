import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values } = parseArgs({
	options: { repository: { type: 'string' }, output: { type: 'string' } },
});
const repository = resolve(
	values.repository ?? join(dirname(fileURLToPath(import.meta.url)), '..')
);
assert(values.output, 'Supply --output for the hash-only evidence report');
assert.equal(process.platform, 'darwin', 'The independent DOCX reader requires macOS Cocoa');
const chrome = [
	process.env.CHROME_BIN,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((file) => file && existsSync(file));
assert(chrome, 'Set CHROME_BIN to a Chromium executable');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sections = [
	{ title: 'French', text: '  Bonjour.\n\n', language: 'fr-CA', depth: 0, isFolder: false },
	{ title: 'Japanese', text: 'こんにちは。\n', language: 'ja', depth: 0, isFolder: false },
	{
		title: 'Nested styles',
		text: ' Bold both bold\n\n',
		language: 'fr',
		depth: 0,
		isFolder: false,
		formattedText: [
			{ text: ' Bold ', style: { bold: true } },
			{ text: 'both', style: { bold: true, italic: true } },
			{ text: ' bold\n\n', style: { bold: true } },
		],
	},
	{
		title: 'Decorations',
		text: 'souligné rayé',
		language: 'fr',
		depth: 0,
		isFolder: false,
		formattedText: [
			{ text: 'souligné', style: { underline: true } },
			{ text: ' rayé', style: { strikethrough: true } },
		],
	},
];
const meta = { title: 'Original CC0 export rendering fixture', language: 'fr-CA' };
const { toDocx, toEpub } = await import(
	pathToFileURL(join(repository, 'dist/services/export/manuscript-exporters.js'))
);
const workspace = await mkdtemp(join(tmpdir(), 'scrivener-export-rendering-'));
let server;
let timeout;
const nativeSource = String.raw`#import <AppKit/AppKit.h>
int main(int argc, const char **argv) { @autoreleasepool {
  NSError *error = nil;
  NSAttributedString *value = [[NSAttributedString alloc] initWithURL:[NSURL fileURLWithPath:@(argv[1])]
    options:@{NSDocumentTypeDocumentOption:NSOfficeOpenXMLTextDocumentType} documentAttributes:nil error:&error];
  if (!value) { fprintf(stderr, "%s\n", error.localizedDescription.UTF8String); return 1; }
  NSMutableArray *runs = [NSMutableArray array];
  [value enumerateAttributesInRange:NSMakeRange(0, value.length) options:0 usingBlock:^(NSDictionary *a, NSRange r, BOOL *stop) {
    NSFont *font = a[NSFontAttributeName];
    NSFontTraitMask traits = font ? [[NSFontManager sharedFontManager] traitsOfFont:font] : 0;
    [runs addObject:@{@"start":@(r.location), @"length":@(r.length), @"bold":@((BOOL)((traits & NSBoldFontMask) != 0)),
      @"italic":@((BOOL)((traits & NSItalicFontMask) != 0)), @"underline":@((BOOL)([a[NSUnderlineStyleAttributeName] integerValue] != 0)),
      @"strikethrough":@((BOOL)([a[NSStrikethroughStyleAttributeName] integerValue] != 0)),
      @"language":a[NSLanguageIdentifierAttributeName] ?: [NSNull null]}];
  }];
  NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"text":value.string, @"runs":runs} options:0 error:&error];
  if (!json) return 2;
  fwrite(json.bytes, 1, json.length, stdout);
} return 0; }`;
try {
	const docx = await toDocx(sections, { ...meta, preset: 'beta-reader' });
	const epub = await toEpub(sections, { ...meta, preset: 'ebook' });
	await writeFile(join(workspace, 'fixture.docx'), docx);
	await writeFile(join(workspace, 'fixture.epub'), epub);
	await writeFile(join(workspace, 'reader.m'), nativeSource);
	await execute(
		'/usr/bin/clang',
		[
			'-fobjc-arc',
			'-fblocks',
			'-framework',
			'AppKit',
			join(workspace, 'reader.m'),
			'-o',
			join(workspace, 'reader'),
		],
		{ timeout: 30_000, maxBuffer: 1024 * 1024 }
	);
	const native = JSON.parse(
		(
			await execute(join(workspace, 'reader'), [join(workspace, 'fixture.docx')], {
				timeout: 15_000,
				maxBuffer: 1024 * 1024,
			})
		).stdout
	);
	const expected =
		meta.title + '\n' + sections.map((s) => s.title + '\n' + s.text + '\n').join('');
	assert.equal(native.text, expected, 'Cocoa DOCX text differs, including terminal paragraphs');
	const nativeStyles = [];
	const nativeLanguages = [];
	for (const section of sections) {
		let offset = native.text.indexOf(section.title + '\n') + section.title.length + 1;
		assert(offset > section.title.length, 'Native section heading missing');
		for (const run of section.formattedText ?? [{ text: section.text }]) {
			for (let index = 0; index < run.text.length; index++) {
				if (run.text[index] === '\n') continue;
				const observed = native.runs.find(
					(r) => r.start <= offset + index && r.start + r.length > offset + index
				);
				assert(observed, 'Native style run missing');
				for (const key of ['bold', 'italic', 'underline', 'strikethrough'])
					assert.equal(observed[key], !!run.style?.[key], `Cocoa ${key} differs`);
				nativeStyles.push({
					offset: offset + index,
					bold: observed.bold,
					italic: observed.italic,
					underline: observed.underline,
					strikethrough: observed.strikethrough,
				});
				if (index === 0)
					nativeLanguages.push({ expected: section.language, actual: observed.language });
			}
			offset += run.text.length;
		}
	}
	await execute(
		'/usr/bin/unzip',
		['-q', join(workspace, 'fixture.epub'), '-d', join(workspace, 'epub')],
		{ timeout: 10_000 }
	);
	let complete;
	const browserResult = new Promise((done, reject) => {
		complete = done;
		timeout = setTimeout(() => reject(new Error('Chromium rendering timed out')), 30_000);
	});
	const host = `<!doctype html><meta charset="utf-8"><title>Independent EPUB resource render</title><style>iframe{width:550px;height:360px;border:1px solid #aaa;margin:8px}</style>${sections.map((_, i) => `<iframe src="/book/OEBPS/chapter-${i + 1}.xhtml"></iframe>`).join('')}<script>
window.addEventListener('load', async () => {
 try {
  const pages=[...document.querySelectorAll('iframe')].map(frame=>{
   const doc=frame.contentDocument, view=frame.contentWindow, paragraphs=[...doc.querySelectorAll('body > p')];
   const runs=[];
   for(const p of paragraphs){const walker=doc.createTreeWalker(p,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){
    const css=view.getComputedStyle(node.parentElement), decoration=[];for(let el=node.parentElement;el&&el!==doc.body;el=el.parentElement)decoration.push(view.getComputedStyle(el).textDecorationLine);
    const range=doc.createRange();range.selectNodeContents(node);const box=range.getBoundingClientRect();
    runs.push({text:node.textContent,bold:parseInt(css.fontWeight)>=600,italic:css.fontStyle==='italic',underline:decoration.some(v=>v.includes('underline')),strikethrough:decoration.some(v=>v.includes('line-through')),width:box.width,height:box.height});
   }}
   return {text:paragraphs.map(p=>p.textContent).join('\\n'),language:doc.documentElement.lang,xmlLanguage:doc.documentElement.getAttributeNS('http://www.w3.org/XML/1998/namespace','lang'),runs,paragraphs:paragraphs.map(p=>({empty:p.textContent==='',height:p.getBoundingClientRect().height,fontSize:parseFloat(view.getComputedStyle(p).fontSize),whiteSpace:view.getComputedStyle(p).whiteSpace}))};
  });
  const opf=new DOMParser().parseFromString(await(await fetch('/book/OEBPS/content.opf')).text(),'application/xml');
  if(opf.querySelector('parsererror'))throw Error('Browser rejected OPF XML');
  const languages=[...opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/','language')].map(n=>n.textContent);
  await fetch('/done',{method:'POST',body:JSON.stringify({pages,languages})});
 }catch(error){await fetch('/done',{method:'POST',body:JSON.stringify({error:error.message})});}
});</script>`;
	server = createServer(async (request, response) => {
		try {
			if (request.url === '/done' && request.method === 'POST') {
				const chunks = [];
				let bytes = 0;
				for await (const chunk of request) {
					bytes += chunk.length;
					assert(bytes < 128 * 1024);
					chunks.push(chunk);
				}
				complete(JSON.parse(Buffer.concat(chunks).toString()));
				response.end('ok');
				return;
			}
			if (request.url === '/') {
				response.setHeader('Content-Type', 'text/html; charset=utf-8');
				response.end(host);
				return;
			}
			assert(
				/^\/book\/OEBPS\/(chapter-\d+\.xhtml|style\.css|content\.opf)$/.test(request.url)
			);
			response.setHeader(
				'Content-Type',
				request.url.endsWith('.css')
					? 'text/css'
					: request.url.endsWith('.xhtml')
						? 'application/xhtml+xml'
						: 'application/xml'
			);
			response.end(
				await readFile(join(workspace, 'epub', request.url.slice('/book/'.length)))
			);
		} catch {
			response.statusCode = 400;
			response.end('Invalid fixture request');
		}
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const screenshot = join(workspace, 'render.png');
	const [, rendered] = await Promise.all([
		execute(
			chrome,
			[
				'--headless',
				'--disable-gpu',
				'--no-first-run',
				'--no-default-browser-check',
				`--user-data-dir=${join(workspace, 'chrome')}`,
				'--window-size=1200,900',
				'--virtual-time-budget=3000',
				`--screenshot=${screenshot}`,
				`http://127.0.0.1:${server.address().port}/`,
			],
			{ timeout: 30_000, maxBuffer: 1024 * 1024 }
		),
		browserResult,
	]);
	assert(!rendered.error, rendered.error);
	assert.equal(rendered.pages.length, sections.length);
	const pages = rendered.pages.map((page, index) => {
		const section = sections[index];
		assert.equal(
			page.text,
			section.text,
			'Browser text differs, including boundary whitespace'
		);
		assert.equal(page.language, section.language);
		assert.equal(page.xmlLanguage, section.language);
		assert(page.paragraphs.every((p) => p.whiteSpace === 'pre-wrap'));
		assert(
			page.paragraphs.every((p) => !p.empty || p.height >= p.fontSize),
			'Empty EPUB paragraph collapses below one em'
		);
		assert(
			page.runs.every((run) => run.width > 0 && run.height > 0),
			'Rendered glyph range has no layout'
		);
		const expectedStyles = (section.formattedText ?? [{ text: section.text }]).flatMap((run) =>
			[...run.text]
				.filter((c) => c !== '\n')
				.map(() =>
					Object.fromEntries(
						['bold', 'italic', 'underline', 'strikethrough'].map((key) => [
							key,
							!!run.style?.[key],
						])
					)
				)
		);
		const observedStyles = page.runs.flatMap((run) =>
			[...run.text].map(() =>
				Object.fromEntries(
					['bold', 'italic', 'underline', 'strikethrough'].map((key) => [key, run[key]])
				)
			)
		);
		assert.deepEqual(observedStyles, expectedStyles, 'Browser computed styles differ');
		return {
			textSha256: hash(page.text),
			utf16Length: page.text.length,
			language: page.language,
			stylesSha256: hash(JSON.stringify(observedStyles)),
			paragraphs: page.paragraphs,
		};
	});
	assert.deepEqual(rendered.languages.sort(), ['fr', 'fr-CA', 'ja']);
	const report = {
		runtime: {
			node: process.version,
			platform: process.platform,
			release: release(),
			chrome: (await execute(chrome, ['--version'])).stdout.trim(),
		},
		fixtureSha256: hash(JSON.stringify({ sections, meta })),
		artifacts: {
			docxSha256: hash(docx),
			epubSha256: hash(epub),
			screenshotSha256: hash(await readFile(screenshot)),
			exporterSha256: hash(
				await readFile(join(repository, 'dist/services/export/manuscript-exporters.js'))
			),
			epubWriterSha256: hash(
				await readFile(join(repository, 'dist/services/export/epub.js'))
			),
		},
		docx: {
			reader: 'macOS Cocoa NSAttributedString Office Open XML importer',
			textExact: true,
			textSha256: hash(native.text),
			utf16Length: native.text.length,
			stylesExact: true,
			stylesSha256: hash(JSON.stringify(nativeStyles)),
			languageObservations: nativeLanguages,
		},
		epub: {
			reader: 'Chromium native XHTML/CSS layout; system unzip extraction',
			pages,
			languages: rendered.languages,
		},
		limitations: [
			'Synthetic original CC0 fixtures only; no Word, Pages or commercial EPUB reading-system qualification.',
			'Chromium renders unmodified EPUB resources; this does not test a full EPUB reader navigation/pagination engine.',
			'DOCX source language declarations are verified only when the Cocoa importer exposes a language attribute.',
			'Empty EPUB paragraph layout heights are reported separately; exact DOM text reconstruction does not certify visual blank-line spacing.',
		],
	};
	for (const observed of nativeLanguages)
		if (observed.actual !== null)
			assert.equal(observed.actual, observed.expected, 'Cocoa imported a different language');
	await mkdir(dirname(resolve(values.output)), { recursive: true });
	await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
	console.log(
		JSON.stringify({
			docxTextExact: true,
			docxStylesExact: true,
			docxLanguageExposed: nativeLanguages.some((row) => row.actual !== null),
			epubPagesExact: pages.length,
			emptyParagraphHeights: pages.flatMap((page) =>
				page.paragraphs.filter((p) => p.empty).map((p) => p.height)
			),
		})
	);
} finally {
	clearTimeout(timeout);
	if (server) await new Promise((done) => server.close(done));
	await rm(workspace, { recursive: true, force: true });
}
