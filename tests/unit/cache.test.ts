/**
 * Unit tests for cache implementation
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { LRUCache } from '../../src/core/cache.js';

describe('LRUCache', () => {
	let cache: LRUCache<string>;

	beforeEach(() => {
		cache = new LRUCache<string>({ maxSize: 1000 }); // 1KB for testing
	});

	describe('Basic Operations', () => {
		it('should set and get values', () => {
			cache.set('key1', 'value1');
			expect(cache.get('key1')).toBe('value1');
		});

		it('should return undefined for non-existent keys', () => {
			expect(cache.get('nonexistent')).toBeUndefined();
		});

		it('should check if key exists', () => {
			cache.set('key1', 'value1');
			expect(cache.has('key1')).toBe(true);
			expect(cache.has('key2')).toBe(false);
		});

		it('should delete values', () => {
			cache.set('key1', 'value1');
			expect(cache.has('key1')).toBe(true);
			
			cache.delete('key1');
			expect(cache.has('key1')).toBe(false);
			expect(cache.get('key1')).toBeUndefined();
		});

		it('should clear all values', () => {
			cache.set('key1', 'value1');
			cache.set('key2', 'value2');
			expect(cache.getSize()).toBe(2);
			
			cache.clear();
			expect(cache.getSize()).toBe(0);
			expect(cache.get('key1')).toBeUndefined();
			expect(cache.get('key2')).toBeUndefined();
		});
	});

	describe('LRU Eviction', () => {
		it('should evict least recently used items when size limit exceeded', () => {
			// Create cache with small size limit
			const smallCache = new LRUCache<string>({ maxSize: 100 }); // 100 bytes
			
			// Add items that together exceed the limit (strings are 2 bytes per char)
			smallCache.set('a', 'x'.repeat(20)); // 40 bytes
			smallCache.set('b', 'y'.repeat(20)); // 40 bytes
			smallCache.set('c', 'z'.repeat(20)); // 40 bytes - should evict 'a'
			
			expect(smallCache.has('a')).toBe(false); // 'a' should be evicted
			expect(smallCache.has('b')).toBe(true);
			expect(smallCache.has('c')).toBe(true);
		});

		it('should update LRU order on get', () => {
			const smallCache = new LRUCache<string>({ maxSize: 100 });
			
			smallCache.set('a', 'x'.repeat(15)); // 30 bytes
			smallCache.set('b', 'y'.repeat(15)); // 30 bytes
			
			// Access 'a' to make it most recently used
			smallCache.get('a');
			
			// Add 'c' which should evict 'b' (least recently used)
			smallCache.set('c', 'z'.repeat(25)); // 50 bytes
			
			expect(smallCache.has('a')).toBe(true); // 'a' was accessed
			expect(smallCache.has('b')).toBe(false); // 'b' should be evicted
			expect(smallCache.has('c')).toBe(true);
		});

		it('should update LRU order on set (update)', () => {
			const smallCache = new LRUCache<string>({ maxSize: 100 });
			
			smallCache.set('a', 'x'.repeat(15)); // 30 bytes
			smallCache.set('b', 'y'.repeat(15)); // 30 bytes
			
			// Update 'a' to make it most recently used
			smallCache.set('a', 'x'.repeat(12)); // 24 bytes
			
			// Add 'c' which should evict 'b'
			smallCache.set('c', 'z'.repeat(25)); // 50 bytes
			
			expect(smallCache.has('a')).toBe(true);
			expect(smallCache.has('b')).toBe(false);
			expect(smallCache.has('c')).toBe(true);
		});
	});

	describe('Size Management', () => {
		it('should track cache size correctly', () => {
			expect(cache.getSize()).toBe(0);
			
			cache.set('key1', 'value1');
			expect(cache.getSize()).toBe(1);
			
			cache.set('key2', 'value2');
			expect(cache.getSize()).toBe(2);
			
			cache.delete('key1');
			expect(cache.getSize()).toBe(1);
		});

		it('should calculate memory usage', () => {
			const initialMemory = cache.getMemoryUsage();
			
			cache.set('key1', 'a'.repeat(100));
			const afterAdd = cache.getMemoryUsage();
			
			// Memory should increase by approximately 100 bytes (plus key overhead)
			expect(afterAdd).toBeGreaterThan(initialMemory + 100);
		});

		it('should handle different value types', () => {
			cache.set('string', 'test');
			cache.set('number', '123');
			cache.set('object', JSON.stringify({ a: 1, b: 2 }));
			cache.set('array', JSON.stringify([1, 2, 3]));
			
			expect(cache.get('string')).toBe('test');
			expect(cache.get('number')).toBe('123');
			expect(JSON.parse(cache.get('object')!)).toEqual({ a: 1, b: 2 });
			expect(JSON.parse(cache.get('array')!)).toEqual([1, 2, 3]);
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty string values', () => {
			cache.set('empty', '');
			expect(cache.get('empty')).toBe('');
			expect(cache.has('empty')).toBe(true);
		});

		it('should handle very large values', () => {
			// Test with a larger cache for this test (10000 chars * 2 bytes = 20000 bytes)
			const largeCache = new LRUCache<string>({ maxSize: 25000 });
			const largeValue = 'x'.repeat(10000);
			largeCache.set('large', largeValue);
			expect(largeCache.get('large')).toBe(largeValue);
		});

		it('should handle rapid set/get operations', () => {
			// Test with a larger cache to hold 100 items
			const largeCache = new LRUCache<string>({ maxSize: 10000, maxEntries: 100 });
			for (let i = 0; i < 100; i++) {
				largeCache.set(`key${i}`, `value${i}`);
			}
			
			for (let i = 0; i < 100; i++) {
				expect(largeCache.get(`key${i}`)).toBe(`value${i}`);
			}
		});

		it('should handle special characters in keys', () => {
			const specialKeys = [
				'key with spaces',
				'key/with/slashes',
				'key.with.dots',
				'key-with-dashes',
				'key_with_underscores',
				'🔑',
			];
			
			specialKeys.forEach((key) => {
				cache.set(key, 'value');
				expect(cache.get(key)).toBe('value');
			});
		});
	});

	describe('Statistics', () => {
		it('should provide cache statistics', () => {
			cache.set('a', 'value1');
			cache.set('b', 'value2');
			cache.set('c', 'value3');
			
			// Access some values
			cache.get('a'); // hit
			cache.get('b'); // hit
			cache.get('nonexistent'); // miss
			
			const stats = {
				size: cache.getSize(),
				memoryUsage: cache.getMemoryUsage(),
				maxSize: 1000,
			};
			
			expect(stats.size).toBe(3);
			expect(stats.memoryUsage).toBeGreaterThan(0);
			expect(stats.memoryUsage).toBeLessThanOrEqual(stats.maxSize);
		});
	});
});