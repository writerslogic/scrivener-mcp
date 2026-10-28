import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const [option, argument] = process.argv.slice(2);

if (option === '--worker') {
	const { test } = await import('node:test');
	const { HolographicMemorySystem } =
		await import('../dist/services/memory/hhm/holographic-memory-system.js');
	const { HMSVectorStore } = await import('../dist/services/ai/hms-vector-store.js');
	const { initializeHHM, nativeHHMTools } = await import('../dist/handlers/memory-handlers.js');
	const hms = await initializeHHM();
	const engine =
		argument === 'native'
			? `Rust Native ${process.env.SCRIVENER_HMS_EXPECTED_VERSION}`
			: 'JS Fallback';
	const text = 'lighthouse captain harbor';

	await test(`${argument}: selects the requested engine`, () => {
		assert.equal(hms.getStats().engine, engine);
	});

	await test(`${argument}: text, document, buffer and batch retrieval`, async () => {
		await hms.memorizeText(text, 'text', 'trace-text');
		await hms.memorizeDocument({ id: 'scene', content: text });
		await hms.memorizeTextBuffer('buffer', Buffer.from(text), 'trace-buffer');
		await hms.memorizeBatch([{ id: 'batch', text }], 'trace-batch');
		const results = await hms.queryText(text, 20, 'trace-query');
		for (const id of ['text', 'doc_scene', 'buffer', 'batch']) {
			assert.ok(
				results.some((r) => r.id === id && Number.isFinite(r.similarity)),
				id
			);
		}
		assert.equal(results.find((r) => r.id === 'text').reconstructed, text);
		assert.equal((await hms.queryBatch([text], 20))[0].length, results.length);
	});

	await test(`${argument}: find_analogies accepts the handler's generated trace ID`, async () => {
		const tool = nativeHHMTools.find((t) => t.name === 'find_analogies');
		const response = await tool.handler({ a: 'captain', b: 'harbor', c: 'lighthouse' });
		const results = JSON.parse(response.content[0].text);
		assert.ok(Array.isArray(results), response.content[0].text);
		assert.ok(results.length > 0);
	});

	await test(`${argument}: ingested files remain visible through queryText`, async () => {
		const file = join(process.cwd(), 'scene.txt');
		writeFileSync(file, text);
		await hms.memorizeFile('file', file);
		const result = (await hms.queryText(text, 20)).find((r) => r.id === 'file');
		assert.ok(result);
		assert.equal(result.entry.metadata.modality, 'file');
	});

	await test(`${argument}: file limits and invalid inputs preserve existing memory`, async () => {
		const limit = 8 * 1024 * 1024;
		const before = hms.getStats().totalMemories;
		for (const delta of [-1, 0, 1]) {
			const file = join(process.cwd(), `boundary-${delta}.txt`);
			const bytes = Buffer.alloc(limit + delta, 32);
			bytes.write(text);
			writeFileSync(file, bytes);
			if (delta <= 0) await hms.memorizeFile(`boundary-${delta}`, file);
			else await assert.rejects(hms.memorizeFile('too-large', file), /8 MiB/);
		}
		const invalid = join(process.cwd(), 'invalid.txt');
		writeFileSync(invalid, Buffer.from([0xff]));
		await assert.rejects(hms.memorizeFile('invalid', invalid));
		await assert.rejects(hms.memorizeFile('directory', process.cwd()), /regular file/);
		await assert.rejects(
			hms.memorizeFile('missing', join(process.cwd(), 'absent.txt')),
			/ENOENT/
		);
		assert.equal(hms.getStats().totalMemories, before + 2);
		assert.equal(
			(await hms.queryText(text, 30)).find((r) => r.id === 'text').reconstructed,
			text
		);
	});

	await test(`${argument}: triplets, sequences, associations and concept synthesis`, async () => {
		await hms.memorizeTriplet('relationship', 'captain', 'commands', 'ship');
		assert.ok(
			(await hms.queryTriplet('captain', 'commands')).some((r) => r.id === 'relationship')
		);
		await hms.memorizeSequence('order', ['harbor', 'lighthouse', 'ship']);
		assert.ok(Array.isArray(await hms.dream()));
		assert.ok((await hms.discoverAssociations('text', 0)).every((r) => r.id !== 'text'));
	});

	if (argument === 'native') {
		await test('native: compatible owners share safely and reject incompatible store configuration', async () => {
			assert.throws(() => new HolographicMemorySystem({ dimensions: 1024 }), /dimensions/);
			const storagePath = join(process.cwd(), 'explicit-store');
			const explicit = new HolographicMemorySystem({ storagePath });
			const shared = new HolographicMemorySystem({ storagePath });
			await explicit.memorizeText('shared lighthouse harbor', 'shared-owner');
			await explicit.destroy();
			assert.ok(
				(await shared.queryText('shared lighthouse harbor')).some(
					(hit) => hit.id === 'shared-owner'
				)
			);
			execFileSync(process.execPath, [script, '--locked-store', storagePath], {
				env: process.env,
				stdio: 'inherit',
				timeout: 30000,
			});
			await shared.destroy();
			const reopened = new HolographicMemorySystem({ storagePath });
			assert.ok(
				(await reopened.queryText('shared lighthouse harbor')).some(
					(hit) => hit.id === 'shared-owner'
				)
			);
			await reopened.destroy();
		});
	}

	await test(`${argument}: document provenance, Unicode byte ranges, supplied concepts and replacement`, async () => {
		const documents = new HolographicMemorySystem({
			storagePath: join(process.cwd(), 'document-store'),
			dimensions: 32,
			embeddingSpace: { model: 'compat-concepts', revision: '1', dimensions: 2 },
		});
		try {
			const quote = 'Café — 東京 😀 The captain buried her son by the orchard.';
			await documents.memorizeDocuments([
				{
					id: 'grief',
					text: quote,
					sourceUri: 'scene:grief',
					version: 'saved-1',
					metadata: { project: 'fixture' },
					embeddings: [[1, 0]],
					chunkWords: 4096,
					overlapWords: 0,
				},
				{
					id: 'weather',
					text: 'Thunder lashed the ship.',
					metadata: { project: 'other' },
					embeddings: [[0, 1]],
				},
			]);
			const hits = await documents.searchDocuments('mourning', {
				embedding: [1, 0],
				lexicalWeight: 0,
				semanticWeight: 1,
				minSemanticScore: 0.01,
				filter: { project: 'fixture' },
			});
			assert.equal(hits.length, 1);
			assert.equal(hits[0].documentId, 'grief');
			assert.equal(hits[0].version, 'saved-1');
			assert.equal(hits[0].sourceUri, 'scene:grief');
			assert.equal(
				Buffer.from(quote).subarray(hits[0].startByte, hits[0].endByte).toString('utf8'),
				hits[0].text
			);
			assert.equal(
				(
					await documents.searchDocuments('mourning', {
						embedding: [1, 0],
						documentIds: [],
					})
				).length,
				0
			);
			await documents.memorizeDocuments([
				{
					id: 'grief',
					text: 'Sunlight filled the harbor.',
					version: 'saved-2',
					metadata: { project: 'fixture' },
				},
			]);
			assert.equal(
				(
					await documents.searchDocuments('mourning', {
						embedding: [1, 0],
						lexicalWeight: 0,
						minSemanticScore: 0.01,
					})
				).length,
				0
			);
			assert.equal((await documents.searchDocuments('harbor'))[0].version, 'saved-2');
			assert.equal(await documents.deleteDocument('weather'), true);
		} finally {
			await documents.destroy();
		}
	});

	await test(`${argument}: independent application consumers coexist and survive reinitialization`, async () => {
		const first = new HMSVectorStore();
		const second = new HMSVectorStore();
		const content = 'violet orchid greenhouse';
		await first.addDocuments([{ pageContent: content, metadata: { id: 'first-store' } }]);
		await second.addDocuments([
			{ pageContent: 'copper canyon desert', metadata: { id: 'second-store' } },
		]);
		assert.equal((await first.similaritySearch(content, 1))[0].pageContent, content);
		await initializeHHM();
		assert.equal(
			(await first.similaritySearchWithScore(content, 1))[0][0].pageContent,
			content
		);
		assert.equal(
			(await second.similaritySearch('copper canyon desert', 1))[0].metadata.id,
			'second-store'
		);
		await first.close();
		await second.close();
		const durable = new HMSVectorStore({
			storagePath: join(process.cwd(), 'durable-vectorstore'),
			scope: 'compat',
		});
		await durable.addDocuments([
			{
				pageContent: 'Café — 東京 😀 persistent lighthouse',
				sourceUri: 'scene:durable',
				version: 'saved-3',
				metadata: { id: 'durable-scene', project: 'fixture' },
			},
		]);
		assert.equal(
			(await durable.similaritySearch('lighthouse', 1))[0].metadata.project,
			'fixture'
		);
		await durable.close();
		await (await initializeHHM()).destroy();
	});
} else if (option === '--locked-store') {
	const { HolographicMemorySystem } =
		await import('../dist/services/memory/hhm/holographic-memory-system.js');
	assert.throws(
		() => new HolographicMemorySystem({ storagePath: argument, engine: 'native' }),
		/already open/
	);
	const fallback = new HolographicMemorySystem({ storagePath: argument, engine: 'auto' });
	assert.equal(fallback.getStats().engine, 'JS Fallback');
	await fallback.destroy();
	process.stdout.write(
		'native: second-process owner rejected; local fallback remains available\n'
	);
} else if (option === '--reopen') {
	const { HolographicMemorySystem } =
		await import('../dist/services/memory/hhm/holographic-memory-system.js');
	const hms = new HolographicMemorySystem();
	assert.equal(
		hms.getStats().engine,
		`Rust Native ${process.env.SCRIVENER_HMS_EXPECTED_VERSION}`
	);
	const results = await hms.queryText('lighthouse captain harbor', 30);
	assert.ok(results.some((r) => r.id === 'file'));
	assert.ok(results.some((r) => r.id === 'text'));
	assert.ok((await hms.queryTriplet('captain', 'commands')).some((r) => r.id === 'relationship'));
	await hms.destroy();
	const { HMSVectorStore } = await import('../dist/services/ai/hms-vector-store.js');
	const store = new HMSVectorStore({
		storagePath: join(process.cwd(), 'durable-vectorstore'),
		scope: 'compat',
	});
	try {
		const result = (await store.similaritySearch('lighthouse', 1))[0];
		assert.equal(result.metadata.id, 'durable-scene');
		assert.equal(result.metadata.project, 'fixture');
		assert.equal(result.version, 'saved-3');
		assert.equal(result.sourceUri, 'scene:durable');
		assert.ok(result.pageContent.includes('東京 😀'));
	} finally {
		await store.close();
	}
	process.stdout.write('native: text, file and relationship state survive process restart\n');
} else {
	if (option) throw new Error('Usage: node scripts/check-hms-compatibility.mjs');
	const { loadNativeBinding } = await import('../dist/services/memory/hhm/native-loader.cjs');
	const version = loadNativeBinding().version;
	const root = mkdtempSync(join(tmpdir(), 'scrivener-hms-'));
	const baseEnv = {
		...process.env,
		SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
		SCRIVENER_LOCAL_ONLY: 'true',
		SCRIVENER_HMS_EXPECTED_VERSION: version,
	};
	try {
		const modes = ['fallback', 'native'];
		for (const mode of modes) {
			const cwd = join(root, mode);
			const { mkdirSync } = await import('node:fs');
			mkdirSync(cwd);
			const env = {
				...baseEnv,
				SCRIVENER_HMS_ENGINE: mode === 'native' ? 'native' : 'fallback',
				SCRIVENER_HMS_STORAGE_DIR: join(cwd, 'hms'),
				HOME: join(cwd, 'home'),
				USERPROFILE: join(cwd, 'home'),
			};
			writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true }));
			execFileSync(process.execPath, [script, '--worker', mode], {
				cwd,
				env,
				stdio: 'inherit',
				timeout: 120000,
			});
			if (mode === 'native') {
				execFileSync(process.execPath, [script, '--reopen'], {
					cwd,
					env,
					stdio: 'inherit',
					timeout: 60000,
				});
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
