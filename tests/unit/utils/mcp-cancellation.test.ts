import { describe, expect, it, jest } from '@jest/globals';
import {
	InMemoryTransport,
	Server,
	ProtocolErrorCode,
	ProtocolError,
	type JSONRPCMessage,
	type JSONRPCRequest,
	type RequestId,
} from '@modelcontextprotocol/server';
import { setImmediate as tick } from 'node:timers/promises';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Protocol event did not arrive')), 2000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const request = (id: RequestId, name = 'success'): JSONRPCRequest => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: { name },
});
const cancelled = (requestId: RequestId): JSONRPCMessage => ({
	jsonrpc: '2.0',
	method: 'notifications/cancelled',
	params: { requestId, reason: 'stop' },
});

describe('installed MCP transport cancellation', () => {
	it.each([0, ''])(
		'cancels wire ID %j through the installed SDK without colliding with alias-like IDs',
		async (id) => {
			const [peer, raw] = InMemoryTransport.createLinkedPair();
			const server = new Server(
				{ name: 'cancel-test', version: '1' },
				{ capabilities: { tools: {} } }
			);
			const signals = new Map<string, AbortSignal>();
			const entered = deferred<void>();
			const aborted = deferred<void>();
			const responses = jest.fn();
			peer.onmessage = responses;
			server.setRequestHandler('tools/call', async (message, extra) => {
				signals.set(message.params.name, extra.mcpReq.signal);
				if (signals.size === 2) entered.resolve();
				await new Promise<void>((done) =>
					extra.mcpReq.signal.addEventListener(
						'abort',
						() => {
							if (message.params.name === 'target') aborted.resolve();
							done();
						},
						{ once: true }
					)
				);
				return { content: [] };
			});
			try {
				await server.connect(raw);
				await peer.start();
				await peer.send(request(id, 'target'));
				await peer.send(request(`scrivener:request:${JSON.stringify(id)}`, 'collision'));
				await within(entered.promise);
				await peer.send(cancelled(id));
				await within(aborted.promise);
				expect(signals.get('target')?.aborted).toBe(true);
				expect(signals.get('collision')?.aborted).toBe(false);
				await tick();
				expect(responses).not.toHaveBeenCalled();
				await peer.send(cancelled(id));
			} finally {
				await server.close();
				await peer.close();
			}
		}
	);

	it.each([0, ''])(
		'ignores malformed and late cancellation while allowing completed wire ID %j to be reused',
		async (id) => {
			const [peer, raw] = InMemoryTransport.createLinkedPair();
			const server = new Server(
				{ name: 'cancel-reuse-test', version: '1' },
				{ capabilities: { tools: {} } }
			);
			const signals = new Map<string, AbortSignal>();
			const reply = deferred<JSONRPCMessage>();
			const reused = deferred<void>();
			const aborted = deferred<void>();
			peer.onmessage = (message) => reply.resolve(message);
			server.setRequestHandler('tools/call', async (message, extra) => {
				signals.set(message.params.name, extra.mcpReq.signal);
				if (message.params.name === 'reused') {
					reused.resolve();
					await new Promise<void>((done) =>
						extra.mcpReq.signal.addEventListener(
							'abort',
							() => {
								aborted.resolve();
								done();
							},
							{ once: true }
						)
					);
				}
				return { content: [] };
			});
			try {
				await server.connect(raw);
				await peer.start();
				await peer.send(request(id, 'complete'));
				await within(reply.promise);
				await tick();
				await peer.send(cancelled(id));
				await tick();
				expect(signals.get('complete')?.aborted).toBe(false);
				await peer.send(request(id, 'reused'));
				await within(reused.promise);
				for (const params of [{}, { requestId: null }, { requestId: [] }])
					await peer.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params });
				await tick();
				expect(signals.get('reused')?.aborted).toBe(false);
				await peer.send(cancelled(id));
				await within(aborted.promise);
				expect(signals.get('reused')?.aborted).toBe(true);
				expect(signals.get('complete')?.aborted).toBe(false);
			} finally {
				await server.close();
				await peer.close();
			}
		}
	);

	it.each(['success', 'error'])(
		'preserves exact wire IDs on SDK %s responses',
		async (outcome) => {
			const [peer, raw] = InMemoryTransport.createLinkedPair();
			const server = new Server(
				{ name: 'response-test', version: '1' },
				{ capabilities: { tools: {} } }
			);
			server.setRequestHandler('tools/call', () => {
				if (outcome === 'error')
					throw ProtocolError.fromError(
						ProtocolErrorCode.InvalidParams,
						'expected error'
					);
				return { content: [{ type: 'text', text: 'ok' }] };
			});
			try {
				await server.connect(raw);
				await peer.start();
				for (const id of [
					0,
					'',
					'scrivener:request:0',
					'scrivener:request:""',
					1,
					'1',
					'ordinary',
				]) {
					const reply = deferred<JSONRPCMessage>();
					peer.onmessage = (message) => reply.resolve(message);
					await peer.send(request(id));
					const message = await within(reply.promise);
					expect(message).toMatchObject({ id });
					if (outcome === 'error')
						expect(message).toMatchObject({
							error: { code: ProtocolErrorCode.InvalidParams },
						});
					else expect(message).toMatchObject({ result: { content: [{ text: 'ok' }] } });
				}
			} finally {
				await server.close();
				await peer.close();
			}
		}
	);
});
