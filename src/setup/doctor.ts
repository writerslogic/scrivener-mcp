import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ServerEntry } from './runtime.js';
import { redactDiagnostics } from './redaction.js';

const MAX_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8192;
const MAX_PAGES = 64;
const MAX_TOOLS = 10_000;
const MAX_CURSOR_LENGTH = 1024;

export interface HandshakeResult {
	ok: boolean;
	serverName?: string;
	serverVersion?: string;
	toolCount?: number;
	error?: string;
	ms: number;
}

class DiagnosticTransport extends StdioClientTransport {
	private closing?: Promise<void>;
	private exited = false;
	private resolveExit!: () => void;
	private readonly exit = new Promise<void>((resolve) => {
		this.resolveExit = resolve;
	});
	override onclose = (): void => {
		this.exited = true;
		this.resolveExit();
	};

	override close(): Promise<void> {
		return (this.closing ??= this.closeAndWait());
	}

	private async closeAndWait(): Promise<void> {
		const spawned = this.pid !== null;
		await super.close();
		if (!spawned || this.exited) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.exit,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error('Diagnostic server did not exit after transport shutdown')
							),
						1000
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
}

/** The deadline covers negotiation and listing; SDK child shutdown has a bounded cleanup grace. */
export async function handshake(
	entry: ServerEntry,
	timeoutMs = 60_000,
	signal?: AbortSignal
): Promise<HandshakeResult> {
	const started = performance.now();
	const controller = new AbortController();
	let transport: DiagnosticTransport | undefined;
	let client: Client | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let removeAbort = (): void => {};
	let stderr = Buffer.alloc(0);
	let stderrTruncated = false;
	let stage = 'configuration';
	let failure: unknown;
	let ok = false;
	let server: { name: string; version: string } | undefined;
	let toolCount = 0;
	const secrets = Object.entries(entry.env ?? {})
		.filter(
			([key, value]) =>
				/api.?key|token|password|secret|authorization/i.test(key) &&
				typeof value === 'string' &&
				value.length > 0
		)
		.map(([, value]) => value)
		.sort((a, b) => b.length - a.length);
	const redact = (value: string): string => {
		let result = value;
		for (const secret of secrets) result = result.split(secret).join('[redacted]');
		return String(redactDiagnostics(result));
	};
	const errorText = (error: unknown): string =>
		error instanceof Error ? error.message : String(error ?? 'Diagnostic failed');
	const collectStderr = (chunk: Buffer): void => {
		stderrTruncated ||= stderr.length + chunk.length > MAX_STDERR_BYTES;
		stderr =
			chunk.length >= MAX_STDERR_BYTES
				? Buffer.from(chunk.subarray(-MAX_STDERR_BYTES))
				: Buffer.concat([stderr, chunk]).subarray(-MAX_STDERR_BYTES);
	};
	try {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
			throw new Error(
				`Diagnostic timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`
			);
		if (signal?.aborted) throw new Error('Diagnostic cancelled');
		transport = new DiagnosticTransport({
			command: entry.command,
			args: entry.args,
			stderr: 'pipe',
			maxBufferSize: MAX_STDOUT_BYTES,
			env: {
				...getDefaultEnvironment(),
				...entry.env,
				SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
				SCRIVENER_SKIP_SETUP: 'true',
				SCRIVENER_QUIET: 'true',
				SCRIVENER_LOCAL_ONLY: 'true',
				LOG_LEVEL: 'ERROR',
			},
		});
		transport.stderr?.on('data', collectStderr);
		client = new Client({ name: 'scrivener-setup', version: '1' }, { capabilities: {} });
		const diagnosticClient = client;
		const diagnosticTransport = transport;
		const deadline = started + timeoutMs;
		const timeoutError = (): Error =>
			new Error(`Diagnostic exceeded its total ${timeoutMs} ms deadline`);
		const options = () => {
			if (controller.signal.aborted) throw controller.signal.reason;
			const remaining = Math.ceil(deadline - performance.now());
			if (remaining <= 0) throw timeoutError();
			return {
				signal: controller.signal,
				timeout: remaining,
				maxTotalTimeout: remaining,
				resetTimeoutOnProgress: false,
			};
		};
		const stopped = new Promise<never>((_, reject) => {
			const stop = (error: Error): void => {
				if (controller.signal.aborted) return;
				controller.abort(error);
				reject(error);
			};
			diagnosticClient.onerror = stop;
			const cancelled = (): void => stop(new Error('Diagnostic cancelled'));
			signal?.addEventListener('abort', cancelled, { once: true });
			removeAbort = (): void => signal?.removeEventListener('abort', cancelled);
			timer = setTimeout(
				() => stop(timeoutError()),
				Math.max(1, deadline - performance.now())
			);
		});
		const run = async (): Promise<void> => {
			stage = 'initialize';
			await diagnosticClient.connect(diagnosticTransport, options());
			server = diagnosticClient.getServerVersion();
			stage = 'tools/list';
			const cursors = new Set<string>();
			const names = new Set<string>();
			let cursor: string | undefined;
			for (let page = 0; page < MAX_PAGES; page++) {
				const listing = await diagnosticClient.listTools(
					cursor === undefined ? {} : { cursor },
					options()
				);
				for (const tool of listing.tools) {
					if (names.has(tool.name))
						throw new Error('Server repeated a tool name while listing tools');
					names.add(tool.name);
					if (names.size > MAX_TOOLS)
						throw new Error('Server tool listing exceeded the diagnostic tool limit');
				}
				if (listing.nextCursor === undefined) {
					if (!names.size) throw new Error('Server returned an empty tool listing');
					toolCount = names.size;
					return;
				}
				cursor = listing.nextCursor;
				if (!cursor.length || cursor.length > MAX_CURSOR_LENGTH || cursors.has(cursor))
					throw new Error('Server returned an invalid or repeated tools/list cursor');
				cursors.add(cursor);
			}
			throw new Error('Server tool listing exceeded the diagnostic page limit');
		};
		await Promise.race([run(), stopped]);
		ok = true;
	} catch (error) {
		failure = error;
	} finally {
		clearTimeout(timer);
		removeAbort();
		if (!ok && !controller.signal.aborted) controller.abort(failure);
		try {
			await client?.close();
			await transport?.close();
		} catch (error) {
			failure = new Error(
				`${failure === undefined ? '' : `${errorText(failure)}; `}shutdown: ${errorText(error)}`
			);
			ok = false;
		}
		transport?.stderr?.removeListener('data', collectStderr);
	}
	if (signal?.aborted) {
		ok = false;
		const previous = failure === undefined ? '' : errorText(failure);
		failure = new Error(
			previous.includes('Diagnostic cancelled')
				? previous
				: `Diagnostic cancelled${previous ? `; ${previous}` : ''}`
		);
	}
	const result: HandshakeResult = { ok, ms: Math.max(0, Math.ceil(performance.now() - started)) };
	if (server) {
		result.serverName = redact(server.name);
		result.serverVersion = redact(server.version);
	}
	if (ok) result.toolCount = toolCount;
	else {
		const retained = stderr.toString('utf8');
		const firstBreak = retained.indexOf('\n');
		const completeLines = stderrTruncated
			? firstBreak < 0
				? '[Diagnostic stderr exceeded its retained tail limit]'
				: retained.slice(firstBreak + 1)
			: retained;
		const tail = redact(completeLines).trim().slice(-1024);
		result.error =
			`${stage}: ${redact(errorText(failure)).slice(0, 2048)}${tail ? `\n${tail}` : ''}`.slice(
				0,
				4096
			);
	}
	return result;
}
