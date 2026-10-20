import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
	const engine = argument === 'native' ? 'Rust Native v2.0' : 'JS Fallback';
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
		await test('native: sharing preserves dimension and explicit-store ownership checks', async () => {
			assert.throws(() => new HolographicMemorySystem({ dimensions: 1024 }), /dimensions/);
			const storagePath = join(process.cwd(), 'explicit-store');
			const explicit = new HolographicMemorySystem({ storagePath });
			assert.throws(() => new HolographicMemorySystem({ storagePath }), /already open/);
			await explicit.destroy();
		});
	}

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
		await (await initializeHHM()).destroy();
	});
} else if (option === '--reopen') {
	const { HolographicMemorySystem } =
		await import('../dist/services/memory/hhm/holographic-memory-system.js');
	const hms = new HolographicMemorySystem();
	assert.equal(hms.getStats().engine, 'Rust Native v2.0');
	const results = await hms.queryText('lighthouse captain harbor', 30);
	assert.ok(results.some((r) => r.id === 'file'));
	assert.ok(results.some((r) => r.id === 'text'));
	assert.ok((await hms.queryTriplet('captain', 'commands')).some((r) => r.id === 'relationship'));
	await hms.destroy();
	process.stdout.write('native: text, file and relationship state survive process restart\n');
} else {
	if (option && (option !== '--native-package' || !argument)) {
		throw new Error('Usage: node scripts/check-hms-compatibility.mjs [--native-package PATH]');
	}
	const root = mkdtempSync(join(tmpdir(), 'scrivener-hms-'));
	const env = { ...process.env, SCRIVENER_DISABLE_KEY_DISCOVERY: '1' };
	try {
		const modes = ['fallback', ...(argument ? ['native'] : [])];
		for (const mode of modes) {
			const cwd = join(root, mode);
			const { mkdirSync } = await import('node:fs');
			mkdirSync(cwd);
			writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true }));
			if (mode === 'native') {
				assert.ok(process.env.npm_execpath, 'Run this check through npm run check:hms');
				execFileSync(
					process.execPath,
					[
						process.env.npm_execpath,
						'install',
						'--ignore-scripts',
						'--omit=optional',
						'--no-audit',
						'--no-fund',
						resolve(argument),
					],
					{ cwd, env, stdio: 'pipe' }
				);
			}
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
