import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassageSearch } from '../../../src/services/editorial/passage-search.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
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
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		search = new PassageSearch(source, store);
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
	});

	it('keeps exact passages, Unicode offsets, context and revisions through incremental changes and restart', async () => {
		documents[0] = {
			...documents[0],
			text: `Prelude 🌙\n\n${'A quiet threshold. '.repeat(90)}\n\nHer closest friend sold their plan to the enemy.`,
		};
		documents[0].revision = createHash('sha256').update(documents[0].text).digest('hex');
		const first = await search.search('betrayal', { mode: 'semantic', contextChars: 80 });
		const hit = first.results[0];
		expect(hit.documentId).toBe(documents[0].documentId);
		expect(documents[0].text.slice(hit.start, hit.end)).toBe(hit.quote);
		expect(documents[0].text.slice(hit.contextStart, hit.contextEnd)).toBe(hit.context);
		expect(hit.line).toBe(documents[0].text.slice(0, hit.start).split('\n').length);
		await search.close();
		store.close();
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		search = new PassageSearch(source, store);
		expect((await search.refresh()).changedDocuments).toBe(0);
		documents[0] = {
			...documents[0],
			text: 'The baker arranged fresh loaves.',
			revision: 'new-saved-revision',
		};
		const changed = await search.search('betrayal', { mode: 'semantic' });
		expect(changed.index.changedDocuments).toBe(1);
		expect(changed.results).toEqual([]);
		documents.splice(1, 1);
		expect((await search.refresh()).removedDocuments).toBe(1);
	});

	it.each([0, 51])('rejects out-of-range result limit %s', async (limit) => {
		await expect(search.search('bread', { limit })).rejects.toThrow('1 to 50');
	});

	it.each([1, 50])(
		'accepts boundary result limit %s and enforces document scope',
		async (limit) => {
			const result = await search.search('betrayal', {
				mode: 'semantic',
				limit,
				documentIds: [documents[4].documentId],
			});
			expect(result.results).toEqual([]);
		}
	);
});
