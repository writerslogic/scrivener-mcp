#!/usr/bin/env node
/**
 * Scrivener MCP Server - Refactored entry point
 */

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require('../package.json') as { version: string };

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ContentAnalyzer } from './analysis/base-analyzer.js';
import { getLogger } from './core/logger.js';
import { formatError, cleanupSpool } from './core/response-formatter.js';
import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';
import { HandlerError, type HandlerContext } from './handlers/index.js';
import {
	initializeSkillRegistry,
	getRegisteredTools,
	executeRegisteredHandler,
	validateRegisteredArgs,
	activateSkills,
} from './handlers/skill-registry.js';
import { ContentEnhancer } from './services/enhancements/content-enhancer.js';
import { PersonalizationService } from './services/personalization/personalization-service.js';
import { initializeHHM } from './handlers/memory-handlers.js';

const logger = getLogger('main');

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
		capabilities: {
			tools: {},
		},
	}
);

// Initialize skill registry
initializeSkillRegistry();

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: getRegisteredTools(),
}));

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	try {
		// Ensure context is initialized
		if (!context) {
			context = await contextPromise;
		}

		// Validate arguments
		validateRegisteredArgs(name, args || {});

		// Execute handler
		const result = await executeRegisteredHandler(name, args || {}, context);

		// After use_skill or open_project, notify client of new tools
		if (name === 'use_skill') {
			await server.sendToolListChanged();
		} else if (name === 'open_project' && context.project) {
			const changed = activateSkills('documents', 'search');
			if (hhmInitialized) {
				activateSkills('memory');
			}
			if (changed) {
				await server.sendToolListChanged();
			}
		}

		return { content: result.content };
	} catch (error) {
		logger.error('Tool error', { tool: name, error });
		return {
			content: [{ type: 'text', text: formatError(error, name) }],
		};
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

// Handle graceful shutdown
process.on('SIGINT', async () => {
	logger.info('Shutting down...');

	// Clean up resources
	await shutdownAsyncServices();
	if (context.project) {
		await context.project.close();
	}

	if (context.memoryManager) {
		await context.memoryManager.stopAutoSave();
	}

	// Clean up HHM system
	if (hhmInitialized) {
		try {
			const { getHHMSystem } = await import('./handlers/memory-handlers.js');
			const hhmSystem = getHHMSystem();
			await hhmSystem.destroy();
			logger.info('HHM system shutdown complete');
		} catch (error) {
			logger.warn('Error during HHM shutdown', { error });
		}
	}

	process.exit(0);
});

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
