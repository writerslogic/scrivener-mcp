import {
	HolographicMemorySystem,
	validateHMSDocumentBatch,
	validateHMSMetadata,
} from '../../../src/services/memory/hhm/holographic-memory-system.js';

const embeddingSpace = { model: 'fixture-concepts', revision: '1', dimensions: 2 };
const engines: HolographicMemorySystem[] = [];

function memory(): HolographicMemorySystem {
	const engine = new HolographicMemorySystem({ engine: 'fallback', embeddingSpace });
	engines.push(engine);
	return engine;
}

afterEach(async () => {
	await Promise.all(engines.splice(0).map((engine) => engine.destroy()));
});

it('uses supplied concept vectors with exact provenance, scoped metadata and isolated copies', async () => {
	const engine = memory();
	const text = 'Café — 東京 😀 She buried her son beside the orchard.';
	const metadata = { project: 'first', nested: { canonical: true } };
	await engine.memorizeDocuments([
		{
			id: 'first',
			text,
			metadata,
			sourceUri: 'scene:first',
			version: 'saved-1',
			embeddings: [[1, 0]],
		},
		{ id: 'other-project', text, metadata: { project: 'second' }, embeddings: [[1, 0]] },
	]);
	metadata.project = 'changed-after-indexing';
	const options = {
		filter: { project: 'first' },
		embedding: [1, 0],
		lexicalWeight: 0,
		semanticWeight: 1,
	};
	const results = await engine.searchDocuments('mourning', options);
	expect(results).toHaveLength(1);
	expect(results[0]).toMatchObject({
		documentId: 'first',
		sourceUri: 'scene:first',
		version: 'saved-1',
		semanticScore: 1,
	});
	expect(
		Buffer.from(text).subarray(results[0].startByte, results[0].endByte).toString('utf8')
	).toBe(results[0].text);
	(results[0].metadata.nested as { canonical: boolean }).canonical = false;
	expect((await engine.searchDocuments('mourning', options))[0].metadata.nested).toEqual({
		canonical: true,
	});
	expect(await engine.searchDocuments('mourning', { ...options, documentIds: [] })).toEqual([]);
});

it('replaces old chunks and versions, then removes the complete document', async () => {
	const engine = memory();
	await engine.memorizeDocuments([
		{ id: 'scene', text: 'lighthouse harbor lantern', chunkWords: 1, overlapWords: 0 },
	]);
	expect((await engine.searchDocuments('lighthouse'))[0].documentId).toBe('scene');
	await engine.memorizeDocuments([
		{ id: 'scene', text: 'violet orchard', version: 'saved-2', chunkWords: 1, overlapWords: 0 },
	]);
	expect(await engine.searchDocuments('lighthouse')).toEqual([]);
	expect((await engine.searchDocuments('orchard'))[0]).toMatchObject({
		version: 'saved-2',
		text: 'orchard',
	});
	expect(await engine.deleteDocument('scene')).toBe(true);
	expect(await engine.deleteDocument('scene')).toBe(false);
	expect(await engine.searchDocuments('orchard')).toEqual([]);
});

it('rejects invalid batches atomically and leaves the previous indexed revision intact', async () => {
	const engine = memory();
	await engine.memorizeDocuments([{ id: 'scene', text: 'lighthouse', version: 'saved-1' }]);
	await expect(
		engine.memorizeDocuments([
			{ id: 'scene', text: 'orchard', version: 'saved-2' },
			{ id: 'invalid', text: 'untrusted', metadata: { number: Number.NaN } },
		])
	).rejects.toThrow('finite JSON');
	expect((await engine.searchDocuments('lighthouse'))[0].version).toBe('saved-1');
	expect(await engine.searchDocuments('orchard')).toEqual([]);
	for (const embedding of [[0, 0], [1], [Number.NaN, 1]])
		await expect(
			engine.memorizeDocuments([{ id: 'invalid', text: 'orchard', embeddings: [embedding] }])
		).rejects.toThrow();
	await expect(
		engine.searchDocuments('lighthouse', { lexicalWeight: 0, semanticWeight: 0 })
	).rejects.toThrow('positive sum');
});

it.each([-1, 0, 1])('enforces metadata and source byte budgets at boundary %d', (delta) => {
	const metadataLimit = 64 * 1024;
	const overhead = Buffer.byteLength(JSON.stringify({ payload: '' }));
	const metadata = { payload: 'x'.repeat(metadataLimit - overhead + delta) };
	const source = {
		id: 'scene',
		text: ' '.repeat(8 * 1024 * 1024 - Buffer.byteLength('scene') + delta),
	};
	if (delta <= 0) {
		expect(() => validateHMSMetadata(metadata)).not.toThrow();
		expect(() => validateHMSDocumentBatch([source])).not.toThrow();
	} else {
		expect(() => validateHMSMetadata(metadata)).toThrow('64 KiB');
		expect(() => validateHMSDocumentBatch([source])).toThrow('8 MiB');
	}
});

it.each([-1, 0, 1])('bounds aggregate query allocation at boundary %d', async (delta) => {
	const engine = memory();
	const half = 4 * 1024 * 1024;
	const pending = engine.queryBatch([' '.repeat(half), ' '.repeat(half + delta)], 1);
	if (delta <= 0) await expect(pending).resolves.toEqual([[], []]);
	else await expect(pending).rejects.toThrow('8 MiB');
});

it('drains accepted operations before release and rejects use of a closed owner', async () => {
	const engine = memory();
	const pending = engine.memorizeDocuments([{ id: 'scene', text: 'lighthouse' }]);
	const closed = engine.destroy();
	await pending;
	await closed;
	expect(engine.destroy()).toBe(closed);
	await expect(engine.searchDocuments('lighthouse')).rejects.toThrow('closed');
});
