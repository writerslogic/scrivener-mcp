/**
 * MCP handlers for HHM memory operations
 */

import type { HHMConfig } from '../services/memory/hhm/holographic-memory-system.js';
import { HolographicMemorySystem } from '../services/memory/hhm/holographic-memory-system.js';
import { quickBenchmark } from '../services/memory/hhm/benchmark.js';
import { getLogger } from '../core/logger.js';
import type { ScrivenerDocument } from '../types/index.js';
import { SHARED_DEFS } from './shared-schemas.js';
import type { ToolDefinition } from './types.js';

const logger = getLogger('memory-handlers');

// Global HHM instance
let hhmSystem: HolographicMemorySystem | null = null;

/**
 * Initialize HHM system
 */
export async function initializeHHM(config?: HHMConfig): Promise<HolographicMemorySystem> {
	if (hhmSystem) {
		await hhmSystem.destroy();
	}

	hhmSystem = new HolographicMemorySystem(config || {});
	return hhmSystem;
}

/**
 * Get HHM system instance
 */
export function getHHMSystem(): HolographicMemorySystem {
	if (!hhmSystem) {
		throw new Error('HHM system not initialized. Call initializeHHM first.');
	}
	return hhmSystem;
}

/**
 * Native HHM Tool Definitions
 */
export const nativeHHMTools: ToolDefinition[] = [
	{
		name: 'semantic_search',
		description: 'Native HMS semantic search',
		inputSchema: {
			type: 'object',
			properties: {
				query: SHARED_DEFS.query,
				k: SHARED_DEFS.maxResults,
			},
			required: ['query'],
		},
		handler: async (args) => {
			const traceId = crypto.randomUUID();
			const system = getHHMSystem();
			const results = await system.queryText(
				args.query as string,
				(args.k as number) || 10,
				traceId
			);
			return {
				content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
			};
		},
	},
	{
		name: 'find_analogies',
		description: 'Find analogies (A:B :: C:?)',
		inputSchema: {
			type: 'object',
			properties: {
				a: { type: 'string' },
				b: { type: 'string' },
				c: { type: 'string' },
			},
			required: ['a', 'b', 'c'],
		},
		handler: async (args) => {
			const traceId = crypto.randomUUID();
			const system = getHHMSystem();
			const results = await system.findAnalogy(
				args.a as string,
				args.b as string,
				args.c as string,
				traceId
			);
			return {
				content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
			};
		},
	},
	{
		name: 'hhm_dream',
		description: 'Creative concept recombination',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		handler: async () => {
			const system = getHHMSystem();
			const results = await system.dream();
			return {
				content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
			};
		},
	},
];

export const memoryHandlers = {
	async memorizeText(params: { text: string; id?: string; traceId?: string }) {
		const system = getHHMSystem();
		return system.memorizeText(params.text, params.id, params.traceId);
	},
	async memorizeDocument(params: { document: ScrivenerDocument; traceId?: string }) {
		const system = getHHMSystem();
		return system.memorizeDocument(params.document, params.traceId);
	},
};

export const retrievalHandlers = {
	async queryText(params: { text: string; k?: number; traceId?: string }) {
		const system = getHHMSystem();
		return system.queryText(params.text, params.k || 10, params.traceId);
	},
	async findAnalogy(params: { a: string; b: string; c: string; traceId?: string }) {
		const system = getHHMSystem();
		return system.findAnalogy(params.a, params.b, params.c, params.traceId);
	},
};

export const managementHandlers = {
	async dreamMode() {
		const system = getHHMSystem();
		return system.dream();
	},
	async getStats(): Promise<Record<string, unknown>> {
		const system = getHHMSystem();
		return system.getStats();
	},
};

export const benchmarkHandlers = {
	async runBenchmark(params: { dimensions?: number }): Promise<string> {
		logger.info('Running HHM benchmark...');
		await quickBenchmark(params.dimensions || 10000);
		return 'Benchmark complete. Check console for results.';
	},
};

export function registerHHMHandlers(
	_server: import('@modelcontextprotocol/sdk/server/index.js').Server
): void {
	logger.info('HHM handlers integrated with Native core');
}
