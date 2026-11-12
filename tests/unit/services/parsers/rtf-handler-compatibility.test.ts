import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RTFHandler } from '../../../../src/services/parsers/rtf-handler.js';
import baseline from '../../../fixtures/rtf/parser-baseline.json';

const handler = new RTFHandler();

test.each(baseline)('checks the declared saved-RTF semantics for $file', async (fixture) => {
	const raw = await readFile(resolve(__dirname, '../../../..', fixture.file), 'utf8');
	expect(createHash('sha256').update(raw).digest('hex')).toBe(fixture.sourceSha256);

	const parsed = await handler.parseRTF(raw);
	if (fixture.text !== undefined) {
		expect(parsed.plainText).toBe(fixture.text);
		expect(parsed.formattedText.map((run) => run.text).join('')).toBe(fixture.text);
	} else
		expect(createHash('sha256').update(JSON.stringify(parsed)).digest('hex')).toBe(
			fixture.sha256
		);
});

test.each([
	[String.raw`{\rtf1\ansi\ansicpg1252 caf\'e9}`, 'café'],
	[String.raw`{\rtf1\ansi\ansicpg1251 \u1055?\u1088?}`, 'Пр'],
	[String.raw`{\rtf1\mac\uc0 \u26481\u20140}`, '東京'],
	[String.raw`{\rtf1\ansi\uc0 \u-10179\u-8704}`, '😀'],
	[String.raw`{\rtf1\ansi\uc0 \u55357\u56832}`, '😀'],
	['', ''],
])('preserves supported legacy and Unicode RTF: %p', async (raw, expected) => {
	expect((await handler.parseRTF(raw)).plainText).toBe(expected);
});

test.each([
	String.raw`{\rtf1 \'0}`,
	String.raw`{\rtf1 \'zz}`,
	String.raw`{\rtf1 \bin missing}`,
	String.raw`{\rtf1 \bin-1 invalid}`,
	String.raw`{\rtf1 \bin9007199254740992 invalid}`,
	String.raw`{\rtf1 \u999999999999999999999999999999999999999999999999?}`,
	String.raw`{\rtf1 \uc999999999999999999999999999999999999999999999999 x}`,
	String.raw`{\rtf1 \u missing}`,
	String.raw`{\rtf1 \uc missing}`,
])(
	'rejects invalid controls rather than reporting empty or partial manuscript text: %p',
	async (raw) => {
		await expect(handler.parseRTF(raw)).rejects.toThrow(/RTF/);
		expect(() => handler.extractPlainText(raw)).toThrow(/RTF/);
	}
);

test.each([-32769, -32768, -32767, 65534, 65535, 65536])(
	'validates Unicode code-unit boundary %i',
	async (code) => {
		const reading = handler.parseRTF(`{\\rtf1\\uc0 \\u${code}}`);
		if (code < -32768 || code > 65535)
			await expect(reading).rejects.toThrow('Invalid RTF Unicode code unit');
		else
			expect((await reading).plainText).toBe(
				String.fromCharCode(code < 0 ? code + 65536 : code)
			);
	}
);

test.each([-1, 0, 1, 32766, 32767, 32768])(
	'validates Unicode fallback-length boundary %i',
	async (length) => {
		const reading = handler.parseRTF(
			`{\\rtf1\\uc${length} \\u945${'?'.repeat(Math.max(0, length))}After}`
		);
		if (length < 0 || length > 32767)
			await expect(reading).rejects.toThrow('Invalid RTF Unicode fallback length');
		else expect((await reading).plainText).toBe('αAfter');
	}
);

test.each([-1, 0, 1])('validates embedded binary byte length plus %i', async (delta) => {
	const payload = '{}\\\0';
	const raw = `{\\rtf1{\\pict\\bin${Buffer.byteLength(payload) + delta} ${payload}}Text}`;
	if (delta === 0) expect((await handler.parseRTF(raw)).plainText).toBe('Text');
	else await expect(handler.parseRTF(raw)).rejects.toThrow(/RTF/);
});

test.each([1, 2, 3])('validates UTF-8 binary byte length %i', async (length) => {
	const raw = `{\\rtf1{\\pict\\bin${length} é}Text}`;
	if (length === 2) expect((await handler.parseRTF(raw)).plainText).toBe('Text');
	else await expect(handler.parseRTF(raw)).rejects.toThrow(/RTF/);
});

test('refuses the historical raw-UTF8-in-ANSI sample instead of misreporting native text', async () => {
	const raw = await readFile(
		resolve(__dirname, '../../../fixtures/rtf/unsupported-literal-utf8.rtf'),
		'utf8'
	);
	await expect(handler.parseRTF(raw)).rejects.toThrow(/Unsupported unescaped non-ASCII RTF/);
});
