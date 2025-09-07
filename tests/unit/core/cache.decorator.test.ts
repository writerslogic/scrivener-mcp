/**
 * Tests for the @cached decorator
 */

import { LRUCache, cached } from '../../../src/core/cache';

describe('cached decorator', () => {
	it('should cache method results', async () => {
		const testCache = new LRUCache<string>({ ttl: 1000 });
		
		class TestService {
			callCount = 0;
			
			@cached(
				(id: string) => `test:${id}`,
				testCache
			)
			async getData(id: string): Promise<string> {
				this.callCount++;
				return `data-${id}`;
			}
		}
		
		const service = new TestService();
		
		const result1 = await service.getData('1');
		const result2 = await service.getData('1');
		
		expect(result1).toBe('data-1');
		expect(result2).toBe('data-1');
		expect(service.callCount).toBe(1); // Should only call once due to cache
	});
	
	it('should use different keys for different args', async () => {
		const testCache = new LRUCache<string>({ ttl: 1000 });
		
		class TestService {
			callCount = 0;
			
			@cached(
				(id: string) => `test:${id}`,
				testCache
			)
			async getData(id: string): Promise<string> {
				this.callCount++;
				return `data-${id}`;
			}
		}
		
		const service = new TestService();
		
		const result1 = await service.getData('1');
		const result2 = await service.getData('2');
		
		expect(result1).toBe('data-1');
		expect(result2).toBe('data-2');
		expect(service.callCount).toBe(2); // Should call twice for different args
	});
	
	it('should respect TTL expiration', async () => {
		const testCache = new LRUCache<string>({ ttl: 50 }); // 50ms TTL
		
		class TestService {
			callCount = 0;
			
			@cached(
				(id: string) => `test:${id}`,
				testCache
			)
			async getData(id: string): Promise<string> {
				this.callCount++;
				return `data-${id}-${this.callCount}`;
			}
		}
		
		const service = new TestService();
		
		const result1 = await service.getData('1');
		expect(result1).toBe('data-1-1');
		expect(service.callCount).toBe(1);
		
		// Wait for cache to expire
		await new Promise(resolve => setTimeout(resolve, 60));
		
		const result2 = await service.getData('1');
		expect(result2).toBe('data-1-2');
		expect(service.callCount).toBe(2); // Should call again after expiration
	});
	
	it('should work with multiple parameters', async () => {
		const testCache = new LRUCache<string>({ ttl: 1000 });
		
		class TestService {
			callCount = 0;
			
			@cached(
				(a: string, b: number) => `test:${a}:${b}`,
				testCache
			)
			async getData(a: string, b: number): Promise<string> {
				this.callCount++;
				return `data-${a}-${b}`;
			}
		}
		
		const service = new TestService();
		
		const result1 = await service.getData('a', 1);
		const result2 = await service.getData('a', 1);
		const result3 = await service.getData('a', 2);
		const result4 = await service.getData('b', 1);
		
		expect(result1).toBe('data-a-1');
		expect(result2).toBe('data-a-1');
		expect(result3).toBe('data-a-2');
		expect(result4).toBe('data-b-1');
		expect(service.callCount).toBe(3); // 3 unique combinations
	});
	
	it('should work with default cache', async () => {
		class TestService {
			callCount = 0;
			
			@cached((id: string) => `test:${id}`)
			async getData(id: string): Promise<string> {
				this.callCount++;
				return `data-${id}`;
			}
		}
		
		const service = new TestService();
		
		const result1 = await service.getData('1');
		const result2 = await service.getData('1');
		
		expect(result1).toBe('data-1');
		expect(result2).toBe('data-1');
		expect(service.callCount).toBe(1); // Should use default cache
	});
});