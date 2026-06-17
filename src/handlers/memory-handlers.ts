/**
 * MCP handlers for HMS memory operations
 */

import * as crypto from 'crypto';
import type { HHMConfig } from '../services/memory/hhm/holographic-memory-system.js';
import { HolographicMemorySystem } from '../services/memory/hhm/holographic-memory-system.js';
import { getLogger } from '../core/logger.js';
import { compact } from '../core/response-formatter.js';
import { formatError } from '../core/response-formatter.js';
import { SHARED_DEFS } from './shared-schemas.js';
import type { ToolDefinition } from './types.js';

const logger = getLogger('memory-handlers');

let hhmSystem: HolographicMemorySystem | null = null;

export async function initializeHHM(config?: HHMConfig): Promise<HolographicMemorySystem> {
	const old = hhmSystem;
	hhmSystem = null;
	if (old) {
		try {
			await old.destroy();
		} catch (err) {
			logger.warn('Failed to destroy previous HMS instance', { error: err });
		}
	}
	hhmSystem = new HolographicMemorySystem(config || {});
	return hhmSystem;
}

export function getHHMSystem(): HolographicMemorySystem {
	if (!hhmSystem) {
		throw new Error(
			'HMS not initialized. Open a project first, then activate the memory skill.'
		);
	}
	return hhmSystem;
}

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
			try {
				const query = String(args.query || '');
				const k = Number(args.k) || 10;
				const traceId = crypto.randomUUID();
				const system = getHHMSystem();
				const results = await system.queryText(query, k, traceId);
				return {
					content: [{ type: 'text', text: compact(results) }],
				};
			} catch (error) {
				return {
					content: [{ type: 'text', text: formatError(error, 'semantic_search') }],
				};
			}
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
			try {
				const a = String(args.a || '');
				const b = String(args.b || '');
				const c = String(args.c || '');
				const traceId = crypto.randomUUID();
				const system = getHHMSystem();
				const results = await system.findAnalogy(a, b, c, traceId);
				return {
					content: [{ type: 'text', text: compact(results) }],
				};
			} catch (error) {
				return {
					content: [{ type: 'text', text: formatError(error, 'find_analogies') }],
				};
			}
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
			try {
				const system = getHHMSystem();
				const results = await system.dream();
				return {
					content: [{ type: 'text', text: compact(results) }],
				};
			} catch (error) {
				return {
					content: [{ type: 'text', text: formatError(error, 'hhm_dream') }],
				};
			}
		},
	},
];

export { HolographicMemorySystem };
