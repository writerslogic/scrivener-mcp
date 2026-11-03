import { describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const builder = resolve('scripts/build-c2pa-binding.mjs');
const source = resolve('native/c2pa-binding');
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const runner = `
import { pathToFileURL } from 'node:url';
try {
  const { prepareC2paSources } = await import(pathToFileURL(process.argv[2]).href);
  await prepareC2paSources(process.argv[3]);
  process.stdout.write(JSON.stringify({ ok: true }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
}
`;

async function prepare(root: string): Promise<{ ok: boolean }> {
	const result = await execute(
		process.execPath,
		['--input-type=module', '-e', runner, 'prepare-c2pa-fixture', builder, root],
		{ cwd: root, env: { PATH: process.env.PATH }, timeout: 10_000, maxBuffer: 65536 }
	);
	return JSON.parse(result.stdout) as { ok: boolean };
}

async function fixture(operation: (root: string, native: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'scrivener-c2pa-build-'));
	try {
		const native = join(root, 'native/c2pa-binding');
		await mkdir(native, { recursive: true });
		for (const file of [
			'c2pa-0.91.7.crate',
			'sdk-patches.json',
			'static-regular-grammar-2.0.2.crate',
			'grammar-patches.json',
		])
			await copyFile(join(source, file), join(native, file));
		await operation(root, native);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe('C2PA pinned source preparation', () => {
	it('recreates both patched crates with their reviewed source hashes', async () => {
		await fixture(async (root, native) => {
			expect(await prepare(root)).toEqual({ ok: true });
			for (const [crate, manifest] of [
				['c2pa-0.91.7', 'sdk-patches.json'],
				['static-regular-grammar-2.0.2', 'grammar-patches.json'],
			]) {
				const patches = JSON.parse(await readFile(join(native, manifest), 'utf8')) as {
					patches: { file: string; afterSha256: string }[];
				};
				const finalHashes = new Map(
					patches.patches.map((patch) => [patch.file, patch.afterSha256])
				);
				for (const [file, expected] of finalHashes)
					expect(hash(await readFile(join(native, '.sdk', crate, file)))).toBe(expected);
			}
			const grammar = join(native, '.sdk/static-regular-grammar-2.0.2/src/lib.rs');
			const expected = await readFile(grammar);
			await writeFile(grammar, 'Incomplete previous build');
			expect(await prepare(root)).toEqual({ ok: true });
			expect(await readFile(grammar)).toEqual(expected);
		});
	});

	it('rejects a corrupted archive before replacing the previous source tree', async () => {
		await fixture(async (root, native) => {
			await mkdir(join(native, '.sdk'));
			const previous = join(native, '.sdk/previous');
			await writeFile(previous, 'Previous sources');
			const archive = join(native, 'static-regular-grammar-2.0.2.crate');
			const bytes = await readFile(archive);
			bytes[bytes.length - 1] ^= 1;
			await writeFile(archive, bytes);
			expect(await prepare(root)).toEqual({ ok: false });
			expect(await readFile(previous, 'utf8')).toBe('Previous sources');
		});
	});

	it('rejects patch traversal without changing the target', async () => {
		await fixture(async (root, native) => {
			const outside = join(root, 'outside.rs');
			await writeFile(outside, 'Outside source');
			const file = join(native, 'grammar-patches.json');
			const patches = JSON.parse(await readFile(file, 'utf8'));
			patches.patches[0].file = '../../../../outside.rs';
			await writeFile(file, JSON.stringify(patches));
			expect(await prepare(root)).toEqual({ ok: false });
			expect(await readFile(outside, 'utf8')).toBe('Outside source');
		});
	});

	it.each(['beforeSha256', 'afterSha256', 'before'])(
		'rejects a mismatched patch %s',
		async (field) => {
			await fixture(async (root, native) => {
				const file = join(native, 'grammar-patches.json');
				const patches = JSON.parse(await readFile(file, 'utf8'));
				patches.patches[0][field] =
					field === 'before' ? 'Missing source text' : '0'.repeat(64);
				await writeFile(file, JSON.stringify(patches));
				expect(await prepare(root)).toEqual({ ok: false });
			});
		}
	);
});
