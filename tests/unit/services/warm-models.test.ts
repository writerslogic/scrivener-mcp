import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalEmbedder, createLocalReranker } from 'writerslogic-warm/semantic';
import { loadWarmModels } from '../../../src/services/memory/warm-models.js';

jest.mock('writerslogic-warm/semantic', () => ({
	createLocalEmbedder: jest.fn(),
	createLocalReranker: jest.fn(),
}));

const embed = jest.mocked(createLocalEmbedder);
const rerank = jest.mocked(createLocalReranker);
let directory: string;
let previous: Record<string, string | undefined>;
const names = [
	'EMBED_MODEL_PATH',
	'EMBED_MODEL_ID',
	'EMBED_REVISION',
	'RERANK_MODEL_PATH',
	'MODEL_DTYPE',
	'QUERY_PREFIX',
	'DOCUMENT_PREFIX',
].map((name) => 'SCRIVENER_WARM_' + name);

beforeEach(async () => {
	previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	directory = await mkdtemp(join(tmpdir(), 'warm-models-'));
	jest.resetAllMocks();
});
afterEach(async () => {
	for (const name of names) {
		if (previous[name] === undefined) delete process.env[name];
		else process.env[name] = previous[name];
	}
	await rm(directory, { recursive: true, force: true });
});

function configure(): void {
	process.env.SCRIVENER_WARM_EMBED_MODEL_PATH = directory;
	process.env.SCRIVENER_WARM_EMBED_MODEL_ID = 'fixture-local-model';
	process.env.SCRIVENER_WARM_EMBED_REVISION = 'revision-1';
	embed.mockResolvedValue({
		space: {
			model: 'fixture-local-model',
			revision: 'revision-1',
			dimensions: 2,
			normalization: 'l2',
			metric: 'cosine',
		},
		encodeQuery: async () => [1, 0],
		encodeDocuments: async (texts) => texts.map(() => [1, 0]),
		dispose: jest.fn(async () => undefined),
	});
}

it('does not load models without explicit local configuration', async () => {
	expect(await loadWarmModels()).toBeUndefined();
	expect(embed).not.toHaveBeenCalled();
	expect(rerank).not.toHaveBeenCalled();
});
it.each(['relative/model', 'https://example.invalid/model'])(
	'rejects nonlocal path %s',
	async (path) => {
		configure();
		process.env.SCRIVENER_WARM_EMBED_MODEL_PATH = path;
		await expect(loadWarmModels()).rejects.toThrow('absolute paths');
		expect(embed).not.toHaveBeenCalled();
	}
);
it('requires an explicit revision and disposes the first model if the second cannot load', async () => {
	configure();
	delete process.env.SCRIVENER_WARM_EMBED_REVISION;
	await expect(loadWarmModels()).rejects.toThrow('explicit model ID and revision');
	expect(embed).not.toHaveBeenCalled();
	process.env.SCRIVENER_WARM_EMBED_REVISION = 'revision-1';
	process.env.SCRIVENER_WARM_RERANK_MODEL_PATH = directory;
	rerank.mockRejectedValue(new Error('model unavailable'));
	await expect(loadWarmModels()).rejects.toThrow('model unavailable');
	const model = await embed.mock.results[0].value;
	expect(model.dispose).toHaveBeenCalledTimes(1);
});
it('passes local model identity and retries failed disposal without releasing successful owners twice', async () => {
	configure();
	process.env.SCRIVENER_WARM_RERANK_MODEL_PATH = directory;
	process.env.SCRIVENER_WARM_MODEL_DTYPE = 'q8';
	const dispose = jest.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
	rerank.mockResolvedValue(
		Object.assign(async (_query: string, passages: string[]) => passages.map(() => 1), {
			dispose,
		})
	);
	const models = (await loadWarmModels())!;
	expect(embed).toHaveBeenCalledWith(
		expect.objectContaining({
			modelId: 'fixture-local-model',
			revision: 'revision-1',
			dtype: 'q8',
		})
	);
	await expect(models.close()).rejects.toThrow('failed to close');
	await models.close();
	await models.close();
	expect(models.embedder!.dispose).toHaveBeenCalledTimes(1);
	expect(dispose).toHaveBeenCalledTimes(2);
});
it.each([511, 512, 513])('bounds model identity to 512 bytes: %d', async (length) => {
	configure();
	process.env.SCRIVENER_WARM_EMBED_MODEL_ID = 'x'.repeat(length);
	if (length > 512) await expect(loadWarmModels()).rejects.toThrow('bounded');
	else await (await loadWarmModels())!.close();
});
