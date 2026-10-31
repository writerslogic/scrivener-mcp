import { describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
	Transport,
	TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	CallToolRequestSchema,
	CreateMessageRequestSchema,
	ErrorCode,
	McpError,
	type JSONRPCMessage,
	type JSONRPCRequest,
	type MessageExtraInfo,
	type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { setImmediate as tick } from 'node:timers/promises';
import { CancellationSafeTransport } from '../../../src/utils/cancellation-safe-transport.js';

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
const sample = {
	role: 'assistant' as const,
	model: 'local-test',
	content: { type: 'text' as const, text: 'sample' },
};

function recordingTransport() {
	const send = jest.fn(async (_message: JSONRPCMessage, _options?: TransportSendOptions) => {});
	const raw: Transport = {
		send,
		start: jest.fn(async () => {}),
		close: jest.fn(async () => {
			raw.onclose?.();
		}),
	};
	return { raw, send, transport: new CancellationSafeTransport(raw) };
}

describe('cancellation-safe public MCP transport', () => {
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
			server.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
				signals.set(message.params.name, extra.signal);
				if (signals.size === 2) entered.resolve();
				await new Promise<void>((done) =>
					extra.signal.addEventListener(
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
				await server.connect(new CancellationSafeTransport(raw));
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

	it.each(['success', 'error'])(
		'preserves exact wire IDs on SDK %s responses',
		async (outcome) => {
			const [peer, raw] = InMemoryTransport.createLinkedPair();
			const server = new Server(
				{ name: 'response-test', version: '1' },
				{ capabilities: { tools: {} } }
			);
			server.setRequestHandler(CallToolRequestSchema, () => {
				if (outcome === 'error')
					throw new McpError(ErrorCode.InvalidParams, 'expected error');
				return { content: [{ type: 'text', text: 'ok' }] };
			});
			try {
				await server.connect(new CancellationSafeTransport(raw));
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
						expect(message).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
					else expect(message).toMatchObject({ result: { content: [{ text: 'ok' }] } });
				}
			} finally {
				await server.close();
				await peer.close();
			}
		}
	);

	it('cancels the first server sampling request at an unwrapped SDK client and rejects unencoded responses', async () => {
		const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
		const server = new Server({ name: 'sampling-server', version: '1' });
		const client = new Client(
			{ name: 'sampling-client', version: '1' },
			{ capabilities: { sampling: {} } }
		);
		const entered = deferred<AbortSignal>();
		const aborted = deferred<void>();
		const received: JSONRPCMessage[] = [];
		clientWire.onmessage = (message) => {
			received.push(message);
		};
		const errors = jest.fn();
		server.onerror = errors;
		client.setRequestHandler(CreateMessageRequestSchema, async (_request, extra) => {
			entered.resolve(extra.signal);
			await new Promise<void>((done) =>
				extra.signal.addEventListener(
					'abort',
					() => {
						aborted.resolve();
						done();
					},
					{ once: true }
				)
			);
			return sample;
		});
		try {
			await server.connect(new CancellationSafeTransport(serverWire));
			await client.connect(clientWire);
			const controller = new AbortController();
			const pending = server.createMessage(
				{ messages: [], maxTokens: 1 },
				{ signal: controller.signal }
			);
			const rejected = expect(pending).rejects.toMatchObject({
				code: ErrorCode.RequestTimeout,
			});
			const signal = await within(entered.promise);
			const sampling = received.find(
				(message) => 'method' in message && message.method === 'sampling/createMessage'
			) as JSONRPCRequest;
			expect(sampling.id).toBeTruthy();
			expect(sampling.id).not.toBe(0);
			let settled = false;
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				}
			);
			for (const id of [0, '']) await clientWire.send({ jsonrpc: '2.0', id, result: sample });
			await tick();
			expect(errors).toHaveBeenCalledTimes(2);
			expect(settled).toBe(false);
			controller.abort('stop');
			await rejected;
			await within(aborted.promise);
			expect(signal.aborted).toBe(true);
			expect(received).toContainEqual(cancelled(sampling.id));
		} finally {
			await server.close();
			await client.close();
		}
	});

	it.each(['success', 'error'])(
		'matches the first SDK sampling %s response after renaming ID zero',
		async (outcome) => {
			const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
			const server = new Server({ name: 'sampling-server', version: '1' });
			const client = new Client(
				{ name: 'sampling-client', version: '1' },
				{ capabilities: { sampling: {} } }
			);
			client.setRequestHandler(CreateMessageRequestSchema, () => {
				if (outcome === 'error')
					throw new McpError(ErrorCode.InvalidRequest, 'expected error');
				return sample;
			});
			try {
				await server.connect(new CancellationSafeTransport(serverWire));
				await client.connect(clientWire);
				const result = server.createMessage({ messages: [], maxTokens: 1 });
				if (outcome === 'error')
					await expect(result).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
				else await expect(result).resolves.toEqual(sample);
			} finally {
				await server.close();
				await client.close();
			}
		}
	);

	it('preserves metadata, routing options and frozen messages while leaving unaffected IDs unchanged', async () => {
		const { raw, send, transport } = recordingTransport();
		const original = Object.freeze({
			...request(0),
			params: Object.freeze({ name: 'test', _meta: { progressToken: 0 } }),
		});
		const extra: MessageExtraInfo = {
			requestInfo: { headers: { 'x-request': 'context' } },
			closeSSEStream: jest.fn(),
		};
		const received = jest.fn<NonNullable<Transport['onmessage']>>();
		transport.onmessage = received;
		await transport.start();
		try {
			raw.onmessage!(original, extra);
			const mapped = received.mock.calls[0][0] as JSONRPCRequest;
			expect(mapped.id).toBeTruthy();
			expect(mapped.params).toBe(original.params);
			expect(received.mock.calls[0][1]).toBe(extra);
			const reply = Object.freeze({
				jsonrpc: '2.0' as const,
				id: mapped.id,
				result: { _meta: { preserved: true } },
			});
			const options = Object.freeze({
				relatedRequestId: mapped.id,
				resumptionToken: 'token',
				onresumptiontoken: jest.fn(),
			});
			await transport.send(reply, options);
			expect(send).toHaveBeenLastCalledWith(
				{ ...reply, id: 0 },
				{ ...options, relatedRequestId: 0 }
			);
			expect(options.relatedRequestId).toBe(mapped.id);
			expect(reply.id).toBe(mapped.id);
			const notification = Object.freeze({
				...cancelled(0),
				params: Object.freeze({ requestId: 0, reason: 'stop', _meta: { preserved: true } }),
			});
			await transport.send(notification);
			expect(send.mock.calls[send.mock.calls.length - 1]?.[0]).toMatchObject({
				params: { requestId: mapped.id, _meta: { preserved: true } },
			});
			expect(notification.params.requestId).toBe(0);
			const unchanged = Object.freeze(request(7));
			await transport.send(unchanged);
			expect(send.mock.calls[send.mock.calls.length - 1]?.[0]).toBe(unchanged);
			const progress: JSONRPCMessage = {
				jsonrpc: '2.0',
				method: 'notifications/progress',
				params: { progressToken: 0, progress: 1 },
			};
			await transport.send(progress);
			expect(send.mock.calls[send.mock.calls.length - 1]?.[0]).toBe(progress);
		} finally {
			await transport.close();
		}
	});

	it('rejects malformed aliases without consuming a valid following response', async () => {
		const { raw, send, transport } = recordingTransport();
		const received = jest.fn<NonNullable<Transport['onmessage']>>();
		const errors = jest.fn();
		transport.onmessage = received;
		transport.onerror = errors;
		await transport.start();
		try {
			await transport.send(request(0));
			const sent = send.mock.calls[0][0] as JSONRPCRequest;
			for (const id of [
				'scrivener:request:{',
				'scrivener:request:[]',
				'scrivener:request:1',
				'scrivener:request: 0',
			])
				raw.onmessage!({ jsonrpc: '2.0', id, result: {} });
			expect(errors).toHaveBeenCalledTimes(4);
			expect(received).not.toHaveBeenCalled();
			raw.onmessage!({ jsonrpc: '2.0', id: sent.id, result: {} });
			expect(received).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 0, result: {} }, undefined);
		} finally {
			await transport.close();
		}
	});

	it('forwards lifecycle metadata and failures and closes once without retaining callbacks', async () => {
		const { raw, send, transport } = recordingTransport();
		raw.sessionId = 'session';
		const error = new Error('transport failure');
		const rawError = jest.fn();
		const rawClosed = jest.fn();
		raw.onerror = rawError;
		raw.onclose = rawClosed;
		const errors = jest.fn();
		const closed = jest.fn();
		transport.onerror = errors;
		transport.onclose = closed;
		await transport.start();
		expect(transport.sessionId).toBe('session');
		transport.sessionId = 'updated';
		expect(raw.sessionId).toBe('updated');
		raw.onerror!(error);
		expect(rawError).toHaveBeenCalledWith(error);
		expect(errors).toHaveBeenCalledWith(error);
		send.mockRejectedValueOnce(error);
		await expect(transport.send(request(0))).rejects.toBe(error);
		await transport.send(request(0));
		await Promise.all([transport.close(), transport.close()]);
		expect(raw.close).toHaveBeenCalledTimes(1);
		expect(rawClosed).toHaveBeenCalledTimes(1);
		expect(closed).toHaveBeenCalledTimes(1);
		expect(raw.onmessage).toBeUndefined();
		expect(raw.onerror).toBeUndefined();
		expect(raw.onclose).toBeUndefined();
		await expect(transport.send(request(1))).rejects.toThrow('closed');
		await expect(transport.start()).rejects.toThrow('started again');
	});

	it('preserves protocol-version support and propagates start/close failures with cleanup', async () => {
		const error = new Error('lifecycle failure');
		const raw: Transport = {
			start: async () => {
				throw error;
			},
			send: async () => {},
			close: async () => {
				throw error;
			},
			setProtocolVersion: jest.fn(),
		};
		const transport = new CancellationSafeTransport(raw);
		const closed = jest.fn();
		transport.onclose = closed;
		transport.setProtocolVersion!('2025-11-25');
		expect(raw.setProtocolVersion).toHaveBeenCalledWith('2025-11-25');
		await expect(transport.start()).rejects.toBe(error);
		await expect(transport.close()).rejects.toBe(error);
		expect(closed).toHaveBeenCalledTimes(1);
		expect(raw.onmessage).toBeUndefined();
		expect(recordingTransport().transport.setProtocolVersion).toBeUndefined();
	});
});
