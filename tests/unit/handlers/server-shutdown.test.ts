import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { serializeMessage } from '@modelcontextprotocol/server';

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

function kill(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(pid, 'SIGKILL');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
	}
}

async function readPid(path: string): Promise<number | undefined> {
	const value = await readFile(path, 'utf8').catch((error) => {
		if (error.code === 'ENOENT') return '';
		throw error;
	});
	return /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
}

for (const mode of ['EOF', 'SIGTERM', 'cancel-zero', 'cancel-empty'] as const) {
	const cancellation = mode === 'cancel-zero' || mode === 'cancel-empty';
	const requestId = mode === 'cancel-zero' ? 0 : '';
	const run = mode === 'SIGTERM' && process.platform === 'win32' ? test.skip : test;
	run(
		cancellation
			? `${mode} stops a blocked native analysis while keeping the stdio server usable`
			: `${mode} closes MCP requests before draining a blocked native project analysis`,
		async () => {
			const sourceRoot = resolve(__dirname, '../../..');
			const require = createRequire(join(sourceRoot, 'package.json'));
			const root = await mkdtemp(join(tmpdir(), 'scrivener-shutdown-'));
			const project = join(root, 'Welcome.scriv');
			const preload = join(root, 'block-native.cjs');
			const spawnedPidFile = join(root, 'native-spawned.pid');
			const blockedPidFile = join(root, 'native-blocked.pid');
			const nativeModule = require.resolve('narrative-lens');
			await writeFile(
				preload,
				`
if (require('node:worker_threads').isMainThread) {
  const fs = require('node:fs');
  fs.writeFileSync(${JSON.stringify(spawnedPidFile)}, String(process.pid));
  const native = require(${JSON.stringify(nativeModule)});
  require.cache[require.resolve(${JSON.stringify(nativeModule)})].exports = {
    ...native,
    ManuscriptContext: class {
      constructor(...args) { this.context = new native.ManuscriptContext(...args); }
      analyze(input) {
        fs.writeFileSync(${JSON.stringify(blockedPidFile)}, String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
        return this.context.analyze(input);
      }
      stats() { return this.context.stats(); }
    }
  };
}`
			);
			const child = spawn(
				process.execPath,
				[
					'--import',
					pathToFileURL(require.resolve('tsx')).href,
					join(sourceRoot, 'tests/helpers/server-resource-probe.mjs'),
				],
				{
					cwd: root,
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true,
					env: {
						...getDefaultEnvironment(),
						HOME: root,
						USERPROFILE: root,
						APPDATA: root,
						LOCALAPPDATA: root,
						XDG_CONFIG_HOME: root,
						XDG_DATA_HOME: root,
						SCRIVENER_DATA_DIR: join(root, 'server-state'),
						SCRIVENER_HMS_ENGINE: 'fallback',
						SCRIVENER_LOCAL_ONLY: 'true',
						SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
						SCRIVENER_SKIP_SETUP: 'true',
						SCRIVENER_MCP_EAGER_TOOLS: '0',
						SCRIVENER_NOVEL_RESOURCE_PRELOAD: preload,
						NODE_ENV: 'test',
						UV_THREADPOOL_SIZE: '1',
						RAYON_NUM_THREADS: '1',
						OMP_NUM_THREADS: '1',
					},
				}
			);
			const transport = new StdioServerTransport(child.stdout, child.stdin, {
				maxBufferSize: 2 * 1024 * 1024,
			});
			transport.send = (message) =>
				new Promise((done, reject) => {
					child.stdin.write(serializeMessage(message), (error) =>
						error ? reject(error) : done()
					);
				});
			child.stdin.on('error', (error) => transport.onerror?.(error));
			child.on('error', (error) => transport.onerror?.(error));
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
				(done) => {
					child.once('close', (code, signal) => {
						transport.onclose?.();
						done({ code, signal });
					});
				}
			);
			let stderr = '';
			child.stderr.on('data', (chunk) => {
				stderr = (stderr + String(chunk)).slice(-8192);
			});
			const client = new Client(
				{ name: 'shutdown-regression', version: '1' },
				{ capabilities: {} }
			);
			let nativePid: number | undefined;
			try {
				await cp(join(sourceRoot, 'assets/sample-project/Welcome.scriv'), project, {
					recursive: true,
				});
				await client.connect(transport, {
					timeout: 30000,
				});
				expect(
					(
						await client.callTool(
							{ name: 'open_project', arguments: { path: project } },
							{ timeout: 10000 }
						)
					).isError
				).not.toBe(true);
				let analysis: Promise<unknown> | undefined;
				if (cancellation) {
					await transport.send({
						jsonrpc: '2.0',
						id: requestId,
						method: 'tools/call',
						params: { name: 'analyze_manuscript_local', arguments: {} },
					});
				} else {
					analysis = client
						.callTool(
							{ name: 'analyze_manuscript_local', arguments: {} },
							{
								timeout: 15000,
							}
						)
						.catch(() => undefined);
				}
				const startedBy = Date.now() + 5000;
				while (nativePid === undefined && Date.now() < startedBy) {
					nativePid = await readPid(blockedPidFile);
					if (nativePid === undefined) await delay(20);
				}
				expect(nativePid).toBeDefined();
				if (cancellation) {
					await transport.send({
						jsonrpc: '2.0',
						method: 'notifications/cancelled',
						params: { requestId, reason: 'Cancel the blocked native analysis' },
					});
					const cancelledBy = Date.now() + 2000;
					while (alive(nativePid!) && Date.now() < cancelledBy) await delay(20);
					expect(alive(nativePid!)).toBe(false);
					expect(alive(child.pid!)).toBe(true);
					expect(child.exitCode).toBeNull();
					expect(child.signalCode).toBeNull();
					expect(
						(await client.listTools(undefined, { timeout: 2000 })).tools.length
					).toBeGreaterThan(0);
				}
				if (mode === 'SIGTERM') child.kill('SIGTERM');
				else child.stdin.end();
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					const exited = await Promise.race([
						closed,
						new Promise<undefined>((done) => {
							timeout = setTimeout(() => done(undefined), 2000);
						}),
					]);
					expect(exited).toEqual({ code: 0, signal: null });
				} finally {
					clearTimeout(timeout);
				}
				expect(alive(child.pid!)).toBe(false);
				expect(alive(nativePid!)).toBe(false);
				if (analysis) await analysis;
				if (cancellation) expect(stderr).toMatch(/\"outcome\":\"cancelled\"/);
			} catch (error) {
				throw new Error(`Server ${mode} regression failed: ${String(error)}\n${stderr}`);
			} finally {
				nativePid ??= await readPid(spawnedPidFile);
				kill(nativePid);
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
				await closed;
				await client.close();
				await rm(root, { recursive: true, force: true });
			}
		},
		60000
	);
}
