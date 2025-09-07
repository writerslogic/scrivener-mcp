/**
 * Cache system tests
 */

import { LRUCache, CacheKeys, cached } from '../../../src/core/cache';

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
			
			await new Promise(resolve => setTimeout(resolve, 60));
			
			expect(shortCache.get('key1')).toBeUndefined();
		});
		
		it('should use custom TTL', async () => {
			cache.set('key1', 'value1', 50);
			
			expect(cache.get('key1')).toBe('value1');
			
			await new Promise(resolve => setTimeout(resolve, 60));
			
			expect(cache.get('key1')).toBeUndefined();
		});
		
		it('should clean expired entries', async () => {
			const shortCache = new LRUCache({ ttl: 10 }); // 10ms TTL
			shortCache.set('key1', 'value1');
			shortCache.set('key2', 'value2');
			
			// Wait for entries to expire
			await new Promise(resolve => setTimeout(resolve, 15));
			
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
	});
	
	describe('size limits', () => {
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
	it('should build document key', () => {
		const key = CacheKeys.document('proj1', 'doc1');
		expect(key).toBe('doc:proj1:doc1');
	});
	
	it('should build analysis key', () => {
		const key = CacheKeys.analysis('doc1', 'sentiment');
		expect(key).toBe('analysis:doc1:sentiment');
	});
	
	it('should build query key', () => {
		const key = CacheKeys.query('SELECT *', 'param1');
		expect(key).toBe('query:SELECT *:param1');
	});
	
	it('should build structure key', () => {
		expect(CacheKeys.structure('proj1')).toBe('structure:proj1');
		expect(CacheKeys.structure('proj1', 'folder1')).toBe('structure:proj1:folder1');
	});
});

