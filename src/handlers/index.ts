/**
 * Handler registry and dispatcher
 */

import { analysisHandlers } from './analysis-handlers.js';
import { compilationHandlers } from './compilation-handlers.js';
import { documentHandlers } from './document-handlers.js';
import { projectHandlers } from './project-handlers.js';
import { searchHandlers } from './search-handlers.js';
import { asyncHandlerDefinitions } from './async-handler-definitions.js';
import { fractalMemoryTools } from './fractal-memory-handlers.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from './types.js';
import { HandlerError } from './types.js';

// Combine all handlers
const allHandlers: ToolDefinition[] = [
	...projectHandlers,
	...documentHandlers,
	...searchHandlers,
	...compilationHandlers,
	...analysisHandlers,
	...asyncHandlerDefinitions,
	...fractalMemoryTools,
];

// Create handler map for fast lookup
const handlerMap = new Map<string, ToolDefinition>();
for (const handler of allHandlers) {
	handlerMap.set(handler.name, handler);
}

/**
 * Get all tool definitions
 */
export function getAllTools() {
	return allHandlers.map((h) => ({
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

		// Wrap unexpected errors
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

	// Check required properties
	const required = handler.inputSchema.required || [];
	for (const prop of required) {
		if (!(prop in args) || args[prop] === undefined) {
			throw new HandlerError(`Missing required argument: ${prop}`, 'MISSING_ARGUMENT');
		}
	}

	// Validate property types
	const properties = handler.inputSchema.properties;
	for (const [key, value] of Object.entries(args)) {
		if (!(key in properties)) {
			continue; // Allow extra properties
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

		// Validate enum values
		if (schemaEnum && !schemaEnum.includes(value)) {
			throw new HandlerError(
				`Invalid value for ${key}: must be one of ${schemaEnum.join(', ')}`,
				'INVALID_VALUE'
			);
		}
	}
}

export { HandlerContext, HandlerError, HandlerResult } from './types.js';
