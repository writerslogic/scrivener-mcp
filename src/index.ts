#!/usr/bin/env node
/**
 * Scrivener MCP Server - Refactored entry point
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ContentAnalyzer } from './analysis/base-analyzer.js';
import { ContentEnhancer } from './services/enhancements/content-enhancer.js';
import {
	executeHandler,
	getAllTools,
	HandlerError,
	validateHandlerArgs,
	type HandlerContext,
} from './handlers/index.js';
import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';
import { getLogger } from './core/logger.js';

const logger = getLogger('main');

// Initialize context
const context: HandlerContext = {
	project: null,
	memoryManager: null,
	contentAnalyzer: new ContentAnalyzer(),
	contentEnhancer: new ContentEnhancer(),
};

// Initialize server
const server = new Server(
	{
		name: 'scrivener-mcp',
		version: '0.3.1',
	},
	{
		capabilities: {
			tools: {},
		},
	}
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: getAllTools(),
}));

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	try {
		// Validate arguments
		validateHandlerArgs(name, args || {});

		// Execute handler
		const result = await executeHandler(name, args || {}, context);

		// Return MCP-compliant format
		return {
			content: result.content,
		};
	} catch (error) {
		if (error instanceof HandlerError) {
			return {
				content: [
					{
						type: 'text',
						text: `Error: ${error.message}`,
					},
				],
			};
		}

		// Log unexpected errors
		logger.error('Unexpected error', { error });

		return {
			content: [
				{
					type: 'text',
					text: 'An unexpected error occurred',
				},
			],
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
