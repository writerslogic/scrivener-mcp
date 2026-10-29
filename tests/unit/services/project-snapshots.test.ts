import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ProjectSnapshots } from '../../../src/services/project-snapshots.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';

const DOCUMENT = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT = '2026-10-29-12-00-00+0000';
const LIMIT = 64 * 1024 * 1024;
const SENTINEL = 'EXTERNAL_PRIVATE_SENTINEL';
let root: string;
let project: string;
let directory: string;
let file: string;
let index: string;
let snapshots: ProjectSnapshots;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-snapshot-guards-'));
	project = path.join(root, 'Book.scriv');
	directory = path.join(project, 'Snapshots', `${DOCUMENT}.snapshots`);
	file = path.join(directory, `${SNAPSHOT}.rtf`);
	index = path.join(directory, 'index.xml');
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(file, new RTFHandler().convertToRTF('Snapshot scene. Café 🌙'));
	await fs.writeFile(
		index,
		'<Snapshots><Snapshot><Title>Before revision</Title><Date>2026-10-29 12:00:00 +0000</Date></Snapshot></Snapshots>'
	);
	snapshots = new ProjectSnapshots(
		project,
		async () => [],
		async () => 'Current scene.'
	);
});

afterEach(async () => {
	jest.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

test('reads native metadata and text without opening an editorial database', async () => {
	expect(await snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).toMatchObject({
		title: 'Before revision',
		text: 'Snapshot scene. Café 🌙',
		snapshotId: SNAPSHOT,
	});
	await expect(fs.lstat(path.join(project, '.scrivener-mcp'))).rejects.toMatchObject({
		code: 'ENOENT',
	});
	await fs.rename(file, path.join(directory, `${SNAPSHOT}.RTF`));
	expect((await snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).text).toBe('Snapshot scene. Café 🌙');
});

test('keeps missing metadata and missing snapshots as ordinary absence', async () => {
	await fs.unlink(index);
	expect(await snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).toMatchObject({
		title: '',
		date: SNAPSHOT,
	});
	await fs.rm(path.join(project, 'Snapshots'), { recursive: true });
	expect(await snapshots.listSnapshots()).toEqual([]);
	await expect(snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).rejects.toMatchObject({
		code: 'NOT_FOUND',
	});
});

test.each(['Snapshots', 'document'] as const)(
	'rejects a %s directory junction that redirects outside the project',
	async (kind) => {
		const outside = path.join(root, 'outside');
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'sentinel.rtf'), SENTINEL);
		const target = kind === 'Snapshots' ? path.join(project, 'Snapshots') : directory;
		await fs.rm(target, { recursive: true });
		await fs.symlink(outside, target, 'junction');
		await expect(snapshots.listSnapshots(DOCUMENT)).rejects.toThrow(/symlink/i);
		await expect(snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).rejects.toThrow(/symlink/i);
		expect(await fs.readFile(path.join(outside, 'sentinel.rtf'), 'utf8')).toBe(SENTINEL);
		await expect(fs.lstat(path.join(project, '.scrivener-mcp'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	}
);

const symlinkTest = process.platform === 'win32' ? test.skip : test;
symlinkTest.each(['rtf', 'index'] as const)(
	'rejects an external %s symlink before reading its contents',
	async (kind) => {
		const outside = path.join(root, 'external-private-file');
		await fs.writeFile(outside, SENTINEL);
		const target = kind === 'rtf' ? file : index;
		await fs.unlink(target);
		await fs.symlink(outside, target, 'file');
		for (const operation of [
			() => snapshots.listSnapshots(DOCUMENT),
			() => snapshots.readSnapshot(DOCUMENT, SNAPSHOT),
		]) {
			let failure: unknown;
			try {
				await operation();
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toMatch(/symlink/i);
			expect((failure as Error).message).not.toContain(SENTINEL);
		}
		expect(await fs.readFile(outside, 'utf8')).toBe(SENTINEL);
	}
);

test.each(['rtf', 'index', 'container'] as const)(
	'rejects a nonregular %s path explicitly',
	async (kind) => {
		const target = kind === 'rtf' ? file : kind === 'index' ? index : directory;
		await fs.rm(target, { recursive: true });
		if (kind === 'container') await fs.writeFile(target, 'not a directory');
		else await fs.mkdir(target);
		await expect(snapshots.listSnapshots(DOCUMENT)).rejects.toThrow(/regular|directory/i);
		await expect(snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).rejects.toThrow(
			/regular|directory/i
		);
	}
);

test.each([-1, 0, 1])(
	'bounds listed snapshot sizes at 64 MiB plus %i without reading their bodies',
	async (delta) => {
		const handle = await fs.open(file, 'r+');
		try {
			await handle.truncate(LIMIT + delta);
		} finally {
			await handle.close();
		}
		if (delta <= 0)
			expect((await snapshots.listSnapshots(DOCUMENT))[0].snapshots).toHaveLength(1);
		else {
			await expect(snapshots.listSnapshots(DOCUMENT)).rejects.toThrow(/64 MiB/);
			await expect(snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).rejects.toThrow(/64 MiB/);
		}
	}
);

test('rejects an oversized index through the common bounded artifact reader', async () => {
	const handle = await fs.open(index, 'r+');
	try {
		await handle.truncate(LIMIT + 1);
	} finally {
		await handle.close();
	}
	await expect(snapshots.listSnapshots(DOCUMENT)).rejects.toThrow(/supported regular file/);
	await expect(snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).rejects.toThrow(
		/supported regular file/
	);
});

test('propagates directory I/O failures instead of silently reporting no snapshots', async () => {
	jest.spyOn(fs, 'opendir').mockRejectedValueOnce(
		Object.assign(new Error('Access denied'), { code: 'EACCES' })
	);
	await expect(snapshots.listSnapshots(DOCUMENT)).rejects.toMatchObject({ code: 'EACCES' });
});

test.each([9999, 10000, 10001])(
	'bounds directory enumeration and releases its iterator at %i entries',
	async (count) => {
		let closed = false;
		const entries = (async function* () {
			try {
				for (let index = 0; index < count; index++) yield { name: `unrelated-${index}` };
			} finally {
				closed = true;
			}
		})();
		jest.spyOn(fs, 'opendir').mockResolvedValueOnce(
			entries as unknown as Awaited<ReturnType<typeof fs.opendir>>
		);
		const operation = snapshots.listSnapshots(DOCUMENT);
		if (count > 10000) await expect(operation).rejects.toThrow(/exceeds 10000 entries/);
		else await expect(operation).resolves.toEqual([]);
		expect(closed).toBe(true);
	}
);

const fifoTest = process.platform === 'win32' ? test.skip : test;
fifoTest.each(['rtf', 'index'] as const)(
	'rejects a %s FIFO without waiting for a writer',
	async (kind) => {
		const target = kind === 'rtf' ? file : index;
		await fs.unlink(target);
		await promisify(execFile)('mkfifo', [target], { timeout: 5000 });
		await expect(snapshots.readSnapshot(DOCUMENT, SNAPSHOT)).rejects.toThrow(/regular file/);
	}
);
