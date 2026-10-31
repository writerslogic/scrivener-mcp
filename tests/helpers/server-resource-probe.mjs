import { performance } from 'node:perf_hooks';
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
const profiling = process.env.SCRIVENER_NOVEL_PROFILE === '1';
function mark(stage) {
	if (!profiling || !timer) return;
	measurement.stages.push({
		stage,
		elapsedMs: performance.now() - measurement.started,
		...process.memoryUsage(),
	});
}
if (profiling) {
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
		if (args[2] !== undefined) mark('first-page:start');
		try {
			return page.apply(this, args);
		} finally {
			if (args[2] !== undefined) mark('first-page:end');
		}
	};
}
function sample() {
	const now = performance.now();
	measurement.eventLoopLagMs = Math.max(
		measurement.eventLoopLagMs,
		now - measurement.lastTick - 5
	);
	measurement.lastTick = now;
	measurement.rssPeakBytes = Math.max(measurement.rssPeakBytes, process.memoryUsage.rss());
}
process.on('message', ({ id, action }) => {
	if (action === 'start') {
		if (timer) throw new Error('A resource measurement is already active');
		const now = performance.now();
		measurement = {
			started: now,
			lastTick: now,
			rssStartBytes: process.memoryUsage.rss(),
			rssPeakBytes: 0,
			eventLoopLagMs: 0,
			...(profiling ? { stages: [] } : {}),
		};
		measurement.rssPeakBytes = measurement.rssStartBytes;
		timer = setInterval(sample, 5);
		timer.unref();
		mark('measurement:start');
		process.send({ id });
	} else if (action === 'end') {
		if (!timer) throw new Error('No resource measurement is active');
		mark('measurement:end');
		clearInterval(timer);
		timer = undefined;
		sample();
		const { started, lastTick, ...metrics } = measurement;
		process.send({
			id,
			metrics: {
				...metrics,
				elapsedMs: performance.now() - started,
				rssGrowthBytes: metrics.rssPeakBytes - metrics.rssStartBytes,
				lifetimeHighWaterBytes: process.resourceUsage().maxRSS * 1024,
			},
		});
	} else throw new Error('Unknown resource measurement action');
});

await import('../../src/index.ts');
