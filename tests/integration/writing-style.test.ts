import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { AIClient } from '../../src/services/ai/ai-client.js';
import type { WritingStyleResult } from '../../src/services/ai/writing-style.js';
import type { AnalysisEnvelope } from '../../src/services/editorial/analysis-envelope.js';
import { asyncHandlerDefinitions } from '../../src/handlers/async-handler-definitions.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import {
	initializeAsyncServices,
	shutdownAsyncServices,
} from '../../src/handlers/async-handlers.js';
import { readResult } from '../../src/core/response-formatter.js';

jest.mock('../../src/services/queue/keydb-detector.js', () => ({
	detectConnection: async () => ({ isAvailable: false, type: 'none' }),
	createBullMQConnection: () => {
		throw new Error('Tests require an embedded queue');
	},
}));

const tool = asyncHandlerDefinitions.find(({ name }) => name === 'analyze_writing_style')!;
const validateOutput = new AjvJsonSchemaValidator().getValidator(
	tool.outputSchema as JsonSchemaType
);
const validateInput = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
const profile = {
	voice: 'first-person',
	tone: 'wry',
	sentenceStructure: 'varied',
	vocabularyComplexity: 'plain',
	pacing: 'brisk',
	strengths: ['Concrete imagery'],
	improvements: [],
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const spools = new Set<string>();
let chat: jest.SpiedFunction<AIClient['chat']>;

beforeEach(async () => {
	jest.spyOn(AIClient.prototype, 'isAvailable', 'get').mockReturnValue(true);
	chat = jest.spyOn(AIClient.prototype, 'chat').mockResolvedValue(JSON.stringify(profile));
	await initializeAsyncServices();
});

afterEach(async () => {
	try {
		await shutdownAsyncServices();
	} finally {
		jest.restoreAllMocks();
	}
});

afterAll(async () => {
	for (const directory of spools) await rm(directory, { recursive: true, force: true });
});

async function analyze(
	samples: unknown
): Promise<WritingStyleResult & { envelope: AnalysisEnvelope }> {
	const response = await tool.handler({ samples }, {} as HandlerContext);
	expect(validateOutput(response.structuredContent).valid).toBe(true);
	expect(JSON.parse(response.content[0].text!)).toEqual(response.structuredContent);
	let data = response.structuredContent!;
	if (typeof data._ref === 'string') {
		expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);
		spools.add(dirname(data._file as string));
		let offset: number | null = 0;
		let text = '';
		do {
			const page = readResult(data._ref, offset, 4096);
			text += page.text;
			offset = page.nextOffset;
		} while (offset !== null);
		data = JSON.parse(text);
		expect(validateOutput(data).valid).toBe(true);
	}
	return data as unknown as WritingStyleResult & { envelope: AnalysisEnvelope };
}

test('returns the advertised profile, complete supplied-text provenance and explicit provider policy', async () => {
	const samples = ['The lighthouse flickered. 🌙', 'Mara waited at the harbor.'];
	const result = await analyze(samples);
	expect(result.analysis).toEqual(profile);
	expect(result.availability).toEqual({
		status: 'available',
		unavailableFields: [],
		partialFields: [],
	});
	expect(result.envelope.sourceRevisions).toEqual(
		samples.map((sample, index) => ({
			documentId: `sample-${index + 1}`,
			revision: hash(sample),
		}))
	);
	expect(result.envelope).toMatchObject({
		sourceFormat: 'supplied-text',
		policy: { mode: 'provider', revisionChecked: false, usesSavedProjectControls: false },
	});
	expect(result.coverage.truncated).toBe(false);
	expect(chat.mock.calls[0][0]).toContain('BEGIN UNTRUSTED INPUT');
	expect(chat).toHaveBeenCalledTimes(1);
});

test('preserves valid provider findings and identifies incomplete fields instead of coercing them', async () => {
	chat.mockResolvedValue(
		JSON.stringify({
			voice: 'first-person',
			tone: 20,
			strengths: ['Specific imagery', null, ''],
			improvements: [],
		})
	);
	const result = await analyze(['Sample text.']);
	expect(result.analysis).toEqual({
		voice: 'first-person',
		tone: null,
		sentenceStructure: null,
		vocabularyComplexity: null,
		pacing: null,
		strengths: ['Specific imagery'],
		improvements: [],
	});
	expect(result.availability).toEqual({
		status: 'partial',
		unavailableFields: ['tone', 'sentenceStructure', 'vocabularyComplexity', 'pacing'],
		partialFields: ['strengths'],
	});
});

test('an empty profile is explicitly unavailable with no invented strings or scores', async () => {
	chat.mockResolvedValue('{}');
	const result = await analyze(['Sample text.']);
	expect(Object.values(result.analysis).every((value) => value === null)).toBe(true);
	expect(result.availability.status).toBe('unavailable');
	expect(result.availability.unavailableFields).toHaveLength(7);
});

test.each(['No analysis available.', '[]', '{broken'])(
	'rejects malformed provider output: %s',
	async (reply) => {
		chat.mockResolvedValue(reply);
		await expect(analyze(['Sample text.'])).rejects.toThrow('Style analysis unavailable');
	}
);

test('propagates provider failures without replacing them with a profile', async () => {
	chat.mockRejectedValue(new Error('Fixture provider failure'));
	await expect(analyze(['Sample text.'])).rejects.toThrow('Fixture provider failure');
	expect(chat).toHaveBeenCalledTimes(1);
});

test.each([7999, 8000, 8001])(
	'reports exact context coverage for %i UTF-16 characters',
	async (length) => {
		const sample = 'x'.repeat(length);
		const result = await analyze([sample]);
		expect(result.coverage.samples).toEqual([
			{
				sampleId: 'sample-1',
				revision: hash(sample),
				start: 0,
				end: Math.min(length, 8000),
				sourceCharacters: length,
				truncated: length > 8000,
			},
		]);
		expect(chat.mock.calls[0][0]).toContain('x'.repeat(Math.min(length, 8000)));
		if (length > 8000) expect(chat.mock.calls[0][0]).not.toContain(sample);
	}
);

test('accounts for separators and reports fully omitted samples', async () => {
	const result = await analyze(['x'.repeat(7990), 'Three', 'Omitted sample']);
	expect(result.coverage.samples.map(({ end }) => end)).toEqual([7990, 3, 0]);
	expect(result.coverage.truncated).toBe(true);
	expect(chat.mock.calls[0][0]).toContain('\n\n---\n\nThr\n');
	expect(chat.mock.calls[0][0]).not.toContain('Omitted sample');
	expect(result.envelope.sourceRevisions[2].revision).toBe(hash('Omitted sample'));
});

test('never cuts a Unicode pair at the context boundary', async () => {
	const sample = 'x'.repeat(7999) + '🌙';
	const result = await analyze([sample]);
	expect(result.coverage.samples[0]).toMatchObject({
		end: 7999,
		sourceCharacters: 8001,
		truncated: true,
	});
	expect(chat.mock.calls[0][0]).not.toContain('\uD83C');
});

test('caller mutations during generation cannot change the admitted sample revisions', async () => {
	const samples = ['Original sample.'];
	chat.mockImplementationOnce(async () => {
		samples[0] = 'Different text.';
		samples.push('New sample.');
		return JSON.stringify(profile);
	});
	const result = await analyze(samples);
	expect(result.envelope.sourceRevisions).toEqual([
		{ documentId: 'sample-1', revision: hash('Original sample.') },
	]);
	expect(result.coverage.samples).toHaveLength(1);
});

test.each([63, 64, 65])('bounds sample count at %i', async (count) => {
	const samples = Array.from({ length: count }, () => 'Sample text.');
	expect(validateInput({ samples }).valid).toBe(count <= 64);
	if (count <= 64) expect((await analyze(samples)).coverage.samples).toHaveLength(count);
	else {
		await expect(analyze(samples)).rejects.toThrow('1–64');
		expect(chat).not.toHaveBeenCalled();
	}
});

test.each([63999, 64000, 64001])('bounds individual sample admission at %i', async (length) => {
	const samples = ['x'.repeat(length)];
	expect(validateInput({ samples }).valid).toBe(length <= 64000);
	if (length <= 64000) expect((await analyze(samples)).coverage.samples[0].end).toBe(8000);
	else {
		await expect(analyze(samples)).rejects.toThrow('1–64000');
		expect(chat).not.toHaveBeenCalled();
	}
});

test.each([[], [''], [' '], [4], 'text', new Array(1)])(
	'rejects invalid samples before provider access: %j',
	async (samples) => {
		await expect(analyze(samples)).rejects.toThrow();
		expect(chat).not.toHaveBeenCalled();
	}
);

test('spools large profiles without losing valid findings or provenance', async () => {
	const strengths = Array.from(
		{ length: 200 },
		(_, index) => `Finding ${index}: concrete imagery 🌙`
	);
	chat.mockResolvedValue(JSON.stringify({ ...profile, strengths }));
	const result = await analyze(['A source sample.']);
	expect(result.analysis.strengths).toEqual(strengths);
	expect(result.envelope.sourceRevisions[0].revision).toBe(hash('A source sample.'));
});
