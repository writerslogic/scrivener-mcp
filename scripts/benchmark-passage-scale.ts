import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { processTree, PROCESS_OBSERVER_TIMEOUT_MS } from './lib/benchmark-process-tree.js';
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { cpus, loadavg, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { setImmediate as turn } from 'node:timers/promises';
import {
	PassageSearch,
	type PassageSearchResult,
} from '../src/services/editorial/passage-search.js';
import { PersistentStore } from '../src/services/editorial/persistent-store.js';
import { ProjectSource } from '../src/services/editorial/project-source.js';
import { HolographicMemorySystem } from '../src/services/memory/hhm/holographic-memory-system.js';
import { RTFHandler } from '../src/services/parsers/rtf-handler.js';
import type { ScrivenerDocument } from '../src/types/index.js';

const { values } = parseArgs({
	options: {
		output: { type: 'string' },
		passages: { type: 'string', default: '1000' },
		samples: { type: 'string', default: '5' },
		engine: { type: 'string', default: 'fallback' },
	},
	strict: true,
});
const count = Number(values.passages);
const samples = Number(values.samples);
assert([1000, 10000, 50000].includes(count), 'Passages must be 1000, 10000 or 50000');
assert(
	Number.isSafeInteger(samples) && samples >= 1 && samples <= 5,
	'Samples must be 1 through 5'
);
assert(
	values.engine === 'fallback' || values.engine === 'native',
	'Select fallback or installed native explicitly'
);
assert(values.output, '--output is required');
const engineMode = values.engine;
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, '{"status":"initializing"}\n', { flag: 'wx' });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fixturePath = 'tests/fixtures/passage-relevance.json';
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as { documents: Array<{ text: string }> };
const files = execFileSync('rg', ['--files', 'src'], { encoding: 'utf8' })
	.trim()
	.split('\n')
	.sort();
const sourceManifest = await Promise.all(
	files.map(async (file) => ({ file, sha256: hash(await readFile(file)) }))
);
const paragraphsPerDocument = 10;
const passageUnits = 900;
const targetPassage = Math.floor(count / 2);
const documentCount = count / paragraphsPerDocument;
function paragraph(index: number): string {
	const marker = index === targetPassage ? 'amberpin' : `marker${String(index).padStart(6, '0')}`;
	const prose = `Passage ${index}. ${marker} 🌙 ${fixture.documents[index % fixture.documents.length].text} `;
	const filler =
		'The keeper copied each entry into the ledger and placed the brass compass on the desk. ';
	return (
		(prose + filler.repeat(Math.ceil(passageUnits / filler.length))).slice(
			0,
			passageUnits - 1
		) + '.'
	);
}
function documentText(index: number): string {
	return Array.from({ length: paragraphsPerDocument }, (_, offset) =>
		paragraph(index * paragraphsPerDocument + offset)
	).join('\n\n');
}
const targetDocument = Math.floor(targetPassage / paragraphsPerDocument);
const ids = Array.from(
	{ length: documentCount },
	(_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
);
const documentList: ScrivenerDocument[] = ids.map((id, index) => ({
	id,
	title: `Part ${index + 1}`,
	type: 'Text',
	path: `Draft/Part ${index + 1}`,
}));
const rtf = new RTFHandler();
const corpusHash = createHash('sha256').update('[');
const rawHash = createHash('sha256').update('[');
for (let index = 0; index < documentCount; index++) {
	const text = documentText(index);
	assert.equal(
		text.length,
		passageUnits * paragraphsPerDocument + (paragraphsPerDocument - 1) * 2
	);
	if (index) {
		corpusHash.update(',');
		rawHash.update(',');
	}
	corpusHash.update(JSON.stringify(text));
	rawHash.update(JSON.stringify(rtf.convertToRTF(text)));
}
const corpusSha256 = corpusHash.update(']').digest('hex');
const sourceRawSha256 = rawHash.update(']').digest('hex');
const budgets = {
	elapsedMs: 5000,
	eventLoopLagMs: 100,
	rssGrowthBytes: 128 * 1024 * 1024,
	processTreeRssPeakBytes: 2 * 1024 * 1024 * 1024,
};
const measurements: Record<string, unknown>[] = [];
const failures: Record<string, unknown>[] = [];
const report = {
	status: 'running',
	processObserverDeadlineMs: PROCESS_OBSERVER_TIMEOUT_MS,
	progress: { sample: -1, phase: 'initializing' },
	revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
	sourceTreeSha256: hash(JSON.stringify(sourceManifest)),
	sourceManifest,
	scriptSha256: hash(await readFile(new URL(import.meta.url))),
	resourceHelperSha256: hash(
		await readFile(new URL('./lib/benchmark-process-tree.ts', import.meta.url))
	),
	environment: {
		node: process.version,
		v8: process.versions.v8,
		platform: process.platform,
		arch: process.arch,
		osRelease: release(),
		cpu: cpus()[0]?.model,
		logicalCpus: cpus().length,
		totalMemoryBytes: totalmem(),
		loadAverageBefore: loadavg(),
	},
	workload: {
		passages: count,
		documents: documentCount,
		passageUtf16Units: passageUnits,
		sourceUtf16Units: count * passageUnits + documentCount * (paragraphsPerDocument - 1) * 2,
		samples,
		engineMode,
		fixturePath,
		fixtureSha256: hash(fixtureBytes),
		corpusSha256,
		sourceRawSha256,
		queries: ['amberpin', 'cobaltzz'],
		model: 'scrivener-story-concepts',
		modelRevision: '1',
		dimensions: 30,
	},
	budgets,
	limitations: [
		'Direct PassageSearch + real ProjectSource and saved RTF/filesystem; not MCP, native Scrivener GUI, ranking-quality or client compatibility evidence.',
		'Fixed original CC0 synthetic fixtures exercise index scale and exact citations; repetitive passages do not represent natural manuscript relevance.',
		'Cold means a fresh project, SQLite catalog, source text cache and selected engine, not OS cold disk or a fresh Node process. Reopen preserves SQLite and discards source/engine state.',
		'Trials share one Node process without forced GC; raw RSS baselines and post-close memory are retained. Fixture text is generated on demand outside timed phases, not retained as whole-project oracle copies. Setup allocations may influence later GC. No tail-percentile claims.',
		'This explicitly supplied engine bypasses model discovery/download. Fallback is JavaScript; native selection only uses an already installed binding.',
		'RSS includes in-process SQLite/native memory. Process-tree RSS is sampled independently every100ms and at boundaries, excluding the ps observer. The tsx/esbuild helper is a separate descendant and remains included; child identities/CPU/RSS are recorded before/after and checked after close.',
		'Process inventory spawn/parse overhead remains inside measured parent CPU/elapsed; ps observer RSS/CPU is excluded. RSS/event-loop sampling every5ms can miss peaks. Setup, external fixture edits, citation verification, disk inventory and close/open construction are excluded; reopen search includes cache rehydration.',
		'Isolation is operator-enforced, not automatic. Pause competing builds/tests before timing; unrelated host activity is uncontrolled.',
	],
	measurements,
	failures,
};
const startedAll = performance.now();
const save = async () => {
	await writeFile(
		`${output}.partial`,
		JSON.stringify({ ...report, wallTimeMs: performance.now() - startedAll }, null, 2) + '\n'
	);
	await rename(`${output}.partial`, output);
};
async function disk(
	directory: string
): Promise<{ logicalBytes: number; allocatedBytes: number; files: number }> {
	let logicalBytes = 0;
	let allocatedBytes = 0;
	let files = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const location = join(directory, entry.name);
		if (entry.isDirectory()) {
			const child = await disk(location);
			logicalBytes += child.logicalBytes;
			allocatedBytes += child.allocatedBytes;
			files += child.files;
		} else {
			const info = await stat(location);
			logicalBytes += info.size;
			allocatedBytes += info.blocks * 512;
			files++;
		}
	}
	return { logicalBytes, allocatedBytes, files };
}
const initialChildren = (await processTree())
	.filter((row) => row.pid !== process.pid)
	.map((row) => row.pid)
	.sort();
for (let sample = 0; sample < samples; sample++) {
	const root = await mkdtemp(join(tmpdir(), 'scrivener-passage-scale-'));
	let store: PersistentStore | undefined;
	let engine: HolographicMemorySystem | undefined;
	let search: PassageSearch | undefined;
	let source!: ProjectSource;
	const changes = new Map<number, string>();
	const expectedText = (index: number) => changes.get(index) ?? documentText(index);
	const expectedRaw = (index: number) => rtf.convertToRTF(expectedText(index));
	const file = (id: string) => join(root, 'Files', 'Data', id, 'content.rtf');
	let rawReads = 0;
	const open = () => {
		store = new PersistentStore(join(root, '.scrivener-mcp', 'editorial.sqlite'));
		source = new ProjectSource(
			root,
			store,
			async () => documentList,
			async (id) => {
				rawReads++;
				return readFile(file(id), 'utf8');
			}
		);
		engine = new HolographicMemorySystem({
			engine: engineMode,
			dimensions: 30,
			storagePath: join(root, '.scrivener-mcp', 'passage-native.sqlite'),
			embeddingSpace: { model: 'scrivener-story-concepts', revision: '1', dimensions: 30 },
		});
		search = new PassageSearch(source, store, engine);
	};
	const close = async () => {
		await search?.close();
		await engine?.destroy();
		store?.close();
		search = undefined;
		engine = undefined;
		store = undefined;
	};
	const verify = (result: PassageSearchResult, query: string, expectedCount = count) => {
		assert.equal(result.index.passages, expectedCount);
		assert(
			result.results.length > 0 && result.results.length <= 10,
			'Expected a bounded matching result'
		);
		assert(
			result.results.some(
				(hit) => hit.documentId === ids[targetDocument] && hit.quote.includes(query)
			),
			'Unique target marker missing'
		);
		for (const hit of result.results) {
			const index = ids.indexOf(hit.documentId);
			assert(index >= 0);
			assert.equal(hit.projectId, source.projectId);
			assert.equal(hit.revision, hash(expectedRaw(index)));
			assert.equal(hit.quote, expectedText(index).slice(hit.start, hit.end));
			assert.equal(hit.context, expectedText(index).slice(hit.contextStart, hit.contextEnd));
			assert.equal(hit.line, expectedText(index).slice(0, hit.start).split('\n').length);
			assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(hit.quote));
		}
	};
	const measure = async (phase: string, query: string, expectedChanged: number) => {
		report.progress = { sample, phase };
		await save();
		const treeBefore = await processTree();
		rawReads = 0;
		await turn();
		const memoryBefore = process.memoryUsage();
		const cpuBefore = process.cpuUsage();
		const start = performance.now();
		let last = start,
			lag = 0,
			peak = memoryBefore.rss,
			ticks = 0;
		const sampleResources = () => {
			const now = performance.now();
			lag = Math.max(lag, now - last - 5);
			last = now;
			peak = Math.max(peak, process.memoryUsage.rss());
			ticks++;
		};
		let processTreePeak = treeBefore.reduce((sum, row) => sum + row.rssBytes, 0);
		let processTreeSamples = 1;
		let treePending: Promise<void> | undefined;
		let treeError: string | undefined;
		const sampleTree = () =>
			(treePending ??= processTree()
				.then((rows) => {
					processTreePeak = Math.max(
						processTreePeak,
						rows.reduce((sum, row) => sum + row.rssBytes, 0)
					);
					processTreeSamples++;
				})
				.catch((error: unknown) => {
					treeError = String(error);
				})
				.finally(() => {
					treePending = undefined;
				}));
		const treeTimer = setInterval(() => {
			void sampleTree();
		}, 100);
		const timer = setInterval(sampleResources, 5);
		let result: PassageSearchResult | undefined;
		let error: unknown;
		try {
			result = await search!.search(query, { mode: 'keyword', limit: 10, contextChars: 80 });
			await turn();
		} catch (caught) {
			error = caught;
		} finally {
			clearInterval(timer);
			clearInterval(treeTimer);
			sampleResources();
			await sampleTree();
		}
		const metrics = {
			sample,
			phase,
			elapsedMs: performance.now() - start,
			eventLoopLagMs: lag,
			rssStartBytes: memoryBefore.rss,
			rssPeakBytes: peak,
			rssGrowthBytes: peak - memoryBefore.rss,
			parentLifetimeHighWaterBytes: process.resourceUsage().maxRSS * 1024,
			processTreeRssPeakBytes: Math.max(processTreePeak, peak),
			processTreeSamples,
			treeBefore,
			treeError,
			memoryBefore,
			memoryAfter: process.memoryUsage(),
			cpu: process.cpuUsage(cpuBefore),
			ticks,
			rawReads,
			engine: engine!.getStats(),
			index: result?.index,
		};
		measurements.push(metrics);
		for (const [metric, budget] of Object.entries(budgets))
			if (metrics[metric as keyof typeof budgets] > budget)
				failures.push({
					sample,
					phase,
					metric,
					value: metrics[metric as keyof typeof budgets],
					budget,
				});
		if (error) {
			failures.push({
				sample,
				phase,
				error: error instanceof Error ? error.message : String(error),
			});
			await save();
			throw error;
		}
		verify(result!, query);
		assert.equal(result!.index.changedDocuments, expectedChanged);
		const treeAfter = await processTree();
		Object.assign(metrics, { treeAfter });
		assert.equal(treeError, undefined);
		Object.assign(metrics, {
			citationsVerified: result!.results.length,
			catalog: store!.usage(`passage-documents:${source.projectId}`),
			disk: await disk(root),
		});
		await save();
		process.stdout.write(
			JSON.stringify({
				sample,
				phase,
				passages: count,
				elapsedMs: metrics.elapsedMs,
				rssGrowthBytes: metrics.rssGrowthBytes,
			}) + '\n'
		);
	};
	try {
		for (const [index, id] of ids.entries()) {
			await mkdir(dirname(file(id)), { recursive: true });
			await writeFile(file(id), expectedRaw(index));
		}
		open();
		await measure('cold', 'amberpin', documentCount);
		await measure('warm', 'amberpin', 0);
		const previous = await stat(file(ids[targetDocument]));
		changes.set(targetDocument, expectedText(targetDocument).replace('amberpin', 'cobaltzz'));
		assert.equal(Buffer.byteLength(expectedRaw(targetDocument)), previous.size);
		await writeFile(file(ids[targetDocument]), expectedRaw(targetDocument));
		await utimes(file(ids[targetDocument]), previous.atimeMs / 1000, previous.mtimeMs / 1000);
		const current = await stat(file(ids[targetDocument]));
		assert(
			Math.abs(current.mtimeMs - previous.mtimeMs) < 0.01,
			'Fixture mtime restore differs by >=10 microseconds'
		);
		await measure('same-size-edit', 'cobaltzz', 1);
		assert.equal((await search!.search('amberpin', { mode: 'keyword' })).results.length, 0);
		await close();
		open();
		await measure('reopen', 'cobaltzz', 0);
		if (count === 50000 && sample === 0) {
			const index = documentCount - 1;
			const saveLast = async (text: string) => {
				changes.set(index, text);
				await writeFile(file(ids[index]), expectedRaw(index));
			};
			await saveLast(documentText(index).split('\n\n').slice(0, -1).join('\n\n'));
			verify(await search!.search('cobaltzz', { mode: 'keyword' }), 'cobaltzz', 49999);
			await saveLast(documentText(index));
			verify(await search!.search('cobaltzz', { mode: 'keyword' }), 'cobaltzz', 50000);
			const namespace: string = `passage-documents:${source.projectId}`;
			const before = store!.usage(namespace);
			const savedLast = hash(JSON.stringify(store!.get(namespace, ids[index])));
			await saveLast(documentText(index) + '\n\n' + paragraph(0));
			await assert.rejects(
				search!.search('cobaltzz', { mode: 'keyword' }),
				/exceeds 50000 passages/
			);
			assert.deepEqual(store!.usage(namespace), before);
			assert.equal(hash(JSON.stringify(store!.get(namespace, ids[index]))), savedLast);
			await saveLast(documentText(index));
			verify(await search!.search('cobaltzz', { mode: 'keyword' }), 'cobaltzz');
			measurements.push({
				sample,
				phase: 'admission-boundaries',
				accepted: [49999, 50000],
				rejected: 50001,
				unchangedCatalogAfterRefusal: true,
				retriedAfterRefusal: true,
			});
		}
		await close();
		assert.deepEqual(
			(await processTree())
				.filter((row) => row.pid !== process.pid)
				.map((row) => row.pid)
				.sort(),
			initialChildren
		);
		measurements.push({
			sample,
			phase: 'closed',
			memory: process.memoryUsage(),
			disk: await disk(root),
			processTree: await processTree(),
		});
	} catch (error) {
		failures.push({
			sample,
			scope: 'trial',
			error: error instanceof Error ? error.stack : String(error),
		});
	} finally {
		try {
			await close();
		} catch (error) {
			failures.push({ sample, scope: 'close', error: String(error) });
		}
		await rm(root, { recursive: true, force: true });
		await save();
	}
}
report.status = failures.length ? 'completed-with-failures' : 'complete';
await save();
if (failures.length) process.exitCode = 1;
