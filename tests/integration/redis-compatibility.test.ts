import { expect, it } from '@jest/globals';
import { createServer, type Socket } from 'node:net';
import { Redis } from 'ioredis';
import * as detector from '../../src/services/queue/keydb-detector.js';
import { KeyDBCache } from '../../src/handlers/database/keydb-cache.js';
import {
	createBullMQConnection,
	detectConnection,
} from '../../src/services/queue/keydb-detector.js';

function readRequest(buffer: Buffer): { args: string[]; bytes: number } | undefined {
	const headerEnd = buffer.indexOf('\r\n');
	if (headerEnd < 0) return undefined;
	const count = Number(buffer.toString('ascii', 1, headerEnd));
	if (buffer[0] !== 42 || !Number.isInteger(count) || count < 1 || count > 16) {
		throw new Error('Invalid RESP2 request array');
	}
	const args: string[] = [];
	let offset = headerEnd + 2;
	for (let index = 0; index < count; index++) {
		const lengthEnd = buffer.indexOf('\r\n', offset);
		if (lengthEnd < 0) return undefined;
		const length = Number(buffer.toString('ascii', offset + 1, lengthEnd));
		if (buffer[offset] !== 36 || !Number.isInteger(length) || length < 0 || length > 4096) {
			throw new Error('Invalid RESP2 request string');
		}
		const start = lengthEnd + 2;
		const end = start + length;
		if (buffer.length < end + 2) return undefined;
		if (buffer[end] !== 13 || buffer[end + 1] !== 10) {
			throw new Error('Invalid RESP2 request terminator');
		}
		args.push(buffer.toString('utf8', start, end));
		offset = end + 2;
	}
	return { args, bytes: offset };
}

async function within<T>(operation: Promise<T>, milliseconds = 5000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Redis fixture deadline exceeded')),
					milliseconds
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

it('connects through production Redis paths when the endpoint forbids HELLO', async () => {
	const previous = {
		SCRIVENER_LOCAL_ONLY: process.env.SCRIVENER_LOCAL_ONLY,
		KEYDB_URL: process.env.KEYDB_URL,
		REDIS_URL: process.env.REDIS_URL,
	};
	const sockets = new Set<Socket>();
	let client: ReturnType<typeof createBullMQConnection> | undefined;
	let fixtureError: unknown;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		socket.on('error', (error) => {
			fixtureError ??= error;
		});
		let buffered = Buffer.alloc(0);
		socket.on('data', (chunk: Buffer) => {
			try {
				if (buffered.length + chunk.length > 65536) {
					throw new Error('Redis fixture request exceeded its limit');
				}
				buffered = Buffer.concat([buffered, chunk]);
				for (;;) {
					const request = readRequest(buffered);
					if (!request) break;
					buffered = buffered.subarray(request.bytes);
					switch (request.args[0].toUpperCase()) {
						case 'HELLO':
							socket.write(
								"-NOPERM this user has no permissions to run the 'hello' command\r\n"
							);
							break;
						case 'INFO': {
							const info = 'redis_version:7.2.0\r\nloading:0\r\n';
							socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
							break;
						}
						case 'PING':
							socket.write('+PONG\r\n');
							break;
						case 'CLIENT':
							socket.write('+OK\r\n');
							break;
						case 'QUIT':
							socket.end('+OK\r\n');
							return;
						default:
							throw new Error('Unexpected Redis fixture command');
					}
				}
			} catch (error) {
				fixtureError ??= error;
				socket.destroy();
			}
		});
	});
	try {
		await within(
			new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', resolve);
			})
		);
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Redis fixture did not bind');
		const url = `redis://127.0.0.1:${address.port}`;
		Object.assign(process.env, {
			SCRIVENER_LOCAL_ONLY: 'true',
			KEYDB_URL: url,
			REDIS_URL: url,
		});
		expect(await within(detectConnection())).toEqual({
			type: 'none',
			url: null,
			isAvailable: false,
		});
		expect(await within(detectConnection([]))).toEqual({
			type: 'none',
			url: null,
			isAvailable: false,
		});
		expect(await within(detectConnection([url]))).toEqual({
			type: 'redis',
			url,
			isAvailable: true,
			version: '7.2.0',
		});
		for (const count of [15, 16])
			expect((await within(detectConnection(Array<string>(count).fill(url)))).url).toBe(url);
		await expect(detectConnection(Array<string>(17).fill(url))).rejects.toThrow(/at most 16/);
		const base = `${url}/0#`;
		for (const size of [4095, 4096]) {
			const candidate = base + 'x'.repeat(size - base.length);
			expect((await within(detectConnection([candidate]))).url).toBe(candidate);
		}
		await expect(detectConnection([base + 'x'.repeat(4097 - base.length)])).rejects.toThrow(
			/4096/
		);
		client = createBullMQConnection(url);
		expect(await within(client.ping())).toBe('PONG');
		await within(client.quit());
		expect(fixtureError).toBeUndefined();
	} finally {
		for (const key of ['SCRIVENER_LOCAL_ONLY', 'KEYDB_URL', 'REDIS_URL'] as const) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		client?.disconnect();
		for (const socket of sockets) socket.destroy();
		if (server.listening) {
			await within(
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				})
			);
		}
	}
});

it.each([
	null,
	{},
	[null],
	['https://fixture.invalid'],
	['redis://'],
	['redis://localhost:0'],
	[' redis://localhost:1'],
	['redis://local\nhost:1'],
	['redis://localhost:1/\u0085'],
])('rejects invalid explicit Redis candidates before discovery: %j', async (value) => {
	await expect(detectConnection(value as readonly string[])).rejects.toThrow(/explicit|Explicit/);
});

it.each(['discovery', 'ping', 'read', 'write', 'quit', 'disconnect'])(
	'releases a real socket when Redis stops replying during %s',
	async (phase) => {
		const sockets = new Set<Socket>();
		const closed: Promise<void>[] = [];
		let fixtureError: unknown;
		const server = createServer((socket) => {
			sockets.add(socket);
			closed.push(
				new Promise<void>((resolve) =>
					socket.once('close', () => {
						sockets.delete(socket);
						resolve();
					})
				)
			);
			socket.on('error', () => undefined);
			let buffered = Buffer.alloc(0);
			socket.on('data', (chunk: Buffer) => {
				try {
					buffered = Buffer.concat([buffered, chunk]);
					if (buffered.length > 65536) throw new Error('Fixture request too large');
					for (;;) {
						const request = readRequest(buffered);
						if (!request) break;
						buffered = buffered.subarray(request.bytes);
						const command = request.args[0].toUpperCase();
						if (
							phase === 'discovery' ||
							(phase === 'ping' && command === 'PING') ||
							(phase === 'read' && ['GET', 'GETRANGE'].includes(command)) ||
							(phase === 'write' && command === 'SETEX') ||
							(phase === 'quit' && command === 'QUIT')
						)
							continue;
						if (command === 'PING') socket.write('+PONG\r\n');
						else if (command === 'GET' || command === 'GETRANGE')
							socket.write('$-1\r\n');
						else if (command === 'QUIT') socket.end('+OK\r\n');
						else if (['CLIENT', 'SETEX'].includes(command)) socket.write('+OK\r\n');
						else throw new Error(`Unexpected fixture command: ${command}`);
					}
				} catch (error) {
					fixtureError = error;
					socket.destroy();
				}
			});
		});
		const cache = new KeyDBCache();
		try {
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
			const url = `redis://127.0.0.1:${address.port}`;
			if (phase === 'discovery') {
				expect((await within(detectConnection([url]), 4000)).isAvailable).toBe(false);
			} else {
				let connectionEnded: Promise<void> | undefined;
				if (phase === 'disconnect') {
					const connect = Redis.prototype.connect;
					jest.spyOn(Redis.prototype, 'connect').mockImplementation(function (
						this: Redis
					) {
						connectionEnded = new Promise<void>((resolve) => this.once('end', resolve));
						return connect.call(this);
					});
				}
				jest.spyOn(detector, 'detectConnection').mockResolvedValue({
					type: 'redis',
					url,
					isAvailable: true,
				});
				expect(await within(cache.initialize(), 4000)).toBe(phase !== 'ping');
				if (phase === 'disconnect') {
					expect(connectionEnded).toBeDefined();
					for (const socket of sockets) socket.end();
					await within(connectionEnded!);
					expect(await within(cache.getOrSet('after-disconnect', async () => 42))).toBe(
						42
					);
				}
				if (phase === 'read' || phase === 'write') {
					expect(
						await within(
							cache.getOrSet('fixture', async () => 42),
							4000
						)
					).toBe(42);
				}
				await within(cache.close(), 4000);
			}
			await within(Promise.all(closed));
			expect(sockets.size).toBe(0);
			expect(fixtureError).toBeUndefined();
		} finally {
			for (const socket of sockets) socket.destroy();
			await within(cache.close());
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			);
			jest.restoreAllMocks();
		}
	}
);
