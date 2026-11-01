import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { ManuscriptContext } from 'narrative-lens';

const require = createRequire(import.meta.url);
const context = new ManuscriptContext(16 * 1024 * 1024);
const manuscript = {
	documentId: 'local-integration-benchmark',
	scenes: Array.from({ length: 100 }, (_, index) => ({
		id: `scene-${index}`,
		text:
			`Mira crossed the quiet garden in chapter ${index}. `.repeat(100) +
			'She was was tired.',
	})),
	configuration: { rules: ['NL-GRAMMAR-REPETITION'] },
};
const measurements = [];
try {
	for (const phase of ['cold', 'warm', 'one-scene-edit']) {
		if (phase === 'one-scene-edit') manuscript.scenes[50].text += ' She returned home.';
		let timerCallbacks = 0;
		const timer = setInterval(() => timerCallbacks++, 1);
		const started = performance.now();
		let report;
		try {
			report = await context.analyzeAsync(manuscript);
		} finally {
			clearInterval(timer);
		}
		const elapsedMs = performance.now() - started;
		const cache = context.stats();
		assert.equal(report.findings.length, 100);
		if (phase === 'warm') assert.equal(cache.reusedScenes, 100);
		if (phase === 'one-scene-edit') {
			assert.equal(cache.recomputedScenes, 1);
			assert.equal(cache.reusedScenes, 99);
		}
		measurements.push({
			phase,
			elapsedMs,
			timerCallbacks,
			findings: report.findings.length,
			cache,
		});
	}
	process.stdout.write(
		JSON.stringify(
			{
				node: process.version,
				platform: `${process.platform}-${process.arch}`,
				binding: require('narrative-lens').__napiBindingTarget,
				scenes: manuscript.scenes.length,
				utf8Bytes: manuscript.scenes.reduce(
					(total, scene) => total + Buffer.byteLength(scene.text),
					0
				),
				measurements,
				scope: 'One synthetic native-context run per phase; excludes Scrivener I/O, serialization, other rule families and model inference. Not a throughput or accuracy benchmark.',
			},
			null,
			2
		) + '\n'
	);
} finally {
	context.clear();
}
