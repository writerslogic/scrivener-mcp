#!/usr/bin/env node
/**
 * Scrivener MCP Server - Refactored entry point
 */

import { createRequire } from 'module';
import { readFile } from 'node:fs/promises';
const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require('../package.json') as { version: string };

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	ListResourcesRequestSchema,
	ReadResourceRequestSchema,
	McpError,
	ErrorCode as McpErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { ContentAnalyzer } from './analysis/base-analyzer.js';
import { getLogger } from './core/logger.js';
import { formatError, cleanupSpool } from './core/response-formatter.js';
import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';
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
import { ContentEnhancer } from './services/enhancements/content-enhancer.js';
import { PersonalizationService } from './services/personalization/personalization-service.js';
import { initializeHHM } from './handlers/memory-handlers.js';
import { applyDiscoveredAIKeys } from './utils/env-config.js';
import { registerSamplingServer } from './services/ai/sampling-bridge.js';

const logger = getLogger('main');

// Fill in AI provider keys (Anthropic, OpenAI, OpenRouter) from dotfiles or the
// macOS Keychain before any AIClient is constructed; explicit env vars always win.
applyDiscoveredAIKeys();

// Initialize HHM system
let hhmInitialized = false;

// Initialize context
async function initializeContext(): Promise<HandlerContext> {
	let hhmSystem;

	// Initialize HHM system
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
		contentEnhancer: new ContentEnhancer(),
		personalization: new PersonalizationService(null),
		hhmSystem,
	};
}

// Initialize context
const contextPromise = initializeContext();
let context: HandlerContext;

// Initialize server
const server = new Server(
	{
		name: 'scrivener-mcp',
		version: PKG_VERSION,
	},
	{
		capabilities: SERVER_CAPABILITIES,
	}
);

// Let AIClient reach the client's own model via sampling/createMessage when
// the connected MCP client supports it (checked per call, post-handshake).
registerSamplingServer(server);

// Initialize skill registry
initializeSkillRegistry();
let advertisedToolRevision = getToolCatalogRevision();

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: getRegisteredTools(supportsApps(server.getClientCapabilities())),
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: supportsApps(server.getClientCapabilities())
		? [
				{
					uri: DASHBOARD_URI,
					name: 'Manuscript dashboard',
					mimeType: APP_MIME_TYPE,
					description: 'Accessible binder, source context, continuity and change review.',
				},
			]
		: [],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	if (request.params.uri !== DASHBOARD_URI || !supportsApps(server.getClientCapabilities()))
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

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	try {
		// Ensure context is initialized
		if (!context) {
			context = await contextPromise;
		}
		context.uiSupported = supportsApps(server.getClientCapabilities());

		// Execute handler
		const result = await executeRegisteredHandler(name, args ?? {}, context);
		if (name === 'open_project' && context.project && !result.isError)
			activateSkills('documents', 'search', ...(hhmInitialized ? ['memory'] : []));

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
		if (result._meta) response._meta = result._meta;
		if (result.isError) {
			response.isError = true;
		}
		return response;
	} catch (error) {
		if (error instanceof HandlerError && error.code === 'UNKNOWN_TOOL')
			throw new McpError(McpErrorCode.InvalidParams, 'Unknown or unavailable tool');
		if (error instanceof HandlerError && error.code === 'INVALID_ARGUMENT')
			logger.warn('Tool arguments failed validation', { tool: name, code: error.code });
		else logger.error('Tool error', { tool: name, error });
		return {
			content: [{ type: 'text', text: formatError(error, name) }],
			isError: true,
		};
	} finally {
		const revision = getToolCatalogRevision();
		if (revision !== advertisedToolRevision) {
			advertisedToolRevision = revision;
			try {
				await server.sendToolListChanged();
			} catch {
				logger.warn('Failed to send tools/list_changed notification', { tool: name });
			}
		}
	}
});

// Start server
async function main() {
	// Check for first run
	try {
		const { FirstRunManager } = await import('./services/auto-setup/first-run.js');
		const firstRunManager = new FirstRunManager();

		// Initialize on first run (will prompt for setup if interactive)
		await firstRunManager.initialize({
			quietMode: process.env.SCRIVENER_QUIET === 'true',
			skipSetup: process.env.SCRIVENER_SKIP_SETUP === 'true',
		});
	} catch (error) {
		logger.warn('First-run check failed', { error });
		// Continue anyway
	}

	// Initialize async services
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

	cleanupSpool();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.info('Scrivener MCP Server started');
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	let failed = false;
	const operations = [
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

// Start the server
main().catch((error) => {
	logger.fatal('Failed to start server', { error });
	process.exit(1);
});
