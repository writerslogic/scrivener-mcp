import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { AIClient } from '../../src/services/ai/ai-client.js';
import { ProjectSource, savedRevision } from '../../src/services/editorial/project-source.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import type { SuggestionResult } from '../../src/services/ai/writing-suggestions.js';
import { asyncHandlerDefinitions } from '../../src/handlers/async-handler-definitions.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import {
	generateSuggestions,
	getJobStatus,
	initializeAsyncServices,
	shutdownAsyncServices,
} from '../../src/handlers/async-handlers.js';
import { JobType } from '../../src/services/queue/job-queue.js';
import { readResult } from '../../src/core/response-formatter.js';

jest.mock('../../src/services/queue/keydb-detector.js', () => ({
	detectConnection: async () => ({ isAvailable: false, type: 'none' }),
	createBullMQConnection: () => {
		throw new Error('Tests require an embedded queue');
	},
}));

const documentId = '00000000-0000-4000-8000-000000000001';
const tool = asyncHandlerDefinitions.find(({ name }) => name === 'suggest_improvements')!;
const validateOutput = new AjvJsonSchemaValidator().getValidator(
	tool.outputSchema! as JsonSchemaType
);
const validateInput = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
let root: string;
let store: PersistentStore;
let source: ProjectSource;
let chat: jest.SpiedFunction<AIClient['chat']>;
const request = { documentId, prompt: 'Tighten the opening.', useContext: true };

async function save(text: string): Promise<string> {
	const raw = `{\\rtf1\\ansi ${text}}`;
	await writeFile(join(root, `${documentId}.rtf`), raw);
	return savedRevision(raw);
}

beforeEach(async () => {
	jest.spyOn(AIClient.prototype, 'isAvailable', 'get').mockReturnValue(true);
	chat = jest.spyOn(AIClient.prototype, 'chat').mockResolvedValue('Keep the lighthouse image.');
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-suggestions-')));
	store = new PersistentStore(join(root, '.scrivener-mcp', 'editorial.sqlite'));
	source = new ProjectSource(
		root,
		store,
		async () => [
			{
				id: documentId,
				title: 'Opening',
				type: 'Text',
				path: 'Draft/Opening',
			},
		],
		(id) => readFile(join(root, `${id}.rtf`), 'utf8')
	);
	await save('The lighthouse flickered over the harbor.');
	await initializeAsyncServices({ projectPath: root, sqliteOnly: true, source: () => source });
});

afterEach(async () => {
	try {
		await shutdownAsyncServices();
	} finally {
		store.close();
		jest.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	}
});

async function completed(jobId: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const status = await getJobStatus({ jobId, jobType: JobType.GENERATE_SUGGESTIONS });
		if (status.state !== 'active') return status;
		await setImmediate();
	}
	throw new Error('Suggestion fixture did not settle');
}

async function queued(params = request) {
	const result = await generateSuggestions({ ...params, async: true });
	if (!('jobId' in result)) throw new Error('Expected queued suggestions');
	return result.jobId;
}

test.each([false, true])(
	'sync and queued suggestions use identical saved-source contracts, context=%s',
	async (useContext) => {
		const read = jest.spyOn(source, 'read');
		const response = await tool.handler({ ...request, useContext }, {} as HandlerContext);
		expect(validateOutput(response.structuredContent).valid).toBe(true);
		expect(JSON.parse(response.content[0].text!)).toEqual(response.structuredContent);
		const sync = response.structuredContent as unknown as SuggestionResult;
		const status = await completed(await queued({ ...request, useContext }));
		expect(status.state).toBe('completed');
		const background = status.result as SuggestionResult;
		expect(background).toEqual({
			...sync,
			envelope: { ...sync.envelope, createdAt: expect.any(String) },
		});
		expect(chat).toHaveBeenCalledTimes(2);
		expect(chat.mock.calls[0]).toEqual(chat.mock.calls[1]);
		if (useContext) {
			const raw = await readFile(join(root, `${documentId}.rtf`), 'utf8');
			expect(sync.envelope.sourceRevisions).toEqual([
				{ documentId, revision: savedRevision(raw) },
			]);
			expect(sync.envelope.sourceFormat).toBe('saved-rtf');
			expect(sync.envelope.policy).toMatchObject({ mode: 'provider', revisionChecked: true });
			expect(chat.mock.calls[0][0]).toContain('BEGIN UNTRUSTED INPUT');
			expect(chat.mock.calls[0][0]).toContain('The lighthouse flickered over the harbor.');
			expect(chat.mock.calls[0][0]).not.toContain('\\rtf1');
		} else {
			expect(read).not.toHaveBeenCalled();
			expect(chat.mock.calls[0][0]).toBe(request.prompt);
			expect(sync.context).toEqual({ mode: 'none' });
			expect(sync.envelope.sourceRevisions).toEqual([]);
			expect(sync.envelope.policy.revisionChecked).toBe(false);
		}
	}
);

test('rejects a queued document revision changed after admission before sending provider context', async () => {
	const originalRead = source.read.bind(source);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	jest.spyOn(source, 'read')
		.mockImplementationOnce(originalRead)
		.mockImplementationOnce(async (id) => {
			entered();
			await gate;
			return originalRead(id);
		});
	const id = await queued();
	await ready;
	try {
		await save('The saved opening changed.');
	} finally {
		release();
	}
	expect(await completed(id)).toMatchObject({
		state: 'failed',
		error: expect.stringContaining('Saved source changed before'),
	});
	expect(chat).not.toHaveBeenCalled();
});

test.each([false, true])(
	'rejects changed saved text after provider completion, async=%s',
	async (background) => {
		chat.mockImplementationOnce(async () => {
			await save('Externally revised text.');
			return 'Advice for the old revision.';
		});
		if (background)
			expect(await completed(await queued())).toMatchObject({
				state: 'failed',
				error: expect.stringContaining('Saved source changed during'),
			});
		else
			await expect(generateSuggestions(request)).rejects.toThrow(
				'Saved source changed during'
			);
		expect(chat).toHaveBeenCalledTimes(1);
	}
);

test.each([15999, 16000, 16001])(
	'reports the exact saved excerpt boundary for %i characters',
	async (length) => {
		await save('x'.repeat(length));
		const result = (await generateSuggestions(request)) as SuggestionResult;
		expect(result.context).toEqual({
			mode: 'saved-document',
			start: 0,
			end: Math.min(length, 16000),
			sourceCharacters: length,
			truncated: length > 16000,
		});
		expect(chat.mock.calls[0][0]).toContain('x'.repeat(Math.min(length, 16000)));
		if (length > 16000) expect(chat.mock.calls[0][0]).not.toContain('x'.repeat(length));
	}
);

test('preserves Unicode pairs at the excerpt boundary', async () => {
	await save('x'.repeat(15999) + '🌙 tail');
	const result = (await generateSuggestions(request)) as SuggestionResult;
	expect(result.context).toEqual({
		mode: 'saved-document',
		start: 0,
		end: 15999,
		sourceCharacters: 16006,
		truncated: true,
	});
	expect(chat.mock.calls[0][0]).not.toContain('\uD83C');
});

test.each([15999, 16000, 16001])('bounds prompt admission at %i characters', async (length) => {
	const params = { prompt: 'x'.repeat(length) };
	expect(validateInput(params).valid).toBe(length <= 16000);
	if (length > 16000) {
		await expect(generateSuggestions(params)).rejects.toThrow('1–16000');
		expect(chat).not.toHaveBeenCalled();
	} else
		await expect(generateSuggestions(params)).resolves.toMatchObject({
			suggestions: expect.any(String),
		});
});

test.each([
	{ prompt: ' ', useContext: false },
	{ prompt: 'Review', useContext: true },
	{ ...request, documentId: '../outside' },
	{ ...request, useContext: 'true' },
	{ ...request, async: 'true' },
	{ ...request, content: 'caller-supplied replacement' },
])('rejects invalid or foreign context without provider access: %j', async (params) => {
	await expect(tool.handler(params, {} as HandlerContext)).rejects.toThrow();
	expect(chat).not.toHaveBeenCalled();
});

test('requires an open, matching source and advertises that input dependency', async () => {
	expect(validateInput({ prompt: 'Review', useContext: true }).valid).toBe(false);
	await initializeAsyncServices({
		projectPath: root,
		sqliteOnly: true,
		source: () => ({
			projectId: 'another-project',
			projectPath: root,
			list: () => source.list(),
			read: (id) => source.read(id),
		}),
	});
	await expect(generateSuggestions(request)).rejects.toThrow('different project');
	await shutdownAsyncServices();
	await initializeAsyncServices();
	await expect(generateSuggestions(request)).rejects.toThrow('open project');
	expect(chat).not.toHaveBeenCalled();
});

test.each(['failure', 'empty'])(
	'provider %s is explicit and has no partial successful result',
	async (mode) => {
		if (mode === 'failure') chat.mockRejectedValue(new Error('Fixture provider unavailable'));
		else chat.mockResolvedValue('');
		expect(await completed(await queued())).toMatchObject({ state: 'failed' });
		expect(chat).toHaveBeenCalledTimes(1);
	}
);

test('spools large suggestions without losing text, coverage or source revisions', async () => {
	const reply = '🌙 Lighthouse advice. '.repeat(1000);
	chat.mockResolvedValue(reply);
	const response = await tool.handler(request, {} as HandlerContext);
	expect(validateOutput(response.structuredContent).valid).toBe(true);
	expect(JSON.parse(response.content[0].text!)).toEqual(response.structuredContent);
	expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);
	const id = response.structuredContent!._ref as string;
	let offset: number | null = 0;
	let text = '';
	do {
		const page = readResult(id, offset, 4096);
		text += page.text;
		offset = page.nextOffset;
	} while (offset !== null);
	const result = JSON.parse(text) as SuggestionResult;
	expect(validateOutput(result).valid).toBe(true);
	expect(result.suggestions).toBe(reply);
	expect(result.context).toMatchObject({ mode: 'saved-document', truncated: false });
	expect(result.envelope.sourceRevisions[0].documentId).toBe(documentId);
	await rm(dirname(response.structuredContent!._file as string), {
		recursive: true,
		force: true,
	});
});
