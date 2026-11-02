import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { collectNarrativeReport } from '../../helpers/narrative-report.js';
import { setTimeout } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
	CallToolResultSchema,
	ErrorCode,
	ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

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
			SCRIVENER_QUIET: 'false',
			SCRIVENER_SKIP_SETUP: 'true',
			SCRIVENER_MCP_EAGER_TOOLS: '0',
			NODE_ENV: 'test',
			LOG_LEVEL: 'INFO',
			UV_THREADPOOL_SIZE: '1',
			RAYON_NUM_THREADS: '1',
			OMP_NUM_THREADS: '1',
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
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		phase = `tools/call ${name}`;
		const result = await client.callTool({ name, arguments: args }, undefined, {
			timeout: 10000,
		});
		expect(result._meta?.['com.writerslogic/operation']).toMatchObject({
			id: expect.stringMatching(/^[a-f0-9-]{36}$/),
			durationMs: expect.any(Number),
		});
		return result;
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
		expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
		expect(stderr).not.toContain('First-run check failed');
		const initial = await names();
		expect(initial).toContain('read_result');
		expect(initial).not.toContain('analyze_document');
		for (const name of [
			'no_such_tool',
			'find_analogies',
			'multi_agent_analysis',
			'store_chapter_order',
			'sync_to_neo4j',
		])
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
		const remembered = CallToolResultSchema.parse(
			await call('remember', {
				memoryType: 'worldBuilding',
				data: { name: 'Moon Harbor', type: 'location', description: 'A tidal port.' },
			})
		);
		expect(remembered.isError).not.toBe(true);
		expect(remembered.structuredContent).toMatchObject({
			persisted: true,
			memoryType: 'worldBuilding',
		});
		const recalledMemory = CallToolResultSchema.parse(
			await call('recall', { memoryType: 'worldBuilding' })
		);
		expect(recalledMemory.isError).not.toBe(true);
		expect(recalledMemory.structuredContent).toMatchObject({
			revision: remembered.structuredContent?.revision,
			memory: [
				{
					id: remembered.structuredContent?.id,
					name: 'Moon Harbor',
					type: 'location',
					description: 'A tidal port.',
				},
			],
		});
		const structure = (await call('get_structure')).structuredContent as {
			documents: Array<{ id: string; type: string }>;
		};
		const documentId = structure.documents.find((document) => document.type === 'Text')?.id;
		expect(documentId).toBeDefined();
		const info = CallToolResultSchema.parse(await call('get_document_info', { documentId }));
		expect(info.isError).not.toBe(true);
		const text = info.content.find((item) => item.type === 'text');
		expect(text?.type).toBe('text');
		if (text?.type !== 'text') throw new Error('Missing document information text');
		expect(JSON.parse(text.text)).toEqual(info.structuredContent);
		expect(JSON.parse(text.text)).toHaveProperty('metadata');
		const enhancement = CallToolResultSchema.parse(
			await call('enhance_content', { documentId, enhancementType: 'style' })
		);
		expect(enhancement.isError).toBe(true);
		expect(enhancement.structuredContent).toMatchObject({
			documentId,
			enhanced: null,
			availability: { status: 'unavailable', reason: 'provider_failed' },
			envelope: { policy: { revisionChecked: true } },
		});
		const generation = CallToolResultSchema.parse(
			await call('generate_content', { prompt: 'Write a scene.' })
		);
		expect(generation.isError).toBe(true);
		expect(generation.content).toEqual([
			expect.objectContaining({
				type: 'text',
				text: expect.stringContaining('disabled in local-only mode'),
			}),
		]);
		const documentAnalysis = CallToolResultSchema.parse(
			await call('analyze_document', { documentId, analysisTypes: ['style'] })
		);
		expect(documentAnalysis.isError).not.toBe(true);
		let report = documentAnalysis.structuredContent!;
		expect(typeof report._ref).toBe('string');
		if (typeof report._ref === 'string') {
			const resultId = report._ref;
			let offset: number | null = 0,
				json = '';
			do {
				const result = CallToolResultSchema.parse(
					await call('read_result', { resultId, offset, limit: 1024 })
				);
				expect(result.isError).not.toBe(true);
				const page = result.structuredContent as {
					text: string;
					nextOffset: number | null;
				};
				expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1024);
				json += page.text;
				offset = page.nextOffset;
			} while (offset !== null);
			report = JSON.parse(json);
		}
		expect(report).toMatchObject({
			focus: { requested: ['style'], scope: 'broad-local' },
			availability: { provider: 'unavailable', local: 'available', grammar: 'available' },
			envelope: { policy: { mode: 'raw', revisionChecked: true } },
		});
		const repeated = await call('use_skill', { name: 'search' });
		const fallback = repeated.structuredContent as {
			tools: Array<{ name: string; inputSchema: unknown }>;
		};
		expect(
			fallback.tools.find((tool) => tool.name === 'search_passages')?.inputSchema
		).toMatchObject({ properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } });
		expect(notifications).toBe(4);
		const suppliedText =
			'Mira waited by the gate. The wind carried a distant bell across the harbor.';
		const queued = CallToolResultSchema.parse(
			await call('queue_document_analysis', { documentId, content: suppliedText })
		);
		expect(queued.isError).not.toBe(true);
		const jobId = queued.structuredContent?.jobId;
		expect(typeof jobId).toBe('string');
		let status: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			const response = CallToolResultSchema.parse(
				await call('get_job_status', { jobType: 'analyze_document', jobId })
			);
			expect(response.isError).not.toBe(true);
			status = response.structuredContent;
			if (status?.state !== 'active' && status?.state !== 'waiting') break;
			await setTimeout(25);
		}
		expect(status?.state).toBe('completed');
		let analysis = status?.result as Record<string, unknown>;
		if (analysis._ref) {
			let offset: number | null = 0;
			let serialized = '';
			do {
				const page = CallToolResultSchema.parse(
					await call('read_result', { resultId: analysis._ref, offset })
				).structuredContent as { text: string; nextOffset: number | null };
				serialized += page.text;
				offset = page.nextOffset;
			} while (offset !== null);
			analysis = JSON.parse(serialized);
		}
		expect(analysis).toMatchObject({
			analysis: { metrics: { wordCount: 14 } },
			readability: { availability: 'available' },
			envelope: {
				sourceFormat: 'supplied-text',
				sourceRevisions: [
					{
						documentId,
						revision: createHash('sha256').update(suppliedText).digest('hex'),
					},
				],
				policy: { mode: 'raw', revisionChecked: false, providerAccess: false },
			},
		});
		expect(
			(
				await call('add_relationship', {
					head: 'Mara',
					headType: 'Character',
					relation: 'mentors',
					tail: 'Élodie',
					tailType: 'Character',
				})
			).isError
		).not.toBe(true);
		const related = (await call('find_relationships', { entity: 'Élodie' })).structuredContent;
		expect(related).toMatchObject({
			relationships: [{ head: 'Mara', relation: 'mentors', tail: 'Élodie' }],
			total: 1,
			truncated: false,
		});
		expect((await call('character_network')).structuredContent).toMatchObject({
			network: { Mara: [{ target: 'Élodie', relation: 'mentors' }], Élodie: [] },
		});
		const narrative = (args: Record<string, unknown>) =>
			call('analyze_manuscript_local', args).then((value) =>
				CallToolResultSchema.parse(value)
			);
		const before = await collectNarrativeReport(narrative, { saveAs: 'protocol-baseline' });
		const compared = await collectNarrativeReport(narrative, { baseline: 'protocol-baseline' });
		expect(compared.report.comparisonBaseline).toEqual({
			name: 'protocol-baseline',
			envelope: before.report.envelope,
		});
		expect(compared.report.snapshot.report).toEqual(before.report.snapshot.report);
		expect(compared.report.envelope.sourceRevisions).toEqual(
			before.report.envelope.sourceRevisions
		);
		expect(compared.report.comparison?.introduced).toEqual([]);
		expect(compared.report.comparison?.resolved).toEqual([]);
		expect((await call('close_project')).isError).not.toBe(true);
		expect((await call('open_project', { path: project })).isError).not.toBe(true);
		expect((await call('find_relationships', { entity: 'Élodie' })).structuredContent).toEqual(
			related
		);
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

test('modern stdio validates request versions, keeps the full catalog stable and binds operations to the opened project', async () => {
	const sourceRoot = resolve(__dirname, '../../..');
	const loader = pathToFileURL(
		createRequire(join(sourceRoot, 'package.json')).resolve('tsx')
	).href;
	const root = await mkdtemp(join(tmpdir(), 'scrivener-modern-protocol-'));
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', loader, join(sourceRoot, 'src/index.ts')],
		cwd: root,
		stderr: 'pipe',
		env: {
			...getDefaultEnvironment(),
			SCRIVENER_LOCAL_ONLY: 'true',
			SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
			SCRIVENER_SKIP_SETUP: 'true',
			SCRIVENER_DATA_DIR: join(root, 'state'),
			SCRIVENER_HMS_ENGINE: 'fallback',
		},
	});
	type Reply = { result?: Record<string, unknown>; error?: { code: number; message: string } };
	const waiting = new Map<number, (reply: Reply) => void>();
	let nextId = 0;
	let stderr = '';
	transport.onmessage = (message) => {
		if ('id' in message && typeof message.id === 'number')
			waiting.get(message.id)?.(message as Reply);
	};
	const metadata = {
		'io.modelcontextprotocol/protocolVersion': '2026-07-28',
		'io.modelcontextprotocol/clientInfo': { name: 'local-modern-fixture', version: '1' },
		'io.modelcontextprotocol/clientCapabilities': {},
	};
	const request = async (
		method: string,
		params: Record<string, unknown> = {},
		meta: Record<string, unknown> = metadata
	): Promise<Reply> => {
		const id = ++nextId;
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		try {
			const reply = new Promise<Reply>((resolve, reject) => {
				waiting.set(id, resolve);
				timeout = globalThis.setTimeout(
					() => reject(new Error(`Modern request timed out: ${method}; ${stderr}`)),
					10000
				);
			});
			await transport.send({
				jsonrpc: '2.0',
				id,
				method,
				params: { ...params, _meta: meta },
			});
			return await reply;
		} finally {
			clearTimeout(timeout);
			waiting.delete(id);
		}
	};
	try {
		for (const name of ['First.scriv', 'Second.scriv'])
			await cp(join(sourceRoot, 'assets/sample-project/Welcome.scriv'), join(root, name), {
				recursive: true,
			});
		await transport.start();
		transport.stderr?.on('data', (chunk) => {
			stderr = (stderr + String(chunk)).slice(-8192);
		});
		const discovery = await request('server/discover');
		expect(discovery.error).toBeUndefined();
		expect(discovery.result).toMatchObject({
			resultType: 'complete',
			ttlMs: 0,
			cacheScope: 'private',
		});
		const before = await request('tools/list');
		const names = (before.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
		expect(names.length).toBeGreaterThanOrEqual(82);
		expect(names).toContain('analyze_document');
		await request('tools/call', { name: 'use_skill', arguments: { name: 'analysis' } });
		expect((await request('tools/list')).result?.tools).toEqual(before.result?.tools);
		expect(
			(
				await request(
					'tools/list',
					{},
					{ ...metadata, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }
				)
			).error?.code
		).toBe(-32022);
		expect(
			(
				await request(
					'server/discover',
					{},
					{ ...metadata, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }
				)
			).error?.code
		).toBe(-32022);
		expect(
			(
				await request(
					'tools/list',
					{},
					{ ...metadata, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' }
				)
			).error?.code
		).toBe(-32022);
		expect(
			(
				await request(
					'tools/list',
					{},
					{
						...metadata,
						'io.modelcontextprotocol/clientCapabilities': {
							extensions: {
								'io.modelcontextprotocol/ui': {
									mimeTypes: ['text/html;profile=mcp-app'],
								},
							},
						},
					}
				)
			).result?.tools
		).toEqual(before.result?.tools);
		expect((await request('tools/list', {}, {})).error).toBeDefined();
		const opened = await request('tools/call', {
			name: 'open_project',
			arguments: { path: join(root, 'First.scriv') },
		});
		expect(opened.result?.isError).not.toBe(true);
		const token = (opened.result?._meta as Record<string, unknown>)['com.writerslogic/project'];
		expect(typeof token).toBe('string');
		expect(
			(await request('tools/call', { name: 'get_structure', arguments: {} })).result?.isError
		).toBe(true);
		expect(
			(
				await request(
					'tools/call',
					{ name: 'get_structure', arguments: {} },
					{ ...metadata, 'com.writerslogic/project': token }
				)
			).result?.isError
		).not.toBe(true);
		const second = await request('tools/call', {
			name: 'open_project',
			arguments: { path: join(root, 'Second.scriv') },
		});
		expect(second.result?.isError).not.toBe(true);
		expect(
			(
				await request(
					'tools/call',
					{ name: 'get_structure', arguments: {} },
					{ ...metadata, 'com.writerslogic/project': token }
				)
			).result?.isError
		).toBe(true);
		expect((await request('tools/list')).result?.tools).toEqual(before.result?.tools);
		const secondToken = (second.result?._meta as Record<string, unknown>)[
			'com.writerslogic/project'
		];
		expect(
			(
				await request(
					'tools/call',
					{ name: 'close_project', arguments: {} },
					{ ...metadata, 'com.writerslogic/project': secondToken }
				)
			).result?.isError
		).not.toBe(true);
	} finally {
		await transport.close();
		await rm(root, { recursive: true, force: true });
	}
}, 40000);
