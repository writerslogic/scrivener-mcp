import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Server } from '@modelcontextprotocol/server';
import { OAuthServer, type ApprovalRequest } from '../../src/http-auth.js';
import { serveHttp, type HttpHandle } from '../../src/http-server.js';

const issuer = new URL('https://db-test.writerslogic.com');
const redirect = 'https://grok.com/connectors-oauth-exchange-code/';

let dir: string;
let clock: number;
let requests: ApprovalRequest[];
let settled: string[];

function makeServer(): OAuthServer {
	return new OAuthServer({
		issuer,
		storePath: join(dir, 'oauth.json'),
		channel: { request: (r) => requests.push(r), settled: (id) => settled.push(id) },
		now: () => clock,
	});
}

const call = async (oauth: OAuthServer, path: string, init?: RequestInit) =>
	(await oauth.handle(new Request(new URL(path, issuer), init))) as Response;

const form = (fields: Record<string, string>): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(fields).toString(),
});

async function register(oauth: OAuthServer, uris: unknown = [redirect]): Promise<Response> {
	return call(oauth, '/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ redirect_uris: uris, client_name: 'Grok' }),
	});
}

function pkce() {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
	const q = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirect,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state: 'st4te',
		resource: 'https://db-test.writerslogic.com/mcp',
		...extra,
	});
	return `/authorize?${q}`;
}

/** Runs the approval flow and returns the redirect the browser is sent to. */
async function signIn(oauth: OAuthServer, clientId: string, challenge: string, approve = true) {
	const page = await call(oauth, authorizeUrl(clientId, challenge));
	expect(page.status).toBe(200);
	const pending = requests[requests.length - 1];
	expect(await page.text()).toContain(pending.code);
	expect(oauth.decide(pending.id, approve)).toBe(true);
	const done = await call(oauth, `/authorize/wait?request=${pending.id}`);
	expect(done.status).toBe(302);
	return new URL(done.headers.get('location') as string);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'scrivener-oauth-'));
	clock = 1_800_000_000_000;
	requests = [];
	settled = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('OAuth authorization server', () => {
	it('publishes resource and authorization server metadata', async () => {
		const oauth = makeServer();
		const resource = await (
			await call(oauth, '/.well-known/oauth-protected-resource/mcp')
		).json();
		expect(resource).toMatchObject({
			resource: 'https://db-test.writerslogic.com/mcp',
			authorization_servers: ['https://db-test.writerslogic.com/'],
		});
		const server = await (await call(oauth, '/.well-known/oauth-authorization-server')).json();
		expect(server).toMatchObject({
			code_challenge_methods_supported: ['S256'],
			token_endpoint: 'https://db-test.writerslogic.com/token',
			registration_endpoint: 'https://db-test.writerslogic.com/register',
		});
		expect(await oauth.handle(new Request(new URL('/mcp', issuer)))).toBeUndefined();
	});

	it.each([[[]], [['http://evil.example/cb']], [['javascript:alert(1)']], ['x']])(
		'refuses registration with redirect_uris %j',
		async (uris) => {
			expect((await register(makeServer(), uris)).status).toBe(400);
		}
	);

	it('signs in only after approval on the Mac, with PKCE and single-use codes', async () => {
		const oauth = makeServer();
		const { client_id: clientId } = (await (await register(oauth)).json()) as {
			client_id: string;
		};
		const { verifier, challenge } = pkce();
		const back = await signIn(oauth, clientId, challenge);
		expect(back.origin + back.pathname).toBe(redirect);
		expect(back.searchParams.get('state')).toBe('st4te');
		expect(back.searchParams.get('iss')).toBe(issuer.href);
		const code = back.searchParams.get('code') as string;

		const exchange = (fields: Record<string, string>) =>
			call(
				oauth,
				'/token',
				form({
					grant_type: 'authorization_code',
					client_id: clientId,
					redirect_uri: redirect,
					code,
					...fields,
				})
			);
		expect((await exchange({ code_verifier: pkce().verifier })).status).toBe(400);
		// The failed attempt consumed the code: a code is never usable twice.
		expect((await exchange({ code_verifier: verifier })).status).toBe(400);

		const again = await signIn(oauth, clientId, challenge);
		const tokens = (await (
			await call(
				oauth,
				'/token',
				form({
					grant_type: 'authorization_code',
					client_id: clientId,
					redirect_uri: redirect,
					code: again.searchParams.get('code') as string,
					code_verifier: verifier,
				})
			)
		).json()) as { access_token: string; refresh_token: string };
		expect((await oauth.verifyAccessToken(tokens.access_token)).resource?.href).toBe(
			'https://db-test.writerslogic.com/mcp'
		);

		const refresh = (token: string) =>
			call(
				oauth,
				'/token',
				form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token })
			);
		const rotated = (await (await refresh(tokens.refresh_token)).json()) as {
			refresh_token: string;
		};
		expect((await refresh(tokens.refresh_token)).status).toBe(400);

		// A restart keeps the registration and refresh token, never an access token.
		const restarted = makeServer();
		await expect(restarted.verifyAccessToken(tokens.access_token)).rejects.toThrow();
		const renewed = (await (
			await call(
				restarted,
				'/token',
				form({
					grant_type: 'refresh_token',
					client_id: clientId,
					refresh_token: rotated.refresh_token,
				})
			)
		).json()) as { access_token: string };
		await expect(restarted.verifyAccessToken(renewed.access_token)).resolves.toBeDefined();
		if (process.platform !== 'win32')
			expect((await stat(join(dir, 'oauth.json'))).mode & 0o777).toBe(0o600);

		restarted.revokeAll();
		await expect(restarted.verifyAccessToken(renewed.access_token)).rejects.toThrow();
	});

	it('expires access tokens', async () => {
		const oauth = makeServer();
		const { client_id: clientId } = (await (await register(oauth)).json()) as {
			client_id: string;
		};
		const { verifier, challenge } = pkce();
		const back = await signIn(oauth, clientId, challenge);
		const { access_token: token } = (await (
			await call(
				oauth,
				'/token',
				form({
					grant_type: 'authorization_code',
					client_id: clientId,
					redirect_uri: redirect,
					code: back.searchParams.get('code') as string,
					code_verifier: verifier,
				})
			)
		).json()) as { access_token: string };
		clock += 60 * 60 * 1000 - 1;
		await expect(oauth.verifyAccessToken(token)).resolves.toBeDefined();
		clock += 1;
		await expect(oauth.verifyAccessToken(token)).rejects.toThrow();
	});

	it('sends a denial back to the app', async () => {
		const oauth = makeServer();
		const { client_id: clientId } = (await (await register(oauth)).json()) as {
			client_id: string;
		};
		const back = await signIn(oauth, clientId, pkce().challenge, false);
		expect(back.searchParams.get('error')).toBe('access_denied');
		expect(back.searchParams.get('code')).toBeNull();
	});

	it('never redirects to an unregistered address and requires PKCE', async () => {
		const oauth = makeServer();
		const { client_id: clientId } = (await (await register(oauth)).json()) as {
			client_id: string;
		};
		const foreign = await call(
			oauth,
			authorizeUrl(clientId, pkce().challenge, { redirect_uri: 'https://evil.example/cb' })
		);
		expect(foreign.status).toBe(200);
		expect(foreign.headers.get('location')).toBeNull();
		const plain = await call(
			oauth,
			authorizeUrl(clientId, 'x'.repeat(43), { code_challenge_method: 'plain' })
		);
		expect(new URL(plain.headers.get('location') as string).searchParams.get('error')).toBe(
			'invalid_request'
		);
		expect(requests).toHaveLength(0);
	});

	it('limits waiting requests and expires them after five minutes', async () => {
		const oauth = makeServer();
		const { client_id: clientId } = (await (await register(oauth)).json()) as {
			client_id: string;
		};
		for (let i = 0; i < 3; i++) await call(oauth, authorizeUrl(clientId, pkce().challenge));
		expect(requests).toHaveLength(3);
		expect(
			await (await call(oauth, authorizeUrl(clientId, pkce().challenge))).text()
		).toContain('Too many');
		expect(requests).toHaveLength(3);
		clock += 5 * 60 * 1000;
		expect(oauth.decide(requests[0].id, true)).toBe(false);
		expect(settled).toEqual(requests.map((r) => r.id));
		expect(
			await (await call(oauth, `/authorize/wait?request=${requests[0].id}`)).text()
		).toContain('expired');
	});
});

describe('HTTP endpoint with OAuth', () => {
	let handle: HttpHandle;
	let oauth: OAuthServer;

	beforeEach(async () => {
		oauth = makeServer();
		handle = await serveHttp(
			() => {
				const server = new Server(
					{ name: 't', version: '1' },
					{ capabilities: { tools: {} } }
				);
				server.setRequestHandler('tools/list', async () => ({ tools: [] }));
				return server;
			},
			{
				host: '127.0.0.1',
				port: 0,
				token: 'S'.repeat(43),
				allowedHosts: ['db-test.writerslogic.com'],
				allowedOrigins: [],
				publicUrl: issuer,
				oauth,
			},
			() => {}
		);
	});
	afterEach(() => handle.close());

	const post = (path: string, headers: Record<string, string> = {}) =>
		fetch(new URL(path, handle.url), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				...headers,
			},
			body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
		});

	it('challenges with resource metadata and accepts only a valid token', async () => {
		const denied = await post('/mcp');
		expect(denied.status).toBe(401);
		expect(denied.headers.get('www-authenticate')).toContain(
			'resource_metadata="https://db-test.writerslogic.com/.well-known/oauth-protected-resource/mcp"'
		);
		expect((await post(`/mcp/${'S'.repeat(43)}`)).status).toBe(404);
		expect((await post('/mcp', { authorization: 'Bearer nope' })).status).toBe(401);
		expect((await post('/mcp', { authorization: `Bearer ${'S'.repeat(43)}` })).status).toBe(
			200
		);

		const { client_id: clientId } = (await (await register(oauth)).json()) as {
			client_id: string;
		};
		const { verifier, challenge } = pkce();
		const back = await signIn(oauth, clientId, challenge);
		const { access_token: token } = (await (
			await call(
				oauth,
				'/token',
				form({
					grant_type: 'authorization_code',
					client_id: clientId,
					redirect_uri: redirect,
					code: back.searchParams.get('code') as string,
					code_verifier: verifier,
				})
			)
		).json()) as { access_token: string };
		expect((await post('/mcp', { authorization: `Bearer ${token}` })).status).toBe(200);
		const preflight = await fetch(new URL('/token', handle.url), {
			method: 'OPTIONS',
			headers: { origin: 'https://grok.com', 'access-control-request-method': 'POST' },
		});
		expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
	});
});
