import { resolveCredentialFormat } from '../../../src/services/content-credentials/formats.js';

describe('Content Credentials format resolution', () => {
	it.each([
		['IMAGE/JPG', 'photo.JPEG', 'image/jpeg'],
		['audio/x-wav', 'sound.WAVE', 'audio/wav'],
		['audio/vnd.wave', 'sound.wav', 'audio/wav'],
		['video/avi', 'clip.AVI', 'video/x-msvideo'],
		['application/x-troff-msvideo', 'clip.avi', 'video/x-msvideo'],
		['application/mp4', 'clip.mp4', 'video/mp4'],
		['audio/x-m4a', 'sound.m4a', 'audio/mp4'],
		[
			'application/docx',
			'story.docx',
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		],
		[
			'application/xlsx',
			'table.xlsx',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		],
		[
			'application/pptx',
			'slides.pptx',
			'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		],
		[
			'application/ppsx',
			'slides.ppsx',
			'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
		],
		['application/odt', 'story.odt', 'application/vnd.oasis.opendocument.text'],
		['application/ods', 'table.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
		['application/odp', 'slides.odp', 'application/vnd.oasis.opendocument.presentation'],
		['application/odg', 'drawing.odg', 'application/vnd.oasis.opendocument.graphics'],
		['application/csv', 'story.csv', 'text/csv'],
		['text/x-csv', 'story.csv', 'text/csv'],
		['text/tsv', 'story.tsv', 'text/tab-separated-values'],
		['text/xml', 'story.xml', 'application/xml'],
		['text/rtf', 'story.rtf', 'application/rtf'],
		['application/javascript', 'script.mjs', 'text/javascript'],
		['text/x-yaml', 'story.yml', 'application/yaml'],
		['model/vnd.pixar.usd', 'triangle.usdz', 'model/vnd.usdz+zip'],
	])('normalizes %s consistently with %s', (mime, file, canonical) => {
		expect(resolveCredentialFormat(mime, file).mimeType).toBe(canonical);
	});

	it('infers real container types and preserves explicit audio-only MP4 without treating all BMFF assets as aliases', () => {
		expect(resolveCredentialFormat(undefined, 'clip.mp4').mimeType).toBe('video/mp4');
		expect(resolveCredentialFormat('audio/mp4', 'sound.mp4').mimeType).toBe('audio/mp4');
		expect(resolveCredentialFormat(undefined, 'sound.opus').mimeType).toBe('audio/ogg');
		expect(resolveCredentialFormat(undefined, 'photo.heic').mimeType).toBe('image/heic');
		expect(resolveCredentialFormat(undefined, 'photo.heif').mimeType).toBe('image/heif');
		for (const [mime, file] of [
			['image/png', 'photo.jpg'],
			['audio/wav', 'clip.avi'],
			['application/docx', 'story.epub'],
			['audio/mp4', 'photo.avif'],
		])
			expect(() => resolveCredentialFormat(mime, file)).toThrow('conflicts');
	});

	it('requires explicit generic detached intent and preserves verified per-format mode constraints', () => {
		for (const file of ['opaque.bin', 'unknown.asset', 'no-extension'])
			expect(() => resolveCredentialFormat(undefined, file)).toThrow('Cannot infer');
		const generic = resolveCredentialFormat('application/octet-stream', 'opaque.bin');
		expect(generic).toMatchObject({
			mimeType: 'application/octet-stream',
			embedded: 'unsupported',
			sidecar: true,
		});
		for (const file of [
			'original.ttf',
			'original.woff',
			'triangle.gltf',
			'triangle.glb',
			'story.ppsx',
			'story.csv',
			'story.tsv',
			'story.xml',
			'story.xhtml',
		])
			expect(resolveCredentialFormat(undefined, file)).toMatchObject({
				embedded: 'unsupported',
				sidecar: true,
			});
		for (const file of ['story.pdf', 'story.docx', 'story.epub', 'sound.mp3', 'sound.flac'])
			expect(resolveCredentialFormat(undefined, file)).toMatchObject({
				embedded: 'supported',
				sidecar: false,
			});
		for (const extension of ['docx', 'epub', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'odg'])
			expect(resolveCredentialFormat(undefined, `story.${extension}`)).toMatchObject({
				embedded: 'supported',
				sidecar: false,
				preparation: 'zip-store',
			});
		for (const file of ['story.txt', 'story.md', 'story.html'])
			expect(resolveCredentialFormat(undefined, file)).toMatchObject({
				category: 'text',
				embedded: 'experimental',
				sidecar: true,
			});
		expect(resolveCredentialFormat(undefined, 'credential.c2pa')).toMatchObject({
			embedded: 'unsupported',
			sidecar: false,
		});
	});

	it('keeps XML, HTML, XHTML and presentation/slideshow media types distinct', () => {
		expect(resolveCredentialFormat(undefined, 'story.xhtml').mimeType).toBe(
			'application/xhtml+xml'
		);
		expect(resolveCredentialFormat(undefined, 'story.html').mimeType).toBe('text/html');
		expect(resolveCredentialFormat(undefined, 'story.xml').mimeType).toBe('application/xml');
		for (const [mime, file] of [
			['text/html', 'story.xhtml'],
			['application/xhtml+xml', 'story.html'],
			['application/pptx', 'slides.ppsx'],
			['application/ppsx', 'slides.pptx'],
		])
			expect(() => resolveCredentialFormat(mime, file)).toThrow('conflicts');
	});

	it('rejects unknown, parameterized, injected and incorrectly typed MIME values without echoing them', () => {
		for (const mime of [
			'',
			' ',
			'image',
			'image/png; charset=utf-8',
			'image/png\r\nX-Test: secret',
			'unknown/example',
		]) {
			const operation = () => resolveCredentialFormat(mime, 'image.png');
			expect(operation).toThrow();
			try {
				operation();
			} catch (error) {
				if (error instanceof Error) expect(error.message).not.toContain('X-Test: secret');
			}
		}
		expect(() => Reflect.apply(resolveCredentialFormat, undefined, [42, 'image.png'])).toThrow(
			'MIME type'
		);
		expect(() =>
			Reflect.apply(resolveCredentialFormat, undefined, ['image/png', null])
		).toThrow('asset path');
	});

	it('enforces MIME length at 254, 255 and 256 characters before lookup', () => {
		for (const length of [254, 255]) {
			const mime = `${'a'.repeat(127)}/${'b'.repeat(length - 128)}`;
			expect(() => resolveCredentialFormat(mime)).toThrow('Unknown');
		}
		expect(() => resolveCredentialFormat(`${'a'.repeat(127)}/${'b'.repeat(128)}`)).toThrow(
			'255'
		);
	});

	it('enforces bounded paths and extensions without requiring filesystem access', () => {
		for (const length of [4095, 4096])
			expect(
				resolveCredentialFormat(undefined, `${'x'.repeat(length - 4)}.png`).mimeType
			).toBe('image/png');
		expect(() => resolveCredentialFormat(undefined, `${'x'.repeat(4093)}.png`)).toThrow('4096');
		expect(() => resolveCredentialFormat('image/png', 'image.png\0secret')).toThrow(
			'null bytes'
		);
		for (const length of [15, 16])
			expect(
				resolveCredentialFormat('image/png', `asset.${'x'.repeat(length)}`).mimeType
			).toBe('image/png');
		expect(() => resolveCredentialFormat('image/png', `asset.${'x'.repeat(17)}`)).toThrow(
			'extension'
		);
	});
});
