import JSZip from 'jszip';
import { prepareUnsignedCredentialArchive } from '../../../src/services/content-credentials/archive-preparation.js';

const MAXIMUM = 128 * 1024 * 1024;
const DATE = new Date('2020-01-01T00:00:00Z');

function file(archive: JSZip, name: string, bytes: Buffer | string): void {
	archive.file(name, bytes, { createFolders: false, date: DATE });
}

function compressionMethods(bytes: Buffer): number[] {
	const end = bytes.length - 22;
	expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
	const count = bytes.readUInt16LE(end + 10);
	let offset = bytes.readUInt32LE(end + 16);
	const methods: number[] = [];
	for (let index = 0; index < count; index++) {
		expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
		methods.push(bytes.readUInt16LE(offset + 10));
		offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
	}
	expect(offset).toBe(end);
	return methods;
}

test('converts DEFLATE entries to STORE while preserving Unicode paths, binary contents and the original buffer', async () => {
	const entries: Array<[string, Buffer]> = [
		['mimetype', Buffer.from('application/epub+zip')],
		['OEBPS/chapters/Café-東京.xhtml', Buffer.from('<p>Crème brûlée 🌙</p>\n'.repeat(40))],
		['OEBPS/images/pixels.bin', Buffer.from([0, 255, 1, 128, 13, 10, 0])],
		['empty.txt', Buffer.alloc(0)],
	];
	const archive = new JSZip();
	for (const [name, bytes] of entries) file(archive, name, bytes);
	const source = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
	const original = Buffer.from(source);
	expect(compressionMethods(source)).toContain(8);
	const prepared = await prepareUnsignedCredentialArchive(source, 64 * 1024);
	expect(source).toEqual(original);
	expect(compressionMethods(prepared)).toEqual(entries.map(() => 0));
	const restored = await JSZip.loadAsync(prepared, { checkCRC32: true });
	expect(Object.keys(restored.files).sort()).toEqual(entries.map(([name]) => name).sort());
	for (const [name, bytes] of entries) expect(await restored.file(name)!.async('nodebuffer')).toEqual(bytes);
});

test.each(['META-INF/content_credential.c2pa', 'history/PREVIOUS.C2PA'])(
	'refuses to repackage an archive containing existing credentials at %s',
	async (name) => {
		const archive = new JSZip();
		file(archive, 'story.txt', 'Manuscript');
		file(archive, name, Buffer.from([1, 2, 3]));
		const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
		const original = Buffer.from(bytes);
		await expect(prepareUnsignedCredentialArchive(bytes, 64 * 1024)).rejects.toThrow(/existing archive credentials/i);
		expect(bytes).toEqual(original);
	}
);

test.each(['../private.txt', 'safe/../../private.txt', '/private.txt', 'safe\\private.txt', 'private\0.txt', 'C:/private.txt', 'C:private.txt'])(
	'rejects unsafe archive entry names, including names sanitized by JSZip: %p',
	async (name) => {
		const archive = new JSZip();
		file(archive, name, 'Private contents');
		const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
		await expect(prepareUnsignedCredentialArchive(bytes, 64 * 1024)).rejects.toThrow(/unsafe entry name/i);
	}
);

test.each([4095, 4096, 4097])('enforces the archive entry boundary with %i real entries', async (count) => {
	const archive = new JSZip();
	for (let index = 0; index < count; index++) file(archive, `entry-${index}.txt`, '');
	const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
	const operation = prepareUnsignedCredentialArchive(bytes, 1024 * 1024);
	if (count > 4096) await expect(operation).rejects.toThrow(/at most 4096 entries/i);
	else {
		const prepared = await operation;
		expect(Object.keys((await JSZip.loadAsync(prepared)).files)).toHaveLength(count);
	}
});

test('rejects an empty ZIP rather than producing a credential-ready container', async () => {
	const bytes = await new JSZip().generateAsync({ type: 'nodebuffer' });
	await expect(prepareUnsignedCredentialArchive(bytes, 1024)).rejects.toThrow(/at most 4096 entries/i);
});

test.each([-1, 0, 1])('checks cumulative expanded bytes at the limit plus %i before considering ZIP overhead', async (delta) => {
	const maximum = 4096;
	const archive = new JSZip();
	file(archive, 'first.txt', Buffer.alloc(maximum / 2, 'a'));
	file(archive, 'second.txt', Buffer.alloc(maximum / 2 + delta, 'b'));
	const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
	expect(bytes.length).toBeLessThan(maximum);
	await expect(prepareUnsignedCredentialArchive(bytes, maximum)).rejects.toThrow(
		delta > 0 ? /expanded credential archive exceeds/i : /prepared credential archive exceeds/i
	);
});

test.each([-1, 0, 1])('enforces the exact prepared ZIP byte length with maximum plus %i', async (delta) => {
	const archive = new JSZip();
	file(archive, 'story.txt', 'A repeated passage.\n'.repeat(100));
	const source = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
	const stored = await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
	const operation = prepareUnsignedCredentialArchive(source, stored.length + delta);
	if (delta < 0) await expect(operation).rejects.toThrow(/prepared credential archive exceeds/i);
	else {
		const prepared = await operation;
		expect(prepared).toHaveLength(stored.length);
		expect(await (await JSZip.loadAsync(prepared)).file('story.txt')!.async('string')).toBe('A repeated passage.\n'.repeat(100));
	}
});

test('validates numeric allocation limits at the supported maximum without allocating a maximum-sized fixture', async () => {
	const archive = new JSZip();
	file(archive, 'story.txt', 'Story');
	const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
	for (const maximum of [MAXIMUM - 1, MAXIMUM]) {
		expect(await prepareUnsignedCredentialArchive(bytes, maximum)).toHaveLength(bytes.length);
	}
	for (const maximum of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, MAXIMUM + 1, bytes.length - 1]) {
		await expect(prepareUnsignedCredentialArchive(bytes, maximum)).rejects.toThrow(/size limit is invalid or exceeded/i);
	}
});
