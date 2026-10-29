import { describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const posix = process.platform === 'win32' ? describe.skip : describe;
const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

function bootstrap(
	directory: string,
	env: NodeJS.ProcessEnv
): Promise<{
	code: number;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolveResult, reject) => {
		execFile(
			'/bin/sh',
			[resolve(__dirname, '../../scripts/bootstrap-mac.sh'), '--check'],
			{ cwd: directory, env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 32768 },
			(error, stdout, stderr) => {
				if (error) {
					if (error.killed || typeof error.code !== 'number') reject(error);
					else resolveResult({ code: error.code, stdout, stderr });
				} else resolveResult({ code: 0, stdout, stderr });
			}
		);
	});
}

posix('standalone bootstrap runtime selection', () => {
	it.each([
		{ version: '22.13.999', napi: '10', accepted: false },
		{ version: '22.14.0', napi: '10', accepted: false },
		{ version: '22.23.3', napi: '10', accepted: false },
		{ version: '22.23.4', napi: '10', accepted: true },
		{ version: '22.23.5', napi: '10', accepted: true },
		{ version: '23.5.99', napi: '10', accepted: false },
		{ version: '23.6.0', napi: '10', accepted: false },
		{ version: '23.99.99', napi: '10', accepted: false },
		{ version: '24.22.0', napi: '10', accepted: false },
		{ version: '24.22.1', napi: '10', accepted: true },
		{ version: '24.22.2', napi: '10', accepted: true },
		{ version: '25.99.99', napi: '10', accepted: false },
		{ version: '26.12.0', napi: '10', accepted: false },
		{ version: '26.12.1', napi: '10', accepted: true },
		{ version: '26.12.2', napi: '10', accepted: true },
		{ version: '27.0.0', napi: '10', accepted: true },
		{ version: '26.12.1-rc.1', napi: '10', accepted: false },
		{ version: '24.22.1', napi: '9', accepted: false },
		{ version: '9007199254740992.0.0', napi: '10', accepted: false },
	])('checks stable Node $version and N-API $napi before invoking setup', async (fixture) => {
		const directory = await mkdtemp(join(tmpdir(), 'scrivener-bootstrap-'));
		try {
			const bin = join(directory, '.scrivener-mcp', 'node', 'bin');
			const tools = join(directory, 'offline tools');
			const preload = join(directory, 'runtime fixture.cjs');
			const npxRecord = join(directory, 'npx-arguments.txt');
			const curlRecord = join(directory, 'curl-blocked.txt');
			await mkdir(bin, { recursive: true });
			await mkdir(tools);
			await writeFile(
				preload,
				`Object.defineProperties(process.versions, {
					node: { value: process.env.FIXTURE_NODE_VERSION, configurable: true },
					napi: { value: process.env.FIXTURE_NODE_NAPI, configurable: true }
				});`
			);
			await writeFile(
				join(bin, 'node'),
				`#!/bin/sh\nexec ${shellQuote(process.execPath)} --require ${shellQuote(preload)} "$@"\n`,
				{ mode: 0o700 }
			);
			await writeFile(
				join(bin, 'npx'),
				'#!/bin/sh\nprintf "%s\\n" "$@" > "$FIXTURE_NPX_RECORD"\n',
				{ mode: 0o700 }
			);
			await writeFile(
				join(tools, 'curl'),
				'#!/bin/sh\nprintf "network disabled\\n" > "$FIXTURE_CURL_RECORD"\nexit 22\n',
				{ mode: 0o700 }
			);
			const result = await bootstrap(directory, {
				HOME: directory,
				TMPDIR: directory,
				PATH: `${tools}:/usr/bin:/bin`,
				SCRIVENER_ASSUME_YES: '1',
				SCRIVENER_IGNORE_SYSTEM_NODE: '1',
				SCRIVENER_SETUP_PACKAGE: 'fixture-never-installed',
				FIXTURE_NODE_VERSION: fixture.version,
				FIXTURE_NODE_NAPI: fixture.napi,
				FIXTURE_NPX_RECORD: npxRecord,
				FIXTURE_CURL_RECORD: curlRecord,
			});
			expect(result.code).toBe(fixture.accepted ? 0 : 1);
			expect(existsSync(npxRecord)).toBe(fixture.accepted);
			expect(existsSync(curlRecord)).toBe(!fixture.accepted);
			if (fixture.accepted) {
				expect((await readFile(npxRecord, 'utf8')).trim().split('\n')).toEqual([
					'-y',
					'-p',
					'fixture-never-installed',
					'scrivener-setup',
					'--check',
				]);
			} else {
				expect(result.stderr).toContain('Could not reach nodejs.org');
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
