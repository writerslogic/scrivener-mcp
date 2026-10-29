import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { getOrCreateProjectIdentity } from '../../src/services/editorial/project-identity.js';
import { SeriesBible } from '../../src/services/editorial/series-bible.js';
import {
	ContinuityService,
	type ContinuityReport,
} from '../../src/services/editorial/continuity-service.js';
import type { ManuscriptSource, SourceDocument } from '../../src/services/editorial/types.js';
import {
	checkPlotConsistency,
	initializeAsyncServices,
	shutdownAsyncServices,
	getJobStatus,
} from '../../src/handlers/async-handlers.js';
import { CachedSQLiteManager } from '../../src/handlers/database/keydb-cache.js';
import { JobType } from '../../src/services/queue/job-queue.js';

test('queued continuity shares canonical quoted findings and rejects changed saved revisions', async () => {
	const root = await mkdtemp(join(tmpdir(), 'scrivener-continuity-queue-'));
	const store = new PersistentStore(join(root, '.scrivener-mcp', 'editorial.sqlite'));
	const projectId = getOrCreateProjectIdentity(store);
	const documents: SourceDocument[] = ['Mara has blue eyes.', 'Mara has green eyes.'].map(
		(text, index) => ({
			projectId,
			documentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
			title: `Scene ${index + 1}`,
			path: `Draft/Scene ${index + 1}`,
			text,
			order: index,
			metadata: {},
			revision: createHash('sha256').update(text).digest('hex'),
		})
	);
	const source: ManuscriptSource = {
		projectId,
		projectPath: root,
		list: async () => documents,
		read: async (id) => {
			const document = documents.find((item) => item.documentId === id);
			if (!document) throw new Error('Unknown document');
			return document;
		},
	};
	const bible = new SeriesBible(source, store, store, async () => source);
	const continuity = new ContinuityService(source, store, bible);
	const cache = jest
		.spyOn(CachedSQLiteManager.prototype, 'initialize')
		.mockResolvedValue(undefined);
	const wait = async (jobId: string) => {
		for (let attempt = 0; attempt < 200; attempt++) {
			const status = await getJobStatus({ jobType: JobType.CHECK_CONSISTENCY, jobId });
			if (status.state === 'completed' || status.state === 'failed') return status;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		throw new Error('Continuity fixture job did not finish');
	};
	try {
		await initializeAsyncServices({
			projectPath: root,
			redisUrl: 'redis://127.0.0.1:1',
			sqliteOnly: true,
			continuity: (options) => continuity.analyze(options),
		});
		const request = {
			documents: documents.map((doc) => ({ id: doc.documentId, content: doc.text })),
		};
		const synchronous = (await checkPlotConsistency(request, {
			source,
			continuity,
		})) as ContinuityReport;
		expect(synchronous.issues).toHaveLength(1);
		const queued = await checkPlotConsistency(
			{ ...request, async: true },
			{ source, continuity }
		);
		if (!('jobId' in queued)) throw new Error('Expected an asynchronous job');
		const status = await wait(queued.jobId);
		expect(status.state).toBe('completed');
		const report = status.result as ContinuityReport;
		expect(report.coverage).toBe(synchronous.coverage);
		expect(
			report.issues.map(({ id, confidence, evidence, basis }) => ({
				id,
				confidence,
				evidence,
				basis,
			}))
		).toEqual(
			synchronous.issues.map(({ id, confidence, evidence, basis }) => ({
				id,
				confidence,
				evidence,
				basis,
			}))
		);
		const stale = await checkPlotConsistency(
			{ ...request, async: true },
			{ source, continuity }
		);
		if (!('jobId' in stale)) throw new Error('Expected an asynchronous job');
		documents[0] = {
			...documents[0],
			revision: 'f'.repeat(64),
			text: 'Saved external revision.',
		};
		expect(await wait(stale.jobId)).toMatchObject({
			state: 'failed',
			error: expect.stringContaining('Saved source changed'),
		});
		await expect(checkPlotConsistency(request, { source, continuity })).rejects.toThrow(
			/differs from the saved manuscript/
		);
	} finally {
		await shutdownAsyncServices();
		cache.mockRestore();
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});
