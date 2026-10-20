import { spawn } from 'node:child_process';
import type { ServerEntry } from './runtime.js';

export interface HandshakeResult {
	ok: boolean;
	serverName?: string;
	serverVersion?: string;
	toolCount?: number;
	error?: string;
	ms: number;
}

/**
 * Launch the server exactly as a client would, complete the MCP initialize handshake, and list
 * its tools. This is the one check that proves a client config can actually work.
 */
export function handshake(entry: ServerEntry, timeoutMs = 60_000): Promise<HandshakeResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(entry.command, entry.args, {
			env: { ...process.env, ...entry.env, LOG_LEVEL: 'ERROR' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let buffer = '';
		let stderr = '';
		let done = false;
		let serverName: string | undefined;
		let serverVersion: string | undefined;

		const finish = (result: Omit<HandshakeResult, 'ms'>): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			child.kill();
			resolve({ ...result, ms: Date.now() - started });
		};

		const timer = setTimeout(
			() => finish({ ok: false, error: `no response within ${timeoutMs / 1000}s` }),
			timeoutMs
		);

		child.on('error', (error) => finish({ ok: false, error: error.message }));
		child.on('exit', (code) =>
			finish({
				ok: false,
				error: `exited early (code ${code}). ${stderr.trim().slice(-300)}`,
			})
		);
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				let message: {
					id?: number;
					result?: Record<string, unknown>;
					error?: { message?: string };
				};
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id === 1) {
					if (message.error) {
						finish({ ok: false, error: message.error.message ?? 'initialize failed' });
						return;
					}
					const info = message.result?.serverInfo as
						{ name?: string; version?: string } | undefined;
					serverName = info?.name;
					serverVersion = info?.version;
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
					);
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`
					);
				} else if (message.id === 2) {
					const tools = message.result?.tools as unknown[] | undefined;
					finish({ ok: true, serverName, serverVersion, toolCount: tools?.length ?? 0 });
					return;
				}
			}
		});

		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'scrivener-setup', version: '1' },
				},
			})}\n`
		);
	});
}
