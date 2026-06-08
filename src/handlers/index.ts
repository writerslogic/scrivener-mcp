/**
 * Handler registry and dispatcher
 *
 * Tools are registered in tiers to minimize token overhead:
 * - core: always available (~15 tools, project + document + basic search)
 * - extended: registered after open_project (~25 tools, analysis + enhancement + memory)
 * - advanced: registered on demand (~18 tools, fractal memory + async queue + realtime)
 */

import { projectHandlers } from './project-handlers.js';
import { documentHandlers } from './document-handlers.js';
import { searchHandlers } from './search-handlers.js';
import { compilationHandlers } from './compilation-handlers.js';
import { analysisHandlers } from './analysis-handlers.js';
import { asyncHandlerDefinitions } from './async-handler-definitions.js';
import { fractalMemoryTools } from './fractal-memory-handlers.js';
import { nativeHHMTools } from './memory-handlers.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from './types.js';
import { HandlerError } from './types.js';

// Core tools: always registered
const coreHandlers: ToolDefinition[] = [...projectHandlers, ...documentHandlers, ...searchHandlers];

// Extended tools: registered after project is opened
const extendedHandlers: ToolDefinition[] = [...compilationHandlers, ...analysisHandlers];

// Advanced tools: fractal memory, async queue, HMS
const advancedHandlers: ToolDefinition[] = [
	...asyncHandlerDefinitions,
	...fractalMemoryTools,
	...nativeHHMTools,
];

// Active handler map (starts with core only)
const handlerMap = new Map<string, ToolDefinition>();
let registeredTiers: Set<string> = new Set();

function registerTier(name: string, handlers: ToolDefinition[]): boolean {
	if (registeredTiers.has(name)) return false;
	for (const handler of handlers) {
		handlerMap.set(handler.name, handler);
	}
	registeredTiers.add(name);
	return true;
}

// Always register core
registerTier('core', coreHandlers);

/**
 * Register extended tools (call after open_project succeeds)
 */
export function registerExtendedTools(): boolean {
	return registerTier('extended', extendedHandlers);
}

/**
 * Register advanced tools (call when HMS/fractal memory is available)
 */
export function registerAdvancedTools(): boolean {
	return registerTier('advanced', advancedHandlers);
}

/**
 * Get all currently registered tool definitions
 */
export function getAllTools() {
	return Array.from(handlerMap.values()).map((h) => ({
		name: h.name,
		description: h.description,
		inputSchema: h.inputSchema,
	}));
}

/**
 * Execute a tool handler
 */
export async function executeHandler(
	toolName: string,
	args: Record<string, unknown>,
	context: HandlerContext
): Promise<HandlerResult> {
	const handler = handlerMap.get(toolName);

	if (!handler) {
		throw new HandlerError(`Unknown tool: ${toolName}`, 'UNKNOWN_TOOL');
	}

	try {
		return await handler.handler(args, context);
	} catch (error) {
		if (error instanceof HandlerError) {
			throw error;
		}

		throw new HandlerError(
			`Handler execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
			'HANDLER_ERROR',
			error
		);
	}
}

/**
 * Validate handler arguments
 */
export function validateHandlerArgs(toolName: string, args: Record<string, unknown>): void {
	const handler = handlerMap.get(toolName);

	if (!handler) {
		throw new HandlerError(`Unknown tool: ${toolName}`, 'UNKNOWN_TOOL');
	}

	const required = handler.inputSchema.required || [];
	for (const prop of required) {
		if (!(prop in args) || args[prop] === undefined) {
			throw new HandlerError(`Missing required argument: ${prop}`, 'MISSING_ARGUMENT');
		}
	}

	const properties = handler.inputSchema.properties;
	for (const [key, value] of Object.entries(args)) {
		if (!(key in properties)) {
			continue;
		}

		const schema = properties[key] as Record<string, unknown>;
		const schemaType = schema.type as string | undefined;
		const schemaEnum = schema.enum as unknown[] | undefined;
		const actualType = Array.isArray(value) ? 'array' : typeof value;

		if (schemaType && actualType !== schemaType) {
			throw new HandlerError(
				`Invalid type for ${key}: expected ${schemaType}, got ${actualType}`,
				'INVALID_TYPE'
			);
		}

		if (schemaEnum && !schemaEnum.includes(value)) {
			throw new HandlerError(
				`Invalid value for ${key}: must be one of ${schemaEnum.join(', ')}`,
				'INVALID_VALUE'
			);
		}
	}
}

export { HandlerContext, HandlerError, HandlerResult } from './types.js';
