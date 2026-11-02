import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassageSearch } from '../dist/services/editorial/passage-search.js';
import { PersistentStore } from '../dist/services/editorial/persistent-store.js';
import { HolographicMemorySystem } from '../dist/services/memory/hhm/holographic-memory-system.js';
import { loadWarmModels } from '../dist/services/memory/warm-models.js';

const started = performance.now();
const models = await loadWarmModels();
assert.ok(
	models?.embedder,
	'Configure a complete local Warm embedding model before running this check.'
);
const directory = await mkdtemp(join(tmpdir(), 'scrivener-warm-models-'));
const report = { model: models.embedder.space, reranking: !!models.rerank, cases: [] };
const texts = [
	'An orchid bloomed beneath the greenhouse window.',
	'A steam locomotive crossed the viaduct.',
	'The astronomer calibrated a telescope to observe Saturn.',
	'The baker kneaded dough before sunrise.',
];
try {
	for (const mode of ['fallback', 'native']) {
		const store = new PersistentStore(join(directory, mode + '.sqlite'));
		const engine = new HolographicMemorySystem({
			engine: mode,
			dimensions: 30,
			storagePath: join(directory, mode + '-warm'),
			embeddingSpace: models.embedder.space,
		});
		const documents = texts.map((text, index) => ({
			projectId: mode,
			documentId: 'scene-' + index,
			title: 'Scene ' + index,
			text,
			order: index,
			path: 'Draft/' + index,
			metadata: {},
			revision: createHash('sha256').update(text).digest('hex'),
		}));
		const source = {
			projectId: mode,
			projectPath: join(directory, mode),
			list: async () => documents,
			read: async (id) => {
				const found = documents.find((doc) => doc.documentId === id);
				assert.ok(found);
				return found;
			},
		};
		let search = new PassageSearch(source, store, engine, models);
		try {
			const begin = performance.now();
			const result = await search.search('botanical specimen', {
				mode: 'semantic',
				limit: 4,
			});
			assert.equal(result.results[0]?.documentId, 'scene-0');
			assert.equal(result.results[0].quote, texts[0]);
			assert.equal(result.results[0].keywordScore, 0);
			const scoped = await search.search('botanical specimen', {
				mode: 'semantic',
				documentIds: ['scene-1'],
			});
			assert.ok(scoped.results.every((hit) => hit.documentId === 'scene-1'));
			assert.equal(
				(await search.search('orchid', { mode: 'keyword' })).results[0]?.documentId,
				'scene-0'
			);
			await search.close();
			search = new PassageSearch(source, store, engine, models);
			assert.equal(
				(await search.search('botanical specimen', { mode: 'semantic' })).results[0]
					?.documentId,
				'scene-0'
			);
			documents[0] = {
				...documents[0],
				text: 'A violet grew in the conservatory.',
				revision: createHash('sha256')
					.update('A violet grew in the conservatory.')
					.digest('hex'),
			};
			assert.equal((await search.search('orchid', { mode: 'keyword' })).results.length, 0);
			assert.equal(
				(await search.search('violet', { mode: 'keyword' })).results[0]?.revision,
				documents[0].revision
			);
			report.cases.push({
				engine: engine.getStats().engine,
				firstRanking: result.results.map((hit) => ({
					id: hit.documentId,
					score: hit.score,
					cosine: hit.semanticScore,
				})),
				elapsedMs: performance.now() - begin,
				checks: [
					'zero-overlap semantic retrieval',
					'scope',
					'exact source quote',
					'keyword bypass',
					'reopen',
					'replacement',
				],
			});
		} finally {
			await search.close();
			await engine.destroy();
			store.close();
		}
	}
} finally {
	await models.close();
	await rm(directory, { recursive: true, force: true });
}
report.elapsedMs = performance.now() - started;
report.peakRssKiB = process.resourceUsage().maxRSS;
report.limitation =
	'Four synthetic passages verify integration; these measurements do not establish manuscript-wide relevance or memory stability.';
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
