import { describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const checker = resolve('scripts/check-c2pa-binding.mjs');
const WASM = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const ARTIFACTS = [
	'binding.js',
	'binding.d.ts',
	'binding_bg.wasm',
	'binding_bg.wasm.d.ts',
	'package.json',
];
const ARTIFACT_BYTES: Record<string, Buffer> = {
	'binding.js': Buffer.from('export const fixture = true;\n'),
	'binding.d.ts': Buffer.from('export declare const fixture: boolean;\n'),
	'binding_bg.wasm': WASM,
	'binding_bg.wasm.d.ts': Buffer.from('export declare const memory: WebAssembly.Memory;\n'),
	'package.json': Buffer.from(JSON.stringify({ type: 'module', private: true })),
};
const SOURCES = ['Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'c2pa-0.91.7.crate', 'sdk-patches.json']
	.map((file) => `native/c2pa-binding/${file}`)
	.concat('scripts/build-c2pa-binding.mjs');

type Group = 'artifacts' | 'sources';
interface Entry {
	file: string;
	bytes: number;
	sha256: string;
}
interface Fixture {
	root: string;
	assets: string;
	manifestFile: string;
	manifest: { schemaVersion: number; version: string; artifacts: Entry[]; sources: Entry[] };
}
interface Result {
	ok: boolean;
	result?: { version: string; artifacts: number; sources: number };
	error?: string;
}

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const entry = (file: string, bytes: Buffer): Entry => ({
	file,
	bytes: bytes.length,
	sha256: hash(bytes),
});
const location = (fixture: Fixture, group: Group, file: string): string =>
	join(group === 'artifacts' ? fixture.assets : fixture.root, file);

const runner = `
import { pathToFileURL } from 'node:url';
try {
  const { checkC2paBinding } = await import(pathToFileURL(process.argv[2]).href);
  const result = await checkC2paBinding(process.argv[3]);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}
`;

async function run(fixture: Fixture): Promise<Result> {
	const env: NodeJS.ProcessEnv = {
		HOME: fixture.root,
		USERPROFILE: fixture.root,
		TEMP: fixture.root,
		TMP: fixture.root,
		TMPDIR: fixture.root,
	};
	for (const key of ['PATH', 'SystemRoot', 'WINDIR'])
		if (process.env[key] !== undefined) env[key] = process.env[key];
	const result = await execute(
		process.execPath,
		['--input-type=module', '-e', runner, 'c2pa-binding-fixture', checker, fixture.root],
		{
			cwd: fixture.root,
			env,
			timeout: 10_000,
			killSignal: 'SIGKILL',
			maxBuffer: 65536,
		}
	);
	return JSON.parse(result.stdout) as Result;
}

async function saveManifest(fixture: Fixture): Promise<void> {
	await writeFile(fixture.manifestFile, JSON.stringify(fixture.manifest));
}

async function withFixture(operation: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'scrivener-c2pa-binding-'));
	try {
		const assets = join(root, 'assets', 'c2pa-binding');
		const fixture: Fixture = {
			root,
			assets,
			manifestFile: join(assets, 'build.json'),
			manifest: { schemaVersion: 1, version: '0.91.7', artifacts: [], sources: [] },
		};
		for (const [group, files] of [
			['artifacts', ARTIFACTS],
			['sources', SOURCES],
		] as const) {
			for (const file of files) {
				const bytes =
					group === 'artifacts'
						? ARTIFACT_BYTES[file]
						: Buffer.from(`Fixture bytes for ${file}\n`);
				const destination = location(fixture, group, file);
				await mkdir(dirname(destination), { recursive: true });
				await writeFile(destination, bytes);
				fixture.manifest[group].push(entry(file, bytes));
			}
		}
		await saveManifest(fixture);
		await operation(fixture);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe('C2PA binding provenance verifier', () => {
	it('accepts intact source and genuine minimal WASM without changing fixture bytes', async () => {
		await withFixture(async (fixture) => {
			const files = [
				fixture.manifestFile,
				join(fixture.assets, 'binding_bg.wasm'),
				join(fixture.root, 'native/c2pa-binding/src/lib.rs'),
			];
			const before = await Promise.all(files.map((file) => readFile(file)));
			expect(await run(fixture)).toEqual({
				ok: true,
				result: { version: '0.91.7', artifacts: 5, sources: 6 },
			});
			expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
		});
	});

	it.each([
		{ group: 'artifacts' as const, file: 'binding_bg.wasm' },
		{ group: 'sources' as const, file: 'native/c2pa-binding/src/lib.rs' },
	])('detects same-length tampering of $file', async ({ group, file }) => {
		await withFixture(async (fixture) => {
			const destination = location(fixture, group, file);
			const changed = Buffer.from(await readFile(destination));
			changed[0] ^= 0xff;
			await writeFile(destination, changed);
			const result = await run(fixture);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('Rebuild C2PA binding after changing');
			expect(await readFile(destination)).toEqual(changed);
		});
	});

	it('rejects malformed WASM with a valid header even when its digest and size match', async () => {
		await withFixture(async (fixture) => {
			const bytes = Buffer.concat([WASM, Buffer.from([1])]);
			await writeFile(join(fixture.assets, 'binding_bg.wasm'), bytes);
			fixture.manifest.artifacts = fixture.manifest.artifacts.map((item) =>
				item.file === 'binding_bg.wasm' ? entry(item.file, bytes) : item
			);
			await saveManifest(fixture);
			expect(await run(fixture)).toMatchObject({
				ok: false,
				error: 'Invalid C2PA WebAssembly',
			});
		});
	});

	it.each([
		{ group: 'artifacts' as const, file: 'nested/../../../outside.js', outside: 'outside.js' },
		{
			group: 'sources' as const,
			file: 'native/c2pa-binding/../../outside.rs',
			outside: 'outside.rs',
		},
	])('blocks a hash-matching traversal entry in $group', async ({ group, file, outside }) => {
		await withFixture(async (fixture) => {
			const bytes = Buffer.from('Existing bytes outside the allowed binding directory');
			const destination = join(fixture.root, outside);
			await writeFile(destination, bytes);
			fixture.manifest[group].push(entry(file, bytes));
			await saveManifest(fixture);
			expect((await run(fixture)).ok).toBe(false);
			expect(await readFile(destination)).toEqual(bytes);
		});
	});

	it.each([63, 64, 65])('rejects a wrong SHA256 value of length %i', async (length) => {
		await withFixture(async (fixture) => {
			fixture.manifest.artifacts[0].sha256 = '0'.repeat(length);
			await saveManifest(fixture);
			const result = await run(fixture);
			expect(result.ok).toBe(false);
			if (length === 64)
				expect(result.error).toContain('Rebuild C2PA binding after changing');
		});
	});

	it.each([
		{ group: 'artifacts' as const, file: 'binding.js' },
		{ group: 'sources' as const, file: 'native/c2pa-binding/Cargo.lock' },
	])('rejects a symlinked $file while preserving its real target', async ({ group, file }) => {
		await withFixture(async (fixture) => {
			const destination = location(fixture, group, file);
			const target = join(fixture.root, 'original-symlink-target');
			const before = await readFile(destination);
			await rename(destination, target);
			await symlink(target, destination, 'file');
			expect((await run(fixture)).ok).toBe(false);
			expect(await readFile(target)).toEqual(before);
		});
	});

	it.each([
		...ARTIFACTS.map((file) => ({ group: 'artifacts' as const, file })),
		...SOURCES.map((file) => ({ group: 'sources' as const, file })),
	])(
		'requires the $file provenance entry even when other entries remain valid',
		async ({ group, file }) => {
			await withFixture(async (fixture) => {
				fixture.manifest[group] = fixture.manifest[group].filter(
					(item) => item.file !== file
				);
				await saveManifest(fixture);
				const result = await run(fixture);
				expect(result.ok).toBe(false);
				expect(result.error).toContain(`Missing C2PA provenance entry: ${file}`);
			});
		}
	);
});
