import { performance, PerformanceObserver } from 'node:perf_hooks';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { NARRATIVE_HEAP_MIB } from '../../src/services/editorial/narrative-worker.ts';

if (process.env.SCRIVENER_NOVEL_RESOURCE_PRELOAD) {
	for (const name of ['spawn', 'execFile']) {
		const original = childProcess[name];
		childProcess[name] = (command, args, ...rest) =>
			original(
				command,
				command === process.execPath &&
					Array.isArray(args) &&
					args.includes(`--max-old-space-size=${NARRATIVE_HEAP_MIB}`)
					? ['--require', process.env.SCRIVENER_NOVEL_RESOURCE_PRELOAD, ...args]
					: args,
				...rest
			);
		const custom = Object.getOwnPropertyDescriptor(original, promisify.custom);
		if (custom) Object.defineProperty(childProcess[name], promisify.custom, custom);
	}
	syncBuiltinESMExports();
}

let measurement;
let timer;
let treeTimer;
let treeSample;
function sampleTree() {
	if (treeSample) return treeSample;
	const current = measurement;
	treeSample = new Promise((done) =>
		childProcess.execFile(
			'ps',
			['-axo', 'pid=,ppid=,rss='],
			{ timeout: 2000, maxBuffer: 1024 * 1024 },
			(error, output) => {
				if (error) current.processTreeError = 'Process-tree RSS sampling failed';
				else {
					const rows = output
						.trim()
						.split('\n')
						.map((line) => line.trim().split(/\s+/).map(Number));
					const selected = new Set([process.pid]);
					let added;
					do {
						added = false;
						for (const [pid, parent] of rows)
							if (selected.has(parent) && !selected.has(pid)) {
								selected.add(pid);
								added = true;
							}
					} while (added);
					const rss = rows.reduce(
						(sum, [pid, , bytes]) => sum + (selected.has(pid) ? bytes * 1024 : 0),
						0
					);
					current.processTreeRssPeakBytes = Math.max(
						current.processTreeRssPeakBytes,
						rss
					);
					current.processTreeSamples++;
				}
				treeSample = undefined;
				done();
			}
		)
	);
	return treeSample;
}
const profiling = process.env.SCRIVENER_NOVEL_PROFILE === '1';
function span(stage, start, cpu, longest = false) {
	if (!profiling || !timer) return;
	const value = {
		stage,
		startMs: start - measurement.started,
		endMs: performance.now() - measurement.started,
		cpu: process.cpuUsage(cpu),
	};
	if (longest) {
		measurement.longestPages.push(value);
		measurement.longestPages.sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs));
		measurement.longestPages.length = Math.min(8, measurement.longestPages.length);
	} else if (measurement.spans.length < 128) measurement.spans.push(value);
	else measurement.droppedSpans++;
}
function instrument(prototype, name, label) {
	const original = prototype[name];
	prototype[name] = function (...args) {
		const start = performance.now();
		const cpu = process.cpuUsage();
		let result;
		try {
			result = original.apply(this, args);
		} finally {
			span(`${label}:call`, start, cpu);
		}
		if (!result || typeof result.then !== 'function') return result;
		return result.finally(() => span(`${label}:complete`, start, cpu));
	};
}
function mark(stage) {
	if (!profiling || !timer) return;
	measurement.stages.push({
		stage,
		elapsedMs: performance.now() - measurement.started,
		...process.memoryUsage(),
	});
}
if (profiling) {
	new PerformanceObserver((list) => {
		if (!timer) return;
		for (const entry of list.getEntries()) {
			if (entry.startTime < measurement.started) continue;
			if (measurement.gc.length < 64)
				measurement.gc.push({
					startMs: entry.startTime - measurement.started,
					durationMs: entry.duration,
				});
			else measurement.droppedGc++;
		}
	}).observe({ entryTypes: ['gc'] });
	const { ProjectSource } = await import('../../src/services/editorial/project-source.ts');
	instrument(ProjectSource.prototype, 'list', 'source.list');
	const { NarrativeContext } = await import('../../src/services/editorial/narrative-context.ts');
	instrument(NarrativeContext.prototype, 'request', 'context.request');
	const { PersistentStore } = await import('../../src/services/editorial/persistent-store.ts');
	for (const name of ['get', 'transaction', 'put'])
		instrument(PersistentStore.prototype, name, `store.${name}`);
	const { NarrativeAnalysis } =
		await import('../../src/services/editorial/narrative-analysis.ts');
	for (const name of ['serializedAnalysis', 'compareReports']) {
		const original = NarrativeAnalysis.prototype[name];
		NarrativeAnalysis.prototype[name] = async function (...args) {
			mark(`${name}:start`);
			try {
				return await original.apply(this, args);
			} finally {
				mark(`${name}:end`);
			}
		};
	}
	const { ReportTransport } = await import('../../src/services/editorial/report-transport.ts');
	const page = ReportTransport.prototype.pageSerialized;
	ReportTransport.prototype.pageSerialized = function (...args) {
		const start = performance.now();
		const cpu = process.cpuUsage();
		if (args[2] !== undefined) mark('first-page:start');
		try {
			return page.apply(this, args);
		} finally {
			span('page', start, cpu, true);
			if (args[2] !== undefined) mark('first-page:end');
		}
	};
}
function sample() {
	const now = performance.now();
	const lag = now - measurement.lastTick - 5;
	if (profiling && lag > measurement.eventLoopLagMs) {
		measurement.worstLag = {
			startMs: measurement.lastTick - measurement.started,
			endMs: now - measurement.started,
			cpu: process.cpuUsage(measurement.lastCpu),
		};
	}
	if (profiling) measurement.lastCpu = process.cpuUsage();
	measurement.eventLoopLagMs = Math.max(
		measurement.eventLoopLagMs,
		now - measurement.lastTick - 5
	);
	measurement.lastTick = now;
	measurement.rssPeakBytes = Math.max(measurement.rssPeakBytes, process.memoryUsage.rss());
}
process.on('message', async ({ id, action }) => {
	if (action === 'start') {
		if (timer) throw new Error('A resource measurement is already active');
		const now = performance.now();
		measurement = {
			started: now,
			lastTick: now,
			rssStartBytes: process.memoryUsage.rss(),
			rssPeakBytes: 0,
			processTreeRssPeakBytes: 0,
			processTreeSamples: 0,
			eventLoopLagMs: 0,
			...(profiling
				? {
						stages: [],
						spans: [],
						droppedSpans: 0,
						gc: [],
						droppedGc: 0,
						longestPages: [],
						lastCpu: process.cpuUsage(),
					}
				: {}),
		};
		measurement.rssPeakBytes = measurement.rssStartBytes;
		timer = setInterval(sample, 5);
		timer.unref();
		await sampleTree();
		treeTimer = setInterval(() => {
			void sampleTree();
		}, 100);
		treeTimer.unref();
		mark('measurement:start');
		process.send({ id });
	} else if (action === 'end') {
		if (!timer) throw new Error('No resource measurement is active');
		mark('measurement:end');
		clearInterval(treeTimer);
		await sampleTree();
		clearInterval(timer);
		timer = undefined;
		sample();
		const { started, lastTick, lastCpu, ...metrics } = measurement;
		const elapsedMs = performance.now() - started;
		let gcDiagnostic;
		if (process.env.SCRIVENER_NOVEL_GC_DIAGNOSTIC === '1') {
			if (typeof globalThis.gc !== 'function')
				throw new Error('GC diagnostic requires --expose-gc');
			const before = process.memoryUsage();
			globalThis.gc();
			await new Promise(setImmediate);
			globalThis.gc();
			gcDiagnostic = {
				before,
				after: process.memoryUsage(),
				scope: 'Parent server only; forced after measured interval; changes subsequent heap conditions; not SLO evidence',
			};
		}
		process.send({
			id,
			metrics: {
				...metrics,
				elapsedMs,
				...(gcDiagnostic ? { gcDiagnostic } : {}),
				rssGrowthBytes: metrics.rssPeakBytes - metrics.rssStartBytes,
				lifetimeHighWaterBytes: process.resourceUsage().maxRSS * 1024,
			},
		});
	} else throw new Error('Unknown resource measurement action');
});

await import('../../src/index.ts');
