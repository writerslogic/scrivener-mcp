import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import {
	chooseRuntime,
	serverEntry,
	stablePath,
	isSupportedRuntime,
	type NodeRuntime,
} from '../../../src/setup/runtime.js';

const rt = (major: number, npx: string | null, node = '/n/bin/node'): NodeRuntime => ({
	node,
	npx,
	version: major === 22 ? 'v22.14.0' : `v${major}.0.0`,
	major,
	source: 'test',
});

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'scrivener-runtime-'));
	temporaryDirectories.push(directory);
	return directory;
}

function withPlatform(platform: NodeJS.Platform, operation: () => void): void {
	const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
	Object.defineProperty(process, 'platform', {
		configurable: true,
		enumerable: descriptor.enumerable,
		value: platform,
	});
	try {
		operation();
	} finally {
		Object.defineProperty(process, 'platform', descriptor);
	}
}

function runtimeFiles(
	platform: NodeJS.Platform,
	bundledNpm = true
): {
	runtime: NodeRuntime;
	npxCli: string;
} {
	const bin = join(temporaryDirectory(), 'Node distribution');
	mkdirSync(bin);
	const node = join(bin, platform === 'win32' ? 'node.exe' : 'node');
	const npx = join(bin, platform === 'win32' ? 'npx.cmd' : 'npx');
	writeFileSync(node, '');
	writeFileSync(npx, '');
	const npxCli = join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js');
	if (platform === 'win32' && bundledNpm) {
		mkdirSync(dirname(npxCli), { recursive: true });
		writeFileSync(npxCli, '');
	}
	return { runtime: rt(22, npx, node), npxCli };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe('runtime selection', () => {
	it('prefers the running Node when it is new enough and has npx', () => {
		const current = rt(22, '/c/bin/npx', '/c/bin/node');
		expect(chooseRuntime([rt(24, '/n/bin/npx')], current)).toBe(current);
	});

	it('skips a running Node that is too old and uses a found one', () => {
		const found = rt(24, '/n/bin/npx');
		expect(chooseRuntime([found], rt(16, '/c/bin/npx'))).toBe(found);
	});

	it.each([
		{ major: 21, version: 'v21.99.99', expected: false },
		{ major: 22, version: 'v22.12.99', expected: false },
		{ major: 22, version: 'v22.13.0', expected: false },
		{ major: 22, version: 'v22.13.999', expected: false },
		{ major: 22, version: 'v22.14.0', expected: true },
		{ major: 22, version: 'v22.14.1', expected: true },
		{ major: 23, version: 'v23.0.0', expected: false },
		{ major: 23, version: 'v23.5.99', expected: false },
		{ major: 23, version: 'v23.6.0', expected: true },
		{ major: 23, version: 'v23.6.1', expected: true },
		{ major: 24, version: 'v24.0.0', expected: true },
		{ major: 26, version: 'v26.12.1', expected: true },
		{ major: 24, version: 'v22.12.0', expected: false },
		{ major: 22, version: 'v24.0.0', expected: false },
		{ major: 26, version: 'v26.0.0-nightly.20261028', expected: false },
		{ major: 26, version: 'v26.0.0+unverified', expected: false },
		{ major: 26, version: '26.invalid', expected: false },
		{ major: 26, version: 'v26.0.0junk', expected: false },
		{ major: 26, version: 'v026.0.0', expected: false },
		{ major: 26, version: `v26.${'9'.repeat(64)}.0`, expected: false },
	])(
		'enforces the runtime floor for major $major at $version',
		({ major, version, expected }) => {
			expect(isSupportedRuntime({ ...rt(major, '/n/bin/npx'), version })).toBe(expected);
		}
	);

	it('skips candidates without npx and returns null when nothing is usable', () => {
		expect(chooseRuntime([rt(22, null)], rt(22, null))).toBeNull();
	});

	it('skips incompatible private and current runtimes before applying selection preferences', () => {
		const obsolete = { ...rt(22, '/private/npx'), version: 'v22.13.999', source: 'private' };
		const current = { ...rt(23, '/current/npx'), version: 'v23.5.99' };
		const supported = rt(24, '/supported/npx');
		expect(chooseRuntime([obsolete, current, supported], current)).toBe(supported);
		expect(chooseRuntime([obsolete, current], current)).toBeNull();
	});

	it('prefers a private runtime, otherwise selects the newest stable version numerically', () => {
		const privateRuntime = { ...rt(22, '/private/npx'), source: 'private' };
		const newest = { ...rt(26, '/new/npx'), version: 'v26.10.0' };
		const older = { ...rt(26, '/old/npx'), version: 'v26.9.9' };
		const nightly = { ...rt(27, '/nightly/npx'), version: 'v27.0.0-nightly.1' };
		expect(chooseRuntime([older, nightly, privateRuntime, newest], null)).toBe(privateRuntime);
		expect(chooseRuntime([older, nightly, newest], null)).toBe(newest);
	});
});

describe('server entry', () => {
	it.each(['darwin', 'win32'] as const)(
		'uses absolute %s commands and a PATH containing the Node directory',
		(platform) => {
			const { runtime, npxCli } = runtimeFiles(platform);
			withPlatform(platform, () => {
				const entry = serverEntry(runtime);
				expect(isAbsolute(entry.command)).toBe(true);
				expect(entry.command).toBe(platform === 'win32' ? runtime.node : runtime.npx);
				expect(entry.args).toEqual(
					platform === 'win32' ? [npxCli, '-y', 'scrivener-mcp'] : ['-y', 'scrivener-mcp']
				);
				expect(entry.env?.PATH?.split(delimiter)[0]).toBe(dirname(runtime.node));
			});
		}
	);

	it('reports an incomplete Windows npm distribution even when npx.cmd exists', () => {
		const { runtime } = runtimeFiles('win32', false);
		withPlatform('win32', () => {
			expect(() => serverEntry(runtime)).toThrow('npm npx-cli.js was not found beside Node');
		});
	});
});

describe('stable path', () => {
	it('returns the PATH symlink instead of the versioned real file', () => {
		const dir = temporaryDirectory();
		const real = join(dir, 'Cellar', '1.0', 'bin');
		const link = join(dir, 'bin');
		const executable = process.platform === 'win32' ? 'node.exe' : 'node';
		mkdirSync(real, { recursive: true });
		writeFileSync(join(real, executable), '');
		symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
		expect(stablePath(join(real, executable), [link])).toBe(join(link, executable));
	});

	it('returns the input when nothing stable points at it', () => {
		const dir = temporaryDirectory();
		const executable = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
		writeFileSync(executable, '');
		expect(stablePath(executable, [])).toBe(executable);
	});
});
