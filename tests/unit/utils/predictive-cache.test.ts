import { PredictiveCache } from '../../../src/utils/predictive-cache.js';

describe('PredictiveCache behavior', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	it('returns undefined on a miss when no dataLoader is configured', async () => {
		const cache = new PredictiveCache<string>();
		expect(await cache.get('absent')).toBeUndefined();
	});

	it('round-trips a value through set then get', async () => {
		const cache = new PredictiveCache<string>();
		await cache.set('k', 'v');
		expect(await cache.get('k')).toBe('v');
	});

	it('overwrites an existing key with the newer value', async () => {
		const cache = new PredictiveCache<number>();
		await cache.set('n', 1);
		await cache.set('n', 2);
		expect(await cache.get('n')).toBe(2);
	});

	it('deletes a present key and reports the removal, no-ops on an absent key', async () => {
		const cache = new PredictiveCache<string>();
		await cache.set('k', 'v');
		expect(cache.delete('k')).toBe(true);
		expect(await cache.get('k')).toBeUndefined();
		expect(cache.delete('k')).toBe(false);
	});

	it('clear empties the cache', async () => {
		const cache = new PredictiveCache<string>();
		await cache.set('a', '1');
		await cache.set('b', '2');
		cache.clear();
		expect(await cache.get('a')).toBeUndefined();
		expect(cache.getStats().entryCount).toBe(0);
	});

	it('tracks hit rate and entry count in getStats', async () => {
		const cache = new PredictiveCache<string>();
		await cache.set('k', 'v');
		await cache.get('k'); // hit
		await cache.get('miss'); // miss
		const stats = cache.getStats();
		expect(stats.entryCount).toBe(1);
		expect(stats.totalAccesses).toBe(2);
		expect(stats.hitRate).toBeCloseTo(0.5, 5);
	});

	it('retains every distinct key without eviction under the size ceiling', async () => {
		const cache = new PredictiveCache<number>();
		const N = 700;
		for (let i = 0; i < N; i++) {
			await cache.set(`key-${i}`, i);
		}
		expect(cache.getStats().entryCount).toBe(N);
		for (let i = 0; i < N; i++) {
			expect(await cache.get(`key-${i}`)).toBe(i);
		}
	});

	it('loads and caches through a dataLoader on a miss', async () => {
		const loader = jest.fn(async (key: string) => `loaded:${key}`);
		const cache = new PredictiveCache<string>(1024 * 1024, loader);
		expect(await cache.get('x')).toBe('loaded:x');
		expect(loader).toHaveBeenCalledTimes(1);
		// second get is a hit, loader not called again
		expect(await cache.get('x')).toBe('loaded:x');
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it('accounts for replacement size without evicting other entries that still fit', async () => {
		const cache = new PredictiveCache<string>(10);
		await cache.set('replace', 'aaaa');
		await cache.set('keep', 'b');
		await cache.set('replace', 'ccc');
		expect(cache.getStats()).toMatchObject({ size: 8, entryCount: 2 });
		await cache.set('replace', 'dddd');
		expect(cache.getStats()).toMatchObject({ size: 10, entryCount: 2 });
		expect(await cache.get('keep')).toBe('b');
		expect(await cache.get('replace')).toBe('dddd');
		cache.delete('replace');
		expect(cache.getStats()).toMatchObject({ size: 2, entryCount: 1 });
		cache.delete('keep');
		expect(cache.getStats()).toMatchObject({ size: 0, entryCount: 0 });
	});

	it('evicts other entries when a growing replacement needs space', async () => {
		const cache = new PredictiveCache<string>(12);
		await cache.set('replace', 'aa');
		await cache.set('evict', 'bbbb');
		await cache.set('replace', 'ccc');
		expect(cache.getStats()).toMatchObject({ size: 6, entryCount: 1 });
		expect(await cache.get('replace')).toBe('ccc');
		expect(await cache.get('evict')).toBeUndefined();
	});

	it('enforces capacity across writes started without awaiting their completion', async () => {
		const cache = new PredictiveCache<string>(10);
		await Promise.all([cache.set('first', 'aaaa'), cache.set('second', 'bbbb')]);
		expect(cache.getStats()).toMatchObject({ size: 8, entryCount: 1 });
		expect(await cache.get('first')).toBeUndefined();
		expect(await cache.get('second')).toBe('bbbb');
	});

	it.each([7, 8, 9])('respects the eight-byte value boundary with capacity %i', async (limit) => {
		const cache = new PredictiveCache<number>(limit);
		await cache.set('number', 42);
		expect(cache.getStats()).toMatchObject({
			size: limit >= 8 ? 8 : 0,
			entryCount: limit >= 8 ? 1 : 0,
		});
		expect(await cache.get('number')).toBe(limit >= 8 ? 42 : undefined);
	});

	it('drops an oversized replacement without evicting unrelated values or serving stale content', async () => {
		const cache = new PredictiveCache<string>(10);
		await cache.set('replace', 'aaaa');
		await cache.set('keep', 'b');
		await cache.set('replace', 'oversized');
		expect(await cache.get('replace')).toBeUndefined();
		expect(await cache.get('keep')).toBe('b');
		expect(cache.getStats()).toMatchObject({ size: 2, entryCount: 1 });
	});

	it('returns oversized loaded values without caching them or evicting useful entries', async () => {
		const loader = jest.fn(async () => 'oversized');
		const cache = new PredictiveCache<string>(8, loader);
		await cache.set('keep', 'a');
		expect(await cache.get('large')).toBe('oversized');
		expect(await cache.get('large')).toBe('oversized');
		expect(loader).toHaveBeenCalledTimes(2);
		expect(await cache.get('keep')).toBe('a');
		expect(cache.getStats()).toMatchObject({ size: 2, entryCount: 1 });
	});
});
