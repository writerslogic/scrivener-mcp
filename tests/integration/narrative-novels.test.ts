import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { HandlerContext } from '../../src/handlers/types.js';
import { ProjectLoader } from '../../src/services/project-loader.js';
import { DocumentTree } from '../../src/services/document-tree.js';
import { MutationCoordinator } from '../../src/services/editorial/mutation-coordinator.js';
import { ProjectSource } from '../../src/services/editorial/project-source.js';
import { manuscriptDocuments } from '../../src/services/editorial/project-registry.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { NarrativeAnalysis } from '../../src/services/editorial/narrative-analysis.js';
import { collectNarrativeReport } from '../helpers/narrative-report.js';
import { createNovelProject, type NovelCorpus } from '../helpers/narrative-novel-project.js';

type Report = Awaited<ReturnType<NarrativeAnalysis['analyze']>>;
const corpus = JSON.parse(
	readFileSync(join(__dirname, '../fixtures/narrative-novels.json'), 'utf8')
) as NovelCorpus[];
const directory = process.env.SCRIVENER_NOVEL_CORPUS;
const samples = Number(process.env.SCRIVENER_NOVEL_SAMPLES ?? 1);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 5)
	throw new Error('Novel sample count must be between one and five');
const budgets = { elapsedMs: 5000, eventLoopLagMs: 100, rssGrowthBytes: 128 * 1024 * 1024 };
const measurements: Record<string, unknown>[] = [];
const pageBytes = 32768;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const profiling = process.env.SCRIVENER_NOVEL_PROFILE === '1';
let stages: Record<string, { calls: number; totalMs: number; maximumMs: number }> = {};
let rssCheckpoints: Record<string, number> = {};
function timed<T>(name: string, operation: () => T): T {
	const started = performance.now();
	try {
		return operation();
	} finally {
		const elapsed = performance.now() - started;
		const stage = (stages[name] ??= { calls: 0, totalMs: 0, maximumMs: 0 });
		stage.calls++;
		stage.totalMs += elapsed;
		stage.maximumMs = Math.max(stage.maximumMs, elapsed);
		rssCheckpoints[name] = process.memoryUsage.rss();
	}
}

afterAll(async () => {
	const output = process.env.SCRIVENER_NOVEL_REPORT;
	if (!output) return;
	await mkdir(dirname(output), { recursive: true });
	await writeFile(
		output,
		JSON.stringify(
			{
				node: process.version,
				platform: `${process.platform}-${process.arch}`,
				compiler:
					(globalThis as { narrativeBenchmarkCompiler?: string })
						.narrativeBenchmarkCompiler ?? 'typechecking',
				samplesPerPhase: samples,
				pageBytes,
				budgets,
				scope: 'Complete Gutenberg bodies including front matter, normalized to LF and split at paragraph-preferred 16000 UTF-16 boundaries. Saved Scrivener RTF, source revision checks, all default native rule families with a declared 5000-finding budget, baseline persistence/comparison and all MCP pages including client reconstruction. Excludes setup, OS cold disk cache, network and model inference. Cold means fresh native/source caches. The edit appends a Unicode sentence to the last scene. Parent RSS growth and lag are sampled every 5 ms in the shared Jest/server/client process; they are not isolated server measurements and sampling may miss peaks. Parent lifetime and comparison child high-water RSS are recorded separately. Context-child RSS is excluded here; the stdio harness records both native children. The sum of observed process peaks is not a simultaneous peak or a total-memory bound. RSS is observed, not contained. Workload measurements do not assess editorial accuracy or represent all novels.',
				measurements,
			},
			null,
			2
		) + '\n'
	);
});

(directory ? test.each(corpus) : test.skip.each(corpus))(
	'complete novel $id: $title',
	async (entry) => {
		const { root, project, body, scenes, ids, rtf, file } = await createNovelProject(
			entry,
			directory!
		);
		const loader = new ProjectLoader(project);
		const reader = new MutationCoordinator(project);
		const store = new PersistentStore(join(project, '.scrivener-mcp', 'editorial.sqlite'));
		let service: NarrativeAnalysis | undefined;
		try {
			const structure = await loader.loadProject();
			const tree = new DocumentTree(project, rtf, () => structure);
			let rawReads = 0;
			const open = () =>
				new NarrativeAnalysis(
					new ProjectSource(
						project,
						store,
						async () => manuscriptDocuments(await tree.getProjectStructure()),
						async (id) => {
							rawReads++;
							return (await reader.readRaw(id)).raw;
						}
					),
					store
				);
			service = open();
			await service.setControls({ configuration: { limits: { maxFindings: 5000 } } });
			await service.close();
			const last = file(ids[ids.length - 1]);
			const original = await readFile(last, 'utf8');
			const childStats = join(root, 'comparison-process.json');
			const nativePaths = jest.requireActual<
				typeof import('../../src/services/editorial/lens-native.cjs')
			>('../../src/services/editorial/lens-native.cjs');
			const nativeModule = nativePaths.narrativeModulePath();
			const wrapper = join(root, 'comparison.cjs');
			await writeFile(
				wrapper,
				`exports.ManuscriptContext = require(${JSON.stringify(nativeModule)}).ManuscriptContext;
exports.compareManuscriptReports = (...args) => {
            const started = performance.now();
            const result = require(${JSON.stringify(nativeModule)}).compareManuscriptReports(...args);
            const nativeComparisonMs = performance.now() - started;
            process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(childStats)}, JSON.stringify({ pid: process.pid, nativeComparisonMs, maxRssBytes: process.resourceUsage().maxRSS * 1024 })));
            return result;
        };`
			);
			jest.spyOn(nativePaths, 'narrativeModulePath').mockReturnValue(wrapper);
			const violations: Array<{
				phase: string;
				sample: number;
				metric: string;
				value: number;
				limit: number;
			}> = [];
			for (let sample = 0; sample < samples; sample++) {
				await writeFile(last, original);
				service = open();
				if (profiling) {
					const page = service.transport.pageSerialized.bind(service.transport);
					service.transport.pageSerialized = (action, args, value) =>
						timed(value === undefined ? 'continuation' : 'firstPage', () =>
							page(action, args, value)
						);
				}
				let expectedHash: string | undefined;
				const analyze = service.serializedAnalysis.bind(service);
				service.serializedAnalysis = async (options) => {
					const serialized = await analyze(options);
					expectedHash = hash(serialized);
					rssCheckpoints.analyzed = process.memoryUsage.rss();
					return serialized;
				};
				const context = {
					project: { getEditorialServices: () => ({ narrative: service }) },
				} as unknown as HandlerContext;
				let baseline:
					| {
							requestId: string;
							reportHash: string;
							sources: Report['snapshot']['sources'];
					  }
					| undefined;
				for (const phase of ['cold', 'warm', 'one-scene-edit']) {
					stages = {};
					rssCheckpoints = {};
					expectedHash = undefined;
					await rm(childStats, { force: true });
					if (phase === 'one-scene-edit')
						await writeFile(
							last,
							rtf.convertToRTF(
								`${scenes[scenes.length - 1]}\n🌙 A brass compass waited beside the harbor.`
							)
						);
					const startReads = rawReads;
					const rssStartBytes = process.memoryUsage.rss();
					let rssPeakBytes = rssStartBytes,
						eventLoopLagMs = 0,
						timerTicks = 0,
						lastTick = performance.now();
					const timer = setInterval(() => {
						const now = performance.now();
						eventLoopLagMs = Math.max(eventLoopLagMs, now - lastTick - 5);
						lastTick = now;
						timerTicks++;
						rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage.rss());
					}, 5);
					const started = performance.now();
					let output: Awaited<ReturnType<typeof collectNarrativeReport>>;
					try {
						output = await collectNarrativeReport(
							context,
							phase === 'cold' ? { saveAs: 'baseline' } : { baseline: 'baseline' },
							pageBytes,
							(phase) => {
								rssCheckpoints[phase] = process.memoryUsage.rss();
							}
						);
					} finally {
						clearInterval(timer);
					}
					const elapsedMs = performance.now() - started;
					eventLoopLagMs = Math.max(eventLoopLagMs, performance.now() - lastTick - 5);
					rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage.rss());
					const { report, ...transport } = output;
					const child =
						phase === 'cold'
							? null
							: (JSON.parse(await readFile(childStats, 'utf8')) as {
									pid: number;
									nativeComparisonMs: number;
									maxRssBytes: number;
								});
					if (child) expect(() => process.kill(child.pid, 0)).toThrow();
					const observation = {
						corpusId: entry.id,
						corpusSha256: entry.sha256,
						bodySha256: hash(body!),
						baselineProjectedScenesSha256: hash(JSON.stringify(scenes)),
						utf8Bytes: Buffer.byteLength(body!),
						utf16Characters: body!.length,
						whitespaceTokens: body!.trim().split(/\s+/).length,
						scenes: scenes.length,
						sample,
						phase,
						elapsedMs,
						eventLoopLagMs,
						timerTicks,
						rssStartBytes,
						rssPeakBytes,
						rssGrowthBytes: rssPeakBytes - rssStartBytes,
						rawReads: rawReads - startReads,
						...transport,
						findings: report.snapshot.report.summary,
						cache: report.cache,
						coverage: report.snapshot.report.coverage,
						requestId: report.envelope.requestId,
						comparisonProcess: child,
						parentLifetimeHighWaterBytes: process.resourceUsage().maxRSS * 1024,
						sumObservedProcessPeaksBytes: rssPeakBytes + (child?.maxRssBytes ?? 0),
						...(profiling ? { stages, rssCheckpoints } : {}),
					};
					measurements.push(observation);
					process.stdout.write(
						JSON.stringify({
							corpusId: entry.id,
							phase,
							sample,
							elapsedMs,
							eventLoopLagMs,
							rssGrowthBytes: observation.rssGrowthBytes,
							pages: transport.pages,
							summary: observation.findings,
						}) + '\n'
					);
					expect(hash(JSON.stringify(report))).toBe(expectedHash);
					expect(report.snapshot.sources).toHaveLength(scenes.length);
					expect(rawReads - startReads).toBe(scenes.length * 2);
					expect(new Set(report.findingIds).size).toBe(report.findingIds.length);
					expect(report.envelope.policy.revisionChecked).toBe(true);
					if (phase === 'cold')
						baseline = {
							requestId: report.envelope.requestId,
							reportHash: hash(JSON.stringify(report.snapshot.report)),
							sources: report.snapshot.sources,
						};
					else if (phase === 'warm') {
						expect(report.envelope.requestId).toBe(baseline!.requestId);
						expect(hash(JSON.stringify(report.snapshot.report))).toBe(
							baseline!.reportHash
						);
					} else {
						expect(report.envelope.requestId).not.toBe(baseline!.requestId);
						expect(
							report.snapshot.sources.filter(
								(source, index) =>
									source.revision !== baseline!.sources[index].revision
							)
						).toHaveLength(1);
					}
					for (const [metric, limit] of Object.entries(budgets)) {
						const value = observation[metric as keyof typeof budgets];
						if (value > limit) violations.push({ phase, sample, metric, value, limit });
					}
				}
				await service.close();
			}
			expect(violations).toEqual([]);
		} finally {
			jest.restoreAllMocks();
			await service?.close();
			await reader.close();
			await loader.close();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	120000
);
