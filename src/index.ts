#!/usr/bin/env node
/**
 * Scrivener MCP Server - Refactored entry point
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ContentAnalyzer } from './analysis/base-analyzer.js';
import { getLogger } from './core/logger.js';
import { initializeAsyncServices, shutdownAsyncServices } from './handlers/async-handlers.js';
import {
	executeHandler,
	getAllTools,
	HandlerError,
	validateHandlerArgs,
	type HandlerContext,
} from './handlers/index.js';
import { LangChainContinuousLearningHandler } from './handlers/langchain-continuous-learning-handler.js';
import { ContentEnhancer } from './services/enhancements/content-enhancer.js';
import { initializeHHM, registerHHMHandlers } from './handlers/memory-handlers.js';
import { GPUAccelerator } from './services/memory/hhm/gpu-accelerator.js';

const logger = getLogger('main');

// Initialize learning handler
let learningHandler: LangChainContinuousLearningHandler | undefined;

// Initialize HHM system
let hhmInitialized = false;

// Initialize context
async function initializeContext(): Promise<HandlerContext> {
	try {
		// Initialize learning handler
		learningHandler = new LangChainContinuousLearningHandler();
		await learningHandler.initialize();
		logger.info('LangChain continuous learning handler initialized');
	} catch (error) {
		logger.warn('Failed to initialize learning handler, continuing without it', {
			error: (error as Error).message,
		});
		learningHandler = undefined;
	}

	// Initialize HHM system
	try {
		await initializeHHM({
			dimensions: 10000,
			maxMemories: 1000000,
			useGPU: GPUAccelerator.isSupported(),
			similarityThreshold: 0.4,
			autoEvolve: true,
		});
		hhmInitialized = true;
		logger.info('HHM system initialized successfully', {
			gpuSupported: GPUAccelerator.isSupported(),
		});
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
		learningHandler,
	};
}

// Initialize context
const contextPromise = initializeContext();
let context: HandlerContext;

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

// Register HHM handlers after context is initialized
contextPromise
	.then(() => {
		if (hhmInitialized) {
			registerHHMHandlers(server as any); // MCP server has complex overloaded types
			logger.info('HHM handlers registered');
		}
	})
	.catch((error) => {
		logger.warn('Failed to register HHM handlers', { error });
	});

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: getAllTools(),
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
