import { HMSVectorStore, type HMSVectorStoreArgs } from '../../../src/services/ai/hms-vector-store.js';
import { AIWritingService } from '../../../src/services/ai/ai-writing-service.js';
import { AIClient } from '../../../src/services/ai/ai-client.js';
import { HolographicMemorySystem } from '../../../src/services/memory/hhm/holographic-memory-system.js';

let stores: HMSVectorStore[];
let engines: HolographicMemorySystem[];
const createStore = (args: HMSVectorStoreArgs = {}): HMSVectorStore => {
	const store = new HMSVectorStore({ engine: 'fallback', ...args });
	stores.push(store);
	return store;
};
const createEngine = (): HolographicMemorySystem => {
	const engine = new HolographicMemorySystem({ dimensions: 1024, engine: 'fallback' });
	engines.push(engine);
	return engine;
};

beforeEach(() => { stores = []; engines = []; });
afterEach(async () => {
	try { await Promise.all(stores.map((store) => store.close())); }
	finally { await Promise.all(engines.map((engine) => engine.destroy())); }
});

it('isolates default stores on a borrowed engine and cleans only their indexed documents', async () => {
	const engine = createEngine();
	const first = createStore({ hms: engine });
	const second = createStore({ hms: engine });
	await first.addDocuments([{ pageContent: 'needle first manuscript', metadata: { id: 'shared-id', title: 'First' } }]);
	await second.addDocuments([{ pageContent: 'needle second manuscript', metadata: { id: 'shared-id', title: 'Second' } }]);
	expect((await first.similaritySearch('needle')).map((hit) => hit.metadata.title)).toEqual(['First']);
	expect((await second.similaritySearch('needle')).map((hit) => hit.metadata.title)).toEqual(['Second']);
	await first.close();
	expect((await second.similaritySearch('needle')).map((hit) => hit.metadata.title)).toEqual(['Second']);
	expect((await engine.searchDocuments('needle')).map((hit) => hit.metadata.title)).toEqual(['Second']);
	await second.close();
	expect(await engine.searchDocuments('needle')).toEqual([]);
	await engine.memorizeDocuments([{ id: 'owner-remains-usable', text: 'surviving owner', metadata: {} }]);
	expect((await engine.searchDocuments('surviving')).map((hit) => hit.documentId)).toEqual(['owner-remains-usable']);
});

it('preserves independent identities, nested metadata, source revision and Unicode byte locations', async () => {
	const store = createStore();
	const text = 'Café 東京 🌙 needle.';
	const metadata = { id: 'public-id', documentId: 'binder-id', title: 'Chapter', nested: { confirmed: true } };
	await store.addDocuments([{ pageContent: text, metadata, sourceUri: 'scrivener://project/binder-id', version: 'saved-revision-1', startByte: 37, endByte: 37 + Buffer.byteLength(text) }]);
	metadata.nested.confirmed = false;
	const [[hit, score]] = await store.similaritySearchWithScore('needle');
	expect(hit.pageContent).toBe(text);
	expect(hit).toMatchObject({ sourceUri: 'scrivener://project/binder-id', version: 'saved-revision-1', startByte: 37, endByte: 37 + Buffer.byteLength(text) });
	expect(hit.metadata).toMatchObject({ id: 'public-id', documentId: 'binder-id', title: 'Chapter', nested: { confirmed: true }, version: 'saved-revision-1', startByte: 37, endByte: 37 + Buffer.byteLength(text), similarity: score });
	expect(Object.keys(hit.metadata).some((key) => key.startsWith('__scrivener_hms_'))).toBe(false);
});

it('replaces every old chunk when an indexed document shrinks', async () => {
	const store = createStore();
	await store.addDocuments([{ pageContent: 'obsolete '.repeat(1025), metadata: { id: 'stable-id', title: 'Old' }, version: '1' }]);
	expect((await store.similaritySearch('obsolete', 10)).length).toBeGreaterThan(1);
	await store.addDocuments([{ pageContent: 'replacement passage', metadata: { id: 'stable-id', title: 'New' }, version: '2' }]);
	expect(await store.similaritySearch('obsolete', 10)).toEqual([]);
	const updated = await store.similaritySearch('replacement', 10);
	expect(updated).toHaveLength(1);
	expect(updated[0]).toMatchObject({ pageContent: 'replacement passage', version: '2', metadata: { id: 'stable-id', title: 'New' } });
});

it('reopens an explicit scoped view on its borrowed engine without deleting retained metadata', async () => {
	const engine = createEngine();
	const first = createStore({ hms: engine, scope: 'series/book-one' });
	await first.addDocuments([{ pageContent: 'needle durable view', metadata: { id: 'stable-id', edition: 2 }, version: 'revision-two' }]);
	await first.close();
	const reopened = createStore({ hms: engine, scope: 'series/book-one' });
	const unrelated = createStore({ hms: engine, scope: 'series/book-two' });
	expect(await unrelated.similaritySearch('needle')).toEqual([]);
	expect(await reopened.similaritySearch('needle')).toMatchObject([{ version: 'revision-two', metadata: { id: 'stable-id', edition: 2 } }]);
});

it('drains an admitted write before closing and leaves no ephemeral documents on a borrowed engine', async () => {
	const engine = createEngine();
	const store = createStore({ hms: engine });
	const writing = store.addDocuments([{ pageContent: 'pending needle', metadata: { id: 'pending' } }]);
	const closing = store.close();
	await Promise.all([writing, closing]);
	await store.close();
	expect(await engine.searchDocuments('needle')).toEqual([]);
	await expect(store.similaritySearch('needle')).rejects.toThrow(/closed/i);
	await expect(store.addDocuments([{ pageContent: 'later', metadata: {} }])).rejects.toThrow(/closed/i);
});

it('indexes a batch boundary without losing document metadata', async () => {
	const store = createStore();
	await store.addDocuments(Array.from({ length: 65 }, (_, index) => ({ pageContent: `needle passage ${index}`, metadata: { id: `doc-${index}`, ordinal: index } })));
	const results = await store.similaritySearch('needle', 100);
	expect(results).toHaveLength(65);
	expect(new Set(results.map((hit) => hit.metadata.ordinal))).toEqual(new Set(Array.from({ length: 65 }, (_, index) => index)));
});

it.each(['cycle', 'undefined', 'reserved'] as const)('rejects %s metadata before writing any planned batch', async (invalid) => {
	const store = createStore();
	const bad: Record<string, unknown> = { id: 'invalid' };
	if (invalid === 'cycle') bad.cycle = bad;
	else if (invalid === 'undefined') bad.value = undefined;
	else bad.__scrivener_hms_scope = 'another-owner';
	const documents = Array.from({ length: 65 }, (_, index) => ({ pageContent: 'sentinel needle', metadata: { id: `valid-${index}` } as Record<string, unknown> }));
	documents.push({ pageContent: 'invalid needle', metadata: bad });
	await expect(store.addDocuments(documents)).rejects.toThrow();
	expect(await store.similaritySearch('sentinel')).toEqual([]);
});

it('enforces UTF-8 identity/query and result-count boundaries', async () => {
	const store = createStore();
	for (const length of [4095, 4096]) await store.addDocuments([{ pageContent: 'needle', metadata: { id: 'i'.repeat(length) } }]);
	await expect(store.addDocuments([{ pageContent: 'needle', metadata: { id: 'i'.repeat(4097) } }])).rejects.toThrow(/id/i);
	for (const length of [65535, 65536]) expect(await store.similaritySearch('needle' + ' '.repeat(length - 6), 1)).toHaveLength(1);
	await expect(store.similaritySearch('needle' + ' '.repeat(65537 - 6))).rejects.toThrow(/query/i);
	for (const k of [1, 999, 1000]) expect((await store.similaritySearch('needle', k)).length).toBe(Math.min(k, 2));
	for (const k of [0, 1001, 1.5, Number.NaN]) await expect(store.similaritySearch('needle', k)).rejects.toThrow(/k/i);
	await expect(store.similaritySearch('   ')).rejects.toThrow(/query/i);
});

it('rejects mismatched supplied source ranges before indexing', async () => {
	const store = createStore();
	await expect(store.addDocuments([{ pageContent: 'Café needle', metadata: { id: 'invalid-range' }, startByte: 4, endByte: 4 + 'Café needle'.length }])).rejects.toThrow(/range/i);
	expect(await store.similaritySearch('needle')).toEqual([]);
});


it('drains a writing-service build before clearing and uses a fresh scoped index afterward', async () => {
	const previous = process.env.SCRIVENER_HMS_ENGINE;
	process.env.SCRIVENER_HMS_ENGINE = 'fallback';
	const service = new AIWritingService(new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' }));
	try {
		await Promise.all([
			service.buildVectorStore([{ id: 'old', title: 'Old', type: 'Text', path: 'old.rtf', content: 'obsolete '.repeat(1025) }]),
			service.clearMemory(),
		]);
		await expect(service.semanticSearch('obsolete')).rejects.toThrow(/not initialized/i);
		await service.buildVectorStore([{ id: 'new', title: 'New', type: 'Text', path: 'new.rtf', content: 'replacement passage', metadata: { revision: 'saved-revision' } }]);
		expect(await service.semanticSearch('obsolete')).toEqual([]);
		expect(await service.semanticSearch('replacement')).toMatchObject([{ pageContent: 'replacement passage', version: 'saved-revision', metadata: { id: 'new', documentId: 'new', title: 'New' } }]);
	} finally {
		try { await service.close(); }
		finally {
			if (previous === undefined) delete process.env.SCRIVENER_HMS_ENGINE;
			else process.env.SCRIVENER_HMS_ENGINE = previous;
		}
	}
});
