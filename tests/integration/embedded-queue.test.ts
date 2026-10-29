import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueueService, JobType } from '../../src/services/queue/job-queue.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';

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
		directory = await mkdtemp(join(tmpdir(), 'scrivener-embedded-'));
		queue = new JobQueueService(directory);
		await queue.initialize({ sqliteOnly: true });
	});

	afterEach(async () => {
		await queue.shutdown();
		await rm(directory, { recursive: true, force: true });
	});

	it('runs real local analysis and retains results through a queue restart without replay', async () => {
		expect(queue.getConnectionInfo()).toMatchObject({
			type: 'embedded',
			isConnected: true,
			legacyQueues: 'excluded',
		});
		const id = await queue.addJob(JobType.ANALYZE_DOCUMENT, {
			documentId: '00000000-0000-4000-8000-000000000001',
			content: 'Mira waited by the gate. The wind carried a distant bell across the harbor.',
			options: { includeReadability: true },
		});
		const completed = await queue.waitForJob(JobType.ANALYZE_DOCUMENT, id);
		expect(completed).toMatchObject({
			state: 'completed',
			progress: 100,
			result: { documentId: '00000000-0000-4000-8000-000000000001' },
		});
		await queue.shutdown();
		queue = new JobQueueService(directory);
		await queue.initialize({ sqliteOnly: true });
		expect(await queue.getJobStatus(JobType.ANALYZE_DOCUMENT, id)).toEqual(completed);
		expect(await queue.getJobStatus(JobType.CHECK_CONSISTENCY, id)).toBeNull();
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
		const failedId = await queue.addJob(JobType.EXPORT_PROJECT, {
			projectId: 'fixture',
			format: 'json',
		});
		expect(await queue.waitForJob(JobType.EXPORT_PROJECT, failedId)).toMatchObject({
			state: 'failed',
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
});
