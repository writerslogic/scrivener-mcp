import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readReleaseFile } from './check-release-candidate.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function checkC2paBinding(root = ROOT) {
	const directory = join(root, 'assets/c2pa-binding');
	const manifest = JSON.parse(
		new TextDecoder('utf-8', { fatal: true }).decode(
			await readReleaseFile(join(directory, 'build.json'), 64 * 1024)
		)
	);
	assert.equal(manifest.schemaVersion, 1);
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
	assert.ok(
		Array.isArray(manifest.artifacts) &&
			manifest.artifacts.length >= 4 &&
			manifest.artifacts.length <= 256
	);
	assert.ok(
		Array.isArray(manifest.sources) &&
			manifest.sources.length >= 3 &&
			manifest.sources.length <= 32
	);
	for (const [entries, required] of [
		[
			manifest.artifacts,
			[
				'binding.js',
				'binding.d.ts',
				'binding_bg.wasm',
				'binding_bg.wasm.d.ts',
				'package.json',
			],
		],
		[
			manifest.sources,
			['Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'c2pa-0.91.7.crate', 'sdk-patches.json']
				.map((file) => `native/c2pa-binding/${file}`)
				.concat('scripts/build-c2pa-binding.mjs'),
		],
	]) {
		for (const name of required)
			assert.ok(
				entries.some((entry) => entry?.file === name),
				`Missing C2PA provenance entry: ${name}`
			);
	}
	for (const [entries, base, sources] of [
		[manifest.artifacts, directory, false],
		[manifest.sources, root, true],
	]) {
		const seen = new Set();
		for (const entry of entries) {
			assert.equal(typeof entry.file, 'string');
			assert.ok(entry.file.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(entry.file));
			assert.ok(
				!entry.file.split('/').some((part) => !part || part === '..' || part === '.')
			);
			assert.ok(!seen.has(entry.file));
			seen.add(entry.file);
			assert.match(entry.sha256, /^[a-f0-9]{64}$/);
			assert.ok(
				Number.isSafeInteger(entry.bytes) &&
					entry.bytes > 0 &&
					entry.bytes <= 64 * 1024 * 1024
			);
			if (sources)
				assert.ok(
					entry.file.startsWith('native/c2pa-binding/') ||
						entry.file === 'scripts/build-c2pa-binding.mjs'
				);
			const target = resolve(base, ...entry.file.split('/'));
			assert.ok(target.startsWith(resolve(base) + sep));
			const bytes = await readReleaseFile(target, 64 * 1024 * 1024);
			assert.equal(bytes.length, entry.bytes, `C2PA artifact size changed: ${entry.file}`);
			assert.equal(
				hash(bytes),
				entry.sha256,
				`Rebuild C2PA binding after changing ${entry.file}`
			);
			if (entry.file.endsWith('.wasm'))
				assert.ok(WebAssembly.validate(bytes), 'Invalid C2PA WebAssembly');
		}
	}
	return {
		version: manifest.version,
		artifacts: manifest.artifacts.length,
		sources: manifest.sources.length,
	};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		assert.ok(process.argv.slice(2).every((value) => value === '--packaged'));
		const result = await checkC2paBinding();
		console.log(
			`C2PA ${result.version}: ${result.artifacts} artifacts and ${result.sources} source hashes verified`
		);
	} catch {
		console.error(
			'C2PA binding verification failed; run npm run build:c2pa with the documented pinned toolchain.'
		);
		process.exitCode = 1;
	}
}
