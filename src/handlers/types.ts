/**
 * Handler types and interfaces - utilizes common utilities for error handling
 */

import type { ContentAnalyzer } from '../analysis/base-analyzer.js';
import type { MemoryManager } from '../memory-manager.js';
import type { ScrivenerProject } from '../scrivener-project.js';
import type { ContentEnhancer } from '../services/enhancements/content-enhancer.js';
import type { LangChainContinuousLearningHandler } from './langchain-continuous-learning-handler.js';
import type { DatabaseService } from './database/database-service.js';
import type { JSONValue } from '../types/index.js';
import { ErrorCode, createError } from '../utils/common.js';

export interface HandlerContext {
	project: ScrivenerProject | null;
	memoryManager: MemoryManager | null;
	contentAnalyzer: ContentAnalyzer;
	contentEnhancer: ContentEnhancer;
	learningHandler?: LangChainContinuousLearningHandler;
	databaseService?: DatabaseService;
}

export interface HandlerResult {
	content: Array<{
		type: string;
		text?: string;
		// Note: Using 'unknown' here to allow complex response objects that may not conform to JSONValue
		// Handler responses often contain nested objects, class instances, and complex data structures
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
		properties: Record<string, JSONValue>;
		required?: string[];
	};
	handler: ToolHandler;
}

export class HandlerError extends Error {
	constructor(
		message: string,
		public code: string = 'HANDLER_ERROR',
		// Note: Using 'unknown' here to accept Error objects and other complex details
		public details?: unknown
	) {
		super(message);
		this.name = 'HandlerError';
	}
}

export function requireProject(context: HandlerContext): ScrivenerProject {
	if (!context.project) {
		throw createError(ErrorCode.PROJECT_NOT_OPEN, {}, 'No project is currently open');
	}
	return context.project;
}

export function requireMemoryManager(context: HandlerContext): MemoryManager {
	if (!context.memoryManager) {
		throw createError(ErrorCode.INITIALIZATION_ERROR, {}, 'Memory manager not initialized');
	}
	return context.memoryManager;
}

export function getLearningHandler(
	context: HandlerContext
): LangChainContinuousLearningHandler | null {
	return context.learningHandler || null;
}

export function getStringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== 'string') {
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'string', actualType: typeof value },
			`Expected string for ${key}, got ${typeof value}`
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
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'string', actualType: typeof value },
			`Expected string for ${key}, got ${typeof value}`
		);
	}
	return value;
}

export function getNumberArg(args: Record<string, unknown>, key: string): number {
	const value = args[key];
	if (typeof value !== 'number') {
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'number', actualType: typeof value },
			`Expected number for ${key}, got ${typeof value}`
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
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'number', actualType: typeof value },
			`Expected number for ${key}, got ${typeof value}`
		);
	}
	return value;
}

export function getBooleanArg(args: Record<string, unknown>, key: string): boolean {
	const value = args[key];
	if (typeof value !== 'boolean') {
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'boolean', actualType: typeof value },
			`Expected boolean for ${key}, got ${typeof value}`
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
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'boolean', actualType: typeof value },
			`Expected boolean for ${key}, got ${typeof value}`
		);
	}
	return value;
}

export function getArrayArg<T>(args: Record<string, unknown>, key: string): T[] {
	const value = args[key];
	if (!Array.isArray(value)) {
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'array', actualType: typeof value },
			`Expected array for ${key}, got ${typeof value}`
		);
	}
	return value as T[];
}

export function getObjectArg<T>(args: Record<string, unknown>, key: string): T {
	const value = args[key];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'object', actualType: typeof value },
			`Expected object for ${key}, got ${typeof value}`
		);
	}
	return value as T;
}

export function getOptionalObjectArg<T>(args: Record<string, unknown>, key: string): T | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw createError(
			ErrorCode.TYPE_MISMATCH,
			{ key, value, expectedType: 'object', actualType: typeof value },
			`Expected object for ${key}, got ${typeof value}`
		);
	}
	return value as T;
}
