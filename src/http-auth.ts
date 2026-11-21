import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode, oauthMetadataResponse } from '@modelcontextprotocol/server';

// A minimal OAuth 2.1 authorization server for one person's own MCP server: public clients
// (dynamic registration, PKCE S256), and every grant approved by that person on their Mac.

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const MAX_CLIENTS = 100;
const MAX_PENDING = 3;
const MAX_AUTHORIZE_PER_WINDOW = 10;
const AUTHORIZE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FORM_BYTES = 16 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface ApprovalRequest {
	id: string;
	/** Short code shown both on the sign-in page and in the approval prompt. */
	code: string;
	clientName: string;
	redirectHost: string;
	expiresAt: number;
}

export interface ApprovalChannel {
	request(request: ApprovalRequest): void;
	settled(id: string): void;
}

interface Client {
	redirectUris: string[];
	name: string;
	createdAt: number;
}

interface Grant {
	clientId: string;
	expiresAt: number;
}

interface Persisted {
	clients: Record<string, Client>;
	/** Refresh tokens, keyed by SHA-256 so the file never holds a usable token. */
	grants: Record<string, Grant>;
}

interface Pending extends ApprovalRequest {
	clientId: string;
	redirectUri: string;
	challenge: string;
	state?: string;
	status: 'pending' | 'approved' | 'denied' | 'expired';
	authCode?: string;
}

interface IssuedCode {
	clientId: string;
	redirectUri: string;
	challenge: string;
	expiresAt: number;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('base64url');
const secret = (): string => randomBytes(32).toString('base64url');
const own = (object: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(object, key);

function sameString(a: string, b: string): boolean {
	const left = Buffer.from(hash(a));
	const right = Buffer.from(hash(b));
	return timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
	);
}

function validRedirect(uri: unknown): uri is string {
	if (typeof uri !== 'string' || uri.length > 2000) return false;
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	if (url.hash) return false;
	if (url.protocol === 'https:') return true;
	return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(body, {
		status,
		headers: {
			'Cache-Control': 'no-store',
			Pragma: 'no-cache',
			'Access-Control-Allow-Origin': '*',
			...headers,
		},
	});
}

function oauthError(error: string, description: string, status = 400): Response {
	return json({ error, error_description: description }, status);
}

function page(title: string, body: string, refreshUrl?: string): Response {
	const refresh = refreshUrl
		? `<meta http-equiv="refresh" content="2;url=${escapeHtml(refreshUrl)}">`
		: '';
	return new Response(
		`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${escapeHtml(title)}</title><style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1d1d1f}code{font-size:2rem;letter-spacing:.15em;font-weight:600}@media(prefers-color-scheme:dark){body{background:#1d1d1f;color:#f5f5f7}}</style></head><body>${body}</body></html>`,
		{
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Content-Security-Policy':
					"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'",
				'X-Frame-Options': 'DENY',
				'Referrer-Policy': 'no-referrer',
			},
		}
	);
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
	const type = request.headers.get('content-type') ?? '';
	if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
	const text = await request.text();
	if (Buffer.byteLength(text) > MAX_FORM_BYTES) return null;
	return new URLSearchParams(text);
}

export interface OAuthServerOptions {
	/** Public origin the server is reached at, such as https://db-1234.writerslogic.com. */
	issuer: URL;
	storePath: string;
	channel: ApprovalChannel;
	now?: () => number;
}

export class OAuthServer implements OAuthTokenVerifier {
	readonly issuer: URL;
	readonly resource: URL;
	private readonly storePath: string;
	private readonly channel: ApprovalChannel;
	private readonly now: () => number;
	private state: Persisted;
	private readonly pending = new Map<string, Pending>();
	private readonly codes = new Map<string, IssuedCode>();
	private readonly access = new Map<string, Grant>();
	private authorizeTimes: number[] = [];

	constructor(options: OAuthServerOptions) {
		this.issuer = new URL(options.issuer.origin);
		this.resource = new URL('/mcp', this.issuer);
		this.storePath = options.storePath;
		this.channel = options.channel;
		this.now = options.now ?? Date.now;
		this.state = this.load();
	}

	private load(): Persisted {
		try {
			const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as Partial<Persisted>;
			if (parsed && typeof parsed.clients === 'object' && typeof parsed.grants === 'object')
				return { clients: parsed.clients ?? {}, grants: parsed.grants ?? {} };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		return { clients: {}, grants: {} };
	}

	private save(): void {
		const now = this.now();
		for (const [key, grant] of Object.entries(this.state.grants))
			if (grant.expiresAt <= now) delete this.state.grants[key];
		mkdirSync(dirname(this.storePath), { recursive: true, mode: 0o700 });
		const temp = `${this.storePath}.${randomBytes(6).toString('hex')}.tmp`;
		writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' });
		renameSync(temp, this.storePath);
	}

	private metadata() {
		const at = (path: string) => new URL(path, this.issuer).href;
		return {
			issuer: this.issuer.href,
			authorization_endpoint: at('/authorize'),
			token_endpoint: at('/token'),
			registration_endpoint: at('/register'),
			revocation_endpoint: at('/revoke'),
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			revocation_endpoint_auth_methods_supported: ['none'],
			scopes_supported: ['mcp'],
		};
	}

	get resourceMetadataUrl(): string {
		return new URL('/.well-known/oauth-protected-resource/mcp', this.issuer).href;
	}

	/** Answers the OAuth routes, or returns undefined for any other path. */
	async handle(request: Request): Promise<Response | undefined> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, '');
		if (path.startsWith('/.well-known/'))
			return (
				oauthMetadataResponse(request, {
					oauthMetadata: this.metadata(),
					resourceServerUrl: this.resource,
					scopesSupported: ['mcp'],
					resourceName: 'Scrivener MCP',
					dangerouslyAllowInsecureIssuerUrl: this.issuer.protocol === 'http:',
				}) ?? json({ error: 'not_found' }, 404)
			);
		if (request.method === 'OPTIONS' && ['/register', '/token', '/revoke'].includes(path))
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'POST',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
					'Access-Control-Max-Age': '600',
				},
			});
		if (path === '/register' && request.method === 'POST') return this.register(request);
		if (path === '/authorize' && request.method === 'GET') return this.authorize(url);
		if (path === '/authorize/wait' && request.method === 'GET') return this.wait(url);
		if (path === '/token' && request.method === 'POST') return this.token(request);
		if (path === '/revoke' && request.method === 'POST') return this.revoke(request);
		return undefined;
	}

	private async register(request: Request): Promise<Response> {
		const text = await request.text();
		if (Buffer.byteLength(text) > MAX_FORM_BYTES)
			return oauthError('invalid_client_metadata', 'Registration is too large.');
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(text) as Record<string, unknown>;
		} catch {
			return oauthError('invalid_client_metadata', 'Registration must be JSON.');
		}
		const uris = body.redirect_uris;
		if (
			!Array.isArray(uris) ||
			uris.length === 0 ||
			uris.length > 10 ||
			!uris.every(validRedirect)
		)
			return oauthError(
				'invalid_redirect_uri',
				'redirect_uris must list 1-10 https (or loopback http) URLs.'
			);
		const name =
			typeof body.client_name === 'string' && body.client_name.trim()
				? body.client_name.trim().slice(0, 100)
				: new URL(uris[0]).hostname;
		const ids = Object.keys(this.state.clients);
		if (ids.length >= MAX_CLIENTS) {
			const oldest = ids.sort(
				(a, b) => this.state.clients[a].createdAt - this.state.clients[b].createdAt
			)[0];
			delete this.state.clients[oldest];
		}
		const clientId = `client_${randomBytes(16).toString('hex')}`;
		const createdAt = this.now();
		this.state.clients[clientId] = { redirectUris: uris, name, createdAt };
		this.save();
		return json(
			{
				client_id: clientId,
				client_id_issued_at: Math.floor(createdAt / 1000),
				client_name: name,
				redirect_uris: uris,
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
			},
			201
		);
	}

	private expirePending(): void {
		const now = this.now();
		for (const [id, item] of this.pending)
			if (item.expiresAt <= now) {
				if (item.status === 'pending') this.channel.settled(id);
				this.pending.delete(id);
			}
		for (const [code, issued] of this.codes)
			if (issued.expiresAt <= now) this.codes.delete(code);
	}

	private authorize(url: URL): Response {
		this.expirePending();
		const q = url.searchParams;
		const clientId = q.get('client_id') ?? '';
		const redirectUri = q.get('redirect_uri') ?? '';
		const client = own(this.state.clients, clientId) ? this.state.clients[clientId] : undefined;
		if (!client || !client.redirectUris.includes(redirectUri))
			return page(
				'Sign-in failed',
				'<h1>This sign-in link is not valid</h1><p>Remove the connector and add it again.</p>'
			);
		const back = (params: Record<string, string>): Response => {
			const target = new URL(redirectUri);
			for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
			const state = q.get('state');
			if (state) target.searchParams.set('state', state);
			target.searchParams.set('iss', this.issuer.href);
			return Response.redirect(target.href, 302);
		};
		if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
		const challenge = q.get('code_challenge') ?? '';
		if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
			return back({ error: 'invalid_request', error_description: 'PKCE S256 is required.' });
		const resource = q.get('resource');
		if (resource !== null && resource.replace(/\/+$/, '') !== this.resource.href)
			return back({ error: 'invalid_target' });
		const now = this.now();
		this.authorizeTimes = this.authorizeTimes.filter((t) => t > now - AUTHORIZE_WINDOW_MS);
		const waiting = [...this.pending.values()].filter((p) => p.status === 'pending').length;
		if (waiting >= MAX_PENDING || this.authorizeTimes.length >= MAX_AUTHORIZE_PER_WINDOW)
			return page(
				'Too many requests',
				'<h1>Too many sign-in requests</h1><p>Wait a few minutes, then try again.</p>'
			);
		this.authorizeTimes.push(now);
		const id = randomBytes(18).toString('base64url');
		const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)])
			.join('')
			.replace(/^(...)/, '$1-');
		const item: Pending = {
			id,
			code,
			clientName: client.name,
			redirectHost: new URL(redirectUri).host,
			expiresAt: now + PENDING_TTL_MS,
			clientId,
			redirectUri,
			challenge,
			state: q.get('state') ?? undefined,
			status: 'pending',
		};
		this.pending.set(id, item);
		this.channel.request({
			id,
			code,
			clientName: item.clientName,
			redirectHost: item.redirectHost,
			expiresAt: item.expiresAt,
		});
		return this.waitingPage(item);
	}

	private waitingPage(item: Pending): Response {
		const next = new URL('/authorize/wait', this.issuer);
		next.searchParams.set('request', item.id);
		return page(
			'Approve on your Mac',
			`<h1>Approve on your Mac</h1><p><strong>${escapeHtml(item.clientName)}</strong> wants to use your Scrivener projects. Draftbridge on your Mac is asking you to allow it. Check that it shows this code:</p><p><code>${escapeHtml(item.code)}</code></p><p>This page continues by itself once you choose.</p>`,
			next.href
		);
	}

	private wait(url: URL): Response {
		this.expirePending();
		const item = this.pending.get(url.searchParams.get('request') ?? '');
		if (!item)
			return page(
				'Request expired',
				'<h1>This request expired</h1><p>Start the connection again from the AI app.</p>'
			);
		if (item.status === 'pending') return this.waitingPage(item);
		this.pending.delete(item.id);
		const target = new URL(item.redirectUri);
		if (item.state) target.searchParams.set('state', item.state);
		target.searchParams.set('iss', this.issuer.href);
		if (item.status === 'approved' && item.authCode)
			target.searchParams.set('code', item.authCode);
		else target.searchParams.set('error', 'access_denied');
		return Response.redirect(target.href, 302);
	}

	/** The person's answer from the approval prompt. Returns false for an unknown or settled id. */
	decide(id: string, approved: boolean): boolean {
		this.expirePending();
		const item = this.pending.get(id);
		if (!item || item.status !== 'pending') return false;
		item.status = approved ? 'approved' : 'denied';
		if (approved) {
			item.authCode = secret();
			this.codes.set(hash(item.authCode), {
				clientId: item.clientId,
				redirectUri: item.redirectUri,
				challenge: item.challenge,
				expiresAt: this.now() + CODE_TTL_MS,
			});
		}
		this.channel.settled(id);
		return true;
	}

	/** Signs every connected app out: refresh and access tokens stop working at once. */
	revokeAll(): void {
		this.state.grants = {};
		this.access.clear();
		this.codes.clear();
		this.save();
	}

	private issue(clientId: string): Response {
		const now = this.now();
		const accessToken = secret();
		const refreshToken = secret();
		this.access.set(hash(accessToken), { clientId, expiresAt: now + ACCESS_TTL_MS });
		this.state.grants[hash(refreshToken)] = { clientId, expiresAt: now + REFRESH_TTL_MS };
		this.save();
		return json({
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: ACCESS_TTL_MS / 1000,
			refresh_token: refreshToken,
			scope: 'mcp',
		});
	}

	private async token(request: Request): Promise<Response> {
		const form = await readForm(request);
		if (!form) return oauthError('invalid_request', 'Send a form-encoded token request.');
		const clientId = form.get('client_id') ?? '';
		if (!own(this.state.clients, clientId))
			return oauthError('invalid_client', 'Unknown client.', 401);
		const grant = form.get('grant_type');
		if (grant === 'authorization_code') {
			this.expirePending();
			const key = hash(form.get('code') ?? '');
			const issued = this.codes.get(key);
			this.codes.delete(key);
			const verifier = form.get('code_verifier') ?? '';
			if (
				!issued ||
				issued.clientId !== clientId ||
				issued.redirectUri !== (form.get('redirect_uri') ?? '') ||
				!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
				!sameString(hash(verifier), issued.challenge)
			)
				return oauthError('invalid_grant', 'The authorization code is invalid or expired.');
			return this.issue(clientId);
		}
		if (grant === 'refresh_token') {
			const key = hash(form.get('refresh_token') ?? '');
			const stored = own(this.state.grants, key) ? this.state.grants[key] : undefined;
			delete this.state.grants[key];
			if (!stored || stored.clientId !== clientId || stored.expiresAt <= this.now()) {
				this.save();
				return oauthError('invalid_grant', 'The refresh token is invalid or expired.');
			}
			return this.issue(clientId);
		}
		return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
	}

	private async revoke(request: Request): Promise<Response> {
		const form = await readForm(request);
		const token = form?.get('token');
		if (token) {
			const key = hash(token);
			this.access.delete(key);
			if (own(this.state.grants, key)) {
				delete this.state.grants[key];
				this.save();
			}
		}
		return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const key = hash(token);
		const grant = this.access.get(key);
		if (!grant || grant.expiresAt <= this.now()) {
			this.access.delete(key);
			throw new OAuthError(
				OAuthErrorCode.InvalidToken,
				'The access token is invalid or expired.'
			);
		}
		return {
			token,
			clientId: grant.clientId,
			scopes: ['mcp'],
			expiresAt: Math.floor(grant.expiresAt / 1000),
			resource: this.resource,
		};
	}
}
