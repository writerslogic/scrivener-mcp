import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { asyncHandlerDefinitions } from '../../../src/handlers/async-handler-definitions.js';
import { getJobStatus } from '../../../src/handlers/async-handlers.js';
import { readResult } from '../../../src/core/response-formatter.js';
import type { HandlerContext } from '../../../src/handlers/types.js';

jest.mock('../../../src/handlers/async-handlers.js', () => ({ getJobStatus: jest.fn() }));

const handler = asyncHandlerDefinitions.find((tool) => tool.name === 'get_job_status')!;

test.each([false, true])(
	'preserves queued result semantics and provenance with spooling=%s',
	async (large) => {
		const original = {
			state: 'completed',
			progress: 100,
			result: {
				envelope: {
					sourceFormat: 'supplied-text',
					sourceRevisions: [{ documentId: 'scene', revision: 'a'.repeat(64) }],
				},
				score: null,
				metadata: {},
				findings: [null, {}, { quote: '🌙 東京'.repeat(large ? 2000 : 1) }],
			},
		};
		const before = JSON.stringify(original);
		jest.mocked(getJobStatus).mockResolvedValue(original);
		const response = await handler.handler(
			{ jobType: 'analyze_document', jobId: 'fixture' },
			{} as HandlerContext
		);
		const output = response.structuredContent as typeof original & {
			result: { _ref?: string; _file?: string };
		};
		expect(response.content[0].type).toBe('text');
		const text = response.content[0].text;
		if (typeof text !== 'string') throw new Error('Missing result text');
		expect(JSON.parse(text)).toEqual(output);
		expect(JSON.stringify(original)).toBe(before);
		if (!large) expect(output.result).toEqual(original.result);
		else {
			expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);
			expect(output.result._ref).toEqual(expect.any(String));
			try {
				let offset: number | null = 0;
				let text = '';
				do {
					const page = readResult(output.result._ref!, offset, 4096);
					text += page.text;
					offset = page.nextOffset;
				} while (offset !== null);
				expect(JSON.parse(text)).toEqual(original.result);
			} finally {
				rmSync(dirname(output.result._file!), { recursive: true, force: true });
			}
		}
	}
);
