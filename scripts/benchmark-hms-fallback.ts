import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HolographicMemorySystem } from '../src/services/memory/hhm/holographic-memory-system.js';

// Run with: node --import tsx scripts/benchmark-hms-fallback.ts [documents] [repetitions]
const count = Number(process.argv[2] ?? 1000);
const repetitions = Number(process.argv[3] ?? 3);
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 50000);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions <= 20);

const vocabulary = [
	'captain harbor lighthouse voyage storm lantern',
	'garden orchard blossom meadow sunlight violet',
	'castle throne kingdom soldier battle fortress',
	'market merchant copper silver bread basket',
];
const documents = Array.from({ length: count }, (_, index) => ({
	id: `document-${index}`,
	text: `${vocabulary[index % vocabulary.length]} scene${index} ${vocabulary[
		(index + 1) % vocabulary.length
	].repeat(12)}`,
}));
const query = 'captain harbor lighthouse';
const cwd = process.cwd();
const isolated = await mkdtemp(join(tmpdir(), 'scrivener-hms-benchmark-'));
const timings: Array<{ batchMs: number; firstQueryMs: number; warmQueryMs: number }> = [];

try {
	process.chdir(isolated);
	for (let repetition = 0; repetition < repetitions; repetition++) {
		const hms = new HolographicMemorySystem({ dimensions: 512 });
		try {
			assert.equal(hms.getStats().engine, 'JS Fallback');
			const started = performance.now();
			await hms.memorizeBatch(documents);
			const batched = performance.now();
			const first = await hms.queryText(query, 10);
			const queried = performance.now();
			const warm = await hms.queryText(query, 10);
			const finished = performance.now();
			assert.deepEqual(warm, first);
			assert.equal(hms.getStats().totalMemories, count);
			timings.push({
				batchMs: batched - started,
				firstQueryMs: queried - batched,
				warmQueryMs: finished - queried,
			});
		} finally {
			await hms.destroy();
		}
	}
} finally {
	process.chdir(cwd);
	await rm(isolated, { recursive: true, force: true });
}

console.log(JSON.stringify({ node: process.version, documents: count, repetitions, timings }));
