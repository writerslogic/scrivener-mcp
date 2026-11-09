import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import * as detector from '../../src/services/queue/keydb-detector.js';
import {
	KeyDBCache,
	MAX_CACHE_ENTRY_BYTES,
	type CacheOptions,
} from '../../src/handlers/database/keydb-cache.js';
import { SQLiteManager } from '../../src/handlers/database/sqlite-manager.js';

jest.mock('ioredis', () => ({ Redis: jest.fn() }));

class CacheConnection extends EventEmitter {
	status = 'ready';
	entries = new Map<string, string>();
	connect = jest.fn(async () => {
		this.status = 'ready';
	});
	ping = jest.fn(async () => 'PONG');
	get = jest.fn(async (key: string) => this.entries.get(key) ?? null);
	getrangeBuffer = jest.fn(async (key: string, start: number, end: number) =>
		Buffer.from(this.entries.get(key) ?? '').subarray(start, end + 1)
	);
	setex = jest.fn(async (key: string, _ttl: number, value: string) => {
		this.entries.set(key, value);
		return 'OK';
	});
	del = jest.fn(async (...keys: string[]) =>
		keys.reduce((n, key) => n + Number(this.entries.delete(key)), 0)
	);
	scan = jest.fn(async (): Promise<[string, string[]]> => ['0', [...this.entries.keys()]]);
	quit = jest.fn(async () => {
		this.status = 'end';
		return 'OK';
	});
	disconnect = jest.fn(() => {
		this.status = 'end';
	});
}

describe('optional query cache with real SQLite', () => {
	let root: string;
	let sqlite: SQLiteManager;
	let connections: CacheConnection[];
	let connection: CacheConnection;
	let caches: KeyDBCache[];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'scrivener-cache-'));
		sqlite = new SQLiteManager(join(root, 'database.sqlite'));
		connections = [];
		caches = [];
		connection = new CacheConnection();
		jest.mocked(Redis).mockImplementation(() => {
			const next = connections.length ? new CacheConnection() : connection;
			connections.push(next);
			return next as unknown as Redis;
		});
		jest.spyOn(detector, 'detectConnection').mockResolvedValue({
			type: 'redis',
			url: 'redis://127.0.0.1:6379',
			isAvailable: true,
		});
	});

	afterEach(async () => {
		await sqlite.close();
		for (const cache of caches) await cache.close();
		await rm(root, { recursive: true, force: true });
		jest.restoreAllMocks();
		jest.mocked(Redis).mockReset();
	});

	function cache(options?: CacheOptions) {
		const value = new KeyDBCache(options);
		caches.push(value);
		return value;
	}

	it('releases a failed connection and keeps SQLite available', async () => {
		connection.ping.mockRejectedValue(new Error('Unavailable'));
		await expect(sqlite.initialize()).resolves.toBeUndefined();
		expect(sqlite.queryOne('SELECT 42 AS answer')).toEqual({ answer: 42 });
		expect(sqlite.isCachingAvailable()).toBe(false);
		expect(connection.disconnect).toHaveBeenCalledTimes(1);
	});

	it('keeps SQLite available when connection detection fails', async () => {
		jest.mocked(detector.detectConnection).mockRejectedValue(new Error('Discovery failed'));
		await sqlite.initialize();
		expect(await sqlite.getCachedManager()!.query('SELECT 42 AS answer')).toEqual([
			{ answer: 42 },
		]);
		expect(sqlite.isCachingAvailable()).toBe(false);
		expect(connections).toHaveLength(0);
	});

	it('shares one connection across concurrent and repeated initialization, then closes it', async () => {
		const instance = cache();
		expect(await Promise.all([instance.initialize(), instance.initialize()])).toEqual([
			true,
			true,
		]);
		await instance.initialize();
		expect(connections).toHaveLength(1);
		await Promise.all([instance.close(), instance.close()]);
		expect(connections.every((client) => client.status === 'end')).toBe(true);
		expect(connection.quit).toHaveBeenCalledTimes(1);
	});

	it('orders close and reopen behind an admitted initialization', async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		connection.ping.mockImplementationOnce(async () => {
			await blocked;
			return 'PONG';
		});
		const instance = cache();
		const first = instance.initialize();
		const closing = instance.close();
		const reopening = instance.initialize();
		release();
		await Promise.all([first, closing, reopening]);
		expect(connections).toHaveLength(2);
		expect(connections[0].status).toBe('end');
		expect(connections[1].status).toBe('ready');
		expect(await instance.set('after-reopen', { value: 1 })).toBe(true);
	});

	it.each(['read', 'write'] as const)(
		'returns authoritative SQLite data when cache %s fails',
		async (operation) => {
			await sqlite.initialize();
			if (operation === 'read') {
				connection.get.mockRejectedValue(new Error('Disconnected'));
				connection.getrangeBuffer.mockRejectedValue(new Error('Disconnected'));
			} else connection.setex.mockRejectedValue(new Error('Disconnected'));
			const cached = sqlite.getCachedManager()!;
			expect(await cached.queryOne('SELECT 42 AS answer')).toEqual({ answer: 42 });
			expect(await cached.query('SELECT 43 AS answer')).toEqual([{ answer: 43 }]);
			expect(connection.disconnect).toHaveBeenCalledTimes(1);
		}
	);

	it('retains SQLite BLOB bytes and their Buffer type on cache hits', async () => {
		await sqlite.initialize();
		const query = jest.spyOn(sqlite, 'query');
		const cached = sqlite.getCachedManager()!;
		const bytes = Buffer.from([0, 1, 127, 128, 255]);
		for (let i = 0; i < 2; i++) {
			const rows = await cached.query('SELECT ? AS payload', [bytes]);
			expect(rows).toEqual([{ payload: bytes }]);
			expect(Buffer.isBuffer((rows[0] as { payload: Buffer }).payload)).toBe(true);
		}
		expect(query).toHaveBeenCalledTimes(1);
	});

	it('retains safe integers in cached rows and generation keys', async () => {
		await sqlite.initialize();
		const db = sqlite.getDatabase();
		const prepare = db.prepare.bind(db);
		Object.defineProperty(db, 'prepare', {
			configurable: true,
			value: (sql: string) => {
				const statement = prepare(sql);
				statement.setReadBigInts(true);
				return statement;
			},
		});
		const query = jest.spyOn(sqlite, 'queryOne');
		const cached = sqlite.getCachedManager()!;
		const value = 9007199254740993n;
		for (let i = 0; i < 2; i++)
			expect(await cached.queryOne('SELECT ? AS value', [value])).toEqual({ value });
		expect(query).toHaveBeenCalledTimes(1);
	});

	it('preserves authoritative errors rather than returning a successful empty result', async () => {
		await sqlite.initialize();
		await expect(sqlite.getCachedManager()!.query('SELECT * FROM nonexistent')).rejects.toThrow(
			'no such table'
		);
	});

	it('disconnects even if graceful shutdown fails, then permits a fresh connection', async () => {
		const instance = cache();
		await instance.initialize();
		connection.quit.mockRejectedValue(new Error('Disconnected'));
		await instance.close();
		expect(connection.disconnect).toHaveBeenCalledTimes(1);
		await instance.initialize();
		expect(await instance.set('fresh', 'value')).toBe(true);
		expect(connections).toHaveLength(2);
	});

	it('does not use a connection before its ping succeeds', async () => {
		let entered!: () => void, release!: () => void;
		const pingStarted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		connection.ping.mockImplementationOnce(async () => {
			entered();
			await blocked;
			return 'PONG';
		});
		const instance = cache();
		const opening = instance.initialize();
		await pingStarted;
		try {
			expect(await instance.getOrSet('before-ready', async () => 42)).toBe(42);
			expect(connection.setex).not.toHaveBeenCalled();
		} finally {
			release();
			await opening;
		}
		expect(await instance.set('after-ready', 43)).toBe(true);
	});

	it('does not disconnect a new owner when an old read rejects after reopen', async () => {
		const instance = cache();
		await instance.initialize();
		let reject!: (error: Error) => void;
		connection.getrangeBuffer.mockImplementationOnce(
			() =>
				new Promise((_, fail) => {
					reject = fail;
				})
		);
		const pending = instance.get('old');
		await instance.close();
		await instance.initialize();
		reject(new Error('Old connection failed'));
		expect(await pending).toBeNull();
		expect(await instance.set('new', 42)).toBe(true);
		expect(await instance.get('new')).toBe(42);
	});

	it.each([-1, 0, 1])(
		'bounds outgoing and incoming encoded payloads at limit%+i',
		async (offset) => {
			const instance = cache({ serialize: String, deserialize: (value) => value });
			await instance.initialize();
			await instance.set('probe', '');
			const header = connection.entries.get('sqlite:probe')!;
			const value = 'x'.repeat(MAX_CACHE_ENTRY_BYTES + offset - Buffer.byteLength(header));
			expect(await instance.set('payload', value)).toBe(offset <= 0);
			connection.entries.set('sqlite:inbound', header + value);
			expect(await instance.get('inbound')).toBe(offset <= 0 ? value : null);
			expect(
				connection.getrangeBuffer.mock.calls.every(
					([, start, end]) => end - start <= MAX_CACHE_ENTRY_BYTES
				)
			).toBe(true);
		}
	);

	it.each([
		'{"payload":{"type":"Buffer","data":[1]}}',
		'v8-1:!!!!',
		'v8-1:AAAA',
		'v8-1:AA=Z',
		'v8-1:AAA',
	])('refetches malformed or legacy data: %s', async (payload) => {
		const instance = cache();
		await instance.initialize();
		connection.entries.set('sqlite:broken', payload);
		expect(await instance.getOrSet('broken', async () => Buffer.from([255]))).toEqual(
			Buffer.from([255])
		);
		expect(await instance.get('broken')).toEqual(Buffer.from([255]));
	});

	it('returns unsupported source values without storing lossy substitutes', async () => {
		const instance = cache();
		await instance.initialize();
		const value = () => 42;
		expect(await instance.getOrSet('function', async () => value)).toBe(value);
		expect(connection.setex).not.toHaveBeenCalled();
	});

	it('preserves collections, repeated references and non-JSON numeric values', async () => {
		const instance = cache();
		await instance.initialize();
		const shared = { value: 42 };
		const value = {
			first: shared,
			second: shared,
			map: new Map([['a', 1n]]),
			set: new Set([2]),
			date: new Date(0),
			infinity: Infinity,
			negativeZero: -0,
			nan: NaN,
		};
		await instance.set('typed', value);
		const restored = await instance.get<typeof value>('typed');
		expect(restored).toEqual(value);
		expect(restored!.first).toBe(restored!.second);
	});

	it.each([0, -1, 2147483648, NaN, Infinity, 1.5])(
		'rejects invalid TTL %s without writing',
		async (ttl) => {
			expect(() => cache({ ttl })).toThrow(RangeError);
			const instance = cache();
			await instance.initialize();
			await expect(instance.set('key', 1, ttl)).rejects.toThrow(RangeError);
			expect(connection.setex).not.toHaveBeenCalled();
		}
	);

	it.each([1, 2, 2147483646, 2147483647])('uses valid boundary TTL %i', async (ttl) => {
		const instance = cache({ ttl });
		await instance.initialize();
		expect(await instance.set('key', 42)).toBe(true);
		expect(connection.setex.mock.calls[0][1]).toBe(ttl);
	});

	it('requires both custom codec functions and treats codec failures as misses', async () => {
		expect(() => cache({ serialize: String })).toThrow(/both/);
		expect(() => cache({ deserialize: String })).toThrow(/both/);
		const instance = cache({
			serialize: () => {
				throw new Error('Cannot encode');
			},
			deserialize: String,
		});
		await instance.initialize();
		expect(await instance.getOrSet('value', async () => 42)).toBe(42);
		expect(connection.setex).not.toHaveBeenCalled();
	});

	it('deletes scan pages before fetching the next page, including batches above 100 keys', async () => {
		const instance = cache();
		await instance.initialize();
		for (let i = 0; i < 201; i++) await instance.set(`key${i}`, i);
		const keys = [...connection.entries.keys()];
		connection.scan
			.mockResolvedValueOnce(['1', keys.slice(0, 101)])
			.mockImplementationOnce(async () => {
				expect(connection.entries.size).toBe(100);
				return ['0', keys.slice(101)];
			});
		expect(await instance.invalidate('key*')).toBe(201);
		expect(connection.entries.size).toBe(0);
		expect(connection.del.mock.calls.every((args) => args.length <= 100)).toBe(true);
	});

	it.each(['delete', 'scan'] as const)(
		'releases failed %s operations and preserves source fallback',
		async (operation) => {
			const instance = cache();
			await instance.initialize();
			await instance.set('key', 42);
			if (operation === 'delete') {
				connection.del.mockRejectedValue(new Error('Disconnected'));
				expect(await instance.del('key')).toBe(false);
			} else {
				connection.scan.mockRejectedValue(new Error('Disconnected'));
				expect(await instance.invalidate('*')).toBe(0);
			}
			expect(await instance.getOrSet('key', async () => 43)).toBe(43);
			expect(connection.disconnect).toHaveBeenCalledTimes(1);
		}
	);
});
