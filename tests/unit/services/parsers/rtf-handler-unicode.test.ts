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

describe('RTF text control and Unicode scope round trips', () => {
	const handler = new RTFHandler();

	it('keeps the default Unicode fallback outside the first nested override', async () => {
		const raw = `{\\rtf1\\ansi${FONT}\\f0 before {\\uc0 alpha \\u945 } caf\\u233? after}`;
		expect((await handler.parseRTF(raw)).plainText).toBe('before alpha α café after');
	});

	it('restores outer Unicode fallback width after a nested local override', async () => {
		const raw = `{\\rtf1\\ansi\\uc1${FONT}\\f0 before {\\uc0 alpha \\u945 } caf\\u233? after}`;
		expect((await handler.parseRTF(raw)).plainText).toBe('before alpha α café after');
	});

	it('preserves quotes, tabs, dashes, combining marks and astral text through the existing serializer', async () => {
		const text = 'Mara\'s "promise"\tcafé — 東京 🌙 Żółć.\nA second paragraph.';
		expect((await handler.parseRTF(handler.convertToRTF(text))).plainText).toBe(text);
	});
});

describe('RTFHandler plain text objects', () => {
	it('saves the plainText used by DocumentManager when there are no formatted segments', async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rtf-plain-object-'));
		const file = path.join(dir, 'content.rtf');
		const handler = new RTFHandler();
		const text = '한글 본문과 {중괄호} 및 \\ 기호\n\n두 번째 문단';
		try {
			await handler.writeRTF(file, { plainText: text, formattedText: [], metadata: {} });
			expect((await handler.readRTF(file)).plainText.trim()).toBe(text);
			await handler.writeRTF(file, {
				plainText: 'bold',
				formattedText: [{ text: 'bold', style: { bold: true } }],
			});
			expect(await fs.promises.readFile(file, 'utf8')).toContain('\\b ');
			expect((await handler.readRTF(file)).plainText.trim()).toBe('bold');
			await handler.writeRTF(file, { plainText: '', formattedText: [] });
			expect((await handler.readRTF(file)).plainText.trim()).toBe('');
		} finally {
			expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
			expect(path.basename(dir)).toMatch(/^rtf-plain-object-/);
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
