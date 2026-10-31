import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real ESM first-run import honors skipSetup without provisioning', async () => {
	const sourceRoot = resolve(__dirname, '../../..');
	const require = createRequire(join(sourceRoot, 'package.json'));
	const directory = await mkdtemp(join(tmpdir(), 'scrivener-first-run-import-'));
	try {
		const source = pathToFileURL(join(sourceRoot, 'src/services/auto-setup/first-run.ts')).href;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				'--import',
				pathToFileURL(require.resolve('tsx')).href,
				'--input-type=module',
				'--eval',
				`process.stderr.write('first-run-import: entered\\n');
const { FirstRunManager } = await import(${JSON.stringify(source)});
process.stderr.write('first-run-import: imported\\n');
const manager = new FirstRunManager();
await manager.initialize({ skipSetup: true });
process.stderr.write('first-run-import: initialized\\n');
process.stdout.write(JSON.stringify({ firstRun: manager.isFirstRun(), complete: await manager.isSetupComplete() }));`,
			],
			{
				cwd: directory,
				timeout: 30000,
				killSignal: 'SIGKILL',
				maxBuffer: 1024 * 1024,
				windowsHide: true,
				env: {
					...getDefaultEnvironment(),
					HOME: directory,
					USERPROFILE: directory,
					APPDATA: directory,
					LOCALAPPDATA: directory,
					XDG_CONFIG_HOME: directory,
					XDG_DATA_HOME: directory,
					SCRIVENER_DATA_DIR: join(directory, 'server-state'),
					SCRIVENER_HMS_ENGINE: 'fallback',
					SCRIVENER_LOCAL_ONLY: 'true',
					SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
					NODE_ENV: 'test',
					UV_THREADPOOL_SIZE: '1',
					RAYON_NUM_THREADS: '1',
					OMP_NUM_THREADS: '1',
				},
			}
		).catch((cause: unknown) => {
			const failure = cause as NodeJS.ErrnoException & {
				signal?: NodeJS.Signals;
				killed?: boolean;
				stdout?: string | Buffer;
				stderr?: string | Buffer;
			};
			throw new Error(
				`ESM first-run subprocess failed: ${JSON.stringify({
					code: failure.code ?? null,
					signal: failure.signal ?? null,
					killed: failure.killed ?? false,
					stdout: String(failure.stdout ?? '').slice(-4096),
					stderr: String(failure.stderr ?? '').slice(-8192),
				})}`,
				{ cause }
			);
		});
		expect(JSON.parse(stdout)).toEqual({ firstRun: true, complete: false });
		for (const file of ['setup.json', '.first-run-complete'])
			await expect(readFile(join(directory, '.scrivener-mcp', file))).rejects.toMatchObject({
				code: 'ENOENT',
			});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);
