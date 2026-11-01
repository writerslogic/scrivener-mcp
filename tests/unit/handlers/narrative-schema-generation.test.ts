import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(__dirname, '../../..');
const generator = join(root, 'scripts/generate-narrative-annotation-schema.mjs');
const generated = join(root, 'src/handlers/narrative-annotation-schema.ts');

async function snapshot(file: string) {
	const handle = await open(file, 'r');
	try {
		return {
			bytes: await handle.readFile(),
			mtimeNs: (await handle.stat({ bigint: true })).mtimeNs,
		};
	} finally {
		await handle.close();
	}
}

describe('pinned Narrative Lens schema generation', () => {
	let directory: string;
	const run = (...args: string[]) =>
		execute(process.execPath, [generator, ...args], {
			cwd: directory,
			timeout: 10000,
			maxBuffer: 16384,
		});
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'narrative-schema-'));
	});
	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	it('checks the current generated contract from an unrelated working directory without writing', async () => {
		const before = await snapshot(generated);
		await run('--check');
		expect(await snapshot(generated)).toEqual(before);
	});
	it('regenerates the complete formatted contract deterministically from the vendored subset', async () => {
		const output = join(directory, 'schema.ts');
		await run('--output', output);
		expect(await readFile(output, 'utf8')).toBe(await readFile(generated, 'utf8'));
		await run('--output', output, '--check');
	});
	it('rejects nested contract drift without repairing the output during verification', async () => {
		const output = join(directory, 'drift.ts');
		const original = await readFile(generated, 'utf8');
		const changed = original.replace('4294967295', '4294967294');
		expect(changed).not.toBe(original);
		await writeFile(output, changed);
		const before = await snapshot(output);
		await expect(run('--output', output, '--check')).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('schema is stale'),
		});
		expect(await snapshot(output)).toEqual(before);
	});
	it.each(['{', '{}'])(
		'rejects malformed or unpinned source %j before writing',
		async (source) => {
			const input = join(directory, 'untrusted.json');
			const output = join(directory, 'rejected.ts');
			await writeFile(input, source);
			await expect(run(input, '--output', output)).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining('does not match the pinned upstream schema'),
			});
			await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
		}
	);
	it('rejects an engine version change before accepting old contracts', async () => {
		await expect(
			execute(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`import { generateAnnotationSchema } from ${JSON.stringify(pathToFileURL(generator).href)}; await generateAnnotationSchema({ check: true, version: '0.2.1' });`,
				],
				{ cwd: directory, timeout: 10000, maxBuffer: 16384 }
			)
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('does not match schema version 0.2.0'),
		});
	});
});
