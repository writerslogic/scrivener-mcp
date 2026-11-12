import { spawnSync } from 'node:child_process';
import { RTFHandler } from '../../../../src/services/parsers/rtf-handler.js';
import { scanRawText, spliceRtfText } from '../../../../src/services/parsers/rtf-splice.js';

const parser = new RTFHandler();
const nativeTest = process.platform === 'darwin' ? test : test.skip;
const corpus = [
	'"Hello", she said. It\'s done.',
	'“Hello,” she said. ‘It’s done.’',
	'\t  Leading and trailing \u00a0 \n\n',
	'Café € Œ œ — 東京 😀 e\u0301',
	'{braces} \\slash\tTab\nParagraph\r\nCRLF',
	'Before\u2028soft line\fpage break',
];

function native(raw: string, format = 'txt'): string {
	const result = spawnSync('/usr/bin/textutil', ['-convert', format, '-stdin', '-stdout'], {
		input: raw,
		encoding: 'utf8',
	});
	if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
	return result.stdout;
}

test.each(corpus)('keeps exact code points and aligned runs: %p', async (text) => {
	const raw = parser.convertToRTF(text);
	const parsed = await parser.parseRTF(raw);
	expect(parsed.plainText).toBe(text);
	expect(parsed.formattedText.map((run) => run.text).join('')).toBe(text);
	expect(scanRawText(raw).text).toBe(text);
});
nativeTest.each(corpus)('independent Cocoa reader sees exact serialized text: %p', (text) => {
	expect(native(parser.convertToRTF(text))).toBe(text);
});

const encoded = String.raw`{\rtf1\ansi\ansicpg1252 \'80\'91\'92\'93\'94\'96\'97\'a0\'8c\'9c}`;
test('decodes Windows-1252 rather than Unicode control code points', async () => {
	expect((await parser.parseRTF(encoded)).plainText).toBe('€‘’“”–—\u00a0Œœ');
});
nativeTest('independent CP1252 decoding agrees with the expected code points', () => {
	expect(native(encoded)).toBe('€‘’“”–—\u00a0Œœ');
});

const nested = String.raw`{\rtf1\ansi\b bold {\i both} bold\par}`;
test('restores enclosing styles and preserves terminal paragraph in the same text coordinate space', async () => {
	const parsed = await parser.parseRTF(nested);
	expect(parsed).toMatchObject({
		plainText: 'bold both bold\n',
		formattedText: [
			{ text: 'bold ', style: { bold: true } },
			{ text: 'both', style: { bold: true, italic: true } },
			{ text: ' bold\n', style: { bold: true } },
		],
	});
});
nativeTest('native style oracle retains the bold parent around nested italic', () => {
	expect(native(nested, 'html')).toContain('<b>bold </b><b><i>both</i></b><b> bold</b>');
});

test('ignores raw layout newlines but reads escaped Cocoa line breaks and NBSP', async () => {
	expect((await parser.parseRTF('{\\rtf1\\ansi a\nb\\\nc\\~d}')).plainText).toBe('ab\nc\u00a0d');
});
test('consumes Unicode fallback controls as one unit and restores scoped fallback lengths', async () => {
	const raw = String.raw`{\rtf1\ansi\uc1 \u945\~{\uc0 \u946}\u947\'3fX}`;
	expect((await parser.parseRTF(raw)).plainText).toBe('αβγX');
	expect(scanRawText(raw).text).toBe('αβγX');
});
const structuralText = [
	[String.raw`{\rtf1\ansi{\listtext\tab 1.\tab}Alpha\par Beta}`, 'Alpha\nBeta'],
	[String.raw`{\rtf1\ansi{\pntext\tab 1.\tab}Alpha\par Beta}`, 'Alpha\nBeta'],
	[String.raw`{\rtf1\ansi A\line B\page C}`, 'A\u2028B\fC'],
	[
		String.raw`{\rtf1\ansi\trowd\cellx1000\cellx2000\intbl A\cell B\cell\row\pard End}`,
		'A\nB\nEnd',
	],
	[
		String.raw`{\rtf1\ansi\trowd\cellx1000\cellx2000\intbl A\par\cell\cell\row\pard End}`,
		'A\n\n\nEnd',
	],
];
test.each(structuralText)(
	'keeps native text coordinates for structural RTF: %p',
	async (raw, expected) => {
		expect((await parser.parseRTF(raw)).plainText).toBe(expected);
		expect(scanRawText(raw).text).toBe(expected);
	}
);
nativeTest.each(structuralText)(
	'native Cocoa independently verifies structural text: %p',
	(raw, expected) => {
		expect(native(raw)).toBe(expected);
	}
);
test('preserves generated list labels outside an edited text span', () => {
	const label = String.raw`{\listtext\tab 1.\tab}`;
	const raw = String.raw`{\rtf1\ansi ` + label + 'Alpha}';
	const result = spliceRtfText(raw, 'Alpha', 'Bravo');
	expect(result?.rtf).toContain(label);
	expect(scanRawText(result!.rtf).text).toBe('Bravo');
});
test.each(['\ud800', '\udfff'])(
	'refuses unpaired surrogates before a preserving splice: %p',
	(text) => {
		expect(() => spliceRtfText(String.raw`{\rtf1 old}`, 'old', text)).toThrow(
			'unpaired Unicode surrogate'
		);
	}
);
test.each([
	String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0}`,
	String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset204 Times;}}\f0 \'c0}`,
	String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset2 Symbol;}}\f0 a}`,
	'{\\rtf1\\ansi Unescaped café}',
	String.raw`{\rtf1 A\sect B}`,
	String.raw`{\rtf1\itap2 nested\nestcell}`,
])('refuses unsupported or ambiguous byte encodings before exposing content: %p', async (raw) => {
	await expect(parser.parseRTF(raw)).rejects.toThrow(/Unsupported.*RTF/);
	expect(() => scanRawText(raw)).toThrow(/Unsupported.*RTF/);
});

test('preserves boundary whitespace and opaque bytes through a local splice', async () => {
	const opaque = String.raw`{\*\Scrv_meta retain this}{\pict\pngblip 00}`;
	const raw = String.raw`{\rtf1\ansi  \'93old\'94 ` + opaque + String.raw`\par}`;
	const before = ' “old” \n';
	const after = ' “new” \n';
	const spliced = spliceRtfText(raw, before, after);
	expect(spliced).not.toBeNull();
	expect(spliced!.rtf).toContain(opaque);
	expect(spliced!.rtf).toContain(String.raw`\'93`);
	expect(spliced!.rtf).toContain(String.raw`\'94`);
	expect((await parser.parseRTF(spliced!.rtf)).plainText).toBe(after);
});

test('metadata preserves Unicode escapes and punctuation without truncating fields', async () => {
	const metadata = {
		title: '"Café" 東京',
		author: "A. O'Brien",
		subject: 'Notes {draft}',
		keywords: '“harbor”',
	};
	const parsed = await parser.parseRTF(
		parser.convertToRTF({ plainText: 'Text', formattedText: [], metadata })
	);
	expect(parsed.metadata).toEqual(metadata);
});
const inheritedMetadata = String.raw`{\rtf1\ansi\uc0{\info{\title \u26481\u20140!}{\author \uc2 \u945??B}}Body}`;
test('metadata inherits header Unicode fallback state and restores field scope', async () => {
	const parsed = await parser.parseRTF(inheritedMetadata);
	expect(parsed.metadata).toMatchObject({ title: '東京!', author: 'αB' });
	expect(parsed.plainText).toBe('Body');
});
nativeTest('Cocoa independently confirms inherited metadata code points', () => {
	const result = spawnSync('/usr/bin/textutil', ['-info', '-stdin'], {
		input: inheritedMetadata,
		encoding: 'utf8',
	});
	if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
	expect(result.stdout).toContain('Title:  東京!');
	expect(result.stdout).toContain('Author:  αB');
});
test('metadata refuses unsupported inherited code pages instead of guessing CP1252', async () => {
	await expect(
		parser.parseRTF(String.raw`{\rtf1\ansi\ansicpg1251{\info{\title \'c0}}Body}`)
	).rejects.toThrow('Unsupported RTF byte encoding 1251');
});
test.each(['different', 'Text ', ' Text', 'Text\n'])(
	'refuses formatted text inconsistent with the canonical preimage: %p',
	(plainText) => {
		expect(() => parser.convertToRTF({ plainText, formattedText: [{ text: 'Text' }] })).toThrow(
			'Formatted RTF spans must concatenate to the exact plainText'
		);
	}
);
test.each(['synopsis', 'notes', 'creationDate', 'modificationDate'] as const)(
	'refuses unsupported metadata instead of silently discarding %s',
	(key) => {
		expect(() =>
			parser.convertToRTF({
				plainText: 'Text',
				formattedText: [],
				metadata: {
					[key]: key.endsWith('Date') ? new Date('2026-01-01T00:00:00Z') : 'Keep this',
				},
			})
		).toThrow(`RTF serialization does not support metadata ${key}`);
	}
);
test('escapes metadata line breaks and tabs instead of dropping them as RTF layout', async () => {
	const metadata = { title: 'First\nSecond\tTab\rReturn' };
	expect(
		(
			await parser.parseRTF(
				parser.convertToRTF({ plainText: 'Text', formattedText: [], metadata })
			)
		).metadata
	).toEqual(metadata);
});
test.each([0, 0.5, 1, 16383, 16383.5, 16384])(
	'validates and preserves font size %p',
	async (fontSize) => {
		const encode = () =>
			parser.convertToRTF({
				plainText: 'Text',
				formattedText: [{ text: 'Text', style: { fontSize } }],
			});
		if (fontSize < 0.5 || fontSize > 16383.5) expect(encode).toThrow(/font size/);
		else
			expect((await parser.parseRTF(encode())).formattedText[0].style?.fontSize).toBe(
				fontSize
			);
	}
);
test('refuses unsupported requested style properties before serializing', () => {
	expect(() =>
		parser.convertToRTF({
			plainText: 'Text',
			formattedText: [{ text: 'Text', style: { color: 'red' } }],
		})
	).toThrow(/does not support color/);
});

test('restores explicit numeric style toggles and default character style', async () => {
	const parsed = await parser.parseRTF(String.raw`{\rtf1\b1 A{\b0 B}C\plain D}`);
	expect(parsed.formattedText).toEqual([
		{ text: 'A', style: { bold: true } },
		{ text: 'B', style: { bold: false } },
		{ text: 'C', style: { bold: true } },
		{ text: 'D', style: undefined },
	]);
});
test.each([String.raw`\cpg1252\fcharset204`, String.raw`\fcharset204\cpg1252`])(
	'explicit font codepage overrides charset independent of property order: %s',
	async (properties) => {
		const raw = `{\\rtf1\\ansi{\\fonttbl{\\f0${properties} Times;}}\\f0 \\'93Text\\'94}`;
		expect((await parser.parseRTF(raw)).plainText).toBe('“Text”');
	}
);
test('refuses unsupported alternate Unicode representations rather than returning their fallback', async () => {
	await expect(
		parser.parseRTF(String.raw`{\rtf1{\upr{fallback}{\*\ud Unicode}}}`)
	).rejects.toThrow(/Unsupported RTF alternate/);
});

test.each(['\ud800', '\udfff', 'before \ud800 after'])(
	'rejects unpaired Unicode surrogates before writing: %p',
	(text) => {
		expect(() => parser.convertToRTF(text)).toThrow(/unpaired Unicode surrogate/);
	}
);
