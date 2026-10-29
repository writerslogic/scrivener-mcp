#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

async function command(program, args, env = process.env, input) {
	try {
		const pending = execute(program, args, { env, timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true });
		let inputFailed = false;
		pending.child.stdin.on('error', () => { inputFailed = true; });
		pending.child.stdin.end(input);
		const result = await pending;
		if (inputFailed) throw new Error('Fixture command input failed');
		return result;
	} catch (error) {
		throw new Error(error.code === 'ENOENT' ? `${program} is required on PATH` : `${program} failed to generate a synthetic fixture`);
	}
}

export async function createC2paTestSigner(directory) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	assert.deepEqual(await readdir(directory), [], 'Test signer directory must be empty');
	const password = randomBytes(32).toString('base64url');
	const env = { ...process.env, C2PA_FIXTURE_PASSPHRASE: password };
	const rootKey = join(directory, 'test-root-key.encrypted.pem');
	const privateKeyPath = join(directory, 'test-leaf-key.encrypted.pem');
	const trustAnchorsPath = join(directory, 'test-root.pem');
	const leaf = join(directory, 'test-leaf.pem');
	const certificatePath = join(directory, 'test-chain.pem');
	const rootConfig = join(directory, 'root.cnf');
	const leafConfig = join(directory, 'leaf.cnf');
	await writeFile(rootConfig, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Scrivener MCP TEST ROOT - NOT PUBLICLY TRUSTED\n[ca]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n`, { flag: 'wx', mode: 0o600 });
	await writeFile(leafConfig, `basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=emailProtection\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`, { flag: 'wx', mode: 0o600 });
	for (const key of [rootKey, privateKeyPath]) {
		await command('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-aes-256-cbc', '-pass', 'env:C2PA_FIXTURE_PASSPHRASE', '-out', key], env);
		await chmod(key, 0o600);
		const info = await stat(key);
		assert.ok(info.size > 0 && info.size <= 16 * 1024, 'Encrypted test key exceeds its size limit');
		if (!/^-----BEGIN ENCRYPTED PRIVATE KEY-----\r?\n/.test(await readFile(key, 'utf8')))
			throw new Error('OpenSSL must write an encrypted PKCS8 test key');
	}
	// OpenSSL 3.6 can prompt despite passin; transient DER avoids its encrypted-PEM UI loader.
	const certificateCommand = async (args, keyPath) => {
		const key = createPrivateKey({ key: await readFile(keyPath), passphrase: password });
		const der = key.export({ format: 'der', type: 'pkcs8' });
		try { await command('openssl', args, env, der); }
		finally { der.fill(0); }
	};
	await certificateCommand(['req', '-batch', '-new', '-x509', '-key', '-', '-keyform', 'DER', '-config', rootConfig, '-set_serial', '1', '-days', '2', '-sha256', '-out', trustAnchorsPath], rootKey);
	const request = join(directory, 'test-leaf.csr');
	await certificateCommand(['req', '-batch', '-new', '-key', '-', '-keyform', 'DER', '-subj', '/CN=Scrivener MCP Synthetic Fixture Signer - TEST ONLY', '-sha256', '-out', request], privateKeyPath);
	await certificateCommand(['x509', '-req', '-in', request, '-CA', trustAnchorsPath, '-CAkey', '-', '-CAkeyform', 'DER', '-set_serial', '2', '-days', '1', '-sha256', '-extfile', leafConfig, '-out', leaf], rootKey);
	await writeFile(certificatePath, Buffer.concat([await readFile(leaf), await readFile(trustAnchorsPath)]), { flag: 'wx', mode: 0o600 });
	return { certificatePath, privateKeyPath, password, trustAnchorsPath };
}

function crc32(buffer) {
	let value = 0xffffffff;
	for (const byte of buffer) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
	}
	return (value ^ 0xffffffff) >>> 0;
}

function png() {
	const chunk = (name, data) => {
		const type = Buffer.from(name);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
		return Buffer.concat([length, type, data, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(16, 0);
	header.writeUInt32BE(16, 4);
	header[8] = 8;
	header[9] = 6;
	const rows = Buffer.alloc(16 * (1 + 16 * 4));
	for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
		const offset = y * 65 + 1 + x * 4;
		rows.set([x * 16, y * 16, 128, 255], offset);
	}
	return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function wav() {
	const samples = 800;
	const result = Buffer.alloc(44 + samples * 2);
	result.write('RIFF', 0);
	result.writeUInt32LE(result.length - 8, 4);
	result.write('WAVEfmt ', 8);
	result.writeUInt32LE(16, 16);
	result.writeUInt16LE(1, 20);
	result.writeUInt16LE(1, 22);
	result.writeUInt32LE(8000, 24);
	result.writeUInt32LE(16000, 28);
	result.writeUInt16LE(2, 32);
	result.writeUInt16LE(16, 34);
	result.write('data', 36);
	result.writeUInt32LE(samples * 2, 40);
	for (let index = 0; index < samples; index++) result.writeInt16LE(Math.round(Math.sin(index * Math.PI / 20) * 1024), 44 + index * 2);
	return result;
}

function originalFonts() {
	const tables = new Map();
	const head = Buffer.alloc(54);
	head.writeUInt32BE(0x00010000, 0);
	head.writeUInt32BE(0x00010000, 4);
	head.writeUInt32BE(0x5f0f3cf5, 12);
	head.writeUInt16BE(1000, 18);
	head.writeUInt16BE(8, 46);
	head.writeInt16BE(2, 48);
	tables.set('head', head);
	const hhea = Buffer.alloc(36);
	hhea.writeUInt32BE(0x00010000, 0);
	hhea.writeInt16BE(800, 4);
	hhea.writeInt16BE(-200, 6);
	hhea.writeUInt16BE(500, 10);
	hhea.writeInt16BE(500, 14);
	hhea.writeInt16BE(1, 18);
	hhea.writeUInt16BE(2, 34);
	tables.set('hhea', hhea);
	const maxp = Buffer.alloc(32);
	maxp.writeUInt32BE(0x00010000, 0);
	maxp.writeUInt16BE(2, 4);
	maxp.writeUInt16BE(1, 14);
	tables.set('maxp', maxp);
	const hmtx = Buffer.alloc(8);
	hmtx.writeUInt16BE(500, 0);
	hmtx.writeUInt16BE(500, 4);
	tables.set('hmtx', hmtx);
	const loca = Buffer.alloc(6);
	loca.writeUInt16BE(6, 2);
	loca.writeUInt16BE(12, 4);
	tables.set('loca', loca);
	tables.set('glyf', Buffer.alloc(24));
	const cmap = Buffer.alloc(44);
	cmap.writeUInt16BE(1, 2);
	cmap.writeUInt16BE(3, 4);
	cmap.writeUInt16BE(1, 6);
	cmap.writeUInt32BE(12, 8);
	cmap.writeUInt16BE(4, 12);
	cmap.writeUInt16BE(32, 14);
	cmap.writeUInt16BE(4, 18);
	cmap.writeUInt16BE(4, 20);
	cmap.writeUInt16BE(1, 22);
	cmap.writeUInt16BE(32, 26);
	cmap.writeUInt16BE(0xffff, 28);
	cmap.writeUInt16BE(32, 32);
	cmap.writeUInt16BE(0xffff, 34);
	cmap.writeInt16BE(-31, 36);
	cmap.writeUInt16BE(1, 38);
	tables.set('cmap', cmap);
	const os2 = Buffer.alloc(78);
	os2.writeInt16BE(500, 2);
	os2.writeUInt16BE(400, 4);
	os2.writeUInt16BE(5, 6);
	os2.write('CC0 ', 58);
	os2.writeUInt16BE(0x40, 62);
	os2.writeUInt16BE(32, 64);
	os2.writeUInt16BE(32, 66);
	os2.writeInt16BE(800, 68);
	os2.writeInt16BE(-200, 70);
	os2.writeUInt16BE(800, 74);
	os2.writeUInt16BE(200, 76);
	tables.set('OS/2', os2);
	const names = [[1, 'Original CC0 Fixture'], [2, 'Regular'], [4, 'Original CC0 Fixture Regular'], [6, 'CC0Fixture-Regular']];
	const strings = names.map(([, value]) => Buffer.from(value, 'utf16le').swap16());
	const name = Buffer.alloc(6 + names.length * 12);
	name.writeUInt16BE(names.length, 2);
	name.writeUInt16BE(name.length, 4);
	let stringOffset = 0;
	names.forEach(([id], index) => {
		const offset = 6 + index * 12;
		[3, 1, 0x0409, id, strings[index].length, stringOffset].forEach((value, field) => name.writeUInt16BE(value, offset + field * 2));
		stringOffset += strings[index].length;
	});
	tables.set('name', Buffer.concat([name, ...strings]));
	const post = Buffer.alloc(32);
	post.writeUInt32BE(0x00030000, 0);
	tables.set('post', post);
	const checksum = (bytes) => {
		const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
		bytes.copy(padded);
		let result = 0;
		for (let index = 0; index < padded.length; index += 4) result = (result + padded.readUInt32BE(index)) >>> 0;
		return result;
	};
	const entries = [...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([tag, bytes]) => ({ tag, bytes, checksum: checksum(bytes) }));
	const directory = Buffer.alloc(12 + entries.length * 16);
	directory.writeUInt32BE(0x00010000, 0);
	directory.writeUInt16BE(entries.length, 4);
	directory.writeUInt16BE(128, 6);
	directory.writeUInt16BE(3, 8);
	directory.writeUInt16BE(entries.length * 16 - 128, 10);
	let offset = directory.length;
	const parts = [directory];
	entries.forEach((entry, index) => {
		entry.offset = offset;
		const row = 12 + index * 16;
		directory.write(entry.tag, row);
		directory.writeUInt32BE(entry.checksum, row + 4);
		directory.writeUInt32BE(offset, row + 8);
		directory.writeUInt32BE(entry.bytes.length, row + 12);
		const padded = Buffer.alloc(Math.ceil(entry.bytes.length / 4) * 4);
		entry.bytes.copy(padded);
		parts.push(padded);
		offset += padded.length;
	});
	const ttf = Buffer.concat(parts);
	ttf.writeUInt32BE((0xb1b0afba - checksum(ttf)) >>> 0, entries.find((entry) => entry.tag === 'head').offset + 8);
	const woffHeader = Buffer.alloc(44 + entries.length * 20);
	woffHeader.write('wOFF', 0);
	woffHeader.writeUInt32BE(0x00010000, 4);
	woffHeader.writeUInt16BE(entries.length, 12);
	woffHeader.writeUInt32BE(ttf.length, 16);
	woffHeader.writeUInt16BE(1, 20);
	offset = woffHeader.length;
	const compressedTables = [];
	entries.forEach((entry, index) => {
		const bytes = ttf.subarray(entry.offset, entry.offset + entry.bytes.length);
		const compressed = deflateSync(bytes);
		const stored = compressed.length < bytes.length ? compressed : bytes;
		const row = 44 + index * 20;
		woffHeader.write(entry.tag, row);
		[ offset, stored.length, bytes.length, entry.checksum ].forEach((value, field) => woffHeader.writeUInt32BE(value, row + 4 + field * 4));
		const padded = Buffer.alloc(Math.ceil(stored.length / 4) * 4);
		stored.copy(padded);
		compressedTables.push(padded);
		offset += padded.length;
	});
	woffHeader.writeUInt32BE(offset, 8);
	return { ttf, woff: Buffer.concat([woffHeader, ...compressedTables]) };
}

function triangle(binary = false) {
	const geometry = Buffer.alloc(44);
	[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => geometry.writeFloatLE(value, index * 4));
	[0, 1, 2].forEach((value, index) => geometry.writeUInt16LE(value, 36 + index * 2));
	const definition = {
		asset: { version: '2.0', generator: 'Original CC0 Scrivener MCP fixture' },
		buffers: [{ byteLength: 42, ...(binary ? {} : { uri: `data:application/octet-stream;base64,${geometry.subarray(0, 42).toString('base64')}` }) }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
		nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
	};
	if (!binary) return Buffer.from(JSON.stringify(definition));
	const encoded = Buffer.from(JSON.stringify(definition));
	const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
	encoded.copy(json);
	const header = Buffer.alloc(20);
	header.write('glTF', 0);
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(28 + json.length + geometry.length, 8);
	header.writeUInt32LE(json.length, 12);
	header.writeUInt32LE(0x4e4f534a, 16);
	const binHeader = Buffer.alloc(8);
	binHeader.writeUInt32LE(geometry.length, 0);
	binHeader.writeUInt32LE(0x004e4942, 4);
	return Buffer.concat([header, json, binHeader, geometry]);
}

export async function createC2paFixtures(outputDirectory) {
	const stage = await mkdtemp(join(tmpdir(), 'c2pa-assets-'));
	const envNames = ['SCRIVENER_LOCAL_ONLY', 'SCRIVENER_DISABLE_KEY_DISCOVERY', 'SCRIVENER_DATA_DIR'];
	const priorEnv = new Map(envNames.map((name) => [name, process.env[name]]));
	const fixtures = [];
	const unavailable = [];
	const save = async (file, mimeType, bytes, source = 'Node builtins; original synthetic CC0 content') => {
		assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024, 'Fixture exceeds one MiB');
		await writeFile(join(stage, file), bytes, { mode: 0o644 });
		fixtures.push({ file, mimeType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source });
	};
	try {
		await save('image.png', 'image/png', png());
		await save('sound.wav', 'audio/wav', wav());
		const fonts = originalFonts();
		await save('original.ttf', 'font/ttf', fonts.ttf);
		await save('original.woff', 'font/woff', fonts.woff);
		await save('drawing.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#7155a0"/><circle cx="8" cy="8" r="4" fill="#ffffff"/></svg>'));
		for (const [file, mime, text] of [
			['story.txt', 'text/plain', 'Original CC0 fixture: Café — 東京 😀. A lantern shone.\n'],
			['story.md', 'text/markdown', '# Original CC0 story\n\nA lantern shone.\n'],
			['story.html', 'text/html', '<!doctype html><html lang="en"><meta charset="utf-8"><title>Original CC0 story</title><p>A lantern shone.</p></html>\n'],
			['story.json', 'application/json', '{"license":"CC0-1.0","story":"A lantern shone."}\n'],
			['triangle.obj', 'model/obj', '# Original CC0 triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'],
			['triangle.stl', 'model/stl', 'solid original_cc0\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid original_cc0\n'],
		]) await save(file, mime, Buffer.from(text));
		await save('triangle.gltf', 'model/gltf+json', triangle());
		await save('triangle.glb', 'model/gltf-binary', triangle(true));
		await save('opaque.bin', 'application/octet-stream', Buffer.from('Original CC0 opaque fixture\0\x01\x02\x03'));
		const ffmpeg = (await command('ffmpeg', ['-version'])).stdout.split(/\r?\n/, 1)[0];
		const media = [
			['image.jpg', 'image/jpeg', ['-i', join(stage, 'image.png'), '-frames:v', '1']],
			['image.gif', 'image/gif', ['-i', join(stage, 'image.png'), '-frames:v', '1']],
			['image.tiff', 'image/tiff', ['-i', join(stage, 'image.png'), '-frames:v', '1']],
			['image.webp', 'image/webp', ['-i', join(stage, 'image.png'), '-frames:v', '1', '-c:v', 'libwebp']],
			['image.bmp', 'image/bmp', ['-i', join(stage, 'image.png'), '-frames:v', '1']],
			['image.avif', 'image/avif', ['-i', join(stage, 'image.png'), '-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1']],
			['image.jxl', 'image/jxl', ['-i', join(stage, 'image.png'), '-frames:v', '1', '-c:v', 'libjxl']],
			...['mp4', 'mov', 'avi'].map((extension) => [`clip.${extension}`, extension === 'mov' ? 'video/quicktime' : extension === 'avi' ? 'video/x-msvideo' : 'video/mp4', ['-f', 'lavfi', '-i', 'color=c=0x7155a0:s=16x16:r=5', '-t', '0.2', '-an', '-c:v', 'mpeg4']]),
			['clip.webm', 'video/webm', ['-f', 'lavfi', '-i', 'color=c=0x7155a0:s=16x16:r=5', '-t', '0.2', '-an', '-c:v', 'libvpx-vp9']],
			['clip.mkv', 'video/x-matroska', ['-f', 'lavfi', '-i', 'color=c=0x7155a0:s=16x16:r=5', '-t', '0.2', '-an', '-c:v', 'ffv1']],
			...[
				['sound.flac', 'audio/flac', 'flac'], ['sound.mp3', 'audio/mpeg', 'libmp3lame'],
				['sound.m4a', 'audio/mp4', 'aac'], ['sound.aac', 'audio/aac', 'aac'],
				['sound.ogg', 'audio/ogg', 'libvorbis'], ['sound.opus', 'audio/ogg', 'libopus'],
				['sound.aiff', 'audio/aiff', 'pcm_s16be'],
			].map(([file, mime, codec]) => [file, mime, ['-i', join(stage, 'sound.wav'), '-c:a', codec]]),
		];
		for (const [file, mime, args] of media) {
			try {
				await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-threads', '1', join(stage, file)]);
				await save(file, mime, await readFile(join(stage, file)), ffmpeg);
			} catch {
				unavailable.push({ file, mimeType: mime, reason: 'Installed ffmpeg could not encode this optional fixture' });
			}
		}
		Object.assign(process.env, { SCRIVENER_LOCAL_ONLY: 'true', SCRIVENER_DISABLE_KEY_DISCOVERY: '1', SCRIVENER_DATA_DIR: stage });
		const exporters = await import(pathToFileURL(join(ROOT, 'dist/services/export/manuscript-exporters.js')).href);
		const { validateExport } = await import(pathToFileURL(join(ROOT, 'dist/services/export/export-presets.js')).href);
		const sections = [{ title: 'Original CC0 chapter', text: 'A lantern shone.\nAn original synthetic fixture for content credential tests.', depth: 0, isFolder: false, sectionType: 'chapter' }];
		for (const [format, mime, fn, preset] of [
			['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'toDocx', 'submission-manuscript'],
			['epub', 'application/epub+zip', 'toEpub', 'ebook'], ['pdf', 'application/pdf', 'toPdf', 'beta-reader'],
		]) {
			const bytes = await exporters[fn](sections, { title: 'Original CC0 fixture', author: 'Scrivener MCP contributors', preset });
			await validateExport(bytes, format);
			await save(`story.${format}`, mime, bytes, 'Existing public manuscript exporter; original synthetic CC0 text');
		}
		await mkdir(outputDirectory, { recursive: true });
		for (const fixture of fixtures) await copyFile(join(stage, fixture.file), join(outputDirectory, fixture.file));
		const index = { schemaVersion: 1, license: 'CC0-1.0', generator: 'scripts/create-c2pa-fixtures.mjs', fixtures, unavailable };
		await writeFile(join(outputDirectory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
		return index;
	} finally {
		for (const [name, value] of priorEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'Use optional --output <directory>');
	const output = resolve(process.argv[3] ?? join(ROOT, 'tests/fixtures/c2pa'));
	const index = await createC2paFixtures(output);
	process.stdout.write(`${JSON.stringify({ ok: true, fixtures: index.fixtures.length, unavailable: index.unavailable })}\n`);
}
