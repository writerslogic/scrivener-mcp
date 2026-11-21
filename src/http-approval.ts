import { createInterface } from 'node:readline';
import type { ApprovalChannel, ApprovalRequest, OAuthServer } from './http-auth.js';

// The approval channel never touches the HTTP listener, which a tunnel exposes to the internet.
// Draftbridge launches the server and speaks JSON lines over stdin/stdout:
//   out: {"event":"ready","url":...} | {"event":"authorization_request",...} | {"event":"authorization_settled","id":...}
//   in:  {"command":"approve"|"deny","id":...} | {"command":"revoke_all"}
// A person running the server in a terminal answers a y/N prompt instead.

const MAX_LINE = 4096;

export interface ControlChannel extends ApprovalChannel {
	attach(oauth: OAuthServer): void;
	ready(url: string): void;
}

function emit(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function jsonLineChannel(): ControlChannel {
	let oauth: OAuthServer | undefined;
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	input.on('line', (line) => {
		if (line.length > MAX_LINE) return;
		let message: { command?: unknown; id?: unknown };
		try {
			message = JSON.parse(line) as typeof message;
		} catch {
			return;
		}
		if (!oauth || typeof message !== 'object' || message === null) return;
		if (
			(message.command === 'approve' || message.command === 'deny') &&
			typeof message.id === 'string'
		)
			oauth.decide(message.id, message.command === 'approve');
		else if (message.command === 'revoke_all') {
			oauth.revokeAll();
			emit({ event: 'revoked' });
		}
	});
	return {
		attach: (server) => {
			oauth = server;
		},
		ready: (url) => emit({ event: 'ready', url }),
		request: (request: ApprovalRequest) =>
			emit({
				event: 'authorization_request',
				id: request.id,
				code: request.code,
				client: request.clientName,
				redirectHost: request.redirectHost,
				expiresAt: request.expiresAt,
			}),
		settled: (id) => emit({ event: 'authorization_settled', id }),
	};
}

export function terminalChannel(): ControlChannel {
	let oauth: OAuthServer | undefined;
	const queue: ApprovalRequest[] = [];
	const input = createInterface({ input: process.stdin, output: process.stderr });
	let asking: ApprovalRequest | undefined;
	const next = (): void => {
		if (asking || !queue.length) return;
		asking = queue.shift() as ApprovalRequest;
		const current = asking;
		input.question(
			`\n${current.clientName} (${current.redirectHost}) wants to use your Scrivener projects.\nCheck that its page shows ${current.code}. Allow? [y/N] `,
			(answer) => {
				asking = undefined;
				const accepted = oauth?.decide(current.id, /^y(es)?$/i.test(answer.trim()));
				if (accepted === false) process.stderr.write('That request already expired.\n');
				next();
			}
		);
	};
	return {
		attach: (server) => {
			oauth = server;
		},
		ready: () => {},
		request: (request) => {
			queue.push(request);
			next();
		},
		settled: (id) => {
			const index = queue.findIndex((item) => item.id === id);
			if (index >= 0) queue.splice(index, 1);
		},
	};
}
