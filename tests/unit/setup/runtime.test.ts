import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	chooseRuntime,
	serverEntry,
	stablePath,
	type NodeRuntime,
} from '../../../src/setup/runtime.js';

const rt = (major: number, npx: string | null, node = '/n/bin/node'): NodeRuntime => ({
	node,
	npx,
	version: `v${major}.0.0`,
	major,
	source: 'test',
});

describe('runtime selection', () => {
	it('prefers the running Node when it is new enough and has npx', () => {
		const current = rt(22, '/c/bin/npx', '/c/bin/node');
		expect(chooseRuntime([rt(24, '/n/bin/npx')], current)).toBe(current);
	});

	it('skips a running Node that is too old and uses a found one', () => {
		const found = rt(20, '/n/bin/npx');
		expect(chooseRuntime([found], rt(16, '/c/bin/npx'))).toBe(found);
	});

	it('skips candidates without npx and returns null when nothing is usable', () => {
		expect(chooseRuntime([rt(22, null)], rt(22, null))).toBeNull();
	});
});

describe('server entry', () => {
	it('uses absolute commands and a PATH that contains the Node directory', () => {
		const entry = serverEntry(rt(22, '/opt/homebrew/bin/npx', '/opt/homebrew/bin/node'));
		expect(entry.command).toBe('/opt/homebrew/bin/npx');
		expect(entry.args).toEqual(['-y', 'scrivener-mcp']);
		expect(entry.env?.PATH?.split(':')[0]).toBe('/opt/homebrew/bin');
	});
});

describe('stable path', () => {
	it('returns the PATH symlink instead of the versioned real file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'stable-'));
		const real = join(dir, 'Cellar', '1.0', 'bin');
		const link = join(dir, 'bin');
		mkdirSync(real, { recursive: true });
		mkdirSync(link, { recursive: true });
		writeFileSync(join(real, 'node'), '');
		symlinkSync(join(real, 'node'), join(link, 'node'));
		expect(stablePath(join(real, 'node'), [link])).toBe(join(link, 'node'));
	});

	it('returns the input when nothing stable points at it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'stable-'));
		writeFileSync(join(dir, 'node'), '');
		expect(stablePath(join(dir, 'node'), [])).toBe(join(dir, 'node'));
	});
});
