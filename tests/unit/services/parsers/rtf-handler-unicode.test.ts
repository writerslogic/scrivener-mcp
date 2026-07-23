/**
 * Regression tests for RTF Unicode handling (\uc fallback tracking).
 * Covers the data-loss bug where the reader assumed \uc1 and dropped the real
 * character following a \u escape in Scrivener files (which use \uc0).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RTFHandler } from '../../../../src/services/parsers/rtf-handler.js';

const FONT = '{\\fonttbl{\\f0 Helvetica;}}';

describe('RTFHandler Unicode (\\uc) handling', () => {
	const handler = new RTFHandler();

	it('honors \\uc0 (Scrivener) and keeps the character after a \\u escape', async () => {
		// Scrivener emits a right single quote with no fallback char, then the
		// real next character. The old skip-1 reader dropped that character.
		const rtf = `{\\rtf1\\ansi\\deff0\\uc0${FONT}\\f0\\fs24 it\\u8217 s done}`;
		const result = await handler.parseRTF(rtf);
		expect(result.plainText).toContain('it’s done');
		expect(result.plainText).not.toContain('?');
	});

	it('honors \\uc1 and strips the single fallback character', async () => {
		const rtf = `{\\rtf1\\ansi\\deff0\\uc1${FONT}\\f0\\fs24 caf\\u233?\\u32?ready}`;
		const result = await handler.parseRTF(rtf);
		expect(result.plainText).toContain('café');
		expect(result.plainText).toContain('ready');
		expect(result.plainText).not.toContain('?');
	});

	it('round-trips BMP Unicode (>= U+0100) through write and read without loss', async () => {
		const text = 'Greek alpha α and Chinese 中 end';
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtf-unicode-'));
		const file = path.join(dir, 'doc.rtf');
		try {
			await handler.writeRTF(file, text);
			const raw = fs.readFileSync(file, 'utf8');
			// Writer must declare \uc1 to match the single '?' fallback it emits.
			expect(raw).toContain('\\uc1');
			const result = await handler.readRTF(file);
			expect(result.plainText).toContain('α');
			expect(result.plainText).toContain('中');
			expect(result.plainText).toContain('Greek alpha');
			expect(result.plainText).toContain('Chinese');
			expect(result.plainText).not.toContain('?');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('strips embedded image data (\\pict/\\shppict) instead of emitting hex as text', async () => {
		// A real Scrivener doc with an inline JPEG: the \pict body is raw hex that
		// must never surface as document text (it also bloated the parser badly).
		const hex = 'ffd8ffe000104a464946'.repeat(50);
		const rtf =
			`{\\rtf1\\ansi\\deff0\\uc0${FONT}\\f0\\fs24 Before image ` +
			`{\\*\\shppict{\\pict\\jpegblip ${hex}}}` +
			` after image}`;
		const result = await handler.parseRTF(rtf);
		expect(result.plainText).toContain('Before image');
		expect(result.plainText).toContain('after image');
		expect(result.plainText).not.toContain('ffd8');
		expect(result.plainText).not.toMatch(/[0-9a-f]{40,}/);
	});
});
