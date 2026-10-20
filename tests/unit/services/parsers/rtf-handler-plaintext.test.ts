import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RTFHandler } from '../../../../src/services/parsers/rtf-handler.js';

describe('RTFHandler plain text objects', () => {
	it('saves the plainText used by DocumentManager when there are no formatted segments', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rtf-plain-object-'));
		const file = path.join(dir, 'content.rtf');
		const handler = new RTFHandler();
		const text = '한글 본문과 {중괄호} 및 \\ 기호\n\n두 번째 문단';
		try {
			await handler.writeRTF(file, { plainText: text, formattedText: [], metadata: {} });
			expect((await handler.readRTF(file)).plainText.trim()).toBe(text);
			await handler.writeRTF(file, {
				plainText: 'fallback',
				formattedText: [{ text: 'bold', style: { bold: true } }],
			});
			expect(await fs.readFile(file, 'utf8')).toContain('\\b ');
			expect((await handler.readRTF(file)).plainText.trim()).toBe('bold');
			await handler.writeRTF(file, { plainText: '', formattedText: [] });
			expect((await handler.readRTF(file)).plainText.trim()).toBe('');
		} finally {
			expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
			expect(path.basename(dir)).toMatch(/^rtf-plain-object-/);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
