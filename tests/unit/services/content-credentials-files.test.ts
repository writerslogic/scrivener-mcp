import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '../../../src/core/errors.js';
import { readStableCredentialFile } from '../../../src/services/content-credentials/local-files.js';

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
