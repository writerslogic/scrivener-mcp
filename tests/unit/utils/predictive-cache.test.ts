/**
 * Characterization tests for PredictiveCache. These lock the observable behavior
 * of the public surface (get / set / delete / clear / getStats and unbounded
 * retention) BEFORE its internal LockFreeHashMap/LockFreeQueue are swapped for a
 * plain Map/array, so the swap can be proven behavior-preserving.
 *
 * Fake timers are installed before construction so the cache's background
 * setInterval loops never schedule real handles (they would otherwise keep the
 * event loop alive and hang an isolated run).
 */

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
		const N = 700; // crosses the 512 initial capacity to exercise growth/rehash
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
});
