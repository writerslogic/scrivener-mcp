import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

describe('local passage retrieval', () => {
	let dir: string;
	let store: PersistentStore;
	let search: PassageSearch;
	let documents: SourceDocument[];
	let source: ManuscriptSource;
	let fixture: RelevanceFixture;

	function openSearch(): void {
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		search = new PassageSearch(source, store);
	}

	function reviseDocument(index: number, text: string): void {
		documents[index] = {
			...documents[index], text,
			revision: createHash('sha256').update(text).digest('hex'),
		};
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'scrivener-passages-'));
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

	afterEach(async () => {
		await search.close();
		store.close();
		await rm(dir, { recursive: true, force: true });
	});

	it('ranks the four zero-keyword-overlap relevance cases using local concept vectors', async () => {
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
		await expect(access(join(dir, '.scrivener-mcp', 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('keeps exact passages, Unicode offsets, context and revisions through incremental changes and restart', async () => {
		reviseDocument(0, `Prelude 🌙\n\n${'A quiet threshold. '.repeat(90)}\n\nHer closest friend sold their plan to the enemy.`);
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
		reviseDocument(0, 'The baker arranged fresh loaves.');
		const changed = await search.search('betrayal', { mode: 'semantic' });
		expect(changed.index.changedDocuments).toBe(1);
		expect(changed.results).toEqual([]);
		documents.splice(1, 1);
		expect((await search.refresh()).removedDocuments).toBe(1);
	});

	it('validates result limit boundaries and enforces document scope', async () => {
		for (const limit of [0, 51])
			await expect(search.search('bread', { limit })).rejects.toThrow('1 to 50');
		for (const limit of [1, 50]) {
			const result = await search.search('betrayal', {
				mode: 'semantic',
				limit,
				documentIds: [documents[4].documentId],
			});
			expect(result.results).toEqual([]);
		}
	});

	it('reads each matched source once while keeping every passage and line tied to that saved revision', async () => {
		reviseDocument(0, 'Rain swept over the harbor 🌙.\n'.repeat(200));
		let reads = 0;
		const read = source.read;
		source.read = async (id) => { reads++; return read(id); };
		const result = await search.search('storm', { mode: 'semantic', limit: 4, documentIds: [documents[0].documentId] });
		expect(result.results).toHaveLength(4);
		expect(reads).toBe(1);
		for (const hit of result.results) {
			expect(hit.revision).toBe(documents[0].revision);
			expect(hit.quote).toBe(documents[0].text.slice(hit.start, hit.end));
			expect(hit.line).toBe(documents[0].text.slice(0, hit.start).split('\n').length);
		}
	});

	it('retains BM25 term-frequency ranking and omits a source that changed during retrieval', async () => {
		reviseDocument(0, 'lantern lantern lantern lantern harbor');
		reviseDocument(1, 'lantern bread bread bread harbor');
		const options = { mode: 'keyword' as const, documentIds: documents.slice(0, 2).map((doc) => doc.documentId) };
		const result = await search.search('lantern harbor', options);
		expect(result.results.map((hit) => hit.documentId)).toEqual(options.documentIds);
		expect(result.results[0].keywordScore).toBeGreaterThan(result.results[1].keywordScore);
		const read = source.read;
		source.read = async (id) => {
			if (id === documents[0].documentId) reviseDocument(0, 'A newly saved scene.');
			return read(id);
		};
		const refreshed = await search.search('lantern harbor', options);
		expect(refreshed.results.map((hit) => hit.documentId)).toEqual([documents[1].documentId]);
	});

	it('releases its HMS cache when an in-flight index refresh fails during close', async () => {
		await search.search('harbor', { mode: 'hybrid' });
		const cache = join(dir, '.scrivener-mcp', 'cache');
		expect((await readdir(cache)).length).toBeGreaterThan(0);
		const primary = new Error('Synthetic source refresh failure');
		let reject!: (error: Error) => void;
		source.list = () => new Promise<SourceDocument[]>((_resolve, fail) => { reject = fail; });
		const refresh = search.refresh().catch((error: unknown) => error);
		const closing = search.close();
		reject(primary);
		expect(await refresh).toBe(primary);
		await expect(closing).rejects.toBe(primary);
		expect(await readdir(cache)).toEqual([]);
	});

	it('reuses unchanged HMS vectors and discards saved revisions removed or replaced by another indexer', async () => {
		const engines: HolographicMemorySystem[] = [];
		const memorize = HolographicMemorySystem.prototype.memorizeBatch;
		const spy = jest.spyOn(HolographicMemorySystem.prototype, 'memorizeBatch').mockImplementation(async function (this: HolographicMemorySystem, items, trace) {
			if (!engines.includes(this)) engines.push(this);
			await memorize.call(this, items, trace);
		});
		const other = new PassageSearch(source, store);
		try {
			const options = { mode: 'hybrid' as const, documentIds: [documents[0].documentId] };
			await search.search('betrayal', options);
			await search.search('betrayal', options);
			expect(engines).toHaveLength(1);
			reviseDocument(0, 'Her closest friend betrayed the captain and sold their plan.');
			await other.refresh();
			const changed = await search.search('betrayal', options);
			expect(changed.index.changedDocuments).toBe(0);
			expect(changed.results[0].revision).toBe(documents[0].revision);
			expect(engines).toHaveLength(2);
			expect(engines[0].getStats().totalMemories).toBe(0);
			documents.splice(0, 1);
			await other.refresh();
			const remaining = await search.search('storm', { mode: 'hybrid' });
			expect(engines).toHaveLength(3);
			expect(engines[1].getStats().totalMemories).toBe(0);
			expect(engines[2].getStats().totalMemories).toBe(remaining.index.passages);
			expect(await readdir(join(dir, '.scrivener-mcp', 'cache'))).toHaveLength(1);
		} finally { spy.mockRestore(); await other.close(); }
	});
});
