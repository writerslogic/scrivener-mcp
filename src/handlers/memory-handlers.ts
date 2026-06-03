/**
 * MCP handlers for HHM memory operations
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { HHMConfig } from '../services/memory/hhm/holographic-memory-system.js';
import { HolographicMemorySystem } from '../services/memory/hhm/holographic-memory-system.js';
import { quickBenchmark } from '../services/memory/hhm/benchmark.js';
import { getLogger } from '../core/logger.js';
import type { ScrivenerDocument } from '../types/index.js';
import type { ToolDefinition } from './types.js';

const logger = getLogger('memory-handlers');

function loadHmsSchema(name: string): Record<string, unknown> | null {
	try {
		const schemaPath = resolve(process.cwd(), '..', 'HMS', 'schemas', `${name}.json`);
		return JSON.parse(readFileSync(schemaPath, 'utf-8'));
	} catch {
		return null;
	}
}

const retrievalResultSchema = loadHmsSchema('RetrievalResult');
const conceptCandidateSchema = loadHmsSchema('ConceptCandidate');

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
		description: `Find documents by semantic meaning using native HMS engine. Returns: ${retrievalResultSchema ? JSON.stringify(retrievalResultSchema.properties) : 'RetrievalResult[]'}`,
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query text' },
				k: { type: 'number', description: 'Number of results to return' },
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
		description: `Discover analogical relationships (A:B :: C:?) using native reasoning engine. Returns: ${retrievalResultSchema ? JSON.stringify(retrievalResultSchema.properties) : 'RetrievalResult[]'}`,
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
		description: `Enter creative recombination mode to generate novel concept combinations. Returns: ${conceptCandidateSchema ? JSON.stringify(conceptCandidateSchema.properties) : 'ConceptCandidate[]'}`,
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
