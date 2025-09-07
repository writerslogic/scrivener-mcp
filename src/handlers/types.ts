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

export type ToolHandler = (args: any, context: HandlerContext) => Promise<HandlerResult>;

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, any>;
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
