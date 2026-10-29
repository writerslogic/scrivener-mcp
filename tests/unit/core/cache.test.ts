import { LRUCache, CacheKeys } from '../../../src/core/cache.js';

describe('LRUCache', () => {
	let cache: LRUCache<string>;

	beforeEach(() => {
		cache = new LRUCache({
			ttl: 1000,
			maxSize: 1024,
			maxEntries: 3,
		});
	});

	describe('basic operations', () => {
		it('should set and get values', () => {
			cache.set('key1', 'value1');
			expect(cache.get('key1')).toBe('value1');
		});

		it('should return undefined for missing keys', () => {
			expect(cache.get('missing')).toBeUndefined();
		});

		it('should check if key exists', () => {
			cache.set('key1', 'value1');
			expect(cache.has('key1')).toBe(true);
			expect(cache.has('missing')).toBe(false);
		});

		it('should delete values', () => {
			cache.set('key1', 'value1');
			expect(cache.delete('key1')).toBe(true);
			expect(cache.get('key1')).toBeUndefined();
			expect(cache.delete('missing')).toBe(false);
		});

		it('should clear all values', () => {
			cache.set('key1', 'value1');
			cache.set('key2', 'value2');
			cache.clear();
			expect(cache.get('key1')).toBeUndefined();
			expect(cache.get('key2')).toBeUndefined();
		});
	});

	describe('TTL expiration', () => {
		it('should expire entries after TTL', async () => {
			const shortCache = new LRUCache({ ttl: 50 });
			shortCache.set('key1', 'value1');

			expect(shortCache.get('key1')).toBe('value1');

			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(shortCache.get('key1')).toBeUndefined();
		});

		it('should use custom TTL', async () => {
			cache.set('key1', 'value1', 50);

			expect(cache.get('key1')).toBe('value1');

			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(cache.get('key1')).toBeUndefined();
		});

		it('should clean expired entries', async () => {
			const shortCache = new LRUCache({ ttl: 10 }); // 10ms TTL
			shortCache.set('key1', 'value1');
			shortCache.set('key2', 'value2');

			// Wait for entries to expire
			await new Promise((resolve) => setTimeout(resolve, 15));

			const cleaned = shortCache.cleanExpired();
			expect(cleaned).toBe(2);
			expect(shortCache.get('key1')).toBeUndefined();
		});
	});

	describe('LRU eviction', () => {
		it('should evict least recently used', () => {
			cache.set('key1', 'value1');
			cache.set('key2', 'value2');
			cache.set('key3', 'value3');

			// Access key1 to make it more recent
			cache.get('key1');

			// Add new item, should evict key2
			cache.set('key4', 'value4');

			expect(cache.get('key1')).toBe('value1');
			expect(cache.get('key2')).toBeUndefined();
			expect(cache.get('key3')).toBe('value3');
			expect(cache.get('key4')).toBe('value4');
		});

		it('should update access order on get', () => {
			cache.set('key1', 'value1');
			cache.set('key2', 'value2');
			cache.set('key3', 'value3');

			// Access in order: 2, 1, 3
			cache.get('key2');
			cache.get('key1');
			cache.get('key3');

			// Add new item, should evict key2 (least recent)
			cache.set('key4', 'value4');

			expect(cache.get('key2')).toBeUndefined();
		});

		it('does not promote an entry when checking membership', () => {
			cache.set('key1', 'value1');
			cache.set('key2', 'value2');
			cache.set('key3', 'value3');
			expect(cache.has('key1')).toBe(true);
			cache.set('key4', 'value4');
			expect(cache.has('key1')).toBe(false);
		});
	});

	describe('size limits', () => {
		it.each(['key1', 'key2', 'key3'])(
			'replaces %s at capacity without evicting another entry',
			(key) => {
				const onEvict = jest.fn();
				const limitedCache = new LRUCache<string>({ maxEntries: 3, onEvict });
				for (const id of ['key1', 'key2', 'key3']) limitedCache.set(id, 'old');
				limitedCache.set(key, 'new');
				expect(limitedCache.getSize()).toBe(3);
				expect(limitedCache.getMemoryUsage()).toBe(18);
				for (const id of ['key1', 'key2', 'key3']) {
					expect(limitedCache.get(id)).toBe(id === key ? 'new' : 'old');
				}
				expect(onEvict.mock.calls).toEqual([[key, 'old']]);
			}
		);

		it('accounts for the replaced value before enforcing the byte limit', () => {
			const sizeCache = new LRUCache<string>({ maxSize: 20 });
			sizeCache.set('oldest', '12345');
			sizeCache.set('newest', '12345');
			sizeCache.set('newest', '12');
			expect(sizeCache.get('oldest')).toBe('12345');
			expect(sizeCache.get('newest')).toBe('12');
			expect(sizeCache.getMemoryUsage()).toBe(14);
		});

		it('makes a replacement most recent before the next eviction', () => {
			cache.set('key1', 'old');
			cache.set('key2', 'value2');
			cache.set('key3', 'value3');
			cache.set('key1', 'new');
			cache.set('key4', 'value4');
			expect(cache.has('key1')).toBe(true);
			expect(cache.has('key2')).toBe(false);
		});

		it.each([19, 20, 21])('enforces a %i-byte limit at the boundary', (maxSize) => {
			const sizeCache = new LRUCache<string>({ maxSize });
			sizeCache.set('value', '1234567890');
			expect(sizeCache.has('value')).toBe(maxSize >= 20);
			expect(sizeCache.getMemoryUsage()).toBe(maxSize >= 20 ? 20 : 0);
		});

		it('retains the existing entry when its replacement is too large', () => {
			const sizeCache = new LRUCache<string>({ maxSize: 20 });
			sizeCache.set('value', 'old');
			sizeCache.set('value', 'x'.repeat(11));
			expect(sizeCache.get('value')).toBe('old');
			expect(sizeCache.getMemoryUsage()).toBe(6);
		});

		it('should respect max entries', () => {
			const limitedCache = new LRUCache({ maxEntries: 2 });

			limitedCache.set('key1', 'value1');
			limitedCache.set('key2', 'value2');
			limitedCache.set('key3', 'value3');

			expect(limitedCache.has('key1')).toBe(false);
			expect(limitedCache.has('key2')).toBe(true);
			expect(limitedCache.has('key3')).toBe(true);
		});

		it('should respect max size', () => {
			const sizeCache = new LRUCache({ maxSize: 100 });

			// Each string is roughly 2 bytes per char
			sizeCache.set('key1', 'a'.repeat(40)); // ~80 bytes
			sizeCache.set('key2', 'b'.repeat(30)); // ~60 bytes, would exceed

			expect(sizeCache.has('key1')).toBe(false);
			expect(sizeCache.has('key2')).toBe(true);
		});

		it('should not cache items exceeding max size', () => {
			const sizeCache = new LRUCache({ maxSize: 100 });

			sizeCache.set('huge', 'x'.repeat(200));
			expect(sizeCache.has('huge')).toBe(false);
		});
	});

	describe('statistics', () => {
		it('should return cache stats', () => {
			cache.set('key1', 'value1');
			cache.set('key2', 'value2');

			const stats = cache.getStats();

			expect(stats.entries).toBe(2);
			expect(stats.maxEntries).toBe(3);
			expect(stats.size).toBeGreaterThan(0);
			expect(stats.maxSize).toBe(1024);
			expect(stats.utilization).toBeGreaterThan(0);
			expect(stats.utilization).toBeLessThan(1);
		});
	});

	describe('eviction callback', () => {
		it('allows eviction callbacks to inspect entries during clear', () => {
			const inspected: string[] = [];
			const onEvict = jest.fn((key: string) => {
				expect(onEvict.mock.calls.length).toBeLessThanOrEqual(2);
				inspected.push(evictCache.get(key)!);
			});
			const evictCache = new LRUCache<string>({ onEvict });
			evictCache.set('key1', 'value1');
			evictCache.set('key2', 'value2');
			evictCache.clear();
			expect(inspected).toEqual(['value1', 'value2']);
			expect(evictCache.getSize()).toBe(0);
			expect(evictCache.getMemoryUsage()).toBe(0);
		});

		it('should call onEvict when item is evicted', () => {
			const onEvict = jest.fn();
			const evictCache = new LRUCache({
				maxEntries: 2,
				onEvict,
			});

			evictCache.set('key1', 'value1');
			evictCache.set('key2', 'value2');
			evictCache.set('key3', 'value3');

			expect(onEvict).toHaveBeenCalledWith('key1', 'value1');
		});

		it('should call onEvict on clear', () => {
			const onEvict = jest.fn();
			const evictCache = new LRUCache({ onEvict });

			evictCache.set('key1', 'value1');
			evictCache.set('key2', 'value2');
			evictCache.clear();

			expect(onEvict).toHaveBeenCalledTimes(2);
		});
	});
});

describe('CacheKeys', () => {
	// Keys hash their components (bounded length, safe characters), so assert the
	// real contract: correct prefix, deterministic, and distinct inputs -> distinct keys.
	it('builds a prefixed, deterministic document key', () => {
		const key = CacheKeys.document('proj1', 'doc1');
		expect(key).toMatch(/^doc:/);
		expect(CacheKeys.document('proj1', 'doc1')).toBe(key);
		expect(CacheKeys.document('proj1', 'doc2')).not.toBe(key);
	});

	it('builds a prefixed, deterministic analysis key', () => {
		const key = CacheKeys.analysis('doc1', 'sentiment');
		expect(key).toMatch(/^analysis:/);
		expect(CacheKeys.analysis('doc1', 'sentiment')).toBe(key);
		expect(CacheKeys.analysis('doc1', 'style')).not.toBe(key);
	});

	it('builds a prefixed, deterministic query key', () => {
		const key = CacheKeys.query('SELECT *', 'param1');
		expect(key).toMatch(/^query:/);
		expect(CacheKeys.query('SELECT *', 'param1')).toBe(key);
		expect(CacheKeys.query('SELECT *', 'param2')).not.toBe(key);
	});

	it('builds a prefixed structure key that varies by folder', () => {
		const projectKey = CacheKeys.structure('proj1');
		expect(projectKey).toMatch(/^structure:/);
		expect(CacheKeys.structure('proj1')).toBe(projectKey);
		expect(CacheKeys.structure('proj1', 'folder1')).not.toBe(projectKey);
	});
});
