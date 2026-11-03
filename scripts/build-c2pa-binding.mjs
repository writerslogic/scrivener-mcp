import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const run = async (command, args, options = {}) => {
	const pending = execute(command, args, {
		cwd: ROOT,
		timeout: 20 * 60 * 1000,
		maxBuffer: 2 * 1024 * 1024,
		...options,
	});
	pending.child.stdin?.end();
	return (await pending).stdout.trim();
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function prepareC2paSources(root = ROOT) {
	const sdkRoot = join(root, 'native/c2pa-binding');
	const extracted = join(sdkRoot, '.sdk');
	const sources = [];
	for (const [crate, manifest] of [
		['c2pa-0.91.7', 'sdk-patches.json'],
		['static-regular-grammar-2.0.2', 'grammar-patches.json'],
	]) {
		const patches = JSON.parse(await readFile(join(sdkRoot, manifest), 'utf8'));
		assert.equal(patches.schemaVersion, 1);
		assert.match(patches.crateSha256, /^[a-f0-9]{64}$/u);
		assert.ok(Array.isArray(patches.patches) && patches.patches.length <= 32);
		const archive = join(sdkRoot, `${crate}.crate`);
		assert.equal(digest(await readFile(archive)), patches.crateSha256);
		for (const patch of patches.patches) {
			assert.match(patch.file, /^(?:Cargo\.toml(?:\.orig)?|src\/[A-Za-z0-9_/-]+\.rs)$/u);
			assert.ok(!patch.file.split('/').some((part) => !part || part === '..'));
			assert.match(patch.beforeSha256, /^[a-f0-9]{64}$/u);
			assert.match(patch.afterSha256, /^[a-f0-9]{64}$/u);
			assert.equal(typeof patch.before, 'string');
			assert.ok(patch.before.length > 0 && patch.before.length <= 64 * 1024);
			assert.equal(typeof patch.after, 'string');
			assert.ok(patch.after.length <= 64 * 1024);
		}
		sources.push({ crate, archive, patches: patches.patches });
	}
	await rm(extracted, { recursive: true, force: true });
	await mkdir(extracted, { recursive: true });
	for (const source of sources) {
		await run('tar', ['-xzf', source.archive, '-C', extracted], { cwd: root });
		for (const patch of source.patches) {
			const file = join(extracted, source.crate, patch.file);
			const before = await readFile(file, 'utf8');
			assert.equal(digest(before), patch.beforeSha256);
			assert.equal(before.split(patch.before).length, 2);
			const after = before.replace(patch.before, patch.after);
			assert.equal(digest(after), patch.afterSha256);
			await writeFile(file, after);
		}
	}
}

async function buildC2paBinding() {
	await prepareC2paSources();
	const compiler = await run('rustc', ['--version']);
	assert.match(compiler, /^rustc 1\.96\.0 /, 'Use Rust 1.96.0 for the reproducible binding');
	const packer = await run('wasm-pack', ['--version']);
	assert.equal(packer, 'wasm-pack 0.14.0');
	const sysroot = await run('rustc', ['--print', 'sysroot']);
	const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
	const flags = [
		`--remap-path-prefix=${resolve(ROOT)}=.`,
		`--remap-path-prefix=${cargoHome}=/cargo`,
		`--remap-path-prefix=${sysroot}=/rust`,
		'-C',
		'link-arg=--max-memory=1073741824',
	];
	const directory = join(ROOT, 'assets/c2pa-binding');
	await mkdir(directory, { recursive: true });
	for (const name of ['reader.js', 'reader.d.ts', 'reader_bg.wasm', 'reader_bg.wasm.d.ts'])
		await rm(join(directory, name), { force: true });
	await run(
		'wasm-pack',
		[
			'build',
			'native/c2pa-binding',
			'--target',
			'web',
			'--release',
			'--out-dir',
			'../../assets/c2pa-binding',
			'--out-name',
			'binding',
			'--no-pack',
			'--no-opt',
			'--',
			'--locked',
		],
		{
			env: {
				...process.env,
				CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'),
				CARGO_BUILD_JOBS: '3',
			},
		}
	);
	await rm(join(directory, '.gitignore'), { force: true });
	await writeFile(
		join(directory, 'package.json'),
		JSON.stringify({ type: 'module', private: true }) + '\n'
	);
	const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
	const describe = async (base, file) => {
		const bytes = await readFile(join(base, file));
		return { file, bytes: bytes.length, sha256: hash(bytes) };
	};
	const artifacts = [];
	async function collect(prefix = '') {
		for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.name === 'build.json') continue;
			assert.ok(!entry.isSymbolicLink());
			const name = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await collect(name);
			else {
				assert.ok(entry.isFile());
				artifacts.push(await describe(directory, name));
			}
		}
	}
	await collect();
	artifacts.sort((a, b) => a.file.localeCompare(b.file));
	const { core_version, default: initialize } = await import(
		new URL('../assets/c2pa-binding/binding.js', import.meta.url)
	);
	await initialize({ module_or_path: await readFile(join(directory, 'binding_bg.wasm')) });
	const sources = [];
	for (const file of [
		'native/c2pa-binding/Cargo.toml',
		'native/c2pa-binding/Cargo.lock',
		'native/c2pa-binding/src/lib.rs',
		'native/c2pa-binding/c2pa-0.91.7.crate',
		'native/c2pa-binding/sdk-patches.json',
		'native/c2pa-binding/static-regular-grammar-2.0.2.crate',
		'native/c2pa-binding/grammar-patches.json',
		'scripts/build-c2pa-binding.mjs',
	])
		sources.push(await describe(ROOT, file));
	await writeFile(
		join(directory, 'build.json'),
		JSON.stringify(
			{
				schemaVersion: 1,
				version: core_version(),
				target: 'wasm32-unknown-unknown',
				compiler,
				packer,
				maximumMemoryBytes: 1073741824,
				flags: ['remap project/cargo/sysroot paths', 'max-memory=1073741824'],
				artifacts,
				sources,
			},
			null,
			2
		) + '\n'
	);
	console.log(
		`Built reproducible C2PA ${core_version()} binding; ${artifacts.length} artifacts recorded`
	);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	assert.ok(
		process.argv.slice(2).length === 0 ||
			(process.argv.length === 3 && process.argv[2] === '--prepare-only')
	);
	if (process.argv[2] === '--prepare-only') await prepareC2paSources();
	else await buildC2paBinding();
}
