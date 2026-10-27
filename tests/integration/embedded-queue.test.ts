import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueueService, JobType } from '../../src/services/queue/job-queue.js';

jest.mock('../../src/services/queue/keydb-detector.js', () => ({
	detectConnection: async () => ({ isAvailable: false, type: 'none' }),
	createBullMQConnection: () => { throw new Error('Embedded execution must not open an external queue connection'); },
}));

describe('embedded queue integration', () => {
	let directory: string;
	let queue: JobQueueService;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'scrivener-embedded-'));
		queue = new JobQueueService(directory);
		await queue.initialize();
	});

	afterEach(async () => {
		await queue.shutdown();
		await rm(directory, { recursive: true, force: true });
	});

	it('runs real local analysis and retains results through a queue restart without replay', async () => {
		expect(queue.getConnectionInfo()).toEqual({ type: 'embedded', isConnected: true });
		const id = await queue.addJob(JobType.ANALYZE_DOCUMENT, { documentId: '00000000-0000-4000-8000-000000000001', content: 'Mira waited by the gate. The wind carried a distant bell across the harbor.', options: { includeReadability: true } });
		const completed = await queue.waitForJob(JobType.ANALYZE_DOCUMENT, id);
		expect(completed).toMatchObject({ state: 'completed', progress: 100, result: { documentId: '00000000-0000-4000-8000-000000000001' } });
		await queue.shutdown();
		queue = new JobQueueService(directory);
		await queue.initialize();
		expect(await queue.getJobStatus(JobType.ANALYZE_DOCUMENT, id)).toEqual(completed);
		expect(await queue.getJobStatus(JobType.CHECK_CONSISTENCY, id)).toBeNull();
	});

	it('keeps cancellation terminal and reports failed jobs as failures', async () => {
		const cancelledId = await queue.addJob(JobType.ANALYZE_DOCUMENT, { documentId: 'cancelled', content: 'No processing should occur.' });
		await queue.cancelJob(JobType.ANALYZE_DOCUMENT, cancelledId);
		expect(await queue.waitForJob(JobType.ANALYZE_DOCUMENT, cancelledId)).toMatchObject({ state: 'cancelled' });
		const failedId = await queue.addJob(JobType.EXPORT_PROJECT, { projectId: 'fixture', format: 'json' });
		expect(await queue.waitForJob(JobType.EXPORT_PROJECT, failedId)).toMatchObject({ state: 'failed' });
	});
});
