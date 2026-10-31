import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { AIWritingService } from '../../src/services/ai/ai-writing-service.js';
import { AIClient } from '../../src/services/ai/ai-client.js';
import { HMSVectorStore } from '../../src/services/ai/hms-vector-store.js';
import {
	initializeAsyncServices,
	shutdownAsyncServices,
	buildVectorStore,
	semanticSearch,
	getJobStatus,
} from '../../src/handlers/async-handlers.js';
import { JobType } from '../../src/services/queue/job-queue.js';

jest.mock('../../src/services/queue/keydb-detector.js', () => ({
	detectConnection: async () => ({ isAvailable: false, type: 'none' }),
	createBullMQConnection: () => {
		throw new Error('Tests require an embedded queue');
	},
}));

const original = {
	id: 'scene',
	title: 'Original title',
	type: 'Text' as const,
	path: 'scene.rtf',
	content: 'harbor lighthouse',
	metadata: { revision: 'original-revision' },
};
let directory: string;
let service: AIWritingService;

beforeEach(async () => {
	jest.spyOn(AIClient.prototype, 'isAvailable', 'get').mockReturnValue(false);
	jest.spyOn(AIClient.prototype, 'chat').mockRejectedValue(
		new Error('Provider calls are forbidden in these local tests')
	);
	directory = await mkdtemp(join(tmpdir(), 'scrivener-writing-index-'));
	service = new AIWritingService();
});

afterEach(async () => {
	try {
		await shutdownAsyncServices();
		await service.close();
		expect(AIClient.prototype.chat).not.toHaveBeenCalled();
	} finally {
		jest.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	}
});

async function complete(jobId: string | undefined): Promise<void> {
	if (!jobId) throw new Error('Expected a queued index update');
	for (let attempt = 0; attempt < 100; attempt++) {
		const status = await getJobStatus({ jobType: JobType.BUILD_VECTOR_STORE, jobId });
		if (status.state === 'completed') return;
		if (status.state !== 'active') throw new Error(`Index job failed: ${status.error}`);
		await setImmediate();
	}
	throw new Error('Index update did not settle');
}

test('queued indexing and foreground search share one local index, retain metadata and honor rebuild', async () => {
	await initializeAsyncServices({ projectPath: directory, sqliteOnly: true });
	await complete((await buildVectorStore({ documents: [original] })).jobId);
	expect((await semanticSearch({ query: 'harbor' })).results).toMatchObject([
		{
			metadata: {
				id: 'scene',
				title: 'Original title',
				version: 'original-revision',
				sourceUri: 'scene.rtf',
			},
		},
	]);
	await complete(
		(
			await buildVectorStore({
				documents: [
					{
						...original,
						id: 'replacement',
						title: 'Replacement title',
						content: 'orchard violet',
						metadata: { revision: 'replacement-revision' },
					},
				],
				rebuild: true,
			})
		).jobId
	);
	expect((await semanticSearch({ query: 'harbor' })).results).toEqual([]);
	expect((await semanticSearch({ query: 'orchard' })).results).toMatchObject([
		{
			metadata: {
				id: 'replacement',
				title: 'Replacement title',
				version: 'replacement-revision',
			},
		},
	]);
});

test('stages a replacement before retiring the current index and retains old passages on validation failure', async () => {
	await service.buildVectorStore([original]);
	await expect(
		service.buildVectorStore(
			[
				{ ...original, content: 'new needle' },
				{ ...original, content: 'duplicate needle' },
			],
			{ rebuild: true }
		)
	).rejects.toThrow(/unique/);
	expect(await service.semanticSearch('harbor')).toMatchObject([
		{ metadata: { id: 'scene', version: 'original-revision' } },
	]);
	expect(await service.semanticSearch('needle')).toEqual([]);
});

test('captures source text and revision before a deferred build begins', async () => {
	const document = { ...original, metadata: { revision: 'snapshot-revision' } };
	const writing = service.buildVectorStore([document]);
	document.content = 'later orchid';
	document.metadata.revision = 'later-revision';
	await writing;
	expect(await service.semanticSearch('harbor')).toMatchObject([
		{ version: 'snapshot-revision' },
	]);
	expect(await service.semanticSearch('orchid')).toEqual([]);
});

test('an explicit empty rebuild removes stale passages', async () => {
	await service.buildVectorStore([original]);
	await service.buildVectorStore([], { rebuild: true });
	expect(await service.semanticSearch('harbor')).toEqual([]);
});

test('retains failed cleanup ownership for retry while the replacement remains searchable', async () => {
	await service.buildVectorStore([original]);
	const close = jest
		.spyOn(HMSVectorStore.prototype, 'close')
		.mockRejectedValueOnce(new Error('Injected close failure'));
	await expect(
		service.buildVectorStore([{ ...original, content: 'orchard violet' }], { rebuild: true })
	).rejects.toThrow(/cleanup/);
	const oldStore = close.mock.contexts[0];
	expect(await service.semanticSearch('orchard')).toHaveLength(1);
	await service.close();
	await expect(oldStore.similaritySearch('harbor')).rejects.toThrow(/closed/);
});

test.each([4095, 4096, 4097])('bounds index admission at %i documents', async (count) => {
	const documents = Array.from({ length: count }, (_, id) => ({
		...original,
		id: String(id),
		content: '',
	}));
	const writing = service.buildVectorStore(documents);
	if (count > 4096) await expect(writing).rejects.toThrow(/4096/);
	else await expect(writing).resolves.toBeUndefined();
});

test('retains a failed replacement for cleanup retry when creation and cleanup both fail', async () => {
	const add = jest
		.spyOn(HMSVectorStore.prototype, 'addDocuments')
		.mockRejectedValueOnce(new Error('Injected build failure'));
	const close = jest
		.spyOn(HMSVectorStore.prototype, 'close')
		.mockRejectedValueOnce(new Error('Injected cleanup failure'));
	await expect(service.buildVectorStore([original])).rejects.toThrow(/build and cleanup/);
	const abandonedStore = close.mock.contexts[0];
	add.mockRestore();
	close.mockRestore();
	await service.buildVectorStore([original]);
	await expect(abandonedStore.similaritySearch('harbor')).rejects.toThrow(/closed/);
	expect(await service.semanticSearch('harbor')).toHaveLength(1);
});
