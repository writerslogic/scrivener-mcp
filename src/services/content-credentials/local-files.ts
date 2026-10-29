import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { createError, ErrorCode, ApplicationError } from '../../core/errors.js';
import { CREDENTIAL_LIMITS } from './limits.js';

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

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
	label: string
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
	if (/^\\\\\.\\|^\\\\\?\\(?:pipe|GLOBALROOT)(?:\\|$)|^\\\\[^\\]+\\pipe(?:\\|$)/iu.test(filePath))
		throw createError(
			ErrorCode.PATH_INVALID,
			undefined,
			'Credential input must be a regular local asset, not a device or named pipe'
		);
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
