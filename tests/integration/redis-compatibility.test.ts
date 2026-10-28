import { expect, it } from '@jest/globals';
import { createServer, type Socket } from 'node:net';
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
