import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
	createMcpHandler,
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	originValidationResponse,
	type McpServerFactory,
} from '@modelcontextprotocol/server';

export const DEFAULT_HTTP_PORT = 3917;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export interface HttpOptions {
	host: string;
	port: number;
	token: string;
	/** Extra Host header names to accept, such as a tunnel's public hostname. */
	allowedHosts: string[];
	/** Extra browser Origin hostnames to accept. */
	allowedOrigins: string[];
}

export class HttpUsageError extends Error {}

function dataDir(): string {
	return process.env.SCRIVENER_DATA_DIR || join(homedir(), '.scrivener-mcp');
}

export function tokenFile(): string {
	return join(dataDir(), 'http-token');
}

/** SCRIVENER_MCP_TOKEN, else the persisted token, else a new one stored with owner-only access. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string {
	const supplied = env.SCRIVENER_MCP_TOKEN;
	if (supplied !== undefined && supplied !== '') {
		if (!TOKEN_PATTERN.test(supplied))
			throw new HttpUsageError(
				'SCRIVENER_MCP_TOKEN must be 32-256 characters of letters, digits, "-" or "_".'
			);
		return supplied;
	}
	const file = tokenFile();
	try {
		const stored = readFileSync(file, 'utf8').trim();
		if (!TOKEN_PATTERN.test(stored))
			throw new HttpUsageError(
				`${file} does not hold a valid token; delete it to create a new one.`
			);
		return stored;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const token = randomBytes(32).toString('base64url');
	mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
	const fd = openSync(file, 'wx', 0o600);
	try {
		writeFileSync(fd, `${token}\n`);
	} finally {
		closeSync(fd);
	}
	return token;
}

function hostname(value: string, flag: string): string {
	const trimmed = value.trim().toLowerCase();
	if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/.test(trimmed))
		throw new HttpUsageError(`${flag} expects a bare hostname, got "${value}".`);
	return trimmed;
}

/** Parse `--http` and its options; null when the server should use stdio. */
export function parseHttpArgs(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env
): Omit<HttpOptions, 'token'> | null {
	if (!argv.includes('--http')) return null;
	const options: Omit<HttpOptions, 'token'> = {
		host: '127.0.0.1',
		port: DEFAULT_HTTP_PORT,
		allowedHosts: [],
		allowedOrigins: [],
	};
	const portEnv = env.SCRIVENER_MCP_PORT;
	if (portEnv) options.port = Number(portEnv);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--http') continue;
		const value = (): string => {
			const next = argv[++i];
			if (next === undefined || next.startsWith('--'))
				throw new HttpUsageError(`${arg} needs a value.`);
			return next;
		};
		if (arg === '--port') options.port = Number(value());
		else if (arg === '--host') options.host = value();
		else if (arg === '--allowed-host') options.allowedHosts.push(hostname(value(), arg));
		else if (arg === '--allowed-origin') options.allowedOrigins.push(hostname(value(), arg));
		else throw new HttpUsageError(`Unknown option ${arg}.`);
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
		throw new HttpUsageError(
			'The port must be an integer from 0 to 65535 (0 picks a free port).'
		);
	return options;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Accepts `Authorization: Bearer <token>` on /mcp, or the token as the last path segment. */
function authorized(url: URL, header: string | null, expected: Buffer): boolean | null {
	const path = url.pathname.replace(/\/+$/, '');
	let presented: string | undefined;
	if (path === '/mcp') {
		const match = header?.match(/^Bearer\s+(\S+)$/i);
		presented = match?.[1];
	} else if (path.startsWith('/mcp/') && !path.slice(5).includes('/')) {
		try {
			presented = decodeURIComponent(path.slice(5));
		} catch {
			return false;
		}
	} else return null;
	return presented !== undefined && timingSafeEqual(digest(presented), expected);
}

function jsonError(
	status: number,
	message: string,
	headers: Record<string, string> = {}
): Response {
	return Response.json(
		{ jsonrpc: '2.0', error: { code: -32000, message }, id: null },
		{ status, headers }
	);
}

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
	}
	const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
	const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
	return new Request(url, {
		method: req.method,
		headers,
		signal,
		...(hasBody
			? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: 'half' }
			: {}),
	} as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((value, name) => {
		headers[name] = value;
	});
	const cookies = response.headers.getSetCookie();
	if (cookies.length) headers['set-cookie'] = cookies;
	res.writeHead(response.status, headers);
	if (!response.body) {
		res.end();
		return;
	}
	await new Promise<void>((resolve) => {
		const body = Readable.fromWeb(response.body as unknown as NodeReadableStream);
		body.on('error', () => res.destroy());
		res.on('close', () => {
			body.destroy();
			resolve();
		});
		body.pipe(res);
	});
}

export interface HttpHandle {
	url: string;
	toolsChanged: () => void;
	close: () => Promise<void>;
}

export async function serveHttp(
	factory: McpServerFactory,
	options: HttpOptions,
	onerror: (error: Error) => void
): Promise<HttpHandle> {
	const handler = createMcpHandler(factory, {
		onerror,
		maxRequestBodySize: MAX_BODY_BYTES,
	});
	const expected = digest(options.token);
	const hosts = [...localhostAllowedHostnames(), ...options.allowedHosts];
	const origins = [...localhostAllowedOrigins(), ...options.allowedOrigins];

	const route = async (request: Request): Promise<Response> => {
		const rejected =
			hostHeaderValidationResponse(request, hosts) ??
			originValidationResponse(request, origins);
		if (rejected) return rejected;
		const verdict = authorized(
			new URL(request.url),
			request.headers.get('authorization'),
			expected
		);
		if (verdict === null) return jsonError(404, 'Not found. The MCP endpoint is /mcp.');
		if (!verdict)
			return jsonError(401, 'Missing or invalid access token.', {
				'WWW-Authenticate': 'Bearer realm="scrivener-mcp"',
			});
		return handler.fetch(request);
	};

	const server = createServer((req, res) => {
		const abort = new AbortController();
		res.on('close', () => abort.abort());
		void (async () => {
			let request: Request;
			try {
				request = toRequest(req, abort.signal);
			} catch {
				await writeResponse(res, jsonError(400, 'Malformed request URL or Host header.'));
				return;
			}
			try {
				await writeResponse(res, await route(request));
			} catch (error) {
				onerror(error as Error);
				if (!res.headersSent) await writeResponse(res, jsonError(500, 'Internal error.'));
				else res.destroy();
			}
		})();
	});
	server.headersTimeout = 30_000;
	server.requestTimeout = 0;
	server.keepAliveTimeout = 5_000;

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, options.host, () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : options.port;
	const host = options.host.includes(':') ? `[${options.host}]` : options.host;
	return {
		url: `http://${host}:${port}/mcp`,
		toolsChanged: () => handler.notify.toolsChanged(),
		close: async () => {
			await handler.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
