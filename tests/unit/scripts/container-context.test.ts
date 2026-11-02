import { beforeAll, describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(__dirname, '../../..');
interface Copy {
	line: number;
	source: string;
	destination: string;
	directory: boolean;
}

// Only the literal COPY form used by this Dockerfile is modeled; Docker and ignore rules are not executed.
async function contextCopies(lines: string[]): Promise<Copy[]> {
	const copies: Copy[] = [];
	for (const [line, instruction] of lines.entries()) {
		if (/^ADD\s/i.test(instruction)) throw new Error('Use explicit literal COPY inputs');
		if (!/^COPY\s/i.test(instruction)) continue;
		if (/^COPY --from=(base|build|c2pa) /.test(instruction)) continue;
		const parts = instruction.split(/\s+/).slice(1);
		expect(parts.length).toBeGreaterThanOrEqual(2);
		for (const part of parts) {
			expect(part).toMatch(/^[A-Za-z0-9._/\-]+$/);
			expect(part.startsWith('/')).toBe(false);
			expect(part.split('/')).not.toContain('..');
		}
		const destination = parts.pop()!;
		for (const source of parts) {
			expect(posix.normalize(source)).not.toBe('.');
			const info = await lstat(join(root, source));
			expect(info.isFile() || info.isDirectory()).toBe(true);
			if (info.isFile()) expect(destination === '.' || destination.endsWith('/')).toBe(true);
			copies.push({ line, source, destination, directory: info.isDirectory() });
		}
	}
	return copies;
}

function destination(copy: Copy, file: string): string | undefined {
	if (copy.directory && file.startsWith(`${copy.source}/`))
		return posix.join(copy.destination, file.slice(copy.source.length + 1));
	if (!copy.directory && file === copy.source)
		return posix.join(copy.destination, posix.basename(file));
	return undefined;
}

describe('container build input contract (without Docker execution)', () => {
	let lines: string[];
	let copies: Copy[];
	beforeAll(async () => {
		lines = (await readFile(join(root, 'Dockerfile'), 'utf8'))
			.replace(/\\\r?\n/g, ' ')
			.split(/\r?\n/)
			.map((line) => line.trim());
		copies = await contextCopies(lines);
		expect(copies.length).toBeGreaterThan(0);
	});

	it('sources the executable engine from the Rust build stage', () => {
		expect(lines).toContain('COPY --from=base /usr/local/bin/node /usr/local/bin/node');
		expect(lines).toContain('COPY --from=c2pa /app/assets/c2pa-binding ./assets/c2pa-binding');
		expect(lines).toContain('RUN node scripts/build-c2pa-binding.mjs');
		expect(
			lines.findIndex((line) => line === 'RUN node scripts/build-c2pa-binding.mjs')
		).toBeLessThan(lines.findIndex((line) => line.startsWith('COPY --from=c2pa ')));
	});

	it('makes every locked local dependency available at its linked path before npm ci', async () => {
		const install = lines.findIndex((line) => /^RUN\s/.test(line) && /\bnpm ci\b/.test(line));
		expect(install).toBeGreaterThan(0);
		const beforeInstall = copies.filter((copy) => copy.line < install);
		for (const file of ['package.json', 'package-lock.json'])
			expect(beforeInstall.some((copy) => destination(copy, file) === file)).toBe(true);
		const { packages } = JSON.parse(
			await readFile(join(root, 'package-lock.json'), 'utf8')
		) as {
			packages: Record<
				string,
				{ link?: boolean; resolved?: string; version?: string } & Record<string, unknown>
			>;
		};
		const local = new Set(
			Object.values(packages)
				.filter((entry) => entry.link)
				.map((entry) => entry.resolved!)
		);
		for (const group of ['dependencies', 'devDependencies', 'optionalDependencies'])
			for (const spec of Object.values((packages[''][group] ?? {}) as Record<string, string>))
				if (spec.startsWith('file:')) local.add(spec.slice(5));
		expect(local.size).toBeGreaterThan(0);
		for (const directory of local) {
			const file = `${directory}/package.json`;
			expect(beforeInstall.some((copy) => destination(copy, file) === file)).toBe(true);
			const manifest = JSON.parse(await readFile(join(root, file), 'utf8'));
			expect(manifest.version).toBe(packages[directory].version);
		}
	});

	it('does not select host root dependencies, credentials, metadata or build output', () => {
		for (const file of [
			'node_modules/narrative-lens/host.node',
			'.env',
			'.env.production',
			'.npmrc',
			'.git/config',
			'dist/index.js',
			'credentials/signing.key',
		])
			expect(copies.some((copy) => destination(copy, file) !== undefined)).toBe(false);
	});

	it('verifies the complete C2PA source and artifact closure staged only from declared inputs', async () => {
		const manifestPath = 'assets/c2pa-binding/build.json';
		const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8')) as {
			version: string;
			artifacts: { file: string }[];
			sources: { file: string }[];
		};
		const files = [
			manifestPath,
			...manifest.artifacts.map(({ file }) => `assets/c2pa-binding/${file}`),
			...manifest.sources.map(({ file }) => file),
			'scripts/check-c2pa-binding.mjs',
			'scripts/check-release-candidate.mjs',
		];
		const staging = await mkdtemp(join(tmpdir(), 'scrivener-container-context-'));
		try {
			for (const file of files) {
				expect(copies.some((copy) => destination(copy, file) === file)).toBe(true);
				const target = join(staging, file);
				await mkdir(dirname(target), { recursive: true });
				await copyFile(join(root, file), target);
			}
			const result = await execute(process.execPath, ['scripts/check-c2pa-binding.mjs'], {
				cwd: staging,
				timeout: 10_000,
				killSignal: 'SIGKILL',
				maxBuffer: 16384,
			});
			expect(result.stdout.trim()).toBe(
				`C2PA ${manifest.version}: ${manifest.artifacts.length} artifacts and ${manifest.sources.length} source hashes verified`
			);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	});
});
