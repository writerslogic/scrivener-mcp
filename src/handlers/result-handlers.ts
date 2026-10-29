import { readResult } from '../core/response-formatter.js';
import type { ToolDefinition } from './types.js';
import { getStringArg, getOptionalNumberArg } from './types.js';

export const readResultHandler: ToolDefinition = {
	name: 'read_result',
	title: 'Read Large Result',
	description:
		'Retrieve a bounded UTF-8 chunk of a large compiled or analysis result using its opaque resultId. Continue using nextOffset until null, then concatenate text in order to reconstruct the original JSON. Available without filesystem tools. Results expire after one hour or a server restart.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			resultId: {
				type: 'string',
				pattern: '^[a-fA-F0-9-]{36}$',
				description: 'Opaque _ref or resultId returned by the original operation.',
			},
			offset: {
				type: 'integer',
				minimum: 0,
				maximum: Number.MAX_SAFE_INTEGER,
				description: 'UTF-8 byte offset, initially zero; subsequent calls use nextOffset.',
			},
			limit: {
				type: 'integer',
				minimum: 4,
				maximum: 65536,
				description: 'Maximum bytes returned, default 16384; characters are never split.',
			},
		},
		required: ['resultId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			resultId: { type: 'string', description: 'Opaque identifier of this result.' },
			text: { type: 'string', description: 'This UTF-8 chunk of the original compact JSON.' },
			offset: { type: 'integer', description: 'Starting UTF-8 byte offset.' },
			nextOffset: {
				type: ['integer', 'null'],
				description: 'Next byte offset, or null after the final chunk.',
			},
			totalBytes: { type: 'integer', description: 'Byte length of the complete result.' },
		},
		required: ['resultId', 'text', 'offset', 'nextOffset', 'totalBytes'],
	},
	handler: async (args) => {
		const result = readResult(
			getStringArg(args, 'resultId'),
			getOptionalNumberArg(args, 'offset'),
			getOptionalNumberArg(args, 'limit')
		);
		return {
			content: [{ type: 'text', text: JSON.stringify(result) }],
			structuredContent: result,
		};
	},
};
