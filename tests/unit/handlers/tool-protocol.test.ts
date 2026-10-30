import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

test('real stdio dispatch distinguishes protocol errors and discloses tools after failed and memory-only activation', async () => {
	const sourceRoot = resolve(__dirname, '../../..');
	const loader = pathToFileURL(
		createRequire(join(sourceRoot, 'package.json')).resolve('tsx')
	).href;
	const root = await mkdtemp(join(tmpdir(), 'scrivener-tool-contract-'));
	const project = join(root, 'Welcome.scriv');
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', loader, join(sourceRoot, 'src', 'index.ts')],
		cwd: root,
		stderr: 'pipe',
		maxBufferSize: 2 * 1024 * 1024,
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
			SCRIVENER_QUIET: 'true',
			SCRIVENER_SKIP_SETUP: 'true',
			SCRIVENER_MCP_EAGER_TOOLS: '0',
			NODE_ENV: 'test',
			LOG_LEVEL: 'ERROR',
		},
	});
	let stderr = '';
	transport.stderr?.on('data', (chunk) => {
		stderr = (stderr + String(chunk)).slice(-8192);
	});
	const client = new Client(
		{ name: 'tool-contract-regression', version: '1' },
		{ capabilities: {} }
	);
	let protocolError = '';
	client.onerror = (error) => {
		protocolError = error.message;
	};
	let notifications = 0;
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
		notifications++;
	});
	let phase = 'initialize';
	const call = (name: string, args: Record<string, unknown> = {}) => {
		phase = `tools/call ${name}`;
		return client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
	};
	const names = async () => {
		phase = 'tools/list';
		return (await client.listTools()).tools.map((tool) => tool.name);
	};
	try {
		await cp(join(sourceRoot, 'assets', 'sample-project', 'Welcome.scriv'), project, {
			recursive: true,
		});
		await client.connect(transport, { timeout: 30000 });
		const initial = await names();
		expect(initial).toContain('read_result');
		expect(initial).not.toContain('analyze_document');
		for (const name of ['no_such_tool', 'find_analogies'])
			await expect(call(name)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
		expect(notifications).toBe(0);
		expect(await names()).toEqual(initial);

		expect((await call('analyze_document')).isError).toBe(true);
		expect(notifications).toBe(1);
		expect(await names()).toContain('analyze_document');
		expect((await call('analyze_document', { documentId: 17 })).isError).toBe(true);
		expect(notifications).toBe(1);
		expect((await call('use_skill', { name: 'unknown' })).isError).toBe(true);
		expect(notifications).toBe(1);

		for (const name of ['documents', 'search'])
			expect((await call('use_skill', { name })).isError).not.toBe(true);
		expect(notifications).toBe(3);
		expect(await names()).not.toContain('remember');
		expect((await call('open_project', { path: project })).isError).not.toBe(true);
		expect(notifications).toBe(4);
		expect(await names()).toContain('remember');
		const repeated = await call('use_skill', { name: 'search' });
		const fallback = repeated.structuredContent as {
			tools: Array<{ name: string; inputSchema: unknown }>;
		};
		expect(
			fallback.tools.find((tool) => tool.name === 'search_passages')?.inputSchema
		).toMatchObject({ properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } });
		expect(notifications).toBe(4);
		expect((await call('close_project')).isError).not.toBe(true);
	} catch (error) {
		throw new Error(
			`Protocol child failed during ${phase}: ${stderr || 'no stderr'}; ${protocolError || 'no transport error'}`,
			{ cause: error }
		);
	} finally {
		try {
			await client.close();
		} finally {
			await transport.close();
			await rm(root, { recursive: true, force: true });
		}
	}
}, 60000);
