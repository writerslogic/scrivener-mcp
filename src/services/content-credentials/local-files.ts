import { constants, type BigIntStats } from 'node:fs';
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	realpath,
	rm,
	type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, basename } from 'node:path';
import { createError, ErrorCode, ApplicationError } from '../../core/errors.js';
import { CREDENTIAL_LIMITS } from './limits.js';
import { assertCredentialKeyAccess, makeCredentialDirectoryPrivate } from './key-access.js';

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function assertLocalCredentialPath(filePath: string): void {
	const normalized = filePath.replace(/\//gu, '\\');
	if (
		/^\\\\\.\\|^\\\\\?\\(?:pipe|GLOBALROOT)(?:\\|$)/iu.test(normalized) ||
		(normalized.startsWith('\\\\') && !/^\\\\\?\\[a-z]:\\/iu.test(normalized))
	)
		throw createError(
			ErrorCode.PATH_INVALID,
			undefined,
			'Credential paths must identify local files, not network locations, devices or named pipes'
		);
}

function acquireReadHandle(filePath: string): Promise<FileHandle> {
	return open(filePath, READ_FLAGS, 0o600);
}

function identity(stat: BigIntStats): string {
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

export async function assertCredentialFileUnchanged(
	filePath: string,
	expected: string
): Promise<void> {
	const current = await lstat(filePath, { bigint: true });
	if (!current.isFile() || current.isSymbolicLink() || identity(current) !== expected)
		throw createError(
			ErrorCode.INVALID_STATE,
			undefined,
			'Source changed while credentials were processed; retry with the saved asset'
		);
}

export async function readStableCredentialFile(
	filePath: string,
	limit: number,
	label: string,
	options: { privateKey?: boolean } = {}
): Promise<{ bytes: Buffer; identity: string }> {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > CREDENTIAL_LIMITS.assetBytes + CREDENTIAL_LIMITS.manifestBytes
	)
		throw createError(
			ErrorCode.INVALID_INPUT,
			undefined,
			'Invalid credential file allocation limit'
		);
	assertLocalCredentialPath(filePath);
	let buffer: Buffer | undefined;
	let handle: FileHandle | undefined;
	let verification: FileHandle | undefined;
	let outcome: { value: { bytes: Buffer; identity: string } } | { error: unknown };
	try {
		handle = await acquireReadHandle(filePath);
		if (process.platform === 'win32') verification = await acquireReadHandle(filePath);
		const [before, entry, verified] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(filePath, { bigint: true }),
			verification?.stat({ bigint: true }),
		]);
		if (!before.isFile() || !entry.isFile() || entry.isSymbolicLink())
			throw createError(
				ErrorCode.INVALID_FORMAT,
				undefined,
				`${label} must be a regular file without a symbolic link`
			);
		if (options.privateKey) {
			try {
				await assertCredentialKeyAccess(filePath, before);
			} catch {
				throw createError(
					ErrorCode.CONFIGURATION_ERROR,
					undefined,
					'Signing key access must be restricted to its owner and trusted system administrators'
				);
			}
		}
		if (before.size > BigInt(limit))
			throw createError(
				ErrorCode.DOCUMENT_TOO_LARGE,
				undefined,
				`${label} exceeds its supported size`
			);
		if (
			before.ino !== entry.ino ||
			(process.platform !== 'win32' && before.dev !== entry.dev) ||
			(verified && identity(verified) !== identity(before))
		)
			throw createError(ErrorCode.INVALID_STATE, undefined, `${label} changed while opening`);
		buffer = Buffer.alloc(Number(before.size) + 1);
		let count = 0;
		while (count < buffer.length) {
			const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
			if (!bytesRead) break;
			count += bytesRead;
		}
		const [after, current] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(filePath, { bigint: true }),
		]);
		if (
			count !== Number(before.size) ||
			identity(after) !== identity(before) ||
			current.isSymbolicLink() ||
			identity(current) !== identity(entry)
		)
			throw createError(
				ErrorCode.INVALID_STATE,
				undefined,
				`${label} changed while reading; retry with the saved asset`
			);
		outcome = { value: { bytes: buffer.subarray(0, count), identity: identity(current) } };
	} catch (error) {
		buffer?.fill(0);
		outcome = {
			error:
				error instanceof ApplicationError
					? error
					: (error as NodeJS.ErrnoException)?.code === 'ELOOP'
						? createError(
								ErrorCode.INVALID_FORMAT,
								undefined,
								`${label} must be a regular file without a symbolic link`
							)
						: createError(
								ErrorCode.IO_ERROR,
								undefined,
								'Credential input could not be read safely'
							),
		};
	}
	const closed = await Promise.allSettled([handle?.close(), verification?.close()]);
	if (closed.some((result) => result.status === 'rejected')) {
		buffer?.fill(0);
		throw createError(
			ErrorCode.IO_ERROR,
			undefined,
			'Credential input descriptors could not be closed'
		);
	}
	if ('error' in outcome) throw outcome.error;
	return outcome.value;
}

export function protectCredentialOutputPath(filePath: string, allowProjectExports = true): void {
	const segments = filePath.split(/[\\/]/u);
	const index = segments.findIndex((part) => part.toLowerCase().endsWith('.scriv'));
	if (
		index >= 0 &&
		(!allowProjectExports ||
			segments[index + 1] !== '.scrivener-mcp' ||
			segments[index + 2] !== 'exports')
	)
		throw createError(
			ErrorCode.PATH_INVALID,
			undefined,
			'Credential output must not modify Scrivener internals'
		);
}

export async function canonicalCredentialOutputPath(filePath: string): Promise<string> {
	assertLocalCredentialPath(filePath);
	let ancestor = dirname(filePath);
	const suffix = [basename(filePath)];
	while (true) {
		try {
			return join(await realpath(ancestor), ...suffix);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException)?.code !== 'ENOENT' ||
				ancestor === dirname(ancestor)
			)
				throw createError(
					ErrorCode.PATH_INVALID,
					undefined,
					'Output directory cannot be resolved safely'
				);
			suffix.unshift(basename(ancestor));
			ancestor = dirname(ancestor);
		}
	}
}

export async function writeExclusiveCredentialFile(
	filePath: string,
	bytes: Buffer,
	options: { allowProjectExports?: boolean } = {}
): Promise<void> {
	if (
		!isAbsolute(filePath) ||
		filePath.length > 4096 ||
		filePath.includes('\0') ||
		!Buffer.isBuffer(bytes) ||
		!bytes.length ||
		bytes.length > CREDENTIAL_LIMITS.assetBytes + CREDENTIAL_LIMITS.manifestBytes
	)
		throw createError(
			ErrorCode.INVALID_INPUT,
			undefined,
			'Invalid credential output path or size'
		);
	protectCredentialOutputPath(filePath, options.allowProjectExports);
	protectCredentialOutputPath(
		await canonicalCredentialOutputPath(filePath),
		options.allowProjectExports
	);
	await mkdir(dirname(filePath), { recursive: true });
	const parent = await realpath(dirname(filePath));
	protectCredentialOutputPath(join(parent, basename(filePath)), options.allowProjectExports);
	const stage = await mkdtemp(join(parent, '.scrivener-credentials-'));
	try {
		await chmod(stage, 0o700);
		await makeCredentialDirectoryPrivate(stage);
		const temporary = join(stage, 'output');
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temporary, join(parent, basename(filePath)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === 'EEXIST')
				throw createError(
					ErrorCode.FILE_WRITE_ERROR,
					undefined,
					'Output already exists; choose a new path rather than overwrite an asset'
				);
			throw error;
		}
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}
