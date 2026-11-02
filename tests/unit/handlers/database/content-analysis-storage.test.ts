import { gzipSync, gunzipSync } from 'node:zlib';
import {
	decodeContentAnalysis,
	encodeContentAnalysis,
	MAX_CONTENT_ANALYSIS_BYTES,
} from '../../../../src/handlers/database/content-analysis-storage.js';

const PREFIX = 'scrivener-mcp:analysis:gzip:1:';

describe('content analysis storage encoding', () => {
	it('preserves literal encoding markers in both legacy and newly encoded JSON values', () => {
		const value = PREFIX + 'x'.repeat(5000);
		expect(decodeContentAnalysis(JSON.stringify(value)).value).toBe(value);
		expect(decodeContentAnalysis(encodeContentAnalysis(value)).value).toBe(value);
	});
	it.each([4095, 4096, 4097])(
		'preserves the payload at the %i-byte compression boundary',
		(bytes) => {
			const value = 'x'.repeat(bytes - 2);
			const encoded = encodeContentAnalysis(value);
			expect(encoded.startsWith(PREFIX)).toBe(bytes >= 4096);
			const decoded = decodeContentAnalysis(encoded);
			expect(decoded.bytes).toBe(bytes);
			expect(decoded.value).toBe(value);
			if (bytes >= 4096)
				expect(
					gunzipSync(Buffer.from(encoded.slice(PREFIX.length), 'base64')).toString('utf8')
				).toBe(JSON.stringify(value));
		}
	);
	it.each([-1, 0, 1])(
		'bounds serialized inputs and decoded output at 64 MiB plus %i',
		(delta) => {
			const bytes = MAX_CONTENT_ANALYSIS_BYTES + delta;
			const value = 'x'.repeat(bytes - 2);
			if (delta > 0) {
				expect(() => encodeContentAnalysis(value)).toThrow(/exceeds 64 MiB/);
				const oversized = PREFIX + gzipSync(JSON.stringify(value)).toString('base64');
				expect(() => decodeContentAnalysis(oversized)).toThrow(/decoding budget/);
			} else {
				const encoded = encodeContentAnalysis(value);
				const decoded = decodeContentAnalysis(encoded);
				expect(decoded.bytes).toBe(bytes);
				expect((decoded.value as string).length).toBe(bytes - 2);
			}
		}
	);
	it.each([999, 1000, 1001])('enforces remaining aggregate capacity of %i bytes', (maxBytes) => {
		const raw = JSON.stringify('x'.repeat(998));
		const encoded = PREFIX + gzipSync(raw).toString('base64');
		if (maxBytes < 1000)
			expect(() => decodeContentAnalysis(encoded, maxBytes)).toThrow(/budget/);
		else expect(decodeContentAnalysis(encoded, maxBytes).bytes).toBe(1000);
	});
	it.each([0, -1, 1.5, MAX_CONTENT_ANALYSIS_BYTES + 1])(
		'rejects an invalid decode budget %i',
		(limit) => {
			expect(() => decodeContentAnalysis('0', limit)).toThrow(/budget/);
		}
	);
	it('rejects corrupt, unsupported and invalid UTF-8 data without exposing its contents', () => {
		const valid = gzipSync('{"private":"PRIVATE_VALUE"}');
		const values = [
			'{"private":"PRIVATE_VALUE"',
			`${PREFIX}!!!!`,
			`${PREFIX}eA`,
			`${PREFIX}${valid.subarray(0, -2).toString('base64')}`,
			`${PREFIX}${gzipSync(Buffer.from([0xff, 0xfe])).toString('base64')}`,
			'scrivener-mcp:analysis:gzip:2:unsupported',
		];
		for (const value of values) {
			try {
				decodeContentAnalysis(value);
				throw new Error('Expected decoding rejection');
			} catch (error) {
				expect((error as Error).message).toMatch(/corrupt, unsupported, or exceeds/);
				expect((error as Error).message).not.toContain('PRIVATE_VALUE');
			}
		}
	});
});
