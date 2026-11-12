import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MAX_CONFIG_BYTES,
	publishConfigFile,
	readConfigFile,
} from '../../../src/setup/config-file.js';
import {
	CLIENTS,
	configureClient,
	removeFromClient,
	type ClientSpec,
} from '../../../src/setup/clients.js';

let directory: string;
let file: string;
let client: ClientSpec;
const original = '{"preferences":{"theme":"dark"},"mcpServers":{"other":{"command":"local"}}}\n';
const entry = { command: 'npx', args: ['scrivener-mcp'] };

beforeEach(() => {
	directory = fs.mkdtempSync(join(tmpdir(), 'scrivener-config-publication-'));
	file = join(directory, 'config.json');
	client = { ...CLIENTS[0], configPath: () => file };
});
afterEach(() => {
	jest.restoreAllMocks();
	fs.rmSync(directory, { recursive: true, force: true });
});

const leftovers = () =>
	fs.readdirSync(directory).filter((name) => name.includes('.scrivener-tmp-'));

describe('shared client configuration publication', () => {
	it('preserves unrelated settings and exact backup bytes, then removes only its own entry', () => {
		fs.writeFileSync(file, original);
		const outcome = configureClient(client, entry);
		expect(outcome.outcome).toBe('added');
		expect(fs.readFileSync(outcome.backup!, 'utf8')).toBe(original);
		const current = JSON.parse(fs.readFileSync(file, 'utf8'));
		expect(current).toEqual({
			preferences: { theme: 'dark' },
			mcpServers: { other: { command: 'local' }, scrivener: entry },
		});
		expect(configureClient(client, entry).outcome).toBe('unchanged');
		expect(removeFromClient(client).outcome).toBe('removed');
		expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(JSON.parse(original));
		expect(leftovers()).toEqual([]);
	});

	it.each(['{bad', '[]', '{"mcpServers":false}', '{"mcpServers":null}'])(
		'leaves corrupt or structurally invalid configuration untouched: %s',
		(text) => {
			fs.writeFileSync(file, text);
			expect(configureClient(client, entry).outcome).toBe('failed');
			expect(fs.readFileSync(file, 'utf8')).toBe(text);
			expect(fs.readdirSync(directory)).toEqual(['config.json']);
		}
	);

	it('does not echo malformed configuration contents in an error', () => {
		fs.writeFileSync(file, '{"token":"sensitive-fixture-value"!}');
		expect(configureClient(client, entry).message).not.toContain('sensitive-fixture-value');
	});

	it('rejects invalid UTF-8 and symlinks without replacing them', () => {
		fs.writeFileSync(file, Buffer.from([0xff]));
		expect(configureClient(client, entry).message).toContain('UTF-8');
		expect(fs.readFileSync(file)).toEqual(Buffer.from([0xff]));
		const alias = join(directory, 'alias.json');
		fs.symlinkSync(file, alias);
		expect(configureClient({ ...client, configPath: () => alias }, entry).message).toContain(
			'regular file'
		);
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
	});

	it('preserves existing custom entries when automatic installation requests no repair', () => {
		const custom = '{"mcpServers":{"scrivener":{"command":"custom","env":{"X":"keep"}}}}';
		fs.writeFileSync(file, custom);
		expect(configureClient(client, entry, { repairExisting: false }).outcome).toBe('unchanged');
		expect(fs.readFileSync(file, 'utf8')).toBe(custom);
		expect(fs.readdirSync(directory)).toEqual(['config.json']);
	});

	it.each([-1, 0, 1])('enforces the input byte limit at limit%+d', (delta) => {
		const bytes = Buffer.alloc(MAX_CONFIG_BYTES + delta, 0x20);
		fs.writeFileSync(file, bytes);
		if (delta > 0) expect(() => readConfigFile(file)).toThrow('byte limit');
		else expect(readConfigFile(file).bytes).toEqual(bytes);
	});

	it.each([-1, 0, 1])('enforces the output byte limit at limit%+d', (delta) => {
		const snapshot = readConfigFile(file);
		const text = ' '.repeat(MAX_CONFIG_BYTES + delta);
		if (delta > 0) {
			expect(() => publishConfigFile(file, snapshot, text)).toThrow('byte limit');
			expect(fs.existsSync(file)).toBe(false);
		} else {
			publishConfigFile(file, snapshot, text);
			expect(fs.readFileSync(file, 'utf8')).toBe(text);
		}
	});

	it('refuses changed and newly created configuration after a snapshot', () => {
		const absent = readConfigFile(file);
		fs.writeFileSync(file, original);
		expect(() => publishConfigFile(file, absent, '{}')).toThrow('changed before publication');
		const before = readConfigFile(file);
		fs.writeFileSync(file, '{"concurrent":true}');
		expect(() => publishConfigFile(file, before, '{}')).toThrow('changed before publication');
		expect(fs.readFileSync(file, 'utf8')).toBe('{"concurrent":true}');
		expect(leftovers()).toEqual([]);
	});

	it('detects an external update during backup before publication', () => {
		fs.writeFileSync(file, original);
		const sync = fs.fsyncSync;
		let calls = 0;
		jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
			sync(fd);
			if (++calls === 2) fs.writeFileSync(file, '{"concurrent":true}');
		});
		expect(configureClient(client, entry)).toMatchObject({
			outcome: 'failed',
			message: expect.stringContaining('changed before publication'),
		});
		expect(fs.readFileSync(file, 'utf8')).toBe('{"concurrent":true}');
		expect(leftovers()).toEqual([]);
	});

	it('does not clobber a file created at the final publication boundary', () => {
		const link = fs.linkSync;
		jest.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
			fs.writeFileSync(file, '{"concurrent":true}');
			link(source, destination);
		});
		expect(configureClient(client, entry).outcome).toBe('failed');
		expect(fs.readFileSync(file, 'utf8')).toBe('{"concurrent":true}');
		expect(leftovers()).toEqual([]);
	});

	it.each(['write', 'sync', 'rename'])(
		'leaves the old complete configuration after a %s failure and permits retry',
		(stage) => {
			fs.writeFileSync(file, original);
			if (stage === 'write')
				jest.spyOn(fs, 'writeFileSync').mockImplementationOnce((fd) => {
					fs.writeSync(fd as number, '{"partial":');
					throw new Error('injected disk full');
				});
			if (stage === 'sync')
				jest.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
					throw new Error('injected sync failure');
				});
			if (stage === 'rename')
				jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
					throw new Error('injected publication failure');
				});
			expect(configureClient(client, entry).outcome).toBe('failed');
			expect(fs.readFileSync(file, 'utf8')).toBe(original);
			expect(leftovers()).toEqual([]);
			jest.restoreAllMocks();
			expect(configureClient(client, entry).outcome).toBe('added');
		}
	);

	it('keeps three distinct complete backups across rapid repairs', () => {
		fs.writeFileSync(file, original);
		for (let i = 0; i < 5; i++) {
			const outcome = configureClient(client, { command: 'local', args: [String(i)] });
			expect(outcome.outcome).not.toBe('failed');
			expect(fs.existsSync(outcome.backup!)).toBe(true);
		}
		const backups = fs
			.readdirSync(directory)
			.filter((name) => name.includes('.scrivener-backup-'));
		expect(backups).toHaveLength(3);
		for (const backup of backups)
			expect(() =>
				JSON.parse(fs.readFileSync(join(directory, backup), 'utf8'))
			).not.toThrow();
		expect(leftovers()).toEqual([]);
	});

	it('does not prune manual or legacy backups with a similar prefix', () => {
		const suffixes = ['manual', '20260101120000', '20260101120000000-not-a-uuid'];
		for (const suffix of suffixes)
			fs.writeFileSync(`${file}.scrivener-backup-${suffix}`, original);
		for (let i = 0; i < 5; i++)
			expect(
				configureClient(client, { command: 'local', args: [String(i)] }).outcome
			).not.toBe('failed');
		for (const suffix of suffixes)
			expect(fs.readFileSync(`${file}.scrivener-backup-${suffix}`, 'utf8')).toBe(original);
	});

	it('removes an incomplete backup and never publishes after backup failure', () => {
		fs.writeFileSync(file, original);
		const write = fs.writeFileSync;
		let calls = 0;
		jest.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
			if (++calls === 2) {
				fs.writeSync(args[0] as number, '{"partial":');
				throw new Error('injected backup disk full');
			}
			write(...args);
		});
		expect(configureClient(client, entry).outcome).toBe('failed');
		expect(fs.readFileSync(file, 'utf8')).toBe(original);
		expect(fs.readdirSync(directory)).toEqual(['config.json']);
	});

	it('preserves the configured entry if removal cannot be published', () => {
		expect(configureClient(client, entry).outcome).toBe('added');
		const before = fs.readFileSync(file);
		jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
			throw new Error('injected publication failure');
		});
		expect(removeFromClient(client).outcome).toBe('failed');
		expect(fs.readFileSync(file)).toEqual(before);
		expect(leftovers()).toEqual([]);
	});
});
