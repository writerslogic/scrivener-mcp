import { execFile } from 'node:child_process';
import { type BigIntStats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { credentialProcessEnvironment } from './process-environment.js';

const execute = promisify(execFile);
let principal: Promise<string> | undefined;

function accessCommandError(error: unknown): Error {
	const reason =
		error instanceof SyntaxError
			? 'invalid-response'
			: error && typeof error === 'object' && 'killed' in error && error.killed === true
				? 'timeout'
				: error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
					? 'unavailable'
					: 'command-failed';
	return new Error(`SIGNER_KEY_ACCESS_INVALID:${reason}`);
}

async function powershell(script: string): Promise<unknown> {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('SIGNER_KEY_ACCESS_INVALID');
	try {
		const pending = execute(
			join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
			[
				'-NoProfile',
				'-NonInteractive',
				'-EncodedCommand',
				Buffer.from(
					`$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\\Modules';${script}`,
					'utf16le'
				).toString('base64'),
			],
			{
				timeout: 15000,
				maxBuffer: 32768,
				windowsHide: true,
				env: {
					...credentialProcessEnvironment(),
					PATH: join(systemRoot, 'System32'),
				},
			}
		);
		pending.child.stdin?.end();
		return JSON.parse((await pending).stdout);
	} catch (error) {
		throw accessCommandError(error);
	}
}

function sid(value: unknown): value is string {
	return typeof value === 'string' && value.length < 192 && /^S-\d+(?:-\d+){1,15}$/u.test(value);
}

async function currentPrincipal(): Promise<string> {
	if (!principal) {
		principal = powershell(
			'[Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress'
		).then((value) => {
			if (!sid(value)) throw new Error('SIGNER_KEY_ACCESS_INVALID');
			return value;
		});
		principal.catch(() => {
			principal = undefined;
		});
	}
	return principal;
}

export async function makeCredentialDirectoryPrivate(directory: string): Promise<void> {
	if (process.platform !== 'win32') return;
	const user = await currentPrincipal();
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR!;
	try {
		const pending = execute(
			join(systemRoot, 'System32/icacls.exe'),
			[
				directory,
				'/inheritance:r',
				'/grant:r',
				`*${user}:(OI)(CI)F`,
				'*S-1-5-18:(OI)(CI)F',
				'*S-1-5-32-544:(OI)(CI)F',
			],
			{
				timeout: 5000,
				maxBuffer: 32768,
				windowsHide: true,
				env: credentialProcessEnvironment(),
			}
		);
		pending.child.stdin?.end();
		await pending;
	} catch (error) {
		throw accessCommandError(error);
	}
}

export async function assertCredentialKeyAccess(
	file: string,
	metadata: BigIntStats
): Promise<void> {
	if (process.platform !== 'win32') {
		if (
			!process.getuid ||
			metadata.uid !== BigInt(process.getuid()) ||
			(metadata.mode & 0o077n) !== 0n
		)
			throw new Error('SIGNER_KEY_ACCESS_INVALID');
		return;
	}
	const encoded = Buffer.from(file, 'utf8').toString('base64');
	const result = await powershell(
		`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$a=Get-Acl -LiteralPath $p;[pscustomobject]@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;entries=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{[pscustomobject]@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');rights=[int]$_.FileSystemRights}})}|ConvertTo-Json -Depth 4 -Compress`
	);
	if (
		!result ||
		typeof result !== 'object' ||
		!('owner' in result) ||
		!('user' in result) ||
		!('entries' in result) ||
		!sid(result.user) ||
		!sid(result.owner) ||
		!Array.isArray(result.entries) ||
		result.entries.length > 128
	)
		throw new Error('SIGNER_KEY_ACCESS_INVALID');
	const allowed = new Set([result.user, 'S-1-5-18', 'S-1-5-32-544']);
	if (!allowed.has(result.owner)) throw new Error('SIGNER_KEY_ACCESS_INVALID');
	for (const entry of result.entries) {
		if (
			!entry ||
			typeof entry !== 'object' ||
			!sid(entry.sid) ||
			typeof entry.allow !== 'boolean' ||
			!Number.isSafeInteger(entry.rights) ||
			(entry.allow && !allowed.has(entry.sid) && entry.rights !== 0)
		)
			throw new Error('SIGNER_KEY_ACCESS_INVALID');
	}
}
