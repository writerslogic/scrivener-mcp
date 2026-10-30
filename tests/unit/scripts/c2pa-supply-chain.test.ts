import { describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	truncate,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = resolve('scripts/check-c2pa-supply-chain.mjs');
const NOW = Date.parse('2026-10-30T12:00:00Z');
const DATABASE_MAXIMUM_AGE = 120 * 60 * 60 * 1000;
const MANIFEST_MAXIMUM = 128 * 1024;
const expected = { name: 'c2pa', version: '0.91.7' };

interface Inventory {
	name: string;
	path: string;
	sha256: string;
	expectedPackages: { name: string; version: string }[];
}

interface Failure {
	code: string;
	message: string;
}

interface Report {
	ok: boolean;
	sourceInventorySha256: string | null;
	tool: { version: string; sha256: string } | null;
	errors: Failure[];
	inventories: {
		name: string;
		ok: boolean;
		packageCount?: number;
		error?: Failure;
		missingExpectedPackages?: { name: string; version: string }[];
		counts?: { medium: number; high: number; critical: number };
		findings?: { id: string; severity: string; fix: { state: string; versions: string[] } }[];
		execution?: {
			stdoutFile: string;
			stderrFile: string;
			stdoutSha256: string;
			exitCode: number;
		};
	}[];
}

interface Fixture {
	root: string;
	grype: string;
	manifest: string;
	output: string;
	control: string;
	inventory: Inventory;
}

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

const runner = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(process.argv[3]);
Date.now = () => input.now;
const spawn = childProcess.spawn;
// Directly executing a script file is not portable to Windows; keep real subprocess I/O and exits.
childProcess.spawn = (command, args, options) => command === input.options.grype
  ? spawn(process.execPath, [command, ...args], options)
  : spawn(command, args, options);
syncBuiltinESMExports();
const { verifyC2paSupplyChain } = await import(pathToFileURL(process.argv[2]).href);
try {
  process.stdout.write(JSON.stringify({ report: await verifyC2paSupplyChain(input.options) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code, message: error.message } }));
}
`;

function fakeGrype(control: string): string {
	return `
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
const args = process.argv.slice(2);
const config = fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8');
if (process.env.OPENAI_API_KEY || process.env.GRYPE_ONLY_FIXED || process.env.GRYPE_VEX_DOCUMENTS ||
    process.env.GRYPE_DB_AUTO_UPDATE !== 'false' ||
    process.env.GRYPE_DB_VALIDATE_AGE !== 'true' ||
    process.env.GRYPE_MATCH_RUST_USING_CPES !== 'true' ||
    process.env.GRYPE_MATCH_JAVASCRIPT_USING_CPES !== 'true' ||
    !/rust:\\s+using-cpes: true/.test(config) ||
    !/javascript:\\s+using-cpes: true/.test(config)) {
  process.stderr.write('Fixture rejected unsafe scanner configuration');
  process.exit(1);
}
if (args[0] === 'version') {
  process.stdout.write(JSON.stringify({ application: 'grype', version: fixture.version ?? '0.121.0' }));
} else if (args[0] === 'db' && args[1] === 'status') {
  process.stdout.write(JSON.stringify(fixture.database));
} else if (args[0].startsWith('sbom:')) {
  if (!args.includes('--add-cpes-if-none') || args[args.indexOf('--fail-on') + 1] !== 'high') {
    process.stderr.write('Fixture rejected missing vulnerability policy');
    process.exit(1);
  }
  const sbom = JSON.parse(fs.readFileSync(args[0].slice(5), 'utf8'));
  const artifact = (sbom.artifacts ?? sbom.components)[0];
  const filtered = args.includes('--only-fixed') || /only-fixed: true/.test(config);
  const matches = filtered ? [] : [{
    artifact: { name: artifact.name, version: artifact.version },
    vulnerability: { id: 'CVE-2099-0001', namespace: 'nvd:cpe',
      severity: fixture.severity ?? 'Medium',
      fix: { state: fixture.fixState ?? (fixture.severity ? 'not-fixed' : ''), versions: [] } },
    matchDetails: [{ type: 'cpe-match', matcher: 'rust-matcher' }]
  }];
  const report = { matches, descriptor: { name: 'grype', version: '0.121.0',
    db: { status: fixture.database } } };
  process.stdout.write(JSON.stringify(report));
  process.stderr.write('fixture-private-diagnostic');
  process.exitCode = fixture.scanExit ?? (['High', 'Critical'].includes(fixture.severity) && !filtered ? 2 : 0);
} else {
  process.stderr.write('Unexpected fixture command');
  process.exit(1);
}
`;
}

async function withFixture(operation: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-c2pa-sca-')));
	try {
		const control = join(root, 'scanner-state.json');
		const grype = join(root, 'fake-grype.cjs');
		const path = join(root, 'native.sbom.json');
		const bytes = JSON.stringify({ artifacts: [expected] });
		const fixture = {
			root,
			grype,
			control,
			manifest: join(root, 'manifest.json'),
			output: join(root, 'output'),
			inventory: { name: 'native', path, sha256: hash(bytes), expectedPackages: [expected] },
		};
		await writeFile(path, bytes);
		await writeFile(grype, fakeGrype(control), { mode: 0o700 });
		await writeManifest(fixture, [fixture.inventory]);
		await operation(fixture);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeManifest(
	fixture: Fixture,
	inventories: Inventory[],
	bytes?: number
): Promise<void> {
	const encoded = JSON.stringify({ schemaVersion: 1, inventories });
	await writeFile(fixture.manifest, bytes === undefined ? encoded : encoded.padEnd(bytes, ' '));
}

async function run(
	fixture: Fixture,
	scenario: Record<string, unknown> = {},
	options: Record<string, unknown> = {}
): Promise<{ report?: Report; error?: Failure }> {
	await writeFile(
		fixture.control,
		JSON.stringify({
			database: {
				schemaVersion: '6.1.10',
				built: new Date(NOW - 1000).toISOString(),
				path: join(fixture.root, 'vulnerability.db'),
				valid: true,
			},
			...scenario,
		})
	);
	const env: NodeJS.ProcessEnv = {};
	for (const name of ['PATH', 'SystemRoot', 'WINDIR'])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	Object.assign(env, {
		HOME: fixture.root,
		USERPROFILE: fixture.root,
		TMPDIR: fixture.root,
		TEMP: fixture.root,
		TMP: fixture.root,
		GRYPE_DB_CACHE_DIR: fixture.root,
		OPENAI_API_KEY: 'fixture-only-never-a-real-key',
		GRYPE_ONLY_FIXED: 'true',
		GRYPE_VEX_DOCUMENTS: join(fixture.root, 'unapproved-vex.json'),
		GRYPE_DB_VALIDATE_AGE: 'false',
		GRYPE_DB_AUTO_UPDATE: 'true',
		GRYPE_MATCH_RUST_USING_CPES: 'false',
		GRYPE_MATCH_JAVASCRIPT_USING_CPES: 'false',
	});
	const result = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			runner,
			'c2pa-supply-chain-fixture',
			script,
			JSON.stringify({
				now: NOW,
				options: {
					grype: fixture.grype,
					manifest: fixture.manifest,
					output: fixture.output,
					...options,
				},
			}),
		],
		{ cwd: fixture.root, env, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }
	);
	return JSON.parse(result.stdout) as { report?: Report; error?: Failure };
}

function errorCodes(result: { report?: Report; error?: Failure }): string[] {
	return [
		result.error,
		...(result.report?.errors ?? []),
		...(result.report?.inventories.map((inventory) => inventory.error) ?? []),
	]
		.filter((error): error is Failure => error !== undefined)
		.map((error) => error.code);
}

describe('C2PA supply-chain evidence gate', () => {
	it('checks Syft and grouped nested CycloneDX coverage while preserving exact source and report bytes', async () => {
		await withFixture(async (fixture) => {
			const npmPath = join(fixture.root, 'npm.sbom.json');
			const npmBytes = JSON.stringify({
				components: [
					{
						name: 'runtime',
						version: '1.0.0',
						components: [{ group: '@scope', name: 'entry', version: '2.0.0' }],
					},
				],
			});
			await writeFile(npmPath, npmBytes);
			await writeManifest(fixture, [
				fixture.inventory,
				{
					name: 'npm',
					path: npmPath,
					sha256: hash(npmBytes),
					expectedPackages: [{ name: '@scope/entry', version: '2.0.0' }],
				},
			]);
			const manifestBefore = await readFile(fixture.manifest);
			const sourceBefore = await readFile(fixture.inventory.path);
			const { report } = await run(fixture);
			expect(report?.ok).toBe(true);
			expect(report?.sourceInventorySha256).toBe(hash(manifestBefore));
			expect(report?.tool).toMatchObject({
				version: '0.121.0',
				sha256: hash(await readFile(fixture.grype)),
			});
			expect(report?.inventories.map((entry) => entry.packageCount)).toEqual([1, 2]);
			expect(report?.inventories[0].findings?.[0].fix).toEqual({ state: '', versions: [] });
			expect(await readFile(join(fixture.output, 'native.sbom.json'))).toEqual(sourceBefore);
			expect(await readFile(join(fixture.output, 'npm.sbom.json'), 'utf8')).toBe(npmBytes);
			expect(await readFile(fixture.inventory.path)).toEqual(sourceBefore);
			expect(await readFile(fixture.manifest)).toEqual(manifestBefore);
			expect(JSON.parse(await readFile(join(fixture.output, 'report.json'), 'utf8'))).toEqual(
				report
			);
			if (process.platform !== 'win32') {
				expect((await stat(fixture.output)).mode & 0o077).toBe(0);
				expect((await stat(join(fixture.output, 'report.json'))).mode & 0o077).toBe(0);
			}
		});
	});

	it.each([-1, 0, 1])('bounds the inventory manifest at 128 KiB with delta %i', async (delta) => {
		await withFixture(async (fixture) => {
			await writeManifest(fixture, [fixture.inventory], MANIFEST_MAXIMUM + delta);
			const result = await run(fixture);
			expect(result.report?.ok).toBe(delta <= 0);
			expect(errorCodes(result)).toEqual(delta <= 0 ? [] : ['INVALID_FILE']);
		});
	});

	it.each([
		{ inventories: 15, expectations: 1, error: 'WRONG_GRYPE_VERSION' },
		{ inventories: 16, expectations: 1, error: 'WRONG_GRYPE_VERSION' },
		{ inventories: 17, expectations: 1, error: 'INVALID_MANIFEST' },
		{ inventories: 1, expectations: 255, error: 'WRONG_GRYPE_VERSION' },
		{ inventories: 1, expectations: 256, error: 'WRONG_GRYPE_VERSION' },
		{ inventories: 1, expectations: 257, error: 'INVALID_INVENTORY' },
	])(
		'bounds $inventories inventories and $expectations expectations before tool admission',
		async (boundary) => {
			await withFixture(async (fixture) => {
				await writeManifest(
					fixture,
					Array.from({ length: boundary.inventories }, (_, index) => ({
						...fixture.inventory,
						name: `scope-${index}`,
						expectedPackages: Array.from(
							{ length: boundary.expectations },
							() => expected
						),
					}))
				);
				const result = await run(fixture, { version: '0.120.0' });
				expect(result.report?.ok).toBe(false);
				expect(errorCodes(result)).toEqual([boundary.error]);
			});
		}
	);

	it.each([
		{ name: '../escape', error: 'INVALID_INVENTORY' },
		{ name: 'native', path: 'relative.sbom.json', error: 'INVALID_PATH' },
		{ name: 'native', sha256: '0'.repeat(63), error: 'INVALID_INVENTORY' },
		{ name: 'native', sha256: '0'.repeat(64), error: 'SBOM_DIGEST_MISMATCH' },
		{
			name: 'native',
			expectedPackages: [{ ...expected, version: '0.91.6' }],
			error: 'MISSING_EXPECTED_PACKAGE',
		},
		{
			name: 'native',
			expectedPackages: [{ ...expected, name: 'another-crate' }],
			error: 'MISSING_EXPECTED_PACKAGE',
		},
	])('rejects unsafe or unmatched inventory metadata: $error', async ({ error, ...change }) => {
		await withFixture(async (fixture) => {
			await writeManifest(fixture, [{ ...fixture.inventory, ...change }]);
			const result = await run(fixture);
			expect(result.report?.ok).toBe(false);
			expect(errorCodes(result)).toEqual([error]);
			if (error === 'MISSING_EXPECTED_PACKAGE')
				expect(result.report?.inventories[0].missingExpectedPackages).toEqual(
					change.expectedPackages
				);
		});
	});

	it('rejects oversized or nonregular SBOM inputs and unavailable tools', async () => {
		await withFixture(async (fixture) => {
			await truncate(fixture.inventory.path, 64 * 1024 * 1024 + 1);
			expect(errorCodes(await run(fixture))).toEqual(['INVALID_FILE']);
			await rm(fixture.inventory.path);
			await mkdir(fixture.inventory.path);
			const directoryInput = await run(
				fixture,
				{},
				{ output: join(fixture.root, 'directory-input') }
			);
			expect(directoryInput.report?.ok).toBe(false);
			expect(errorCodes(directoryInput)).toEqual([
				expect.stringMatching(/^(INVALID_FILE|IO_FAILED)$/),
			]);
			expect(
				errorCodes(
					await run(
						fixture,
						{},
						{
							grype: join(fixture.root, 'missing-grype'),
							output: join(fixture.root, 'missing-tool'),
						}
					)
				)
			).toEqual(['SCANNER_UNAVAILABLE']);
		});
	});

	it('rejects relative output paths and preserves existing output evidence', async () => {
		await withFixture(async (fixture) => {
			expect(errorCodes(await run(fixture, {}, { output: 'relative-output' }))).toEqual([
				'INVALID_PATH',
			]);
			await mkdir(fixture.output);
			const existing = join(fixture.output, 'report.json');
			await writeFile(existing, 'existing-evidence');
			expect(errorCodes(await run(fixture))).toEqual(['OUTPUT_UNAVAILABLE']);
			expect(await readFile(existing, 'utf8')).toBe('existing-evidence');
		});
	});

	it.each([-1, 0, 1])(
		'requires a database no older than 120 hours with delta %i ms',
		async (delta) => {
			await withFixture(async (fixture) => {
				const result = await run(fixture, {
					database: {
						schemaVersion: '6.1.10',
						valid: true,
						path: join(fixture.root, 'vulnerability.db'),
						built: new Date(NOW - DATABASE_MAXIMUM_AGE - delta).toISOString(),
					},
				});
				expect(result.report?.ok).toBe(delta <= 0);
				expect(errorCodes(result)).toEqual(delta <= 0 ? [] : ['INVALID_DATABASE']);
			});
		}
	);

	it.each(['High', 'Critical'])(
		'fails on unfixed %s findings and preserves the native report',
		async (severity) => {
			await withFixture(async (fixture) => {
				const { report } = await run(fixture, { severity });
				expect(report?.ok).toBe(false);
				const entry = report!.inventories[0];
				expect(entry.error?.code).toBe('SEVERITY_THRESHOLD');
				expect(entry.execution?.exitCode).toBe(2);
				expect(entry.findings).toEqual([
					expect.objectContaining({
						id: 'CVE-2099-0001',
						severity: severity.toLowerCase(),
						fix: { state: 'not-fixed', versions: [] },
					}),
				]);
				const bytes = await readFile(join(fixture.output, entry.execution!.stdoutFile));
				expect(hash(bytes)).toBe(entry.execution?.stdoutSha256);
				expect(JSON.parse(bytes.toString('utf8')).matches[0].vulnerability.severity).toBe(
					severity
				);
				expect(
					JSON.parse(await readFile(join(fixture.output, 'report.json'), 'utf8')).ok
				).toBe(false);
			});
		}
	);

	it('retains JSON and private stderr when the scanner fails below the severity threshold', async () => {
		await withFixture(async (fixture) => {
			const result = await run(fixture, { scanExit: 1 });
			expect(result.report?.ok).toBe(false);
			const entry = result.report!.inventories[0];
			expect(entry.error?.code).toBe('SCANNER_FAILED');
			expect(entry.counts?.medium).toBe(1);
			expect(entry.execution?.exitCode).toBe(1);
			expect(await readFile(join(fixture.output, entry.execution!.stderrFile), 'utf8')).toBe(
				'fixture-private-diagnostic'
			);
			expect(JSON.stringify(result)).not.toContain('fixture-private-diagnostic');
			expect(JSON.stringify(result)).not.toContain('fixture-only-never-a-real-key');
		});
	});
});
