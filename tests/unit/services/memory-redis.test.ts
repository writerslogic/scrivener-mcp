/**
 * Unit tests for in-memory Redis implementation
 */

import { MemoryRedis } from '../../../src/services/queue/memory-redis.js';
import * as fs from 'fs/promises';

describe('MemoryRedis', () => {
  let redis: MemoryRedis;

  beforeEach(async () => {
    redis = new MemoryRedis({ persistPath: './test-memory-redis.json' });
    await redis.connect();
  });

  afterEach(async () => {
    await redis.disconnect();
    try {
      await fs.unlink('./test-memory-redis.json');
    } catch {
      // Ignore if doesn't exist
    }
  });

  describe('String operations', () => {
    it('should set and get values', async () => {
      await redis.set('key', 'value');
      const result = await redis.get('key');
      expect(result).toBe('value');
    });

    it('should return null for non-existent keys', async () => {
      const result = await redis.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should delete keys', async () => {
      await redis.set('key', 'value');
      const deleted = await redis.del('key');
      expect(deleted).toBe(1);
      const result = await redis.get('key');
      expect(result).toBeNull();
    });

    it('should handle expiry', async () => {
      await redis.set('key', 'value', 'EX', 1);
      let result = await redis.get('key');
      expect(result).toBe('value');
      
      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 1100));
      result = await redis.get('key');
      expect(result).toBeNull();
    });
  });

  describe('List operations', () => {
    it('should push and pop from lists', async () => {
      await redis.lpush('list', 'item1', 'item2');
      const length = await redis.llen('list');
      expect(length).toBe(2);

      const item = await redis.rpop('list');
      expect(item).toBe('item1');
    });

    it('should get list range', async () => {
      await redis.rpush('list', 'a', 'b', 'c', 'd');
      const range = await redis.lrange('list', 1, 2);
      expect(range).toEqual(['b', 'c']);
    });

    it('should remove items from list', async () => {
      await redis.rpush('list', 'a', 'b', 'a', 'c');
      const removed = await redis.lrem('list', 0, 'a');
      expect(removed).toBe(2);
      const range = await redis.lrange('list', 0, -1);
      expect(range).toEqual(['b', 'c']);
    });
  });

  describe('Hash operations', () => {
    it('should set and get hash fields', async () => {
      await redis.hset('hash', 'field', 'value');
      const result = await redis.hget('hash', 'field');
      expect(result).toBe('value');
    });

    it('should get all hash fields', async () => {
      await redis.hset('hash', 'field1', 'value1');
      await redis.hset('hash', 'field2', 'value2');
      const result = await redis.hgetall('hash');
      expect(result).toEqual({
        field1: 'value1',
        field2: 'value2'
      });
    });

    it('should delete hash fields', async () => {
      await redis.hset('hash', 'field1', 'value1');
      await redis.hset('hash', 'field2', 'value2');
      const deleted = await redis.hdel('hash', 'field1');
      expect(deleted).toBe(1);
      const result = await redis.hget('hash', 'field1');
      expect(result).toBeNull();
    });
  });

  describe('Set operations', () => {
    it('should add and remove set members', async () => {
      const added = await redis.sadd('set', 'a', 'b', 'c');
      expect(added).toBe(3);

      const members = await redis.smembers('set');
      expect(members).toContain('a');
      expect(members).toContain('b');
      expect(members).toContain('c');

      const removed = await redis.srem('set', 'b');
      expect(removed).toBe(1);

      const size = await redis.scard('set');
      expect(size).toBe(2);
    });
  });

  describe('Sorted set operations', () => {
    it('should add and range sorted sets', async () => {
      await redis.zadd('zset', 1, 'a', 2, 'b', 3, 'c');
      const range = await redis.zrange('zset', 0, -1);
      expect(range).toEqual(['a', 'b', 'c']);
    });

    it('should return scores with WITHSCORES', async () => {
      await redis.zadd('zset', 1.5, 'a', 2.5, 'b');
      const range = await redis.zrange('zset', 0, -1, 'WITHSCORES');
      expect(range).toEqual(['a', '1.5', 'b', '2.5']);
    });

    it('should remove from sorted sets', async () => {
      await redis.zadd('zset', 1, 'a', 2, 'b', 3, 'c');
      const removed = await redis.zrem('zset', 'b');
      expect(removed).toBe(1);
      const range = await redis.zrange('zset', 0, -1);
      expect(range).toEqual(['a', 'c']);
    });
  });

  describe('Persistence', () => {
    it('should persist and restore data', async () => {
      const persistPath = './test-persist-unique.json';
      
      // Clean up any existing file first
      try {
        await fs.unlink(persistPath);
      } catch {
        // Ignore if doesn't exist
      }
      
      // First session
      const redis1 = new MemoryRedis({ persistPath });
      await redis1.connect();
      await redis1.set('key', 'value');
      await redis1.lpush('list', 'item');
      await redis1.hset('hash', 'field', 'value');
      await redis1.sadd('set', 'member');
      await redis1.disconnect();

      // Check file was created
      const fileExists = await fs.access(persistPath).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);

      // Second session
      const redis2 = new MemoryRedis({ persistPath });
      await redis2.connect();
      
      expect(await redis2.get('key')).toBe('value');
      expect(await redis2.llen('list')).toBe(1);
      expect(await redis2.hget('hash', 'field')).toBe('value');
      expect(await redis2.scard('set')).toBe(1);
      
      await redis2.disconnect();
      await fs.unlink(persistPath);
    });
  });

  describe('Utility operations', () => {
    it('should ping', async () => {
      const result = await redis.ping();
      expect(result).toBe('PONG');
    });

    it('should flush database', async () => {
      await redis.set('key1', 'value1');
      await redis.set('key2', 'value2');
      await redis.flushdb();
      
      expect(await redis.get('key1')).toBeNull();
      expect(await redis.get('key2')).toBeNull();
    });

    it('should list keys', async () => {
      await redis.set('user:1', 'Alice');
      await redis.set('user:2', 'Bob');
      await redis.set('post:1', 'Hello');
      
      const userKeys = await redis.keys('user:*');
      expect(userKeys).toHaveLength(2);
      expect(userKeys).toContain('user:1');
      expect(userKeys).toContain('user:2');
      
      const allKeys = await redis.keys('*');
      expect(allKeys).toHaveLength(3);
    });
  });
});