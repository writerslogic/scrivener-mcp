import { isStructurallyValidRtf } from '../../../../src/services/parsers/rtf-validation.js';
import { RTFHandler } from '../../../../src/services/parsers/rtf-handler.js';

test.each([
	String.raw`{\rtf1 A {\b nested {\i styles}} Z}`,
	String.raw`{\rtf1 Escaped \{braces\} and \\backslashes}`,
	String.raw`{\rtf1 Hex \'7b braces \'7d and \u233?}`,
	String.raw`{\rtf1{\*\private escaped \} and {nested}} Body}`,
	'\uFEFF \r\n' + String.raw`{\rtf1 Text}` + '\r\n',
])('accepts complete RTF with correctly escaped and nested structure: %p', (raw) => {
	expect(isStructurallyValidRtf(raw)).toBe(true);
});

test.each([
	String.raw`{\rtf1 A {\b nested} Z`,
	String.raw`{\rtf1 Text}}`,
	String.raw`{\rtf1 A}{\rtf1 B}`,
	String.raw`{\rtf1 Text} trailing`,
	String.raw`{\rtf1 \'0}`,
	String.raw`{\rtf1 \'zz}`,
	String.raw`{\rtf1 \bin missing}`,
	String.raw`{\rtf1 \bin-1 invalid}`,
	String.raw`{\rtf1 \bin9007199254740992 invalid}`,
	String.raw`{\rtf1 Text` + '\\',
	'{\\rtf1 Unescaped\0control}',
])('rejects malformed structure before it can be accepted as preserved: %p', (raw) => {
	expect(isStructurallyValidRtf(raw)).toBe(false);
});

test.each([-1, 0, 1])('counts binary bytes independently of brace and escape syntax at length plus %i', (delta) => {
	const payload = '{}\\\0';
	const raw = `{\\rtf1{\\pict\\bin${Buffer.byteLength(payload) + delta} ${payload}}Text}`;
	expect(isStructurallyValidRtf(raw)).toBe(delta === 0);
});

test.each([1, 2, 3])('respects UTF-8 source byte boundaries for a binary length of %i', (length) => {
	const raw = `{\\rtf1{\\pict\\bin${length} é}Text}`;
	expect(isStructurallyValidRtf(raw)).toBe(length === 2);
});

test('reads a valid minimal RTF document without discarding its body as a header', async () => {
	expect((await new RTFHandler().parseRTF(String.raw`{\rtf1\ansi Entire body}`)).plainText)
		.toBe('Entire body');
});
