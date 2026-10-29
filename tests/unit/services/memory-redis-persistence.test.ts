import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRedis } from '../../../src/services/queue/memory-redis.js';
import { AppError, ErrorCode, readJSON, writeJSON } from '../../../src/utils/common.js';

jest.mock('../../../src/utils/common.js', () => {
	const actual = jest.requireActual<typeof import('../../../src/utils/common.js')>(
		'../../../src/utils/common.js'
	);
	return {
		...actual,
		readJSON: jest.fn(actual.readJSON),
		writeJSON: jest.fn(actual.writeJSON),
	};
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((notify) => {
		resolve = notify;
	});
	return { promise, resolve };
}

function persistence(redis: MemoryRedis): { persist(): Promise<void>; persistTail: Promise<void> } {
	return redis as unknown as { persist(): Promise<void>; persistTail: Promise<void> };
}

describe('MemoryRedis persistence reliability', () => {
	const actual = jest.requireActual<typeof import('../../../src/utils/common.js')>(
		'../../../src/utils/common.js'
	);
	const read = readJSON as jest.MockedFunction<typeof readJSON>;
	const write = writeJSON as jest.MockedFunction<typeof writeJSON>;
	let root: string;
	let file: string;
	let redis: MemoryRedis;
	let stores: MemoryRedis[];
	let releases: Array<() => void>;

	function createStore(): MemoryRedis {
		const store = new MemoryRedis({ persistPath: file });
		stores.push(store);
		return store;
	}

	beforeEach(async () => {
		read.mockImplementation(actual.readJSON);
		write.mockImplementation(actual.writeJSON);
		read.mockClear();
		write.mockClear();
		root = await mkdtemp(join(tmpdir(), 'scrivener-redis-persistence-'));
		file = join(root, 'redis.json');
		stores = [];
		releases = [];
		redis = createStore();
	});

	afterEach(async () => {
		for (const release of releases) release();
		read.mockImplementation(actual.readJSON);
		write.mockImplementation(actual.writeJSON);
		for (const store of stores) await store.disconnect();
		jest.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});

	it('serializes multiple waiting saves and drains them before the final shutdown snapshot', async () => {
		await redis.connect();
		await redis.set('revision', 'older');
		const gates = Array.from({ length: 4 }, deferred);
		const started = Array.from({ length: 4 }, deferred);
		releases.push(...gates.map((gate) => gate.resolve));
		let active = 0;
		let peak = 0;
		let writes = 0;
		write.mockImplementation(async (...args) => {
			const index = writes++;
			active++;
			peak = Math.max(peak, active);
			started[index].resolve();
			await gates[index].promise;
			try {
				await actual.writeJSON(...args);
			} finally {
				active--;
			}
		});
		const first = persistence(redis).persist();
		await started[0].promise;
		const second = persistence(redis).persist();
		const third = persistence(redis).persist();
		await redis.set('revision', 'newest');
		const closing = redis.disconnect();
		for (let index = 0; index < gates.length; index++) {
			await started[index].promise;
			gates[index].resolve();
		}
		await Promise.all([first, second, third, closing]);
		expect(peak).toBe(1);
		expect(writes).toBe(4);
		expect(JSON.parse(await readFile(file, 'utf8')).data).toContainEqual([
			'revision',
			'newest',
		]);
	});

	it('reports a failed save and allows already queued persistence to recover', async () => {
		await redis.connect();
		await redis.set('retained', 'value');
		const failure = new Error('Synthetic persistence failure');
		write.mockRejectedValueOnce(failure);
		const failed = persistence(redis).persist();
		const rejected = expect(failed).rejects.toBe(failure);
		const recovery = persistence(redis).persist();
		await rejected;
		await recovery;
		expect(JSON.parse(await readFile(file, 'utf8')).data).toContainEqual(['retained', 'value']);
	});

	it('keeps a failed disconnect retryable and emits close only after a durable final save', async () => {
		await redis.connect();
		const close = jest.fn();
		redis.on('close', close);
		const failure = new Error('Synthetic final persistence failure');
		write.mockRejectedValueOnce(failure);
		await expect(redis.disconnect()).rejects.toBe(failure);
		expect(close).not.toHaveBeenCalled();
		await redis.set('retained', 'retry');
		await redis.disconnect();
		expect(close).toHaveBeenCalledTimes(1);
		expect(JSON.parse(await readFile(file, 'utf8')).data).toContainEqual(['retained', 'retry']);
	});

	it('restores background timers after a failed disconnect and persists after reconnecting', async () => {
		const intervals = jest.spyOn(global, 'setInterval');
		const cleared = jest.spyOn(global, 'clearInterval');
		await redis.connect();
		const initialTimers = intervals.mock.results.map((result) => result.value);
		const failure = new Error('Synthetic final persistence failure');
		write.mockRejectedValueOnce(failure);
		await expect(redis.disconnect()).rejects.toBe(failure);
		for (const timer of initialTimers) expect(cleared).toHaveBeenCalledWith(timer);
		expect(intervals).toHaveBeenCalledTimes(4);
		await redis.connect();
		expect(intervals).toHaveBeenCalledTimes(4);
		expect(intervals.mock.calls.filter(([, delay]) => delay === 30000)).toHaveLength(2);
		const persistenceTimers = intervals.mock.calls.filter(([, delay]) => delay === 60000);
		expect(persistenceTimers).toHaveLength(2);
		const timer = persistenceTimers[1][0] as () => void;
		await redis.set('retained', 'after reconnect');
		timer();
		await persistence(redis).persistTail;
		expect(write).toHaveBeenCalledTimes(2);
		expect(JSON.parse(await readFile(file, 'utf8')).data).toContainEqual([
			'retained',
			'after reconnect',
		]);
	});

	it('handles a timer save failure and persists the next snapshot on shutdown', async () => {
		const intervals = jest.spyOn(global, 'setInterval');
		await redis.connect();
		const timer = intervals.mock.calls.find(([, delay]) => delay === 60000)![0] as () => void;
		write.mockRejectedValueOnce(new Error('Synthetic timer persistence failure'));
		timer();
		await persistence(redis).persistTail;
		await redis.set('retained', 'after timer failure');
		await redis.disconnect();
		expect(JSON.parse(await readFile(file, 'utf8')).data).toContainEqual([
			'retained',
			'after timer failure',
		]);
	});

	it('serializes concurrent connects and a disconnect requested during the initial read', async () => {
		const gate = deferred();
		releases.push(gate.resolve);
		const started = deferred();
		read.mockImplementationOnce(async (...args) => {
			started.resolve();
			await gate.promise;
			return actual.readJSON(...args);
		});
		const intervals = jest.spyOn(global, 'setInterval');
		const connected = jest.fn();
		const closed = jest.fn();
		redis.on('connect', connected);
		redis.on('close', closed);
		const first = redis.connect();
		await started.promise;
		const second = redis.connect();
		const disconnect = redis.disconnect();
		gate.resolve();
		await Promise.all([first, second, disconnect]);
		expect(read).toHaveBeenCalledTimes(1);
		expect(intervals).toHaveBeenCalledTimes(2);
		expect(connected).toHaveBeenCalledTimes(1);
		expect(closed).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it('persists once when disconnect is requested concurrently', async () => {
		await redis.connect();
		const closed = jest.fn();
		redis.on('close', closed);
		await Promise.all([redis.disconnect(), redis.disconnect()]);
		expect(write).toHaveBeenCalledTimes(1);
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it('restores sorted-set scores, including ties, and permits updates after reconnecting', async () => {
		await redis.connect();
		await redis.zadd('delayed', -1, 'earlier', 0, 'first', 0, 'second', 1, 'later');
		await redis.disconnect();
		const restored = createStore();
		await restored.connect();
		expect(await restored.zrange('delayed', 0, -1, 'WITHSCORES')).toEqual([
			'earlier',
			'-1',
			'first',
			'0',
			'second',
			'0',
			'later',
			'1',
		]);
		await restored.zrem('delayed', 'first');
		await restored.zadd('delayed', 2, 'later');
		await restored.disconnect();
		const reopened = createStore();
		await reopened.connect();
		expect(await reopened.zrange('delayed', 0, -1, 'WITHSCORES')).toEqual([
			'earlier',
			'-1',
			'second',
			'0',
			'later',
			'2',
		]);
	});

	it('loads legacy raw values, legacy sets, and typed collections without changing their meaning', async () => {
		await writeFile(
			file,
			JSON.stringify({
				data: [
					['string', 'value'],
					['list', ['one', 'two']],
					['hash', { field: 'value' }],
					['set', { _isSet: true, items: ['one', 'two'] }],
					['typed-list', { _type: 'list', items: ['one'] }],
					['typed-hash', { _type: 'hash', data: { field: 'value' } }],
					['typed-set', { _type: 'set', items: ['one'] }],
				],
				expiry: [['string', Date.now() + 60000]],
			})
		);
		await redis.connect();
		expect(await redis.get('string')).toBe('value');
		expect(await redis.lrange('list', 0, -1)).toEqual(['one', 'two']);
		expect(await redis.hget('hash', 'field')).toBe('value');
		expect(await redis.smembers('set')).toEqual(['one', 'two']);
		expect(await redis.lrange('typed-list', 0, -1)).toEqual(['one']);
		expect(await redis.hget('typed-hash', 'field')).toBe('value');
		expect(await redis.smembers('typed-set')).toEqual(['one']);
		await redis.disconnect();
		const restored = createStore();
		await restored.connect();
		expect(await restored.smembers('set')).toEqual(['one', 'two']);
		expect(await restored.ttl('string')).toBeGreaterThan(0);
	});

	it.each([
		'{unfinished',
		'null',
		'[]',
		'{}',
		'{"data":{},"expiry":[]}',
		'{"data":[["short"]],"expiry":[]}',
		'{"data":[["long","value","extra"]],"expiry":[]}',
		'{"data":[[4,"value"]],"expiry":[]}',
		'{"data":[["set",{"_type":"set","items":null}]],"expiry":[]}',
		'{"data":[["hash",{"_type":"hash","data":null}]],"expiry":[]}',
		'{"data":[["zset",{"_type":"zset","entries":[["member"]]}]],"expiry":[]}',
		'{"data":[["zset",{"_type":"zset","entries":[["member",0,"extra"]]}]],"expiry":[]}',
		'{"data":[["zset",{"_type":"zset","entries":[["member",1e999]]}]],"expiry":[]}',
		'{"data":[],"expiry":[["key","tomorrow"]]}',
		'{"data":[],"expiry":[["key",1e999]]}',
		'{"data":[],"expiry":[["key",0,"extra"]]}',
		'{"data":[["partial","value"]],"expiry":[["key"]]}',
	])(
		'rejects corrupt persistence atomically and preserves the original bytes: %s',
		async (saved) => {
			await writeFile(file, saved);
			await redis.set('retained', 'existing state');
			const intervals = jest.spyOn(global, 'setInterval');
			await expect(redis.connect()).rejects.toThrow('Invalid persisted Memory Redis');
			await redis.disconnect();
			expect(await redis.get('retained')).toBe('existing state');
			expect(await redis.get('partial')).toBeNull();
			expect(await readFile(file, 'utf8')).toBe(saved);
			expect(write).not.toHaveBeenCalled();
			expect(intervals).not.toHaveBeenCalled();
		}
	);

	it('propagates inaccessible persistence and permits a later connect retry', async () => {
		await writeFile(file, '{"data":[["retained","value"]],"expiry":[]}');
		const failure = new AppError('Synthetic read failure', ErrorCode.PERMISSION_DENIED);
		read.mockRejectedValueOnce(failure);
		await expect(redis.connect()).rejects.toBe(failure);
		expect(write).not.toHaveBeenCalled();
		await redis.connect();
		expect(await redis.get('retained')).toBe('value');
	});
});
