import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createNovelProject, type NovelCorpus } from '../helpers/narrative-novel-project.js';
import { collectNarrativeReport } from '../helpers/narrative-report.js';

type Metrics = {
	elapsedMs: number;
	eventLoopLagMs: number;
	rssStartBytes: number;
	rssPeakBytes: number;
	rssGrowthBytes: number;
	lifetimeHighWaterBytes: number;
	processTreeRssPeakBytes: number;
	processTreeSamples: number;
	processTreeError?: string;
};
const corpus = JSON.parse(
	readFileSync(join(__dirname, '../fixtures/narrative-novels.json'), 'utf8')
) as NovelCorpus[];
const directory = process.env.SCRIVENER_NOVEL_CORPUS;
const samples = Number(process.env.SCRIVENER_NOVEL_SAMPLES ?? 1);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 5)
	throw new Error('Novel sample count must be between one and five');
const budgets = {
	elapsedMs: 5000,
	eventLoopLagMs: 100,
	rssGrowthBytes: 128 * 1024 * 1024,
	processTreeRssPeakBytes: 2 * 1024 * 1024 * 1024,
};
const measurements: Record<string, unknown>[] = [];
const sourceRoot = resolve(__dirname, '../..');
const loader = pathToFileURL(createRequire(join(sourceRoot, 'package.json')).resolve('tsx')).href;

afterAll(async () => {
	const output = process.env.SCRIVENER_NOVEL_STDIO_REPORT;
	if (!output) return;
	await mkdir(dirname(output), { recursive: true });
	await writeFile(
		output,
		JSON.stringify(
			{
				node: process.version,
				platform: `${process.platform}-${process.arch}`,
				samplesPerPhase: samples,
				budgets,
				scope: 'Real src/index.ts server in a separate process, public MCP tools over stdio, complete pinned novel fixtures and 32768-byte result pages. Server RSS and event-loop lag sampled every 5 ms exclude client/Jest and all native children. Native children report lifetime high-water RSS after native execution and after serialization: on the next event-loop turn for the persistent context, and at process exit for comparisons. The sum of observed process peaks is not simultaneous RSS or a containment bound. Elapsed time includes client reconstruction, child instrumentation and local IPC. Setup, project opening and OS cold disk cache are excluded. Cold means a reopened project with fresh native/source caches. Simultaneous server/descendant RSS is sampled using ps every 100 ms plus operation boundaries, including measurement overhead but excluding client/Jest; sample peaks are not hard containment. Sampling can miss peaks. This is workload evidence, not RSS containment or editorial accuracy.',
				measurements,
			},
			null,
			2
		) + '\n'
	);
});

(directory ? test.each(corpus) : test.skip.each(corpus))(
	'stdio novel $id: $title',
	async (entry) => {
		const fixture = await createNovelProject(entry, directory!);
		const { root, project, scenes, ids, file, rtf } = fixture;
		const childResources = join(root, 'native-resources.jsonl');
		const resourceModule = join(root, 'native-resource-module.cjs');
		const resourcePreload = join(root, 'native-resource-preload.cjs');
		const nativeModule = createRequire(join(sourceRoot, 'package.json')).resolve(
			'narrative-lens'
		);
		await writeFile(
			resourcePreload,
			`if (require('node:worker_threads').isMainThread) {
  const instrumented = require(${JSON.stringify(resourceModule)});
  require.cache[require.resolve(${JSON.stringify(nativeModule)})].exports = instrumented;
}`
		);
		await writeFile(
			resourceModule,
			`
const native = require(${JSON.stringify(nativeModule)});
const record = (kind, stage) => require('node:fs').appendFileSync(${JSON.stringify(childResources)}, JSON.stringify({ kind, stage, pid: process.pid, maxRssBytes: process.resourceUsage().maxRSS * 1024, rssBytes: process.memoryUsage.rss() }) + '\\n');
const measured = (kind, fn) => { try { return fn(); } finally { record(kind, 'native'); const serialized = () => record(kind, 'serialized'); if (kind === 'comparison') process.once('exit', serialized); else setImmediate(serialized); } };
module.exports = { ...native,
  ManuscriptContext: class {
    constructor(...args) { this.context = new native.ManuscriptContext(...args); }
    analyze(input) { return measured('context', () => this.context.analyze(input)); }
    stats() { return this.context.stats(); }
    clear() { return this.context.clear(); }
  },
  compareManuscriptReports: (...args) => measured('comparison', () => native.compareManuscriptReports(...args))
};
`
		);
		const child = fork(join(sourceRoot, 'tests/helpers/server-resource-probe.mjs'), [], {
			execPath: process.execPath,
			execArgv: ['--import', loader],
			silent: true,
			cwd: root,
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
				UV_THREADPOOL_SIZE: '1',
				RAYON_NUM_THREADS: '1',
				OMP_NUM_THREADS: '1',
				SCRIVENER_NOVEL_PROFILE: process.env.SCRIVENER_NOVEL_PROFILE === '1' ? '1' : '0',
				SCRIVENER_NOVEL_RESOURCE_PRELOAD: resourcePreload,
			},
		});
		process.stdout.write(JSON.stringify({ corpusId: entry.id, serverPid: child.pid }) + '\n');
		const transport = new StdioServerTransport(child.stdout!, child.stdin!, {
			maxBufferSize: 2 * 1024 * 1024,
		});
		transport.send = (message) =>
			new Promise((done, reject) =>
				child.stdin!.write(serializeMessage(message), (error) =>
					error ? reject(error) : done()
				)
			);
		child.stdin!.on('error', (error) => transport.onerror?.(error));
		child.on('error', (error) => transport.onerror?.(error));
		let stopped = false;
		const closed = new Promise<void>((done) =>
			child.once('close', () => {
				stopped = true;
				transport.onclose?.();
				done();
			})
		);
		let stderr = '';
		child.stderr!.on('data', (chunk) => {
			stderr = (stderr + String(chunk)).slice(-8192);
		});
		const client = new Client(
			{ name: 'novel-resource-probe', version: '1' },
			{ capabilities: {} }
		);
		let nextControlId = 0;
		const control = (action: 'start' | 'end') =>
			new Promise<Metrics | undefined>((done, reject) => {
				const id = ++nextControlId;
				const finish = (error?: Error, metrics?: Metrics) => {
					clearTimeout(timeout);
					child.off('message', receive);
					child.off('close', exited);
					if (error) reject(error);
					else done(metrics);
				};
				const receive = (message: unknown) => {
					const reply = message as { id?: number; metrics?: Metrics };
					if (reply?.id === id) finish(undefined, reply.metrics);
				};
				const exited = () => finish(new Error('Server exited during resource measurement'));
				const timeout = setTimeout(
					() => finish(new Error('Resource measurement control timed out')),
					5000
				);
				child.on('message', receive);
				child.once('close', exited);
				try {
					child.send({ id, action }, (error) => {
						if (error) finish(error);
					});
				} catch (error) {
					finish(error as Error);
				}
			});
		let operation = 'initialize';
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			operation = name;
			const result = CallToolResultSchema.parse(
				await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 })
			);
			if (result.isError)
				throw new Error(
					`Public tool failed: ${name}: ${JSON.stringify(result.content).slice(0, 2048)}`
				);
			return result;
		};
		const violations: Record<string, unknown>[] = [];
		try {
			await client.connect(transport, { timeout: 30000 });
			await call('open_project', { path: project });
			await call('analyze_manuscript_local', {
				action: 'configure',
				controls: { configuration: { limits: { maxFindings: 5000 } } },
			});
			await call('close_project');
			const last = file(ids[ids.length - 1]);
			const original = await readFile(last, 'utf8');
			for (let sample = 0; sample < samples; sample++) {
				await writeFile(last, original);
				await call('open_project', { path: project });
				let before:
					Awaited<ReturnType<typeof collectNarrativeReport>>['report'] | undefined;
				for (const phase of ['cold', 'warm', 'one-scene-edit']) {
					if (phase === 'one-scene-edit')
						await writeFile(
							last,
							rtf.convertToRTF(
								`${scenes[scenes.length - 1]}\n🌙 A brass compass waited beside the harbor.`
							)
						);
					await writeFile(childResources, '');
					await control('start');
					const { report, ...pages } = await collectNarrativeReport(
						(args) => call('analyze_manuscript_local', args),
						phase === 'cold' ? { saveAs: 'baseline' } : { baseline: 'baseline' }
					);
					const metrics = (await control('end'))!;
					expect(metrics.processTreeError).toBeUndefined();
					expect(metrics.processTreeSamples).toBeGreaterThan(0);
					expect(metrics.processTreeRssPeakBytes).toBeLessThanOrEqual(
						budgets.processTreeRssPeakBytes
					);
					const nativeResources = (await readFile(childResources, 'utf8'))
						.trim()
						.split('\n')
						.filter(Boolean)
						.map(
							(line) =>
								JSON.parse(line) as {
									kind: string;
									stage: string;
									pid: number;
									maxRssBytes: number;
									rssBytes: number;
								}
						);
					for (const kind of phase === 'cold' ? ['context'] : ['context', 'comparison'])
						for (const stage of ['native', 'serialized'])
							expect(
								nativeResources.some(
									(value) => value.kind === kind && value.stage === stage
								)
							).toBe(true);
					const processPeaks = new Map<number, number>();
					for (const value of nativeResources) {
						expect(
							Number.isSafeInteger(value.maxRssBytes) && value.maxRssBytes > 0
						).toBe(true);
						processPeaks.set(
							value.pid,
							Math.max(processPeaks.get(value.pid) ?? 0, value.maxRssBytes)
						);
					}
					const observation = {
						corpusId: entry.id,
						corpusSha256: entry.sha256,
						sample,
						phase,
						...metrics,
						nativeResources,
						sumObservedProcessPeaksBytes:
							metrics.rssPeakBytes +
							[...processPeaks.values()].reduce((a, b) => a + b, 0),
						...pages,
						findings: report.snapshot.report.summary,
						cache: report.cache,
						requestId: report.envelope.requestId,
					};
					measurements.push(observation);
					process.stdout.write(JSON.stringify(observation) + '\n');
					expect(report.snapshot.sources).toHaveLength(scenes.length);
					expect(new Set(report.findingIds).size).toBe(report.findingIds.length);
					expect(report.envelope.policy.revisionChecked).toBe(true);
					if (phase === 'cold') before = report;
					else {
						expect(report.comparisonBaseline).toEqual({
							name: 'baseline',
							envelope: before!.envelope,
						});
						if (phase === 'warm')
							expect(report.snapshot.report).toEqual(before!.snapshot.report);
						else
							expect(
								report.snapshot.sources.filter(
									(source, index) =>
										source.revision !== before!.snapshot.sources[index].revision
								)
							).toHaveLength(1);
					}
					for (const [metric, limit] of Object.entries(budgets))
						if (metrics[metric as keyof typeof budgets] > limit)
							violations.push({
								sample,
								phase,
								metric,
								value: metrics[metric as keyof typeof budgets],
								limit,
							});
				}
				await call('close_project');
			}
			expect(violations).toEqual([]);
		} catch (error) {
			throw new Error(
				`Novel stdio probe failed during ${operation}: ${stderr || 'no server diagnostics'}`,
				{
					cause: error,
				}
			);
		} finally {
			try {
				await client.close();
			} finally {
				child.stdin!.end();
				if (!stopped) child.kill('SIGTERM');
				const force = setTimeout(() => {
					if (!stopped) child.kill('SIGKILL');
				}, 5000);
				try {
					await closed;
				} finally {
					clearTimeout(force);
					await rm(root, { recursive: true, force: true });
				}
			}
		}
	},
	120000
);
