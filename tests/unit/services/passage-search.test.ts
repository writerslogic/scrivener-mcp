import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassageSearch } from '../../../src/services/editorial/passage-search.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import { HolographicMemorySystem } from '../../../src/services/memory/hhm/holographic-memory-system.js';
import type { ManuscriptSource, SourceDocument } from '../../../src/services/editorial/types.js';

interface RelevanceFixture {
	documents: Array<{ id: string; title: string; text: string }>;
	queries: Array<{ query: string; relevantDocumentId: string }>;
}

interface SyncCatalog {
	applied: string[];
	pending: string[];
}

describe('local passage retrieval', () => {
	let dir: string;
	let store: PersistentStore;
	let search: PassageSearch;
	let engine: HolographicMemorySystem;
	let engines: Set<HolographicMemorySystem>;
	let documents: SourceDocument[];
	let source: ManuscriptSource;
	let fixture: RelevanceFixture;
	let expectedCloseError: Error | undefined;

	function newEngine(): HolographicMemorySystem {
		const hms = new HolographicMemorySystem({
			engine: 'fallback',
			dimensions: 30,
			embeddingSpace: { model: 'scrivener-story-concepts', revision: '1', dimensions: 30 },
		});
		engines.add(hms);
		return hms;
	}

	function openSearch(hms = newEngine()): void {
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		engine = hms;
		search = new PassageSearch(source, store, engine);
	}

	function reviseDocument(index: number, text: string): void {
		documents[index] = {
			...documents[index],
			text,
			revision: createHash('sha256').update(text).digest('hex'),
		};
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'scrivener-passages-'));
		engines = new Set();
		expectedCloseError = undefined;
		fixture = JSON.parse(
			await readFile(join(__dirname, '../../fixtures/passage-relevance.json'), 'utf8')
		) as RelevanceFixture;
		documents = fixture.documents.map((doc, order) => ({
			projectId: 'fixture-project',
			documentId: doc.id,
			title: doc.title,
			text: doc.text,
			revision: createHash('sha256').update(doc.text).digest('hex'),
			path: `Draft/${doc.title}`,
			order,
			metadata: {},
		}));
		source = {
			projectId: 'fixture-project',
			projectPath: dir,
			list: async () => documents,
			read: async (id) => {
				const doc = documents.find((item) => item.documentId === id);
				if (!doc) throw new Error('Missing fixture document');
				return doc;
			},
		};
		openSearch();
	});

	it('retains absolute cosine relevance when every indexed passage matches the concept', async () => {
		documents.splice(2);
		reviseDocument(0, 'Her hands shook.');
		reviseDocument(1, 'The prisoner was locked in a cell. Her hands shook.');
		const result = await search.search('fear', { mode: 'semantic' });
		expect(result.results).toHaveLength(2);
		for (const hit of result.results) {
			expect(hit.score).toBeCloseTo(hit.semanticScore, 12);
			expect(hit.score).toBeGreaterThan(0.3);
		}
	});

	it('reindexes changed canonical text even when the raw source revision is unchanged', async () => {
		reviseDocument(0, 'Alpha amber.');
		await search.refresh();
		const revision = documents[0].revision;
		documents[0] = { ...documents[0], text: 'Bravo berry.' };
		expect((await search.refresh()).changedDocuments).toBe(1);
		const result = await search.search('bravo', { mode: 'keyword' });
		expect(result.results[0]).toMatchObject({ documentId: documents[0].documentId, revision });
		expect(result.results[0].quote).toBe('Bravo berry.');
		expect((await search.search('alpha', { mode: 'keyword' })).results).toHaveLength(0);
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		try {
			await search.close().catch((error: unknown) => {
				if (error !== expectedCloseError) throw error;
			});
		} finally {
			try {
				await Promise.all([...engines].map((hms) => hms.destroy()));
			} finally {
				store.close();
				await rm(dir, { recursive: true, force: true });
			}
		}
	});

	it('ranks zero-keyword-overlap relevance cases using only the declared local concept space', async () => {
		for (const entry of fixture.queries) {
			const result = await search.search(entry.query, { mode: 'semantic', limit: 3 });
			expect(result.results[0]?.documentId).toBe(entry.relevantDocumentId);
			expect(result.results[0]?.keywordScore).toBe(0);
			expect(result.results[0]?.semanticScore).toBeGreaterThan(0.4);
			expect(result.results[0]?.matchedConcepts.length).toBeGreaterThan(0);
		}
		const unknown = await search.search('nonrepresentational epistemology', {
			mode: 'semantic',
		});
		expect(unknown.results).toEqual([]);
		expect(unknown.limitations).toContain('bounded English');
		expect(unknown.method).toContain('HMS document');
		expect(store.get('passage-hms:fixture-project', 'v2')).toBeUndefined();
	});

	it('keeps Unicode passages, context, lines and revisions through incremental changes and fresh fallback restart', async () => {
		reviseDocument(
			0,
			`Prelude 🌙\n\n${'A quiet threshold. '.repeat(90)}\n\nHer closest friend sold their plan to the enemy.`
		);
		const first = await search.search('betrayal', { mode: 'semantic', contextChars: 80 });
		const hit = first.results[0];
		expect(hit.documentId).toBe(documents[0].documentId);
		expect(documents[0].text.slice(hit.start, hit.end)).toBe(hit.quote);
		expect(documents[0].text.slice(hit.contextStart, hit.contextEnd)).toBe(hit.context);
		expect(hit.line).toBe(documents[0].text.slice(0, hit.start).split('\n').length);
		await search.close();
		store.close();
		openSearch();
		expect((await search.refresh()).changedDocuments).toBe(0);
		expect((await search.search('betrayal', { mode: 'semantic' })).results[0].revision).toBe(
			documents[0].revision
		);
		reviseDocument(0, 'The baker arranged fresh loaves.');
		const changed = await search.search('betrayal', { mode: 'semantic' });
		expect(changed.index.changedDocuments).toBe(1);
		expect(changed.results).toEqual([]);
		documents.splice(1, 1);
		reviseDocument(3, ' \n ');
		const summary = await search.refresh();
		expect(summary.removedDocuments).toBe(1);
		expect(summary.documents).toBe(documents.length - 1);
	});

	it('enforces result and scope bounds while synchronizing all current documents independently of search scope', async () => {
		for (const limit of [0, 51])
			await expect(search.search('bread', { limit })).rejects.toThrow('1 to 50');
		await expect(
			search.search('bread', { documentIds: Array(10001).fill(documents[0].documentId) })
		).rejects.toThrow('scope');
		for (const limit of [1, 50]) {
			const result = await search.search('betrayal', {
				mode: 'semantic',
				limit,
				documentIds: [documents[4].documentId],
			});
			expect(result.results).toEqual([]);
		}
		expect(
			(
				await search.search('storm', {
					mode: 'semantic',
					documentIds: [documents[5].documentId],
				})
			).results[0].documentId
		).toBe(documents[5].documentId);
		expect((await search.search('storm', { documentIds: [] })).results).toEqual([]);
		expect(
			(await search.search('plan', { documentIds: ['unrelated-project-document'] })).results
		).toEqual([]);
	});

	it('reads each matched source once and never splits UTF16 characters at passage or context boundaries', async () => {
		reviseDocument(
			0,
			`${'x'.repeat(1399)}😀\n${'Rain swept over the harbor 🌙.\n'.repeat(200)}`
		);
		let reads = 0;
		const read = source.read;
		source.read = async (id) => {
			reads++;
			return read(id);
		};
		const result = await search.search('storm', {
			mode: 'semantic',
			limit: 4,
			contextChars: 1,
			documentIds: [documents[0].documentId],
		});
		expect(result.results).toHaveLength(4);
		expect(reads).toBe(1);
		for (const hit of result.results) {
			expect(hit.revision).toBe(documents[0].revision);
			expect(hit.quote).toBe(documents[0].text.slice(hit.start, hit.end));
			expect(hit.context).toBe(documents[0].text.slice(hit.contextStart, hit.contextEnd));
			expect(hit.line).toBe(documents[0].text.slice(0, hit.start).split('\n').length);
			for (const value of [hit.quote, hit.context]) {
				expect(value).not.toMatch(/^[\uDC00-\uDFFF]/u);
				expect(value).not.toMatch(/[\uD800-\uDBFF]$/u);
			}
		}
	});

	it('uses HMS BM25 frequency ranking and omits a source changed during final context retrieval', async () => {
		reviseDocument(0, 'lantern lantern lantern lantern harbor');
		reviseDocument(1, 'lantern bread bread bread harbor');
		const options = {
			mode: 'keyword' as const,
			documentIds: documents.slice(0, 2).map((doc) => doc.documentId),
		};
		const result = await search.search('lantern harbor', options);
		expect(result.results.map((hit) => hit.documentId)).toEqual(options.documentIds);
		expect(result.results[0].keywordScore).toBeGreaterThan(result.results[1].keywordScore);
		const read = source.read;
		source.read = async (id) => {
			if (id === documents[0].documentId) reviseDocument(0, 'A newly saved scene.');
			return read(id);
		};
		expect(
			(await search.search('lantern harbor', options)).results.map((hit) => hit.documentId)
		).toEqual([documents[1].documentId]);
	});

	it('keeps the same real index current when another indexer replaces or deletes a saved document', async () => {
		const other = new PassageSearch(source, store, newEngine());
		try {
			await search.search('plan', {
				mode: 'keyword',
				documentIds: [documents[0].documentId],
			});
			const before = await engine.searchDocuments('harbor', {
				lexicalWeight: 1,
				semanticWeight: 0,
			});
			await search.search('plan', { mode: 'keyword' });
			expect(
				(await engine.searchDocuments('harbor', { lexicalWeight: 1, semanticWeight: 0 }))[0]
					.documentId
			).toBe(before[0].documentId);
			reviseDocument(0, 'Her closest friend betrayed the captain and concealed the compass.');
			await other.refresh();
			const changed = await search.search('compass', { mode: 'keyword' });
			expect(changed.index.changedDocuments).toBe(0);
			expect(changed.results[0].revision).toBe(documents[0].revision);
			expect(
				await engine.searchDocuments('plan', { lexicalWeight: 1, semanticWeight: 0 })
			).toEqual([]);
			documents.splice(0, 1);
			await other.refresh();
			expect((await search.search('compass', { mode: 'keyword' })).results).toEqual([]);
			expect(
				await engine.searchDocuments('compass', { lexicalWeight: 1, semanticWeight: 0 })
			).toEqual([]);
			expect(
				(await engine.searchDocuments('harbor', { lexicalWeight: 1, semanticWeight: 0 }))[0]
					.documentId
			).toBe(before[0].documentId);
		} finally {
			await other.close();
		}
	});

	it.each(['insert', 'flush'] as const)(
		'replays durable pending IDs after an interrupted %s without retaining superseded native documents',
		async (fault) => {
			const retained = engine;
			jest.spyOn(engine, 'getStats').mockReturnValue({
				...engine.getStats(),
				persistentDocuments: true,
			});
			const interruption = new Error(`Interrupted ${fault}`);
			if (fault === 'insert') {
				const memorize = engine.memorizeDocuments.bind(engine);
				jest.spyOn(engine, 'memorizeDocuments').mockImplementationOnce(async (inputs) => {
					await memorize(inputs);
					throw interruption;
				});
			} else {
				const flush = engine.flush.bind(engine);
				jest.spyOn(engine, 'flush').mockImplementationOnce(async () => {
					await flush();
					throw interruption;
				});
			}
			await expect(search.refresh()).rejects.toBe(interruption);
			const inserted = await engine.searchDocuments('plan', {
				lexicalWeight: 1,
				semanticWeight: 0,
			});
			expect(inserted).toHaveLength(1);
			expect(store.get<SyncCatalog>('passage-hms:fixture-project', 'v2')?.pending).toContain(
				inserted[0].documentId
			);
			expect(store.get<SyncCatalog>('passage-hms:fixture-project', 'v2')?.applied).toEqual(
				[]
			);
			await search.close();
			store.close();
			openSearch(retained);
			reviseDocument(0, 'The captain studied a brass compass.');
			expect((await search.search('compass', { mode: 'keyword' })).results[0].revision).toBe(
				documents[0].revision
			);
			expect(
				await engine.searchDocuments('plan', { lexicalWeight: 1, semanticWeight: 0 })
			).toEqual([]);
			expect(store.get<SyncCatalog>('passage-hms:fixture-project', 'v2')?.pending).toEqual(
				[]
			);
			expect(
				store.get<SyncCatalog>('passage-hms:fixture-project', 'v2')?.applied
			).toHaveLength(documents.length);
			expect((await search.refresh()).changedDocuments).toBe(0);
		}
	);

	it.each(['project', 'version', 'chunk-boundary'] as const)(
		'rejects actual index corruption of %s provenance',
		async (field) => {
			await search.refresh();
			const original = (
				await engine.searchDocuments('plan', { lexicalWeight: 1, semanticWeight: 0 })
			)[0];
			await engine.memorizeDocuments([
				{
					id: original.documentId,
					text: original.text!,
					sourceUri: original.sourceUri,
					version: field === 'version' ? 'wrong-revision' : original.version,
					metadata:
						field === 'project'
							? { ...original.metadata, projectId: 'unrelated-project' }
							: original.metadata,
					chunkWords: field === 'chunk-boundary' ? 1 : 4096,
					overlapWords: 0,
					storeText: true,
				},
			]);
			await expect(search.search('plan', { mode: 'keyword' })).rejects.toThrow(
				'inconsistent source provenance'
			);
		}
	);

	it('refuses unknown index documents on the full-project fast path while explicit scopes exclude unrelated IDs', async () => {
		await search.refresh();
		await engine.memorizeDocuments([
			{
				id: 'unrelated-document',
				text: 'A secret plan.',
				version: 'other-revision',
				metadata: { projectId: 'unrelated-project', indexVersion: 2 },
				storeText: true,
			},
		]);
		await expect(search.search('plan', { mode: 'keyword' })).rejects.toThrow(
			'inconsistent source provenance'
		);
		const scoped = await search.search('plan', {
			mode: 'keyword',
			documentIds: [documents[0].documentId],
		});
		expect(scoped.results.map((hit) => hit.documentId)).toEqual([documents[0].documentId]);
	});

	it('reports an in-flight source refresh failure during close and leaves external index ownership with its caller', async () => {
		await search.refresh();
		expectedCloseError = new Error('Synthetic source refresh failure');
		let reject!: (error: Error) => void;
		source.list = () =>
			new Promise<SourceDocument[]>((_resolve, fail) => {
				reject = fail;
			});
		const refresh = search.refresh().catch((error: unknown) => error);
		await Promise.resolve();
		const closing = search.close();
		reject(expectedCloseError);
		expect(await refresh).toBe(expectedCloseError);
		await expect(closing).rejects.toBe(expectedCloseError);
		expect(
			(await engine.searchDocuments('plan', { lexicalWeight: 1, semanticWeight: 0 }))[0].text
		).toContain('plan');
	});
});
