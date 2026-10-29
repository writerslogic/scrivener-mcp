import { HolographicMemorySystem } from '../../../src/services/memory/hhm/holographic-memory-system.js';
import type { QueryResult } from '../../../src/services/memory/hhm/holographic-memory-system.js';

describe('HMS fallback corpus vectors', () => {
	const engines: HolographicMemorySystem[] = [];
	const documents = [
		{ id: 'first', text: 'captain lighthouse harbor harbor' },
		{ id: 'second', text: 'captain meadow orchard' },
		{ id: 'third', text: 'orchard violet violet' },
		{ id: 'duplicate', text: 'captain lighthouse harbor harbor' },
	];

	function createEngine(): HolographicMemorySystem {
		const engine = new HolographicMemorySystem({ dimensions: 512, engine: 'fallback' });
		expect(engine.getStats().engine).toBe('JS Fallback');
		engines.push(engine);
		return engine;
	}

	function scores(results: QueryResult[]): Record<string, number> {
		return Object.fromEntries(results.map((result) => [result.id, result.similarity]));
	}

	it('retrieves a large vocabulary without exceeding function argument limits', async () => {
		const engine = createEngine();
		const text = Array.from({ length: 150_000 }, (_, index) => `token${index}`).join(' ');
		await engine.memorizeText(text, 'large');
		const results = await engine.queryText('token149999', 1);
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe('large');
		expect(Number.isFinite(results[0].similarity)).toBe(true);
	});

	afterEach(async () => {
		await Promise.all(engines.splice(0).map((engine) => engine.destroy()));
	});

	it('uses the complete corpus for identical first and warm query scores regardless of insertion order', async () => {
		const forward = createEngine();
		const reverse = createEngine();
		await forward.memorizeBatch(documents);
		await reverse.memorizeBatch([...documents].reverse());

		const first = await forward.queryText(documents[0].text, documents.length);
		expect(scores(first)).toEqual(
			scores(await reverse.queryText(documents[0].text, documents.length))
		);
		expect(await forward.queryText(documents[0].text, documents.length)).toEqual(first);
		for (const id of ['first', 'duplicate']) {
			expect(first.find((result) => result.id === id)?.similarity).toBeCloseTo(1, 12);
		}
	});

	it('invalidates every vector after replacing text and preserves unique memory identities', async () => {
		const updated = createEngine();
		const rebuilt = createEngine();
		await updated.memorizeBatch(documents);
		await updated.queryText('captain harbor', documents.length);
		await updated.memorizeText('meadow violet', 'first');
		await rebuilt.memorizeBatch([
			...documents.slice(1),
			{ id: 'first', text: 'meadow violet' },
		]);

		expect(updated.getStats().totalMemories).toBe(documents.length);
		expect(scores(await updated.queryText('meadow violet', documents.length))).toEqual(
			scores(await rebuilt.queryText('meadow violet', documents.length))
		);
	});

	it('rebuilds pending vectors when analogy is the first retrieval operation', async () => {
		const direct = createEngine();
		const queried = createEngine();
		await direct.memorizeBatch(documents);
		await queried.memorizeBatch(documents);
		await queried.queryText('captain harbor', documents.length);

		expect(scores(await direct.findAnalogy('captain', 'harbor', 'violet'))).toEqual(
			scores(await queried.findAnalogy('captain', 'harbor', 'violet'))
		);
	});

	it('rebuilds pending vectors before concept synthesis and clears them on destruction', async () => {
		const engine = createEngine();
		await engine.memorizeBatch(
			['first', 'second', 'third'].map((id) => ({
				id,
				text: 'captain harbor lighthouse',
			}))
		);
		const concepts = await engine.dream();
		expect(concepts).toHaveLength(1);
		expect(concepts[0].memberCount).toBe(3);
		expect(concepts[0].thematicDensity).toBeCloseTo(1, 12);
		await engine.destroy();
		await expect(engine.queryText('captain harbor lighthouse')).rejects.toThrow('closed');
		expect(engine.getStats().totalMemories).toBe(0);
	});
});
