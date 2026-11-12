import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	type Stats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const MAX_CONFIG_BYTES = 1024 * 1024;
const BACKUP_MARK = '.scrivener-backup-';
const BACKUPS_KEPT = 3;
const BACKUP_SUFFIX =
	/^\d{17}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ConfigSnapshot {
	text: string | null;
	bytes: Buffer | null;
	stat: Stats | null;
}

function sameRevision(a: Stats, b: Stats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs
	);
}

export function readConfigFile(path: string): ConfigSnapshot {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return { text: null, bytes: null, stat: null };
		throw error;
	}
	if (!stat.isFile())
		throw new Error('Client configuration must be a regular file, not a symlink.');
	if (stat.size > MAX_CONFIG_BYTES)
		throw new Error(`Client configuration exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (!sameRevision(stat, fstatSync(fd)))
			throw new Error('Client configuration changed while reading. Run setup again.');
		const buffer = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (!read) break;
			length += read;
		}
		if (length > MAX_CONFIG_BYTES)
			throw new Error(`Client configuration exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
		if (!sameRevision(stat, fstatSync(fd)))
			throw new Error('Client configuration changed while reading. Run setup again.');
		const bytes = buffer.subarray(0, length);
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch {
			throw new Error(
				'Client configuration is not valid UTF-8. Repair it before running setup.'
			);
		}
		return { text, bytes, stat };
	} finally {
		closeSync(fd);
	}
}

function assertCurrent(path: string, expected: ConfigSnapshot): void {
	const current = readConfigFile(path);
	if (
		(current.stat === null) !== (expected.stat === null) ||
		(current.stat && expected.stat && !sameRevision(current.stat, expected.stat)) ||
		(current.bytes && expected.bytes && !current.bytes.equals(expected.bytes))
	)
		throw new Error('Client configuration changed before publication. Run setup again.');
}

function writeExclusive(path: string, content: string | Buffer): void {
	const fd = openSync(path, 'wx', 0o600);
	try {
		try {
			writeFileSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		try {
			unlinkSync(path);
		} catch {
			throw new Error(
				'Configuration staging and cleanup failed. Check filesystem permissions before running setup again.',
				{ cause: error }
			);
		}
		throw error;
	}
}

export function publishConfigFile(
	path: string,
	before: ConfigSnapshot,
	text: string
): { backup?: string; message?: string } {
	if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES)
		throw new Error(`Updated client configuration exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.scrivener-tmp-${randomUUID()}`;
	let saved: string | undefined;
	let failure: { error: unknown } | undefined;
	let cleanupFailed = false;
	try {
		writeExclusive(temp, text);
		assertCurrent(path, before);
		if (before.bytes !== null) {
			saved = `${path}${BACKUP_MARK}${new Date().toISOString().replace(/\D/g, '')}-${randomUUID()}`;
			writeExclusive(saved, before.bytes);
		}
		// External editors do not participate in a filesystem compare-and-swap protocol.
		assertCurrent(path, before);
		if (before.stat === null) linkSync(temp, path);
		else renameSync(temp, path);
	} catch (error) {
		failure = { error };
	} finally {
		try {
			unlinkSync(temp);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailed = true;
		}
	}
	if (failure) {
		if (cleanupFailed)
			throw new Error(
				'Configuration was not published; temporary-file cleanup failed. Run setup again after checking filesystem permissions.',
				{ cause: failure.error }
			);
		throw failure.error;
	}
	try {
		const prefix = basename(path) + BACKUP_MARK;
		const old = readdirSync(dirname(path))
			.filter(
				(file) =>
					file.startsWith(prefix) &&
					BACKUP_SUFFIX.test(file.slice(prefix.length)) &&
					file !== (saved ? basename(saved) : undefined)
			)
			.sort();
		for (const file of old.slice(
			0,
			Math.max(0, old.length - (saved ? BACKUPS_KEPT - 1 : BACKUPS_KEPT))
		))
			unlinkSync(join(dirname(path), file));
	} catch {
		cleanupFailed = true;
	}
	return {
		backup: saved,
		...(cleanupFailed
			? {
					message:
						'Configuration published; temporary-file or old-backup cleanup needs filesystem permission repair.',
				}
			: {}),
	};
}
