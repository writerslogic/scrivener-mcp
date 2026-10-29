import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

async function within(operation, label, milliseconds = 10_000) {
	let timer;
	try {
		return await Promise.race([
			operation,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function settledJob(service, type, id, expected = 'completed') {
	const expires = Date.now() + 10_000;
	while (Date.now() < expires) {
		const job = await within(service.getJobStatus(type, id), 'Scoped job lookup');
		if (job) {
			const state = await within(job.getState(), 'Scoped job state');
			if (state === expected) return job;
			assert.ok(state !== 'failed' || expected === 'failed', 'Scoped fixture job failed');
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('Scoped fixture job did not settle');
}

export async function verifyProjectQueueIsolation({ redisUrl, rootDirectory }) {
	assert.ok(isAbsolute(rootDirectory), 'Queue fixture root must be absolute');
	const endpoint = new URL(redisUrl);
	assert.ok(
		endpoint.protocol === 'redis:' &&
			['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) &&
			endpoint.port !== '0',
		'Queue verifier requires its caller-owned loopback Redis endpoint'
	);
	const root = await mkdtemp(join(rootDirectory, 'project-queue-isolation-'));
	const variables = new Set([
		...Object.keys(process.env).filter((name) => /(?:API_KEY|TOKEN|SECRET|PASSWORD|^NEO4J_)/i.test(name)),
		'SCRIVENER_LOCAL_ONLY', 'SCRIVENER_DISABLE_KEY_DISCOVERY', 'SCRIVENER_HMS_ENGINE',
		'KEYDB_URL', 'REDIS_URL', 'NEO4J_AUTO_INSTALL', 'NEO4J_INTERACTIVE',
	]);
	const previous = new Map([...variables].map((name) => [name, process.env[name]]));
	const services = new Set();
	const stores = new Set();
	const queues = new Set();
	let connection;
	let failure;
	const checks = [];
	try {
		for (const name of variables) delete process.env[name];
		Object.assign(process.env, {
			SCRIVENER_LOCAL_ONLY: 'true', SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
			SCRIVENER_HMS_ENGINE: 'fallback', NEO4J_AUTO_INSTALL: 'false', NEO4J_INTERACTIVE: 'false',
			KEYDB_URL: redisUrl, REDIS_URL: redisUrl,
		});
		const [{ JobQueueService, JobType }, { PersistentStore }, { getOrCreateProjectIdentity },
			{ createQueueScope, scopedJobId }, { SQLiteManager }, { createBullMQConnection }, { Queue }] = await Promise.all([
			import('../dist/services/queue/job-queue.js'),
			import('../dist/services/editorial/persistent-store.js'),
			import('../dist/services/editorial/project-identity.js'),
			import('../dist/services/queue/project-scope.js'),
			import('../dist/handlers/database/sqlite-manager.js'),
			import('../dist/services/queue/keydb-detector.js'),
			import('bullmq'),
		]);
		const paths = [join(root, 'First.scriv'), join(root, 'Copied.scriv')];
		await Promise.all(paths.map((path) => mkdir(path)));
		const identityStores = [];
		let identity;
		try {
			for (const path of paths) {
				const store = new PersistentStore(join(path, '.scrivener-mcp', 'editorial.sqlite'));
				identityStores.push(store);
				stores.add(store);
			}
			identity = getOrCreateProjectIdentity(identityStores[0]);
			identityStores[1].put('identity', 'project', identity);
		} finally {
			for (const store of identityStores) {
				store.close();
				stores.delete(store);
			}
		}
		const scopes = await Promise.all(paths.map(async (path) => createQueueScope(identity, await realpath(path))));
		const open = async (path) => {
			const service = new JobQueueService(path);
			services.add(service);
			await within(service.initialize({ redisUrl, sqliteOnly: true }), 'Production project queue startup', 20_000);
			assert.equal(service.getConnectionInfo().type, 'redis');
			return service;
		};
		let first = await open(paths[0]);
		const second = await open(paths[1]);
		assert.notEqual(first.getConnectionInfo().scopeId, second.getConnectionInfo().scopeId);
		assert.equal(first.getConnectionInfo().scopeId, scopes[0].id);
		checks.push('copied-identities-have-independent-production-queues');
		const sharedId = '11111111-1111-4111-8111-111111111111';
		const data = (title) => ({ documents: [{ id: sharedId, content: 'An original synthetic scene.', metadata: { title } }] });
		const ids = await Promise.all([
			first.addJob(JobType.SYNC_DATABASE, data('First project')),
			second.addJob(JobType.SYNC_DATABASE, data('Second project')),
		]);
		await Promise.all([
			settledJob(first, JobType.SYNC_DATABASE, ids[0]),
			settledJob(second, JobType.SYNC_DATABASE, ids[1]),
		]);
		assert.equal(await first.getJobStatus(JobType.SYNC_DATABASE, ids[1]), null);
		assert.equal(await second.getJobStatus(JobType.SYNC_DATABASE, ids[0]), null);
		const databases = [];
		for (const path of paths) {
			const sqlite = new SQLiteManager(join(path, '.scrivener-databases', 'scrivener.db'));
			stores.add(sqlite);
			await within(sqlite.initialize(), 'Fixture database observation');
			databases.push(sqlite);
		}
		const title = (index) => databases[index].query('SELECT title FROM documents WHERE id = ?', [sharedId]);
		assert.deepEqual(title(0), [{ title: 'First project' }]);
		assert.deepEqual(title(1), [{ title: 'Second project' }]);
		checks.push('overlapping-document-identities-persist-only-in-own-sqlite');
		const delayed = await first.addJob(JobType.SYNC_DATABASE, data('Cancelled fixture'), { delay: 60_000 });
		await assert.rejects(second.cancelJob(JobType.SYNC_DATABASE, delayed), /selected project/);
		assert.ok(await first.getJobStatus(JobType.SYNC_DATABASE, delayed));
		await first.cancelJob(JobType.SYNC_DATABASE, delayed);
		assert.equal(await first.getJobStatus(JobType.SYNC_DATABASE, delayed), null);
		checks.push('foreign-status-and-cancellation-cannot-access-own-jobs');
		const reopenId = await first.addJob(JobType.SYNC_DATABASE, data('After reopen'), { delay: 60_000 });
		await within(first.shutdown(), 'First project retirement');
		services.delete(first);
		first = await open(paths[0]);
		const retained = await first.getJobStatus(JobType.SYNC_DATABASE, reopenId);
		assert.ok(retained);
		assert.equal(await retained.getState(), 'delayed');
		await retained.promote();
		await settledJob(first, JobType.SYNC_DATABASE, reopenId);
		assert.deepEqual(title(0), [{ title: 'After reopen' }]);
		assert.deepEqual(title(1), [{ title: 'Second project' }]);
		checks.push('same-project-pending-jobs-survive-service-reopen');
		connection = createBullMQConnection(redisUrl);
		connection.on('error', () => undefined);
		const scoped = new Queue(JobType.SYNC_DATABASE, { connection, prefix: scopes[0].prefix });
		queues.add(scoped);
		for (const foreign of [false, true]) {
			const id = scopedJobId(scopes[0]);
			const payload = data('Foreign payload must not persist');
			const envelope = foreign ? { version: 1, projectId: identity, scopeId: scopes[1].id, jobType: JobType.SYNC_DATABASE, payload } : payload;
			const injected = await scoped.add(JobType.SYNC_DATABASE, envelope, { jobId: id, attempts: 3 });
			await within((async () => {
				while (await injected.getState() !== 'failed') await new Promise((resolve) => setTimeout(resolve, 20));
			})(), 'Invalid envelope rejection');
			const rejected = await scoped.getJob(id);
			assert.ok(rejected);
			assert.match(rejected.failedReason, /ownership/);
			assert.equal(rejected.attemptsMade, 1);
		}
		assert.deepEqual(title(0), [{ title: 'After reopen' }]);
		assert.deepEqual(title(1), [{ title: 'Second project' }]);
		checks.push('foreign-and-legacy-envelopes-fail-before-project-writes');
		const legacy = new Queue(JobType.SYNC_DATABASE, { connection });
		queues.add(legacy);
		const old = await legacy.add(JobType.SYNC_DATABASE, data('Legacy must remain untouched'), { jobId: `legacy-fixture-${randomUUID()}` });
		const witness = await first.addJob(JobType.SYNC_DATABASE, data('After reopen'));
		await settledJob(first, JobType.SYNC_DATABASE, witness);
		assert.equal(await old.getState(), 'waiting');
		assert.equal(first.getConnectionInfo().legacyQueues, 'excluded');
		assert.match(first.getConnectionInfo().migrationNotice, /unchanged/);
		checks.push('unscoped-legacy-jobs-remain-untouched-and-disclosed');
	} catch (error) {
		failure = error;
	} finally {
		const results = await Promise.allSettled([
			...[...services].map((service) => within(service.shutdown(), 'Scoped service shutdown', 5000)),
			...[...queues].map((queue) => within(queue.close(), 'Fixture producer shutdown', 5000)),
		]);
		const cleanup = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
		for (const store of stores) {
			try { await store.close(); } catch (error) { cleanup.push(error); }
		}
		if (connection) {
			try { await within(connection.quit(), 'Fixture connection shutdown', 3000); }
			catch (error) { cleanup.push(error); connection.disconnect(); }
		}
		try { await rm(root, { recursive: true, force: true }); }
		catch (error) { cleanup.push(error); }
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		if (cleanup.length) failure = new AggregateError(failure ? [failure, ...cleanup] : cleanup, 'Project queue isolation cleanup failed');
	}
	if (failure) throw failure;
	return { checks };
}
