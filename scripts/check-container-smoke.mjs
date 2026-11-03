#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { serializeMessage } from '@modelcontextprotocol/server';

const execute = promisify(execFile);
const label = 'io.scrivener-mcp.smoke';
const memory = 1536 * 1024 * 1024;

async function within(promise, milliseconds, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function checkContainerSmoke({
	image,
	output,
	dockerCommand = 'docker',
	dockerArguments = [],
}) {
	assert.match(image, /^sha256:[0-9a-f]{64}$/, 'Supply the exact locally built image ID');
	assert(isAbsolute(output), 'The evidence output must be an absolute new file');
	const evidence = await open(output, 'wx', 0o600);
	const report = { image, status: 'failed', checks: [], stderrBytes: 0 };
	const controller = new AbortController();
	const interrupted = () => controller.abort(new Error('Container smoke interrupted'));
	const deadline = setTimeout(
		() => controller.abort(new Error('Container smoke exceeded 90 seconds')),
		90_000
	);
	process.once('SIGINT', interrupted);
	process.once('SIGTERM', interrupted);
	let directory, child, closed, client, failure;
	let attempted = false;
	let stage = 'prepare';
	const token = randomUUID();
	const name = `scrivener-smoke-${token}`;
	report.containerName = name;
	const env = getDefaultEnvironment();
	async function docker(args, operation, cleanup = false) {
		try {
			return (
				await execute(dockerCommand, [...dockerArguments, '--config', directory, ...args], {
					env,
					timeout: 15_000,
					killSignal: 'SIGKILL',
					maxBuffer: 1024 * 1024,
					signal: cleanup ? undefined : controller.signal,
				})
			).stdout;
		} catch (error) {
			if (
				cleanup &&
				operation === 'inspect' &&
				error.code === 1 &&
				/No such (?:object|container)/i.test(error.stderr ?? '')
			)
				return undefined;
			throw new Error(
				`Docker ${operation} failed (${error.code ?? error.name}); command output withheld`
			);
		}
	}
	try {
		directory = await mkdtemp(join(tmpdir(), 'scrivener-container-smoke-'));
		await writeFile(join(directory, 'config.json'), '{}\n', { mode: 0o600 });
		stage = 'image';
		const metadata = JSON.parse(
			await docker(['image', 'inspect', '--format', '{{json .}}', image], stage)
		);
		assert.equal(metadata.Id, image);
		assert.equal(metadata.Os, 'linux');
		assert.equal(metadata.Architecture, 'amd64');
		assert.deepEqual(metadata.Config.Entrypoint, ['node', 'dist/index.js']);
		assert(
			metadata.Config.Cmd == null || metadata.Config.Cmd.length === 0,
			'Unexpected image command'
		);
		report.checks.push('image-identity-and-default-entrypoint');
		stage = 'startup';
		const containerEnvironment = {
			HOME: '/tmp/scrivener-smoke-home',
			SCRIVENER_DATA_DIR: '/tmp/scrivener-smoke-data',
			SCRIVENER_LOCAL_ONLY: 'true',
			SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
			SCRIVENER_RUN_LIVE_AI_TESTS: '0',
			SCRIVENER_SKIP_SETUP: 'true',
			SCRIVENER_HMS_ENGINE: 'fallback',
			UV_THREADPOOL_SIZE: '1',
			RAYON_NUM_THREADS: '1',
			OMP_NUM_THREADS: '1',
		};
		const args = [
			'run',
			'-i',
			'--pull=never',
			'--platform=linux/amd64',
			'--network=none',
			'--cpus=1',
			'--memory=1536m',
			'--memory-swap=1536m',
			'--pids-limit=128',
			'--sig-proxy=false',
			'--name',
			name,
			'--label',
			`${label}=${token}`,
			'--cidfile',
			join(directory, 'container.id'),
			...Object.entries(containerEnvironment).flatMap(([key, value]) => [
				'--env',
				`${key}=${value}`,
			]),
			image,
		];
		attempted = true;
		child = spawn(dockerCommand, [...dockerArguments, '--config', directory, ...args], {
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
			signal: controller.signal,
		});
		closed = new Promise((done) =>
			child.once('close', (code, signal) => done({ code, signal }))
		);
		const transport = new StdioServerTransport(child.stdout, child.stdin, {
			maxBufferSize: 4 * 1024 * 1024,
		});
		transport.send = (message) =>
			new Promise((done, reject) =>
				child.stdin.write(serializeMessage(message), (error) =>
					error ? reject(error) : done()
				)
			);
		child.once('error', (error) => controller.abort(error));
		child.once('close', () => transport.onclose?.());
		child.stdin.on('error', (error) => controller.abort(error));
		child.stdout.on('error', (error) => controller.abort(error));
		child.stderr.on('error', (error) => controller.abort(error));
		child.stderr.on('data', (chunk) => {
			report.stderrBytes += chunk.length;
		});
		client = new Client(
			{ name: 'container-release-smoke', version: '1' },
			{ capabilities: {} }
		);
		client.onerror = (error) => controller.abort(error);
		await client.connect(transport, { timeout: 30_000, signal: controller.signal });
		report.server = client.getServerVersion();
		assert.equal(report.server?.name, 'scrivener-mcp');
		assert(typeof report.server.version === 'string' && report.server.version.length > 0);
		report.checks.push('mcp-initialize');
		stage = 'tools';
		const tools = new Set(),
			cursors = new Set();
		let cursor;
		do {
			const page = await client.listTools(cursor ? { cursor } : undefined, {
				timeout: 10_000,
				signal: controller.signal,
			});
			for (const tool of page.tools) {
				assert(!tools.has(tool.name), 'Duplicate tool across discovery pages');
				tools.add(tool.name);
			}
			assert(tools.size <= 4096, 'Tool discovery exceeds its bound');
			cursor = page.nextCursor;
			if (cursor !== undefined) {
				assert(
					typeof cursor === 'string' &&
						cursor.length > 0 &&
						!cursors.has(cursor) &&
						cursors.size < 16,
					'Invalid discovery cursor'
				);
				cursors.add(cursor);
			}
		} while (cursor !== undefined);
		for (const required of ['open_project', 'read_result', 'analyze_manuscript_local'])
			assert(tools.has(required), `Missing required tool: ${required}`);
		report.toolCount = tools.size;
		report.checks.push('mcp-tool-discovery');
		stage = 'identity';
		assert(
			(await stat(join(directory, 'container.id'))).size <= 65,
			'Invalid container ID size'
		);
		const id = (await readFile(join(directory, 'container.id'), 'utf8')).trim();
		assert.match(id, /^[0-9a-f]{64}$/);
		report.containerId = id;
		const identity = JSON.parse(
			await docker(
				[
					'exec',
					id,
					'node',
					'-e',
					"const fs=require('node:fs'); const uid=fs.readFileSync('/proc/1/status','utf8').match(/^Uid:\\s+(.+)$/m); console.log(JSON.stringify({uid:process.getuid(),pid1Uids:uid?uid[1].trim().split(/\\s+/).map(Number):[],platform:process.platform,arch:process.arch,node:process.version}));",
				],
				stage
			)
		);
		report.runtime = identity;
		assert(
			Number.isInteger(identity.uid) && identity.uid > 0,
			'Container exec must run without root'
		);
		assert(
			Array.isArray(identity.pid1Uids) &&
				identity.pid1Uids.length === 4 &&
				identity.pid1Uids.every((uid) => Number.isInteger(uid) && uid > 0),
			'Container PID1 must run without root'
		);
		assert.equal(identity.platform, 'linux');
		assert.equal(identity.arch, 'x64');
		report.checks.push('non-root-runtime-and-pid1');
		stage = 'eof';
		child.stdin.end();
		report.exit = await within(
			closed,
			5000,
			'Container did not exit naturally within five seconds of EOF'
		);
		assert.deepEqual(report.exit, { code: 0, signal: null });
		stage = 'state';
		const container = JSON.parse(
			await docker(['container', 'inspect', '--format', '{{json .}}', id], 'inspect')
		);
		assert.equal(container.Id, id);
		assert.equal(container.Image, image);
		assert.equal(container.Config.Labels?.[label], token, 'Container ownership changed');
		assert.equal(container.State.Running, false);
		assert.equal(container.State.ExitCode, 0);
		assert.equal(container.State.OOMKilled, false);
		for (const [key, value] of Object.entries({
			NanoCpus: 1e9,
			Memory: memory,
			MemorySwap: memory,
			PidsLimit: 128,
			NetworkMode: 'none',
		}))
			assert.equal(container.HostConfig[key], value, key);
		report.limits = { cpus: 1, memoryBytes: memory, swapBytes: 0, pids: 128, network: 'none' };
		report.checks.push('natural-eof-exit-and-container-limits');
	} catch (error) {
		failure = new Error(`Container smoke failed at ${stage}: ${error.message}`);
		report.failureStage = stage;
	} finally {
		clearTimeout(deadline);
		try {
			if (child && child.exitCode === null && child.signalCode === null)
				child.kill('SIGKILL');
			if (closed) await within(closed, 5000, 'Docker client did not exit during cleanup');
		} catch (error) {
			failure = new Error(
				`${failure?.message ?? 'Container smoke cleanup failed'}; ${error.message}`
			);
		}
		try {
			if (attempted) {
				let text;
				for (let attempt = 0; attempt < 3; attempt++) {
					text = await docker(
						[
							'container',
							'inspect',
							'--format',
							'{{json .}}',
							report.containerId ?? name,
						],
						'inspect',
						true
					);
					if (text !== undefined || !failure || attempt === 2) break;
					await delay(250);
				}
				if (text !== undefined) {
					const owned = JSON.parse(text);
					assert.match(owned.Id, /^[0-9a-f]{64}$/);
					assert.equal(
						owned.Name,
						`/${name}`,
						'Refusing to remove a different container'
					);
					assert.equal(
						owned.Config.Labels?.[label],
						token,
						'Refusing to remove a container without the ownership token'
					);
					await docker(
						['container', 'rm', ...(failure ? ['--force'] : []), owned.Id],
						'cleanup',
						true
					);
					report.cleanup = 'owned-container-removed';
				} else report.cleanup = 'container-not-observed';
			}
		} catch (error) {
			report.cleanup = 'failed';
			failure = new Error(
				`${failure?.message ?? 'Container smoke cleanup failed'}; ${error.message}`
			);
		}
		try {
			await client?.close();
			if (directory) await rm(directory, { recursive: true, force: true });
		} catch (error) {
			failure = new Error(
				`${failure?.message ?? 'Container smoke cleanup failed'}; ${error.message}`
			);
		}
		process.off('SIGINT', interrupted);
		process.off('SIGTERM', interrupted);
		report.status = failure ? 'failed' : 'passed';
		try {
			await evidence.writeFile(JSON.stringify(report, null, 2) + '\n');
		} finally {
			await evidence.close();
		}
	}
	if (failure) throw failure;
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		assert.deepEqual(
			[process.argv[2], process.argv[4]],
			['--image', '--output'],
			'Use --image sha256:ID --output /absolute/new.json'
		);
		assert.equal(process.argv.length, 6, 'Unexpected command-line arguments');
		const report = await checkContainerSmoke({
			image: process.argv[3],
			output: process.argv[5],
		});
		process.stdout.write(`Container smoke: ${report.checks.length} checks passed\n`);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}
