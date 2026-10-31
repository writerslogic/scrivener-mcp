import { mkdir, mkdtemp, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueueService, JobType } from '../../src/services/queue/job-queue.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { createHash } from 'node:crypto';
import { AIClient } from '../../src/services/ai/ai-client.js';
import { ContentAnalyzer } from '../../src/analysis/base-analyzer.js';

jest.mock('../../src/services/queue/keydb-detector.js', () => ({
	detectConnection: async () => ({ isAvailable: false, type: 'none' }),
	createBullMQConnection: () => {
		throw new Error('Embedded execution must not open an external queue connection');
	},
}));

describe('embedded queue integration', () => {
	let directory: string;
	let queue: JobQueueService;

	beforeEach(async () => {
		jest.spyOn(AIClient.prototype, 'isAvailable', 'get').mockReturnValue(false);
		directory = await mkdtemp(join(tmpdir(), 'scrivener-embedded-'));
		queue = new JobQueueService(directory);
		await queue.initialize({ sqliteOnly: true });
	});

	afterEach(async () => {
		await queue.shutdown();
		await rm(directory, { recursive: true, force: true });
		jest.restoreAllMocks();
	});

	it('runs real local analysis and retains results through a queue restart without replay', async () => {
		expect(await readdir(join(directory, '.scrivener-mcp'))).not.toContain('queue-state.json');
		expect(queue.getConnectionInfo()).toMatchObject({
			type: 'embedded',
			isConnected: true,
			legacyQueues: 'excluded',
		});
		const id = await queue.addJob(JobType.ANALYZE_DOCUMENT, {
			documentId: '00000000-0000-4000-8000-000000000001',
			content: 'Mira waited by the gate. The wind carried a distant bell across the harbor.',
		});
		const completed = await queue.waitForJob(JobType.ANALYZE_DOCUMENT, id);
		expect(completed).toMatchObject({
			state: 'completed',
			progress: 100,
			result: {
				documentId: '00000000-0000-4000-8000-000000000001',
				analysis: { metrics: { wordCount: 14 }, style: { dialoguePercentage: 0 } },
				readability: { availability: 'available', fleschReadingEase: expect.any(Number) },
				envelope: {
					sourceFormat: 'supplied-text',
					policy: { mode: 'raw', revisionChecked: false, providerAccess: false },
				},
			},
		});
		await queue.shutdown();
		queue = new JobQueueService(directory);
		await queue.initialize({ sqliteOnly: true });
		expect(await queue.getJobStatus(JobType.ANALYZE_DOCUMENT, id)).toEqual(completed);
		expect(await queue.getJobStatus(JobType.CHECK_CONSISTENCY, id)).toBeNull();
	});

	it('analyzes the admitted text snapshot even if the caller mutates its request', async () => {
		const original =
			'Mira waited by the gate. 🌙 The wind carried a distant bell across the harbor.';
		const data = {
			documentId: 'original',
			content: original,
			options: { includeReadability: true },
		};
		const id = await queue.addJob(JobType.ANALYZE_DOCUMENT, data);
		data.documentId = 'replacement';
		data.content = 'Changed after admission.';
		data.options.includeReadability = false;
		expect(await queue.waitForJob(JobType.ANALYZE_DOCUMENT, id)).toMatchObject({
			state: 'completed',
			result: {
				documentId: 'original',
				readability: { availability: 'available' },
				envelope: {
					sourceRevisions: [
						{
							documentId: 'original',
							revision: createHash('sha256').update(original).digest('hex'),
						},
					],
				},
			},
		});
	});

	it('reports unavailable empty-text metrics and keeps independent analysis when NER is unavailable', async () => {
		const result = await queue.analyzeDocument({
			documentId: 'empty',
			content: '',
			options: { includeEntities: true, includeSentiment: true },
		});
		expect(result).toMatchObject({
			analysis: { metrics: { wordCount: 0 } },
			readability: {
				availability: 'unavailable',
				reason: 'no_words',
				fleschReadingEase: null,
				fleschKincaidGrade: null,
			},
			sentiment: {
				availability: 'unavailable',
				reason: 'no_words',
				score: null,
				comparative: null,
				emotion: null,
			},
		});
		expect(result.entities).toHaveProperty('availability');
		if ((result.entities as { availability: string }).availability === 'unavailable')
			expect(result.entities).toMatchObject({ reason: expect.any(String), value: null });
	});

	it.each([
		['happy', 1],
		['sad', -1],
	] as const)(
		'returns measured local lexicon sentiment for %s without a readability projection',
		async (word, sign) => {
			const result = await queue.analyzeDocument({
				documentId: word,
				content: `Mira felt ${word}.`,
				options: { includeReadability: false, includeSentiment: true },
			});
			expect(result).not.toHaveProperty('readability');
			expect(result).not.toHaveProperty('entities');
			expect(result).toHaveProperty('analysis');
			expect(result.sentiment).toMatchObject({
				availability: 'available',
				method: 'local-lexicon',
			});
			expect((result.sentiment as { score: number }).score * sign).toBeGreaterThan(0);
		}
	);

	it('preserves project document order and per-document provenance', async () => {
		const documents = [
			{ id: 'second', content: 'Mira waited by the gate.' },
			{ id: 'first', content: 'The boat crossed the harbor.' },
		];
		const id = await queue.addJob(JobType.ANALYZE_PROJECT, { projectId: 'fixture', documents });
		documents.reverse();
		const completed = await queue.waitForJob(JobType.ANALYZE_PROJECT, id);
		expect(completed).toMatchObject({
			state: 'completed',
			result: {
				documents: [
					{
						documentId: 'second',
						envelope: {
							sourceFormat: 'supplied-text',
							sourceRevisions: [
								{
									documentId: 'second',
									revision: createHash('sha256')
										.update('Mira waited by the gate.')
										.digest('hex'),
								},
							],
						},
					},
					{
						documentId: 'first',
						envelope: {
							sourceFormat: 'supplied-text',
							sourceRevisions: [
								{
									documentId: 'first',
									revision: createHash('sha256')
										.update('The boat crossed the harbor.')
										.digest('hex'),
								},
							],
						},
					},
				],
			},
		});
	});

	it('rejects a redirected project state directory before creating external state', async () => {
		const redirected = join(directory, 'Linked.scriv');
		const outside = join(directory, 'external-state');
		await mkdir(redirected);
		await mkdir(outside);
		await symlink(
			outside,
			join(redirected, '.scrivener-mcp'),
			process.platform === 'win32' ? 'junction' : 'dir'
		);
		const unsafe = new JobQueueService(redirected);
		try {
			await expect(unsafe.initialize({ sqliteOnly: true })).rejects.toMatchObject({
				details: { message: expect.stringMatching(/symlink|outside/i) },
			});
			expect(await readdir(outside)).toEqual([]);
		} finally {
			await unsafe.shutdown();
		}
	});

	it('keeps cancellation terminal and reports failed jobs as failures', async () => {
		const cancelledId = await queue.addJob(JobType.ANALYZE_DOCUMENT, {
			documentId: 'cancelled',
			content: 'No processing should occur.',
		});
		await queue.cancelJob(JobType.ANALYZE_DOCUMENT, cancelledId);
		expect(await queue.waitForJob(JobType.ANALYZE_DOCUMENT, cancelledId)).toMatchObject({
			state: 'cancelled',
		});
		const failedId = await queue.addJob(JobType.GENERATE_SUGGESTIONS, {
			documentId: 'fixture',
			prompt: 'Review this scene.',
		});
		expect(await queue.waitForJob(JobType.GENERATE_SUGGESTIONS, failedId)).toMatchObject({
			state: 'failed',
		});
		expect(await queue.getQueueStats(JobType.ANALYZE_DOCUMENT)).toMatchObject({
			active: 0,
			cancelled: 1,
			failed: 0,
		});
		expect(await queue.getQueueStats(JobType.GENERATE_SUGGESTIONS)).toMatchObject({
			active: 0,
			cancelled: 0,
			failed: 1,
		});
	});

	it('rejects unsupported scheduling before admitting a job and accepts ordinary local execution', async () => {
		const data = { documentId: 'local', content: 'A quiet scene.' };
		for (const options of [{ priority: 1 }, { delay: 1 }])
			await expect(queue.addJob(JobType.ANALYZE_DOCUMENT, data, options)).rejects.toThrow(
				/requires Redis/
			);
		expect(await queue.getQueueStats(JobType.ANALYZE_DOCUMENT)).toMatchObject({
			active: 0,
			completed: 0,
			failed: 0,
		});
		const id = await queue.addJob(JobType.ANALYZE_DOCUMENT, data, { priority: 0, delay: 0 });
		expect(await queue.waitForJob(JobType.ANALYZE_DOCUMENT, id)).toMatchObject({
			state: 'completed',
		});
	});

	it('separates copied project identities and rejects foreign status and cancellation', async () => {
		const otherPath = join(directory, 'Copied.scriv');
		await mkdir(otherPath);
		const original = new PersistentStore(join(directory, '.scrivener-mcp', 'editorial.sqlite'));
		const copied = new PersistentStore(join(otherPath, '.scrivener-mcp', 'editorial.sqlite'));
		try {
			copied.put('identity', 'project', original.get('identity', 'project'));
		} finally {
			original.close();
			copied.close();
		}
		const other = new JobQueueService(otherPath);
		try {
			await other.initialize({ sqliteOnly: true });
			expect(other.getConnectionInfo().scopeId).not.toBe(queue.getConnectionInfo().scopeId);
			const id = await queue.addJob(JobType.ANALYZE_DOCUMENT, {
				documentId: 'shared',
				content: 'An original scene.',
			});
			expect(await other.getJobStatus(JobType.ANALYZE_DOCUMENT, id)).toBeNull();
			await expect(other.cancelJob(JobType.ANALYZE_DOCUMENT, id)).rejects.toThrow(
				/selected project/
			);
			expect(await queue.waitForJob(JobType.ANALYZE_DOCUMENT, id)).toMatchObject({
				state: 'completed',
			});
		} finally {
			await other.shutdown();
		}
	});

	it('does not admit or execute a job when its initial durable write fails', async () => {
		const analyze = jest.spyOn(ContentAnalyzer.prototype, 'analyzeContent');
		const originalPut = PersistentStore.prototype.put;
		const fault = jest.spyOn(PersistentStore.prototype, 'put').mockImplementation(function (
			this: PersistentStore,
			namespace: string,
			id: string,
			value: unknown
		) {
			if (namespace.startsWith('embedded-jobs:')) throw new Error('Injected write failure');
			originalPut.call(this, namespace, id, value);
		});
		try {
			await expect(
				queue.addJob(JobType.ANALYZE_DOCUMENT, {
					documentId: 'scene',
					content: 'Mira waited.',
				})
			).rejects.toThrow(/write failure/);
			expect(await queue.getQueueStats(JobType.ANALYZE_DOCUMENT)).toMatchObject({
				active: 0,
				completed: 0,
				failed: 0,
			});
			expect(analyze).not.toHaveBeenCalled();
		} finally {
			fault.mockRestore();
		}
	});

	it('does not resurrect a completed job from a stale memory copy after its durable record is removed', async () => {
		const id = await queue.addJob(JobType.ANALYZE_DOCUMENT, {
			documentId: 'scene',
			content: 'Mira waited.',
		});
		expect(await queue.waitForJob(JobType.ANALYZE_DOCUMENT, id)).toMatchObject({
			state: 'completed',
		});
		const store = new PersistentStore(join(directory, '.scrivener-mcp', 'editorial.sqlite'));
		try {
			store.delete(`embedded-jobs:${queue.getConnectionInfo().scopeId}`, id);
		} finally {
			store.close();
		}
		expect(await queue.getJobStatus(JobType.ANALYZE_DOCUMENT, id)).toBeNull();
		expect(await queue.getQueueStats(JobType.ANALYZE_DOCUMENT)).toMatchObject({
			active: 0,
			completed: 0,
		});
	});

	it('retries only terminal persistence after storage recovers, retaining the original result across restart', async () => {
		const analyze = jest.spyOn(ContentAnalyzer.prototype, 'analyzeContent');
		const originalPut = PersistentStore.prototype.put;
		const fault = jest.spyOn(PersistentStore.prototype, 'put').mockImplementation(function (
			this: PersistentStore,
			namespace: string,
			id: string,
			value: unknown
		) {
			if (
				namespace.startsWith('embedded-jobs:') &&
				(value as { state: string }).state !== 'active'
			)
				throw new Error('Injected terminal write failure');
			originalPut.call(this, namespace, id, value);
		});
		let id: string;
		try {
			id = await queue.addJob(JobType.ANALYZE_DOCUMENT, {
				documentId: 'scene',
				content: 'Mira waited by the gate.',
			});
			await expect(queue.waitForJob(JobType.ANALYZE_DOCUMENT, id)).rejects.toThrow(
				/awaiting durable storage/
			);
			await expect(queue.getJobStatus(JobType.ANALYZE_DOCUMENT, id)).rejects.toThrow(
				/awaiting durable storage/
			);
			await expect(queue.getQueueStats(JobType.ANALYZE_DOCUMENT)).rejects.toThrow(
				/awaiting durable storage/
			);
			expect(analyze).toHaveBeenCalledTimes(1);
		} finally {
			fault.mockRestore();
		}
		const completed = await queue.getJobStatus(JobType.ANALYZE_DOCUMENT, id!);
		expect(completed).toMatchObject({
			state: 'completed',
			result: { documentId: 'scene', readability: { availability: 'available' } },
		});
		expect(analyze).toHaveBeenCalledTimes(1);
		await queue.shutdown();
		queue = new JobQueueService(directory);
		await queue.initialize({ sqliteOnly: true });
		expect(await queue.getJobStatus(JobType.ANALYZE_DOCUMENT, id!)).toEqual(completed);
		expect(analyze).toHaveBeenCalledTimes(1);
	});

	it('closes resources on persistent write failure and marks the abandoned same-process job interrupted without replay', async () => {
		const analyze = jest.spyOn(ContentAnalyzer.prototype, 'analyzeContent');
		const dispose = jest.spyOn(ContentAnalyzer.prototype, 'dispose');
		const originalPut = PersistentStore.prototype.put;
		const fault = jest.spyOn(PersistentStore.prototype, 'put').mockImplementation(function (
			this: PersistentStore,
			namespace: string,
			id: string,
			value: unknown
		) {
			if (
				namespace.startsWith('embedded-jobs:') &&
				(value as { state: string }).state !== 'active'
			)
				throw new Error('Injected terminal write failure');
			originalPut.call(this, namespace, id, value);
		});
		let id: string;
		try {
			id = await queue.addJob(JobType.ANALYZE_DOCUMENT, {
				documentId: 'scene',
				content: 'Mira waited.',
			});
			await expect(queue.waitForJob(JobType.ANALYZE_DOCUMENT, id)).rejects.toThrow(
				/durable storage/
			);
			await expect(queue.shutdown()).rejects.toThrow(/durable storage/);
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			fault.mockRestore();
		}
		queue = new JobQueueService(directory);
		await queue.initialize({ sqliteOnly: true });
		expect(await queue.getJobStatus(JobType.ANALYZE_DOCUMENT, id!)).toMatchObject({
			state: 'interrupted',
			error: expect.stringMatching(/not automatically replayed/),
		});
		expect(await queue.getQueueStats(JobType.ANALYZE_DOCUMENT)).toMatchObject({
			active: 0,
			failed: 1,
		});
		expect(analyze).toHaveBeenCalledTimes(1);
	});
});
