import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '../../../src/core/errors.js';
import {
	readStableCredentialFile,
	canonicalCredentialOutputPath,
} from '../../../src/services/content-credentials/local-files.js';
import { makeCredentialDirectoryPrivate } from '../../../src/services/content-credentials/key-access.js';
import { credentialProcessEnvironment } from '../../../src/services/content-credentials/process-environment.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let directory: string;
let source: string;
beforeEach(async () => {
	directory = await fs.mkdtemp(join(tmpdir(), 'credential-files-'));
	source = join(directory, 'source.txt');
	await fs.writeFile(source, 'Original source');
});
afterEach(async () => {
	jest.restoreAllMocks();
	await fs.rm(directory, { recursive: true, force: true });
});

it.each(['growth', 'replacement'])(
	'rejects real filesystem %s during descriptor reads and permits a fresh read',
	async (kind) => {
		const probe = await fs.open(source, 'r');
		const prototype = Object.getPrototypeOf(probe) as FileHandle;
		await probe.close();
		const originalRead = prototype.read;
		let changed = false;
		const intercepted = jest.spyOn(prototype, 'read').mockImplementation(async function (
			this: FileHandle,
			...args: unknown[]
		) {
			const result = await Reflect.apply(originalRead, this, args);
			if (!changed) {
				changed = true;
				if (kind === 'growth') await fs.appendFile(source, ' expanded');
				else {
					await fs.rename(source, join(directory, 'previous.txt'));
					await fs.writeFile(source, 'Replacement source');
				}
			}
			return result;
		} as FileHandle['read']);
		try {
			await expect(readStableCredentialFile(source, 4096, 'Fixture')).rejects.toMatchObject({
				code: ErrorCode.INVALID_STATE,
			});
		} finally {
			intercepted.mockRestore();
		}
		const expected = kind === 'growth' ? 'Original source expanded' : 'Replacement source';
		expect((await readStableCredentialFile(source, 4096, 'Fixture')).bytes.toString()).toBe(
			expected
		);
	}
);

it('rejects device namespaces and local or remote Windows named pipes before opening', async () => {
	for (const file of [
		'\\\\.\\pipe\\writer.png',
		'\\\\?\\pipe\\writer.png',
		'\\\\?\\GLOBALROOT\\Device\\writer.png',
		'\\\\server\\pipe\\writer.png',
	])
		await expect(readStableCredentialFile(file, 4096, 'Fixture')).rejects.toMatchObject({
			code: ErrorCode.PATH_INVALID,
		});
});

it.each([
	String.raw`\\host.invalid\share\asset.png`,
	String.raw`\\?\UNC\host.invalid\share\asset.png`,
	'//host.invalid/share/asset.png',
])('rejects network credential locations before filesystem access: %s', async (file) => {
	jest.spyOn(fs, 'open').mockRejectedValue(new Error('Unexpected filesystem access'));
	jest.spyOn(fs, 'realpath').mockRejectedValue(new Error('Unexpected filesystem access'));
	await expect(readStableCredentialFile(file, 4096, 'Asset')).rejects.toMatchObject({
		code: ErrorCode.PATH_INVALID,
		message: expect.stringContaining('not network locations'),
	});
	await expect(canonicalCredentialOutputPath(file)).rejects.toMatchObject({
		code: ErrorCode.PATH_INVALID,
		message: expect.stringContaining('not network locations'),
	});
});

it('rejects a key readable by other accounts and accepts a restricted replacement', async () => {
	await makeCredentialDirectoryPrivate(directory);
	await fs.rm(source);
	await fs.writeFile(source, 'Synthetic secret fixture', { mode: 0o600 });
	expect(
		(await readStableCredentialFile(source, 4096, 'Key', { privateKey: true })).bytes.toString()
	).toBe('Synthetic secret fixture');
	if (process.platform === 'win32') {
		await promisify(execFile)(
			join(process.env.SystemRoot!, 'System32/icacls.exe'),
			[source, '/grant', '*S-1-1-0:R'],
			{ timeout: 5000 }
		);
	} else await fs.chmod(source, 0o644);
	await expect(
		readStableCredentialFile(source, 4096, 'Key', { privateKey: true })
	).rejects.toMatchObject({ code: ErrorCode.CONFIGURATION_ERROR });
});

it('keeps secrets and executable configuration out of credential child processes', async () => {
	const supplied = {
		SCRIVENER_C2PA_KEY_PASSWORD: 'Synthetic credential boundary test',
		NODE_OPTIONS: '--require=untrusted-preload.cjs',
		PSModulePath: join(directory, 'untrusted-modules'),
	};
	const original = new Map(Object.keys(supplied).map((name) => [name, process.env[name]]));
	try {
		Object.assign(process.env, supplied);
		const environment = credentialProcessEnvironment();
		const result = await promisify(execFile)(
			process.execPath,
			['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'],
			{ env: environment, timeout: 5000 }
		);
		const names = JSON.parse(result.stdout) as string[];
		expect(names).not.toContain('SCRIVENER_C2PA_KEY_PASSWORD');
		expect(names).not.toContain('NODE_OPTIONS');
		if (process.platform === 'win32')
			expect(environment.PSModulePath).toBe(
				join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/Modules')
			);
		else expect(names).not.toContain('PSModulePath');
	} finally {
		for (const [name, value] of original) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
