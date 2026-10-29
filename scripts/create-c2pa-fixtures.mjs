#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

async function command(program, args, env = process.env) {
	try {
		return await execute(program, args, { env, timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true });
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
	}
	await command('openssl', ['req', '-new', '-x509', '-key', rootKey, '-passin', 'env:C2PA_FIXTURE_PASSPHRASE', '-config', rootConfig, '-set_serial', '1', '-days', '2', '-sha256', '-out', trustAnchorsPath], env);
	const request = join(directory, 'test-leaf.csr');
	await command('openssl', ['req', '-new', '-key', privateKeyPath, '-passin', 'env:C2PA_FIXTURE_PASSPHRASE', '-subj', '/CN=Scrivener MCP Synthetic Fixture Signer - TEST ONLY', '-sha256', '-out', request], env);
	await command('openssl', ['x509', '-req', '-in', request, '-CA', trustAnchorsPath, '-CAkey', rootKey, '-passin', 'env:C2PA_FIXTURE_PASSPHRASE', '-set_serial', '2', '-days', '1', '-sha256', '-extfile', leafConfig, '-out', leaf], env);
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
				['sound.ogg', 'audio/ogg', 'libvorbis'], ['sound.opus', 'audio/opus', 'libopus'],
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
			['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'toDocx', 'submission'],
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
	} finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'Use optional --output <directory>');
	const output = resolve(process.argv[3] ?? join(ROOT, 'tests/fixtures/c2pa'));
	const index = await createC2paFixtures(output);
	process.stdout.write(`${JSON.stringify({ ok: true, fixtures: index.fixtures.length, unavailable: index.unavailable })}\n`);
}
