/**
 * Handler types and interfaces
 */

import type { ContentAnalyzer } from '../analysis/base-analyzer.js';
import type { MemoryManager } from '../memory-manager.js';
import type { ScrivenerProject } from '../scrivener-project.js';
import type { ContentEnhancer } from '../services/enhancements/content-enhancer.js';

export interface HandlerContext {
	project: ScrivenerProject | null;
	memoryManager: MemoryManager | null;
	contentAnalyzer: ContentAnalyzer;
	contentEnhancer: ContentEnhancer;
}

export interface HandlerResult {
	content: Array<{
		type: string;
		text?: string;
		data?: unknown;
	}>;
	isError?: boolean;
}

export type ToolHandler = (
	args: Record<string, unknown>,
	context: HandlerContext
) => Promise<HandlerResult>;

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, unknown>;
		required?: string[];
	};
	handler: ToolHandler;
}

export class HandlerError extends Error {
	constructor(
		message: string,
		public code: string = 'HANDLER_ERROR',
		public details?: unknown
	) {
		super(message);
		this.name = 'HandlerError';
	}
}

export function requireProject(context: HandlerContext): ScrivenerProject {
	if (!context.project) {
		throw new HandlerError('No project is currently open', 'NO_PROJECT');
	}
	return context.project;
}

export function requireMemoryManager(context: HandlerContext): MemoryManager {
	if (!context.memoryManager) {
		throw new HandlerError('Memory manager not initialized', 'NO_MEMORY');
	}
	return context.memoryManager;
}

export function getStringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== 'string') {
		throw new HandlerError(
			`Expected string for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value;
}

export function getOptionalStringArg(
	args: Record<string, unknown>,
	key: string
): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') {
		throw new HandlerError(
			`Expected string for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value;
}

export function getNumberArg(args: Record<string, unknown>, key: string): number {
	const value = args[key];
	if (typeof value !== 'number') {
		throw new HandlerError(
			`Expected number for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value;
}

export function getOptionalNumberArg(
	args: Record<string, unknown>,
	key: string
): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number') {
		throw new HandlerError(
			`Expected number for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value;
}

export function getBooleanArg(args: Record<string, unknown>, key: string): boolean {
	const value = args[key];
	if (typeof value !== 'boolean') {
		throw new HandlerError(
			`Expected boolean for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value;
}

export function getOptionalBooleanArg(
	args: Record<string, unknown>,
	key: string
): boolean | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'boolean') {
		throw new HandlerError(
			`Expected boolean for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value;
}

export function getArrayArg<T>(args: Record<string, unknown>, key: string): T[] {
	const value = args[key];
	if (!Array.isArray(value)) {
		throw new HandlerError(
			`Expected array for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value as T[];
}

export function getObjectArg<T>(args: Record<string, unknown>, key: string): T {
	const value = args[key];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new HandlerError(
			`Expected object for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value as T;
}

export function getOptionalObjectArg<T>(args: Record<string, unknown>, key: string): T | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new HandlerError(
			`Expected object for ${key}, got ${typeof value}`,
			'INVALID_ARGUMENT'
		);
	}
	return value as T;
}
