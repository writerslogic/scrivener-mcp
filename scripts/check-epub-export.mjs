import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { toEpub } from '../dist/services/export/manuscript-exporters.js';
import { validateExport } from '../dist/services/export/export-presets.js';
const execute = promisify(execFile);
const root = resolve('logs/implementation/epub-validation');
await mkdir(root, { recursive: true });
let jar = process.env.EPUBCHECK_JAR;
if (!jar) {
	const cache = resolve('.cache/epubcheck-5.4.0');
	jar = join(cache, 'epubcheck-5.4.0', 'epubcheck.jar');
	try {
		await stat(jar);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		const response = await fetch(
			'https://github.com/w3c/epubcheck/releases/download/v5.4.0/epubcheck-5.4.0.zip',
			{ signal: AbortSignal.timeout(60000) }
		);
		assert(response.ok, 'EPUBCheck download failed');
		assert(response.body, 'EPUBCheck download has no body');
		const chunks = [];
		let received = 0;
		for await (const chunk of response.body) {
			received += chunk.length;
			assert(received <= 64 * 1024 * 1024, 'EPUBCheck download exceeds 64 MiB');
			chunks.push(chunk);
		}
		const archive = Buffer.concat(chunks, received);
		assert.equal(
			createHash('sha256').update(archive).digest('hex'),
			'33350c61038e71dfb3d45a76aed04bf5481e6d5500cb780f6e98db8bbd15a28c',
			'EPUBCheck download checksum changed'
		);
		const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
		for (const entry of Object.values(zip.files)) {
			assert(
				!entry.name.startsWith('/') && !entry.name.split(/[\\/]/).includes('..'),
				'Invalid EPUBCheck archive path'
			);
			if (entry.dir) continue;
			const target = join(cache, entry.name);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, await entry.async('nodebuffer'));
		}
	}
}
const sections = [
	{ title: 'Part One', text: '', depth: 0, isFolder: true, sectionType: 'part' },
	{
		title: 'Chapter One — Café 東京',
		text: 'A lantern shone. 🌙\nMara returned home.',
		depth: 1,
		isFolder: false,
		sectionType: 'chapter',
		notes: ['Note: Original sample note.'],
	},
];
for (const [name, selected] of [
	['unicode-notes', sections],
	['empty', []],
]) {
	const buffer = await toEpub(selected, {
		title: `Original CC0 ${name} fixture`,
		author: 'Scrivener MCP contributors',
		preset: 'ebook',
	});
	await validateExport(buffer, 'epub');
	const file = join(root, `${name}.epub`);
	await writeFile(file, buffer);
	try {
		const { stdout, stderr } = await execute('java', ['-jar', resolve(jar), file], {
			timeout: 60000,
			maxBuffer: 1024 * 1024,
		});
		await writeFile(join(root, `${name}.txt`), stdout + stderr);
		assert(!/\b(?:ERROR|FATAL)\(/.test(stdout + stderr), 'EPUBCheck reported an error');
		process.stdout.write(`OK EPUBCheck 5.4.0: ${name}\n`);
	} catch (error) {
		await writeFile(
			join(root, `${name}.txt`),
			String(error.stdout ?? '') + String(error.stderr ?? '')
		);
		throw new Error(
			`EPUBCheck failed for ${name}; see logs/implementation/epub-validation/${name}.txt`,
			{ cause: error }
		);
	}
}
