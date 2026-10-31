import type {
	Transport,
	TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';

// SDK 1.32.x ignores falsy cancellation IDs: https://github.com/modelcontextprotocol/typescript-sdk/issues/2283
const PREFIX = 'scrivener:request:';

function encode(id: RequestId): RequestId {
	return id === 0 || id === '' || (typeof id === 'string' && id.startsWith(PREFIX))
		? PREFIX + JSON.stringify(id)
		: id;
}

function decode(id: RequestId): RequestId {
	if (typeof id === 'string' && id.startsWith(PREFIX)) {
		let original: unknown;
		try {
			original = JSON.parse(id.slice(PREFIX.length));
		} catch {
			throw new Error('Invalid encoded request ID');
		}
		if ((typeof original === 'string' || original === 0) && encode(original) === id)
			return original;
		throw new Error('Invalid encoded request ID');
	}
	if (id === 0 || id === '') throw new Error('Unencoded response request ID');
	return id;
}

function translate(message: JSONRPCMessage): JSONRPCMessage {
	if ('id' in message && message.id !== undefined) {
		const id = 'method' in message ? encode(message.id) : decode(message.id);
		return id === message.id ? message : { ...message, id };
	}
	if ('method' in message && message.method === 'notifications/cancelled') {
		const original = message.params?.requestId;
		if (typeof original === 'string' || typeof original === 'number') {
			const requestId = encode(original);
			if (requestId !== original)
				return { ...message, params: { ...message.params, requestId } };
		}
	}
	return message;
}

export class CancellationSafeTransport implements Transport {
	onmessage?: Transport['onmessage'];
	onerror?: Transport['onerror'];
	onclose?: Transport['onclose'];
	readonly setProtocolVersion?: Transport['setProtocolVersion'];
	private started = false;
	private closed = false;
	private closing?: Promise<void>;

	constructor(private readonly transport: Transport) {
		if (transport.setProtocolVersion)
			this.setProtocolVersion = (version) => transport.setProtocolVersion!(version);
	}

	get sessionId(): string | undefined {
		return this.transport.sessionId;
	}

	set sessionId(value: string | undefined) {
		this.transport.sessionId = value;
	}

	async start(): Promise<void> {
		if (this.started || this.closed) throw new Error('Transport cannot be started again');
		this.started = true;
		const { onmessage, onerror, onclose } = this.transport;
		this.transport.onmessage = (message, extra) => {
			onmessage?.(message, extra);
			let translated: JSONRPCMessage;
			try {
				translated = translate(message);
			} catch (error) {
				this.onerror?.(error as Error);
				return;
			}
			this.onmessage?.(translated, extra);
		};
		this.transport.onerror = (error) => {
			onerror?.(error);
			this.onerror?.(error);
		};
		this.transport.onclose = () => {
			try {
				onclose?.();
			} finally {
				this.finish();
			}
		};
		await this.transport.start();
	}

	async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
		if (this.closed) throw new Error('Transport is closed');
		let forwarded = options;
		if (options?.relatedRequestId !== undefined) {
			const relatedRequestId = decode(options.relatedRequestId);
			if (relatedRequestId !== options.relatedRequestId)
				forwarded = { ...options, relatedRequestId };
		}
		await this.transport.send(translate(message), forwarded);
	}

	close(): Promise<void> {
		return (this.closing ??= this.closeTransport());
	}

	private async closeTransport(): Promise<void> {
		if (this.closed) return;
		try {
			await this.transport.close();
		} finally {
			this.finish();
		}
	}

	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.transport.onmessage = undefined;
		this.transport.onerror = undefined;
		this.transport.onclose = undefined;
		this.onclose?.();
	}
}
