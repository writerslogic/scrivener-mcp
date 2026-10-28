import { readFileSync, watch } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { handshake } from '../../../src/setup/doctor.js';
import type { ServerEntry } from '../../../src/setup/runtime.js';

let root: string;
const secret = 'opaque-doctor-secret-value';
const pidFile = (): string => join(root, 'server.pid');
const traceFile = (): string => join(root, 'trace.jsonl');
const entry = (mode = 'success'): ServerEntry => ({
	command: process.execPath,
	args: [join(process.cwd(), 'tests', 'fixtures', 'setup', 'doctor-server.mjs'), mode],
	env: {
		DOCTOR_PID: pidFile(),
		DOCTOR_TRACE: traceFile(),
		DOCTOR_SECRET: secret,
		DOCTOR_API_KEY: 'opaque-',
		SCRIVENER_LOCAL_ONLY: 'false',
		SCRIVENER_DISABLE_KEY_DISCOVERY: 'false',
		SCRIVENER_SKIP_SETUP: 'false',
	},
});
const events = async (): Promise<Array<Record<string, unknown>>> =>
	(await readFile(traceFile(), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
const expectStopped = async (): Promise<void> => {
	const pid = Number(await readFile(pidFile(), 'utf8'));
	expect(pid).toBeGreaterThan(0);
	expect(() => process.kill(pid, 0)).toThrow();
};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'scrivener-doctor-'));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test.each(['success', 'fragmented', 'legacy'])(
	'SDK negotiation lists real tools from a disposable %s server',
	async (mode) => {
		const previous = process.env.DOCTOR_AMBIENT_MARKER;
		process.env.DOCTOR_AMBIENT_MARKER = 'must-not-be-inherited';
		try {
			const result = await handshake(entry(mode), 5000);
			expect(result).toMatchObject({
				ok: true,
				serverName: 'diagnostic-fixture',
				serverVersion: 'fixture-1',
				toolCount: 1,
			});
			const log = await events();
			expect(log[0]).toMatchObject({
				localOnly: 'true',
				discovery: '1',
				skipSetup: 'true',
				ambient: false,
			});
			expect(log.find((event) => event.method === 'initialize')?.protocolVersion).toBe(
				LATEST_PROTOCOL_VERSION
			);
			await expectStopped();
		} finally {
			if (previous === undefined) delete process.env.DOCTOR_AMBIENT_MARKER;
			else process.env.DOCTOR_AMBIENT_MARKER = previous;
		}
	}
);

test.each([
	'rpc-error',
	'malformed-result',
	'malformed-tool',
	'malformed-json',
	'empty',
	'unsupported',
	'stdout-overflow',
])('RPC, schema and transport failures are rejected and cleaned up: %s', async (mode) => {
	const result = await handshake(entry(mode), 5000);
	expect(result.ok).toBe(false);
	expect(result.toolCount).toBeUndefined();
	expect(result.error).toBeTruthy();
	expect(result.error).not.toContain(secret);
	expect(result.error).not.toContain('doctor-secret-value');
	expect(result.error).not.toContain('reader:password');
	await expectStopped();
});

test('bounded stderr retains the actionable tail and redacts returned diagnostics', async () => {
	const result = await handshake(entry('early-exit'), 5000);
	expect(result.ok).toBe(false);
	expect(result.error).toContain('Tail startup cause');
	expect(result.error).not.toContain(secret);
	expect(result.error).not.toContain('doctor-secret-value');
	expect(result.error).not.toContain('reader:password');
	expect(result.error).not.toContain(homedir());
	expect(result.error!.length).toBeLessThanOrEqual(4096);
	await expectStopped();
});

test('a bounded stderr tail omits the remainder of a truncated credential line', async () => {
	const configured = entry('stderr-cut');
	configured.env!.DOCTOR_SECRET = `prefix-${'x'.repeat(9000)}-SENSITIVE-SUFFIX`;
	const result = await handshake(configured, 5000);
	expect(result).toMatchObject({
		ok: false,
		error: expect.stringContaining('Actionable final line'),
	});
	expect(result.error).not.toContain('SENSITIVE-SUFFIX');
	await expectStopped();
});

test('pagination counts each page once and rejects repeated cursors before replay', async () => {
	const result = await handshake(entry('pagination'), 5000);
	expect(result).toMatchObject({ ok: true, toolCount: 3 });
	expect(
		(await events())
			.filter((event) => event.method === 'tools/list')
			.map((event) => event.cursor)
	).toEqual([null, '1', '2']);
	await expectStopped();
	await rm(traceFile());
	const repeated = await handshake(entry('repeat-cursor'), 5000);
	expect(repeated.ok).toBe(false);
	expect(repeated.error).toMatch(/repeated.*cursor/i);
	expect(
		(await events())
			.filter((event) => event.method === 'tools/list')
			.map((event) => event.cursor)
	).toEqual([null, '1']);
	await expectStopped();
});

test.each([
	['duplicate-tools', /repeated.*tool name/i],
	['many-pages', /page limit/i],
	['tools-10001', /tool limit/i],
] as const)('pagination and allocation limits reject %s', async (mode, error) => {
	const result = await handshake(entry(mode), 10_000);
	expect(result.ok).toBe(false);
	expect(result.error).toMatch(error);
	if (mode === 'many-pages')
		expect((await events()).filter((event) => event.method === 'tools/list')).toHaveLength(64);
	await expectStopped();
});

test.each([
	['tools-9999', 9999],
	['tools-10000', 10000],
	['pages-63', 63],
	['pages-64', 64],
	['cursor-1023', 2],
	['cursor-1024', 2],
] as const)(
	'bounded catalogs accept %s at and below the supported limit',
	async (mode, toolCount) => {
		expect(await handshake(entry(mode), 10_000)).toMatchObject({ ok: true, toolCount });
		await expectStopped();
	}
);

test.each(['cursor-0', 'cursor-1025'])(
	'invalid pagination cursor %s is rejected before reuse',
	async (mode) => {
		const result = await handshake(entry(mode), 5000);
		expect(result).toMatchObject({
			ok: false,
			error: expect.stringMatching(/invalid.*cursor/i),
		});
		expect((await events()).filter((event) => event.method === 'tools/list')).toHaveLength(1);
		await expectStopped();
	}
);

test('one total deadline covers all pages instead of resetting for each response', async () => {
	const result = await handshake(entry('slow-pages'), 2000);
	expect(result.ok).toBe(false);
	expect(result.error).toMatch(/deadline|timed out/i);
	expect(result.ms).toBeLessThan(7000);
	await expectStopped();
});

test('deadline cleanup terminates a server that ignores EOF and SIGTERM', async () => {
	const result = await handshake(entry('stubborn'), 1500);
	expect(result.ok).toBe(false);
	expect(result.error).toMatch(/deadline|timed out/i);
	expect(result.ms).toBeLessThan(7500);
	await expectStopped();
});

test.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 120_001])(
	'invalid deadline %s never spawns a process',
	async (timeout) => {
		const result = await handshake(entry(), timeout);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/timeout must be an integer/i);
		await expect(readFile(pidFile())).rejects.toMatchObject({ code: 'ENOENT' });
	}
);

test('an already aborted diagnostic never spawns a server', async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await handshake(entry(), 5000, controller.signal);
	expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/i) });
	await expect(readFile(pidFile())).rejects.toMatchObject({ code: 'ENOENT' });
});

test('cancelling an active diagnostic drains its server', async () => {
	const controller = new AbortController();
	const ready = new Promise<void>((resolve, reject) => {
		const watcher = watch(root, () => {
			try {
				if (Number(readFileSync(pidFile(), 'utf8')) > 0) {
					clearTimeout(timer);
					watcher.close();
					resolve();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					clearTimeout(timer);
					watcher.close();
					reject(error);
				}
			}
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error('Diagnostic fixture did not start'));
		}, 5000);
		watcher.once('error', (error) => {
			clearTimeout(timer);
			watcher.close();
			reject(error);
		});
	});
	const pending = handshake(entry('hold-list'), 10_000, controller.signal);
	try {
		await ready;
		controller.abort();
		expect(await pending).toMatchObject({
			ok: false,
			error: expect.stringMatching(/cancelled/i),
		});
		await expectStopped();
	} finally {
		controller.abort();
		await pending;
	}
});
