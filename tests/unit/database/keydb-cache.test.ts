/**
 * Tests for KeyDB Cache Layer
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { KeyDBCache, CachedSQLiteManager } from '../../../src/database/keydb-cache';
import * as keydbDetector from '../../../src/services/queue/keydb-detector';
import { Redis } from 'ioredis';

// Mock dependencies
jest.mock('../../../src/services/queue/keydb-detector');
jest.mock('ioredis');

describe('KeyDBCache', () => {
	let cache: KeyDBCache;
	let mockClient: any;
	let detectConnectionMock: any;
	let createBullMQConnectionMock: any;

	beforeEach(() => {
		// Setup mocks
		detectConnectionMock = keydbDetector.detectConnection as any;
		createBullMQConnectionMock = keydbDetector.createBullMQConnection as any;

		// Mock Redis client
		mockClient = {
			ping: jest.fn().mockResolvedValue('PONG'),
			get: jest.fn(),
			setex: jest.fn().mockResolvedValue('OK'),
			del: jest.fn(),
			keys: jest.fn(),
			scan: jest.fn(),
			quit: jest.fn().mockResolvedValue('OK'),
		} as any;

		// Setup default mock responses
		createBullMQConnectionMock.mockReturnValue(mockClient);
		
		// Create cache instance
		cache = new KeyDBCache({ prefix: 'test:', ttl: 60 });
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('initialization', () => {
		it('should initialize with KeyDB when available', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});

			const result = await cache.initialize();

			expect(result).toBe(true);
			expect(detectConnectionMock).toHaveBeenCalled();
			expect(createBullMQConnectionMock).toHaveBeenCalledWith('redis://localhost:6379');
			expect(mockClient.ping).toHaveBeenCalled();
			expect(cache.isAvailable()).toBe(true);
		});

		it('should handle initialization failure gracefully', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			const result = await cache.initialize();

			expect(result).toBe(false);
			expect(cache.isAvailable()).toBe(false);
		});

		it('should retry connection on failure', async () => {
			detectConnectionMock.mockRejectedValueOnce(new Error('Connection failed'))
				.mockResolvedValueOnce({
					isAvailable: true,
					type: 'redis',
					url: 'redis://localhost:6379',
					version: '7.0.0',
				});

			const result = await cache.initialize();

			expect(result).toBe(true);
			expect(detectConnectionMock).toHaveBeenCalledTimes(2);
		});
	});

	describe('get operation', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});
			await cache.initialize();
		});

		it('should return cached value when exists', async () => {
			const testData = { id: 1, name: 'Test' };
			mockClient.get.mockResolvedValue(JSON.stringify(testData));

			const result = await cache.get('test-key');

			expect(result).toEqual(testData);
			expect(mockClient.get).toHaveBeenCalledWith('test:test-key');
		});

		it('should return null for cache miss', async () => {
			mockClient.get.mockResolvedValue(null);

			const result = await cache.get('non-existent');

			expect(result).toBeNull();
			expect(mockClient.get).toHaveBeenCalledWith('test:non-existent');
		});

		it('should track cache statistics', async () => {
			mockClient.get.mockResolvedValueOnce(JSON.stringify({ data: 'hit' }))
				.mockResolvedValueOnce(null);

			await cache.get('hit-key');
			await cache.get('miss-key');

			const stats = cache.getStats();
			expect(stats.hits).toBe(1);
			expect(stats.misses).toBe(1);
			expect(stats.hitRate).toBe(0.5);
		});
	});

	describe('set operation', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});
			await cache.initialize();
		});

		it('should cache value with default TTL', async () => {
			const testData = { id: 1, name: 'Test' };

			const result = await cache.set('test-key', testData);

			expect(result).toBe(true);
			expect(mockClient.setex).toHaveBeenCalledWith(
				'test:test-key',
				60,
				JSON.stringify(testData)
			);
		});

		it('should cache value with custom TTL', async () => {
			const testData = { id: 1, name: 'Test' };

			const result = await cache.set('test-key', testData, 300);

			expect(result).toBe(true);
			expect(mockClient.setex).toHaveBeenCalledWith(
				'test:test-key',
				300,
				JSON.stringify(testData)
			);
		});

		it('should retry on transient failures', async () => {
			mockClient.setex.mockRejectedValueOnce(new Error('Temporary failure'))
				.mockResolvedValueOnce('OK');

			const result = await cache.set('test-key', { data: 'test' });

			expect(result).toBe(true);
			expect(mockClient.setex).toHaveBeenCalledTimes(2);
		});
	});

	describe('delete operation', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});
			await cache.initialize();
		});

		it('should delete cached value', async () => {
			mockClient.del.mockResolvedValue(1);

			const result = await cache.del('test-key');

			expect(result).toBe(true);
			expect(mockClient.del).toHaveBeenCalledWith('test:test-key');
		});

		it('should return false when key not found', async () => {
			mockClient.del.mockResolvedValue(0);

			const result = await cache.del('non-existent');

			expect(result).toBe(false);
		});
	});

	describe('invalidate operation', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});
			await cache.initialize();
		});

		it('should invalidate keys matching pattern', async () => {
			// Mock SCAN operation
			mockClient.scan.mockResolvedValueOnce(['1', ['test:users:1', 'test:users:2']])
				.mockResolvedValueOnce(['0', ['test:users:3']]);
			mockClient.del.mockResolvedValue(3);

			const result = await cache.invalidate('users:*');

			expect(result).toBe(3);
			expect(mockClient.scan).toHaveBeenCalledWith(
				'0', 'MATCH', 'test:users:*', 'COUNT', 100
			);
		});

		it('should handle large key sets with batching', async () => {
			// Create 250 keys
			const keys = Array.from({ length: 250 }, (_, i) => `test:item:${i}`);
			
			mockClient.scan.mockResolvedValueOnce(['1', keys.slice(0, 100)])
				.mockResolvedValueOnce(['2', keys.slice(100, 200)])
				.mockResolvedValueOnce(['0', keys.slice(200)]);
			
			// Each batch deletion returns the count
			mockClient.del.mockResolvedValueOnce(100)
				.mockResolvedValueOnce(100)
				.mockResolvedValueOnce(50);

			const result = await cache.invalidate('item:*');

			expect(result).toBe(250);
			expect(mockClient.del).toHaveBeenCalledTimes(3);
		});
	});

	describe('getOrSet operation', () => {
		beforeEach(async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});
			await cache.initialize();
		});

		it('should return cached value if exists', async () => {
			const cachedData = { id: 1, name: 'Cached' };
			mockClient.get.mockResolvedValue(JSON.stringify(cachedData));

			const fetchFn = jest.fn().mockResolvedValue({ id: 1, name: 'Fresh' });
			const result = await cache.getOrSet('test-key', fetchFn);

			expect(result).toEqual(cachedData);
			expect(fetchFn).not.toHaveBeenCalled();
		});

		it('should fetch and cache if not exists', async () => {
			const freshData = { id: 1, name: 'Fresh' };
			mockClient.get.mockResolvedValue(null);

			const fetchFn = jest.fn().mockResolvedValue(freshData);
			const result = await cache.getOrSet('test-key', fetchFn, 120);

			expect(result).toEqual(freshData);
			expect(fetchFn).toHaveBeenCalled();
			expect(mockClient.setex).toHaveBeenCalledWith(
				'test:test-key',
				120,
				JSON.stringify(freshData)
			);
		});
	});

	describe('close operation', () => {
		it('should close connection gracefully', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				url: 'redis://localhost:6379',
				version: '6.3.4',
			});
			await cache.initialize();

			await cache.close();

			expect(mockClient.quit).toHaveBeenCalled();
			expect(cache.isAvailable()).toBe(false);
		});
	});
});

describe('CachedSQLiteManager', () => {
	let cachedManager: CachedSQLiteManager;
	let mockSqliteManager: any;
	let mockCache: any;

	beforeEach(() => {
		// Mock SQLite manager
		mockSqliteManager = {
			query: jest.fn(),
			queryOne: jest.fn(),
			execute: jest.fn(),
			transaction: jest.fn(),
		};

		// Create cached manager
		cachedManager = new CachedSQLiteManager(mockSqliteManager);

		// Access private cache property for testing
		mockCache = (cachedManager as any).cache as jest.Mocked<KeyDBCache>;
	});

	describe('cached query', () => {
		it('should use cache when available', async () => {
			jest.spyOn(mockCache, 'isAvailable').mockReturnValue(true);
			jest.spyOn(mockCache, 'getOrSet').mockResolvedValue([{ id: 1 }]);

			const result = await cachedManager.query('SELECT * FROM users', []);

			expect(result).toEqual([{ id: 1 }]);
			expect(mockCache.getOrSet).toHaveBeenCalled();
			expect(mockSqliteManager.query).not.toHaveBeenCalled();
		});

		it('should bypass cache when unavailable', async () => {
			jest.spyOn(mockCache, 'isAvailable').mockReturnValue(false);
			mockSqliteManager.query.mockResolvedValue([{ id: 1 }]);

			const result = await cachedManager.query('SELECT * FROM users', []);

			expect(result).toEqual([{ id: 1 }]);
			expect(mockSqliteManager.query).toHaveBeenCalledWith('SELECT * FROM users', []);
		});
	});

	describe('execute with cache invalidation', () => {
		it('should invalidate cache after write operations', async () => {
			jest.spyOn(mockCache, 'isAvailable').mockReturnValue(true);
			jest.spyOn(mockCache, 'invalidate').mockResolvedValue(5);
			mockSqliteManager.execute.mockReturnValue({ changes: 1 });

			const result = await cachedManager.execute(
				'UPDATE users SET name = ? WHERE id = ?',
				['John', 1]
			);

			expect(result).toEqual({ changes: 1 });
			expect(mockCache.invalidate).toHaveBeenCalledWith('*:users:*');
			expect(mockCache.invalidate).toHaveBeenCalledWith('query:*users*');
		});
	});

	describe('transaction handling', () => {
		it('should invalidate all cache after transaction', () => {
			jest.spyOn(mockCache, 'isAvailable').mockReturnValue(true);
			jest.spyOn(mockCache, 'invalidate').mockResolvedValue(10);
			
			const transactionFn = jest.fn().mockReturnValue('result');
			mockSqliteManager.transaction.mockReturnValue('result');

			const result = cachedManager.transaction(transactionFn);

			expect(result).toBe('result');
			expect(mockSqliteManager.transaction).toHaveBeenCalledWith(transactionFn, undefined);
			
			// Cache invalidation happens asynchronously
			setTimeout(() => {
				expect(mockCache.invalidate).toHaveBeenCalledWith('*');
			}, 0);
		});
	});
});