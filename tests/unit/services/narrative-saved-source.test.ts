import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { collectNarrativeReport as collect } from '../../helpers/narrative-report.js';
import type { HandlerContext } from '../../../src/handlers/types.js';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import { DocumentTree } from '../../../src/services/document-tree.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import { MutationCoordinator } from '../../../src/services/editorial/mutation-coordinator.js';
import { ProjectSource } from '../../../src/services/editorial/project-source.js';
import { manuscriptDocuments } from '../../../src/services/editorial/project-registry.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import { NarrativeAnalysis } from '../../../src/services/editorial/narrative-analysis.js';

const PAGE_BYTES = 32768;
const SAMPLES = 5;
const BUDGETS = { elapsedMs: 5000, eventLoopLagMs: 100, rssGrowthBytes: 128 * 1024 * 1024 };
type Report = Awaited<ReturnType<NarrativeAnalysis['analyze']>>;
const measurements: Array<{
	scenes: number;
	findingsPerScene: number;
	sample: number;
	phase: string;
	elapsedMs: number;
	eventLoopLagMs: number;
	timerTicks: number;
	rssStartBytes: number;
	rssPeakBytes: number;
	rssGrowthBytes: number;
	pages: number;
	outputBytes: number;
	maxPageBytes: number;
	rawReads: number;
}> = [];

afterAll(async () => {
	const output = process.env.SCRIVENER_RESOURCE_REPORT;
	if (!output) return;
	await mkdir(dirname(output), { recursive: true });
	await writeFile(
		output,
		JSON.stringify(
			{
				node: process.version,
				platform: `${process.platform}-${process.arch}`,
				samplesPerPhase: SAMPLES,
				pageBytes: PAGE_BYTES,
				budgets: BUDGETS,
				scope: 'Saved synthetic Scrivener RTF, production source/revision reads, native analysis, baseline persistence/comparison, all MCP pages and serialization. Excludes project opening, OS cold disk cache, client/network overhead and model inference. RSS is sampled every 5 ms; not an enforced memory bound. Five-sample nearest-rank p95 equals the maximum.',
				measurements,
			},
			null,
			2
		) + '\n'
	);
});

describe('saved-source analysis and report transport', () => {
	it.each([8, 32, 96].flatMap((scenes) => [1, 8].map((density) => [scenes, density])))(
		'preserves revisions and findings for %i saved scenes with %i findings each',
		async (scenes, density) => {
			const directory = await mkdtemp(join(tmpdir(), 'scrivener-saved-lens-'));
			const project = join(directory, 'Probe.scriv');
			await mkdir(project);
			const rtf = new RTFHandler();
			const ids = Array.from(
				{ length: scenes },
				(_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
			);
			const content = (scene: number) =>
				Array.from(
					{ length: density },
					(_, i) => `🌙 Mira was was tired after lesson ${i} in scene ${scene}.`
				).join('\n');
			const file = (id: string) => join(project, 'Files', 'Data', id, 'content.rtf');
			for (let i = 0; i < scenes; i++) {
				await mkdir(dirname(file(ids[i])), { recursive: true });
				await writeFile(file(ids[i]), rtf.convertToRTF(content(i)));
			}
			await writeFile(
				join(project, 'Probe.scrivx'),
				`<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="2.0"><Binder><BinderItem UUID="20000000-0000-4000-8000-000000000001" Type="DraftFolder"><Title>Draft</Title><Children>
${ids.map((id, i) => `<BinderItem UUID="${id}" Type="Text"><Title>Scene ${i}</Title></BinderItem>`).join('')}
</Children></BinderItem></Binder></ScrivenerProject>`
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
				await service.setControls({
					configuration: {
						rules: ['NL-GRAMMAR-REPETITION'],
						limits: { maxFindings: 4096 },
					},
				});
				await service.close();
				const last = file(ids[ids.length - 1]);
				const original = await readFile(last, 'utf8');
				for (let sample = 0; sample < SAMPLES; sample++) {
					await writeFile(last, original);
					service = open();
					const context = {
						project: { getEditorialServices: () => ({ narrative: service }) },
					} as unknown as HandlerContext;
					let before: Report | undefined;
					for (const phase of ['cold', 'warm', 'one-scene-edit']) {
						if (phase === 'one-scene-edit')
							await writeFile(
								last,
								rtf.convertToRTF(content(scenes - 1).replace('was was', 'was'))
							);
						const rssStartBytes = process.memoryUsage.rss();
						let rssPeakBytes = rssStartBytes,
							eventLoopLagMs = 0,
							timerTicks = 0;
						let lastTick = performance.now();
						const timer = setInterval(() => {
							const now = performance.now();
							eventLoopLagMs = Math.max(eventLoopLagMs, now - lastTick - 5);
							lastTick = now;
							timerTicks++;
							rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage.rss());
						}, 5);
						const startReads = rawReads;
						const started = performance.now();
						let output: Awaited<ReturnType<typeof collect>>;
						try {
							output = await collect(
								context,
								phase === 'cold' ? { saveAs: 'baseline' } : { baseline: 'baseline' }
							);
						} finally {
							clearInterval(timer);
						}
						const elapsedMs = performance.now() - started;
						eventLoopLagMs = Math.max(eventLoopLagMs, performance.now() - lastTick - 5);
						rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage.rss());
						const { report, ...transport } = output;
						measurements.push({
							scenes,
							findingsPerScene: density,
							sample,
							phase,
							elapsedMs,
							eventLoopLagMs,
							timerTicks,
							rssStartBytes,
							rssPeakBytes,
							rssGrowthBytes: rssPeakBytes - rssStartBytes,
							...transport,
							rawReads: rawReads - startReads,
						});
						expect(rawReads - startReads).toBe(scenes * 2);
						expect(report.snapshot.report.findings).toHaveLength(
							scenes * density - (phase === 'one-scene-edit' ? 1 : 0)
						);
						expect(new Set(report.findingIds).size).toBe(report.findingIds.length);
						expect(report.envelope.policy.revisionChecked).toBe(true);
						if (phase === 'cold') before = report;
						else if (phase === 'warm') {
							expect(report.envelope.requestId).toBe(before!.envelope.requestId);
							expect(report.cache.reusedScenes).toBe(scenes);
						} else {
							expect(report.envelope.requestId).not.toBe(before!.envelope.requestId);
							expect(report.cache.recomputedScenes).toBe(1);
							expect(report.cache.reusedScenes).toBe(scenes - 1);
							expect(report.comparison!.resolved).toHaveLength(1);
						}
					}
					await service.close();
				}
			} finally {
				await service?.close();
				await reader.close();
				await loader.close();
				store.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
		60000
	);
});
