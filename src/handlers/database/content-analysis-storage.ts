import { gzipSync, gunzipSync } from 'node:zlib';
import { safeParse, safeStringify } from '../../utils/common.js';

export const MAX_CONTENT_ANALYSIS_BYTES = 64 * 1024 * 1024;
const COMPRESS_AT_BYTES = 4096;
const STORAGE_PREFIX = 'scrivener-mcp:analysis:';
const GZIP_PREFIX = `${STORAGE_PREFIX}gzip:1:`;
const INVALID_JSON = Symbol('invalid content analysis');

export function encodeContentAnalysis(value: unknown): string {
	const json = safeStringify(value);
	if (typeof json !== 'string' || !json) throw new Error('Content analysis is not serializable');
	const bytes = Buffer.byteLength(json);
	if (bytes > MAX_CONTENT_ANALYSIS_BYTES) throw new Error('Content analysis exceeds 64 MiB');
	if (bytes < COMPRESS_AT_BYTES) return json;
	const compressed = gzipSync(json, {
		maxOutputLength: MAX_CONTENT_ANALYSIS_BYTES + 1024 * 1024,
	});
	const encoded = GZIP_PREFIX + compressed.toString('base64');
	return encoded.length < bytes ? encoded : json;
}

export function decodeContentAnalysis(
	stored: string | Buffer,
	maxBytes = MAX_CONTENT_ANALYSIS_BYTES
): { value: unknown; bytes: number } {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONTENT_ANALYSIS_BYTES)
		throw new Error('Content analysis decoding budget is invalid');
	if (
		(typeof stored !== 'string' && !Buffer.isBuffer(stored)) ||
		Buffer.byteLength(stored) > MAX_CONTENT_ANALYSIS_BYTES
	)
		throw new Error('Stored content analysis exceeds 64 MiB or has an invalid type');
	try {
		const decoder = new TextDecoder('utf-8', { fatal: true });
		let json = typeof stored === 'string' ? stored : decoder.decode(stored);
		if (json.startsWith(STORAGE_PREFIX)) {
			if (!json.startsWith(GZIP_PREFIX))
				throw new Error('Unsupported content analysis encoding');
			const encoded = json.slice(GZIP_PREFIX.length);
			if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
				throw new Error('Invalid content analysis encoding');
			const compressed = Buffer.from(encoded, 'base64');
			if (compressed.toString('base64') !== encoded)
				throw new Error('Invalid content analysis encoding');
			json = decoder.decode(gunzipSync(compressed, { maxOutputLength: maxBytes }));
		}
		const bytes = Buffer.byteLength(json);
		if (bytes > maxBytes) throw new Error('Content analysis decoding budget exceeded');
		const value = safeParse<unknown>(json, INVALID_JSON);
		if (value === INVALID_JSON) throw new Error('Invalid content analysis JSON');
		return { value, bytes };
	} catch {
		throw new Error(
			'Stored content analysis is corrupt, unsupported, or exceeds the decoding budget'
		);
	}
}
