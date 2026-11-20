import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HttpUsageError, parseHttpArgs, resolveToken } from '../../src/http-server.js';

const sourceRoot = resolve(__dirname, '../..');
const token = 'T'.repeat(43);

describe('HTTP options', () => {
	it('stays on stdio unless --http is given', () => {
		expect(parseHttpArgs([], {})).toBeNull();
	});

	it('defaults to loopback and validates every option', () => {
		expect(parseHttpArgs(['--http'], {})).toMatchObject({ host: '127.0.0.1', port: 3917 });
		expect(
			parseHttpArgs(
				['--http', '--port', '8080', '--allowed-host', 'Abc.trycloudflare.com'],
				{}
			)
		).toMatchObject({ port: 8080, allowedHosts: ['abc.trycloudflare.com'] });
		for (const argv of [
			['--http', '--port', '65536'],
			['--http', '--port', 'x'],
			['--http', '--port'],
			['--http', '--allowed-host', 'https://a.example'],
			['--http', '--bogus'],
		])
			expect(() => parseHttpArgs(argv, {})).toThrow(HttpUsageError);
	});

	it('creates one owner-only token and reuses it', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'scrivener-http-token-'));
		const saved = process.env.SCRIVENER_DATA_DIR;
		process.env.SCRIVENER_DATA_DIR = dir;
		try {
			const first = resolveToken({});
			expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(resolveToken({})).toBe(first);
			if (process.platform !== 'win32')
				expect((await stat(join(dir, 'http-token'))).mode & 0o777).toBe(0o600);
			expect((await readFile(join(dir, 'http-token'), 'utf8')).trim()).toBe(first);
			expect(resolveToken({ SCRIVENER_MCP_TOKEN: token })).toBe(token);
			expect(() => resolveToken({ SCRIVENER_MCP_TOKEN: 'short' })).toThrow(HttpUsageError);
		} finally {
			if (saved === undefined) delete process.env.SCRIVENER_DATA_DIR;
			else process.env.SCRIVENER_DATA_DIR = saved;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

async function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const probe = createServer();
		probe.once('error', fail);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => done(typeof address === 'object' && address ? address.port : 0));
		});
	});
}

/** Raw request so the test controls Host and Origin exactly. */
function post(port: number, path: string, headers: Record<string, string>): Promise<number> {
	return new Promise((done, fail) => {
		const req = httpRequest(
			{
				host: '127.0.0.1',
				port,
				path,
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					...headers,
				},
			},
			(res) => {
				res.resume();
				done(res.statusCode ?? 0);
			}
		);
		req.once('error', fail);
		req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
	});
}

describe('HTTP transport', () => {
	let child: ChildProcess;
	let root: string;
	let port: number;
	let stderr = '';

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), 'scrivener-http-'));
		await cp(
			join(sourceRoot, 'assets', 'sample-project', 'Welcome.scriv'),
			join(root, 'Welcome.scriv'),
			{ recursive: true }
		);
		port = await freePort();
		const loader = pathToFileURL(
			createRequire(join(sourceRoot, 'package.json')).resolve('tsx')
		).href;
		child = spawn(
			process.execPath,
			[
				'--import',
				loader,
				join(sourceRoot, 'src', 'index.ts'),
				'--http',
				'--port',
				String(port),
				'--allowed-host',
				'tunnel.example',
			],
			{
				cwd: root,
				stdio: ['ignore', 'ignore', 'pipe'],
				env: {
					PATH: process.env.PATH,
					HOME: root,
					USERPROFILE: root,
					APPDATA: root,
					LOCALAPPDATA: root,
					SCRIVENER_DATA_DIR: join(root, 'server-state'),
					SCRIVENER_HMS_ENGINE: 'fallback',
					SCRIVENER_LOCAL_ONLY: 'true',
					SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
					SCRIVENER_SKIP_SETUP: 'true',
					SCRIVENER_MCP_TOKEN: token,
					NODE_ENV: 'test',
				},
			}
		);
		child.stderr?.on('data', (chunk) => {
			stderr = (stderr + String(chunk)).slice(-16384);
		});
		for (let attempt = 0; attempt < 600; attempt++) {
			if (stderr.includes('Scrivener MCP Server started')) return;
			if (child.exitCode !== null) break;
			await new Promise((wait) => setTimeout(wait, 100));
		}
		throw new Error(`HTTP server did not start:\n${stderr}`);
	}, 90_000);

	afterAll(async () => {
		if (child && child.exitCode === null) {
			const exited = new Promise((done) => child.once('exit', done));
			child.kill('SIGTERM');
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	});

	it('rejects requests without the token, from foreign hosts or origins, and off the endpoint', async () => {
		const bearer = { authorization: `Bearer ${token}` };
		const local = `127.0.0.1:${port}`;
		expect(await post(port, '/mcp', { host: local })).toBe(401);
		expect(
			await post(port, '/mcp', { host: local, authorization: `Bearer ${'x'.repeat(43)}` })
		).toBe(401);
		expect(await post(port, `/mcp/${'x'.repeat(43)}`, { host: local })).toBe(401);
		expect(await post(port, '/mcp/%E0%A4%A', { host: local })).toBe(401);
		expect(await post(port, '/other', { host: local, ...bearer })).toBe(404);
		expect(await post(port, '/mcp', { host: 'attacker.example', ...bearer })).toBe(403);
		expect(await post(port, '/mcp', { host: 'bad host', ...bearer })).toBe(400);
		expect(
			await post(port, '/mcp', { host: local, origin: 'https://attacker.example', ...bearer })
		).toBe(403);
		expect(await post(port, '/mcp', { host: local, ...bearer })).toBe(200);
		expect(await post(port, '/mcp', { host: 'tunnel.example', ...bearer })).toBe(200);
		expect(stderr).not.toContain(token);
	});

	it('keeps the open project across stateless requests', async () => {
		const client = new Client({ name: 'http-regression', version: '1' }, { capabilities: {} });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${token}`))
		);
		try {
			const opened = await client.callTool({
				name: 'open_project',
				arguments: { path: join(root, 'Welcome.scriv') },
			});
			expect(opened.isError).not.toBe(true);
			const handle = (opened.structuredContent as { projectHandle?: string }).projectHandle;
			expect(handle).toMatch(/^[0-9a-f-]{36}$/);
			const remembered = await client.callTool({
				name: 'remember',
				arguments: {
					projectHandle: handle,
					memoryType: 'worldBuilding',
					data: { name: 'Moon Harbor', type: 'location', description: 'A tidal port.' },
				},
			});
			expect(remembered.isError).not.toBe(true);
			const stale = await client.callTool({
				name: 'remember',
				arguments: {
					projectHandle: '20000000-0000-4000-8000-000000000099',
					memoryType: 'worldBuilding',
					data: { name: 'X', type: 'location', description: 'Y' },
				},
			});
			expect(stale.isError).toBe(true);
		} finally {
			await client.close();
		}
	}, 60_000);
});
