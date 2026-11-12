import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const root = resolve(__dirname, '../../..');
const sourceRequire = createRequire(join(root, 'package.json'));
const executable = join(root, 'src/cli/content-credentials.ts');
let directory: string;

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'scrivener-assessment-cli-'));
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function command(args: string[], entry = executable) {
	return promisify(execFile)(
		process.execPath,
		['--import', pathToFileURL(sourceRequire.resolve('tsx')).href, entry, ...args],
		{
			cwd: directory,
			timeout: 30000,
			killSignal: 'SIGKILL',
			maxBuffer: 65536,
			windowsHide: true,
			env: {
				...getDefaultEnvironment(),
				SCRIVENER_LOCAL_ONLY: 'true',
				SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
				SCRIVENER_RUN_LIVE_AI_TESTS: '0',
				UV_THREADPOOL_SIZE: '1',
				RAYON_NUM_THREADS: '1',
				OMP_NUM_THREADS: '1',
			},
		}
	).then(
		({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
		(error: { code: unknown; stdout?: string; stderr?: string }) => ({
			code: error.code,
			stdout: error.stdout ?? '',
			stderr: error.stderr ?? '',
		})
	);
}

test('advertises the explicit assessment version and required native evidence', async () => {
	const result = await command(['--help']);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain('--crjson-version 2.4 --out ABS --native-out ABS');
	expect(result.stdout).toContain('Default output preserves native SDK crJSON');
});

test.each([
	['--crjson-version', '2.5'],
	['--crjson-version', '2.4'],
	['--crjson-version', '2.4', '--out', '/missing/report.json'],
	['--native-out', '/missing/native.json'],
])(
	'rejects unsupported or incomplete assessment options before reading inputs: %j',
	async (...args) => {
		const result = await command(['validate', '--time', '2026-10-31T00:00:00Z', ...args]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
	}
);

test('rejects an existing destination before attempting native validation', async () => {
	const report = join(directory, 'existing.json');
	await writeFile(report, 'original');
	const result = await command([
		'validate',
		'--time',
		'2026-10-31T00:00:00Z',
		'--crjson-version',
		'2.4',
		'--out',
		report,
		'--native-out',
		join(directory, 'native.json'),
	]);
	expect(result.code).toBe(1);
	expect(JSON.parse(result.stderr)).toMatchObject({ code: 'FILE_WRITE_ERROR' });
	expect(await readFile(report, 'utf8')).toBe('original');
});

test('does not accept assessment flags on a key command', async () => {
	const result = await command([
		'keygen',
		'--crjson-version',
		'2.4',
		'--out',
		join(directory, 'key.pem'),
	]);
	expect(result.code).toBe(1);
	await expect(readFile(join(directory, 'key.pem'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('help does not import credential validation, assessment or private-key implementations', async () => {
	const isolated = join(directory, 'help-only');
	await mkdir(join(isolated, 'cli'), { recursive: true });
	await mkdir(join(isolated, 'services', 'content-credentials'), { recursive: true });
	await mkdir(join(isolated, 'core'), { recursive: true });
	await writeFile(join(isolated, 'package.json'), '{"type":"module"}');
	const entry = join(isolated, 'cli', 'content-credentials.ts');
	await copyFile(executable, entry);
	const modules: Record<string, string> = {
		'core/errors.ts':
			'export class ApplicationError extends Error {}; export const ErrorCode = {}; export const createError = () => new Error();',
		'services/content-credentials/limits.ts':
			'export const CREDENTIAL_LIMITS = {}; export const MAX_CONFIGURATION_BYTES = 1;',
		'services/content-credentials/local-files.ts':
			'export const readStableCredentialFile = () => {throw new Error("Unexpected file read")}; export const writeExclusiveCredentialFile = () => {throw new Error("Unexpected file write")};',
		'services/content-credentials/crjson-assessment-files.ts':
			'export const prepareCrjsonAssessmentFiles = () => {throw new Error("Unexpected output preparation")};',
	};
	for (const name of ['service', 'key-policy', 'crjson-assessment'])
		modules[`services/content-credentials/${name}.ts`] =
			'throw new Error("Heavy implementation loaded during help");';
	for (const [name, content] of Object.entries(modules))
		await writeFile(join(isolated, name), content);
	const result = await command(['--help'], entry);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	expect(result.stdout).toContain('--crjson-version 2.4 --out ABS --native-out ABS');
});
