import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

it.each(['modern', 'legacy'])(
	'rate limits a real %s stdio invocation flood and keeps discovery available',
	async (era) => {
		const sourceRoot = resolve(__dirname, '../../..');
		const root = await mkdtemp(join(tmpdir(), 'scrivener-admission-'));
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [
				'--import',
				pathToFileURL(createRequire(join(sourceRoot, 'package.json')).resolve('tsx')).href,
				join(sourceRoot, 'src/index.ts'),
			],
			cwd: root,
			stderr: 'pipe',
			env: {
				...getDefaultEnvironment(),
				HOME: root,
				USERPROFILE: root,
				APPDATA: root,
				LOCALAPPDATA: root,
				XDG_CONFIG_HOME: root,
				XDG_DATA_HOME: root,
				SCRIVENER_DATA_DIR: join(root, 'state'),
				SCRIVENER_LOCAL_ONLY: 'true',
				SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
				SCRIVENER_SKIP_SETUP: 'true',
				SCRIVENER_HMS_ENGINE: 'fallback',
				NODE_ENV: 'test',
				LOG_LEVEL: 'INFO',
				UV_THREADPOOL_SIZE: '1',
				RAYON_NUM_THREADS: '1',
				OMP_NUM_THREADS: '1',
			},
		});
		type Reply = {
			result?: { tools?: unknown[]; isError?: boolean; _meta?: Record<string, unknown> };
			error?: { code: number };
		};
		const waiting = new Map<number, (reply: Reply) => void>();
		let nextId = 0;
		let stderr = '';
		transport.onerror = (error) => {
			stderr += error.message;
		};
		transport.onmessage = (message) => {
			if ('id' in message && typeof message.id === 'number')
				waiting.get(message.id)?.(message as Reply);
		};
		const metadata = {
			'io.modelcontextprotocol/protocolVersion': '2026-07-28',
			'io.modelcontextprotocol/clientInfo': { name: 'admission-test', version: '1' },
			'io.modelcontextprotocol/clientCapabilities': {},
		};
		async function request(
			method: string,
			params: Record<string, unknown> = {}
		): Promise<Reply> {
			const id = ++nextId;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const response = new Promise<Reply>((done, reject) => {
					waiting.set(id, done);
					timer = setTimeout(
						() =>
							reject(new Error(`No ${era} response for ${method} #${id}: ${stderr}`)),
						id === 1 ? 60_000 : 15_000
					);
				});
				await transport.send({
					jsonrpc: '2.0',
					id,
					method,
					params: { ...params, ...(era === 'modern' ? { _meta: metadata } : {}) },
				});
				return await response;
			} finally {
				clearTimeout(timer);
				waiting.delete(id);
			}
		}
		try {
			await transport.start();
			transport.stderr?.on('data', (chunk) => {
				stderr = (stderr + String(chunk)).slice(-8192);
			});
			if (era === 'legacy') {
				expect(
					(
						await request('initialize', {
							protocolVersion: '2025-11-25',
							capabilities: {},
							clientInfo: { name: 'admission-test', version: '1' },
						})
					).error
				).toBeUndefined();
				await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
			}
			expect((await request('tools/list')).result?.tools?.length).toBeGreaterThan(0);
			const responses = await Promise.all(
				Array.from({ length: 300 }, () => request('tools/call', { name: 'no_such_tool' }))
			);
			const throttled = responses.filter(
				(reply) =>
					(
						reply.result?._meta?.['com.writerslogic/admission'] as
							{ code?: string } | undefined
					)?.code === 'RATE_LIMITED'
			);
			expect(throttled.length).toBeGreaterThan(0);
			for (const reply of responses) {
				if (reply.result) {
					expect(reply.result.isError).toBe(true);
					expect(reply.result._meta?.['com.writerslogic/admission']).toMatchObject({
						code: expect.stringMatching(/^(RATE_LIMITED|RESOURCE_EXHAUSTED)$/),
					});
				} else expect(reply.error?.code).toBe(-32602);
			}
			expect((await request('tools/list')).result?.tools?.length).toBeGreaterThan(0);
		} finally {
			await transport.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000
);
