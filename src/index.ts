#!/usr/bin/env node
/**
 * Scrivener MCP Server - Refactored entry point
 */

import { createRequire } from 'module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require('../package.json') as { version: string };

import {
	Server,
	ProtocolError as McpError,
	ProtocolErrorCode as McpErrorCode,
	type ServerContext,
	type CallToolResult,
	UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/server';
import {
	ListToolsResultSchema,
	CreateMessageRequestParamsSchema,
} from '@modelcontextprotocol/core';
import {
	serveStdio,
	StdioServerTransport,
	type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { ContentAnalyzer } from './analysis/base-analyzer.js';
import { getLogger } from './core/logger.js';
import {
	formatError,
	cleanupSpool,
	disposeSpool,
	cleanupAbandonedSpoolDirs,
} from './core/response-formatter.js';
import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';
import { cleanupPendingProjects } from './handlers/project-handlers/lifecycle.js';
import { type HandlerContext } from './handlers/index.js';
import {
	initializeSkillRegistry,
	getRegisteredTools,
	executeRegisteredHandler,
	getToolCatalogRevision,
	activateSkills,
} from './handlers/skill-registry.js';
import { HandlerError } from './handlers/types.js';
import { SERVER_CAPABILITIES } from './handlers/server-capabilities.js';
import { APP_MIME_TYPE, DASHBOARD_URI, supportsApps } from './handlers/dashboard-handlers.js';
import { PersonalizationService } from './services/personalization/personalization-service.js';
import { initializeHHM } from './handlers/memory-handlers.js';
import { applyDiscoveredAIKeys } from './utils/env-config.js';
import { registerSamplingServer } from './services/ai/sampling-bridge.js';

// SDK 2.4 validates the opening revision but not subsequent pinned stdio requests.
class RevisionCheckedTransport extends StdioServerTransport {
	override async start(): Promise<void> {
		const receive = this.onmessage;
		this.onmessage = (message) => {
			if (!('method' in message && 'id' in message)) {
				receive?.(message);
				return;
			}
			const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
			if (typeof version === 'string' && version !== '2026-07-28') {
				const error = new UnsupportedProtocolVersionError({
					supported: ['2026-07-28'],
					requested: version,
				});
				void this.send({
					jsonrpc: '2.0',
					id: message.id,
					error: { code: error.code, message: error.message, data: error.data },
				}).catch((failure: Error) => this.onerror?.(failure));
				return;
			}
			receive?.(message);
		};
		await super.start();
	}
}

const logger = getLogger('main');

// Fill in AI provider keys (Anthropic, OpenAI, OpenRouter) from dotfiles or the
// macOS Keychain before any AIClient is constructed; explicit env vars always win.
applyDiscoveredAIKeys();

let hhmInitialized = false;

async function initializeContext(): Promise<HandlerContext> {
	let hhmSystem;

	try {
		hhmSystem = await initializeHHM({
			dimensions: 10000,
			maxMemories: 1000000,
			similarityThreshold: 0.4,
			autoEvolve: true,
		});
		hhmInitialized = true;
		logger.info('HHM system initialized successfully');
	} catch (error) {
		logger.warn('Failed to initialize HHM system, continuing without it', {
			error: (error as Error).message,
		});
		hhmInitialized = false;
	}

	return {
		project: null,
		memoryManager: null,
		contentAnalyzer: new ContentAnalyzer(),
		personalization: new PersonalizationService(null),
		hhmSystem,
	};
}

const contextPromise = initializeContext();
let context: HandlerContext;

initializeSkillRegistry();
let stdioHandle: StdioServerHandle | undefined;
function buildServer(modern: boolean): Server {
	let projectToken: string | undefined;
	let dispatch: Promise<void> = Promise.resolve();
	const server = new Server(
		{
			name: 'scrivener-mcp',
			version: PKG_VERSION,
		},
		{
			capabilities: SERVER_CAPABILITIES,
		}
	);

	const clientSupportsApps = (extra: ServerContext): boolean =>
		supportsApps(
			modern
				? (extra.mcpReq.envelope as Record<string, unknown> | undefined)?.[
						'io.modelcontextprotocol/clientCapabilities'
					]
				: server.getClientCapabilities()
		);

	// Let AIClient reach the client's own model via sampling/createMessage when
	// the connected MCP client supports it (checked per call, post-handshake).
	registerSamplingServer(
		modern
			? null
			: {
					getClientCapabilities: () => server.getClientCapabilities(),
					createMessage: (params, options) =>
						server.createMessage(
							CreateMessageRequestParamsSchema.parse(params),
							options
						),
				}
	);

	let advertisedToolRevision = getToolCatalogRevision();

	server.setRequestHandler('tools/list', async (_request, extra) =>
		ListToolsResultSchema.parse({
			tools: getRegisteredTools(modern || clientSupportsApps(extra), modern),
		})
	);

	server.setRequestHandler('resources/list', async (_request, extra) => ({
		resources: clientSupportsApps(extra)
			? [
					{
						uri: DASHBOARD_URI,
						name: 'Manuscript dashboard',
						mimeType: APP_MIME_TYPE,
						description:
							'Accessible binder, source context, continuity and change review.',
					},
				]
			: [],
	}));
	server.setRequestHandler('resources/read', async (request, extra) => {
		if (request.params.uri !== DASHBOARD_URI || !clientSupportsApps(extra))
			throw new McpError(
				McpErrorCode.InvalidParams,
				'This resource requires a client with negotiated MCP Apps support'
			);
		return {
			contents: [
				{
					uri: DASHBOARD_URI,
					mimeType: APP_MIME_TYPE,
					text: await readFile(
						new URL('../assets/manuscript-dashboard.html', import.meta.url),
						'utf8'
					),
					_meta: {
						ui: {
							csp: {
								connectDomains: [],
								resourceDomains: [],
								frameDomains: [],
								baseUriDomains: [],
							},
						},
					},
				},
			],
		};
	});

	server.setRequestHandler('tools/call', async (request, extra) => {
		const execute = async (): Promise<CallToolResult> => {
			const { name, arguments: args } = request.params;
			const operationId = randomUUID();
			const started = performance.now();
			const requestBytes = Buffer.byteLength(JSON.stringify(args ?? {}));

			try {
				// Ensure context is initialized
				if (!context) {
					context = await contextPromise;
				}
				extra.mcpReq.signal.throwIfAborted();
				context.uiSupported = clientSupportsApps(extra);
				if (
					modern &&
					![
						'open_project',
						'discover_projects',
						'list_skills',
						'use_skill',
						'read_result',
					].includes(name) &&
					(context.project || request.params._meta?.['com.writerslogic/project'])
				) {
					if (
						!projectToken ||
						request.params._meta?.['com.writerslogic/project'] !== projectToken
					)
						throw new HandlerError(
							'Supply the com.writerslogic/project metadata token returned by open_project; this request belongs to another project scope.',
							'INVALID_ARGUMENT'
						);
				}

				const result = await executeRegisteredHandler(name, args ?? {}, context, {
					signal: extra.mcpReq.signal,
				});
				if (name === 'open_project' && context.project && !result.isError) {
					projectToken = randomUUID();
					if (!modern)
						activateSkills(
							'documents',
							'search',
							...(hhmInitialized ? ['memory'] : [])
						);
				}
				if (name === 'close_project' && !result.isError) projectToken = undefined;

				// Preserve isError so the client can tell a failed tool call (e.g. a
				// handler reporting an unavailable database) from a successful one;
				// dropping it makes error text read as a normal result.
				const response: {
					_meta?: Record<string, unknown>;
					content: typeof result.content;
					structuredContent?: Record<string, unknown>;
					isError?: boolean;
				} = { content: result.content };
				if (result.structuredContent !== undefined) {
					response.structuredContent = result.structuredContent;
				}
				response._meta = {
					...result._meta,
					...(modern && projectToken ? { 'com.writerslogic/project': projectToken } : {}),
					'com.writerslogic/operation': {
						id: operationId,
						durationMs: Math.round(performance.now() - started),
					},
				};
				if (result.isError) {
					response.isError = true;
				}
				logger.info('Tool operation completed', {
					operationId,
					tool: name,
					durationMs: Math.round(performance.now() - started),
					requestBytes,
					responseBytes: Buffer.byteLength(JSON.stringify(response)),
					outcome: extra.mcpReq.signal?.aborted
						? 'cancelled'
						: response.isError
							? 'error'
							: 'success',
				});
				return response as CallToolResult;
			} catch (error) {
				const outcome = extra.mcpReq.signal?.aborted ? 'cancelled' : 'error';
				const failureMeta = {
					operationId,
					tool:
						error instanceof HandlerError && error.code === 'UNKNOWN_TOOL'
							? 'unknown'
							: name,
					durationMs: Math.round(performance.now() - started),
					requestBytes,
					outcome,
				};
				if (error instanceof HandlerError && error.code === 'INVALID_ARGUMENT')
					logger.warn('Tool operation failed', { ...failureMeta, code: error.code });
				else
					logger.error('Tool operation failed', {
						...failureMeta,
						code: error instanceof HandlerError ? error.code : 'OPERATION_FAILED',
					});
				if (error instanceof HandlerError && error.code === 'UNKNOWN_TOOL')
					throw new McpError(McpErrorCode.InvalidParams, 'Unknown or unavailable tool');
				return {
					_meta: {
						'com.writerslogic/operation': {
							id: operationId,
							durationMs: failureMeta.durationMs,
						},
					},
					content: [{ type: 'text', text: formatError(error, name) }],
					isError: true,
				};
			} finally {
				const revision = getToolCatalogRevision();
				if (!modern && revision !== advertisedToolRevision) {
					advertisedToolRevision = revision;
					try {
						await server.sendToolListChanged();
					} catch {
						logger.warn('Failed to send tools/list_changed notification', {
							tool: name,
						});
					}
				}
			}
		};
		if (!modern) return execute();
		const pending = dispatch.then(execute);
		dispatch = pending.then(
			() => undefined,
			() => undefined
		);
		return pending;
	});

	return server;
}

async function main() {
	try {
		const { FirstRunManager } = await import('./services/auto-setup/first-run.js');
		const firstRunManager = new FirstRunManager();

		await firstRunManager.initialize({
			quietMode: process.env.SCRIVENER_QUIET === 'true',
			skipSetup: process.env.SCRIVENER_SKIP_SETUP === 'true',
		});
	} catch (error) {
		logger.warn('First-run check failed', { error });
		// Continue anyway
	}

	try {
		await initializeAsyncServices({
			redisUrl: process.env.REDIS_URL,
			openaiApiKey: process.env.OPENAI_API_KEY,
			databasePath: process.env.DATABASE_PATH,
			neo4jUri: process.env.NEO4J_URI,
		});
		logger.info('Async services initialized');
	} catch (error) {
		logger.warn('Failed to initialize async services', { error });
		// Continue without async features
	}

	// Capability summary — lets writers see what's active without reading docs
	const resolvedCtx = await contextPromise;
	const neo4jActive = !!process.env.NEO4J_URI;
	const redisActive = !!process.env.REDIS_URL;
	const hmsStatus = resolvedCtx.hhmSystem ? 'active' : 'not available';
	logger.info(
		`Core: ready | Semantic search (HMS): ${hmsStatus} | ` +
			`Neo4j: ${neo4jActive ? 'configured' : 'not connected'} | ` +
			`Redis: ${redisActive ? 'configured' : 'not connected'}`
	);

	cleanupAbandonedSpoolDirs();
	cleanupSpool();
	stdioHandle = serveStdio(({ era }) => buildServer(era === 'modern'), {
		transport: new RevisionCheckedTransport(),
		onerror: () => logger.warn('MCP transport rejected a message'),
	});
	logger.info('Scrivener MCP Server started');
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	let failed = false;
	const operations = [
		async () => {
			await stdioHandle?.close();
		},
		async () => {
			if (context) await cleanupPendingProjects(context);
		},
		async () => {
			await context?.memoryManager?.stopAutoSave();
		},
		async () => {
			await context?.project?.close();
		},
		async () => {
			await shutdownAsyncServices();
		},
		async () => {
			context?.contentAnalyzer.dispose();
		},
		async () => {
			disposeSpool();
		},
		async () => {
			if (hhmInitialized) {
				const { getHHMSystem } = await import('./handlers/memory-handlers.js');
				await getHHMSystem().destroy();
			}
		},
	];
	for (const operation of operations) {
		try {
			await operation();
		} catch (error) {
			failed = true;
			logger.error('A server resource failed to shut down', { error });
		}
	}
	process.exit(failed ? 1 : 0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.once('end', shutdown);

// Error handling
process.on('uncaughtException', (error) => {
	logger.fatal('Uncaught exception', { error });
	process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
	logger.fatal('Unhandled rejection', { reason, promise });
	process.exit(1);
});

main().catch((error) => {
	logger.fatal('Failed to start server', { error });
	process.exit(1);
});
