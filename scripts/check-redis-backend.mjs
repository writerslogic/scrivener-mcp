#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));

async function deadline(operation, label, milliseconds = 10_000) {
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

async function verify() {
	const args = process.argv.slice(2);
	assert.ok(
		args.length === 0 ||
			(args.length === 2 && args[0] === '--legacy-root' && isAbsolute(args[1])),
		'Usage: node scripts/check-redis-backend.mjs [--legacy-root <absolute-package-root>]'
	);
	assert.notEqual(process.platform, 'win32', 'This verifier requires Redis Unix sockets');
	let producerRequire = require;
	if (args.length) {
		const legacyRoot = await realpath(args[1]);
		assert.ok((await stat(join(legacyRoot, 'package.json'))).isFile());
		producerRequire = createRequire(join(legacyRoot, 'package.json'));
		assert.match(producerRequire('bullmq/package.json').version, /^5\./);
	}
	const versions = {
		node: process.version,
		bullmq: require('bullmq/package.json').version,
		producerBullmq: producerRequire('bullmq/package.json').version,
		ioredis: require('ioredis/package.json').version,
	};
	assert.match(versions.bullmq, /^6\./);
	assert.match(versions.ioredis, /^6\./);
	const fixture = await mkdtemp(join(tmpdir(), 'sr-'));
	const socketPath = join(fixture, 'redis.sock');
	const clients = new Set();
	const resources = new Set();
	const sockets = new Set();
	const checks = [];
	let child;
	let childClosed;
	let proxy;
	let admin;
	let cleaning = false;
	let releaseProcessor = () => {};
	let asyncError;
	let rejectFailure;
	const failure = new Promise((_, reject) => {
		rejectFailure = reject;
	});
	failure.catch(() => undefined);
	const fail = (error) => {
		if (!cleaning && !asyncError) {
			asyncError = error;
			rejectFailure(error);
		}
	};
	const interrupted = () => fail(new Error('Redis backend verification interrupted'));
	process.once('SIGINT', interrupted);
	process.once('SIGTERM', interrupted);
	const overallTimer = setTimeout(
		() => fail(new Error('Redis backend verification exceeded its 60-second limit')),
		60_000
	);
	const checked = (operation, label) => deadline(Promise.race([operation, failure]), label);
	const until = async (condition, label) => {
		const expires = Date.now() + 10_000;
		while (!condition()) {
			if (asyncError) throw asyncError;
			if (Date.now() >= expires) throw new Error(`${label} timed out`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	};
	const track = (socket) => {
		sockets.add(socket);
		socket.on('error', () => socket.destroy());
		socket.once('close', () => sockets.delete(socket));
		return socket;
	};
	const own = (resource) => {
		resources.add(resource);
		resource.on('error', fail);
		return resource;
	};
	const closeResource = async (resource) => {
		await deadline(resource.close(), 'BullMQ shutdown', 5_000);
		resources.delete(resource);
	};
	const closeClient = async (client) => {
		try {
			if (client.status !== 'end') await deadline(client.quit(), 'Redis quit', 3_000);
		} finally {
			client.disconnect();
			clients.delete(client);
		}
	};
	const observe = (events) => {
		const seen = Object.fromEntries(
			['completed', 'failed', 'delayed', 'progress'].map((name) => [name, new Map()])
		);
		for (const [name, records] of Object.entries(seen))
			events.on(name, (event) => records.set(event.jobId, event));
		return seen;
	};
	let originalError;
	const cleanupErrors = [];
	try {
		assert.ok(Buffer.byteLength(socketPath) < 104, 'Temporary Redis socket path is too long');
		Object.assign(process.env, {
			SCRIVENER_DATA_DIR: fixture,
			SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
			SCRIVENER_LOCAL_ONLY: 'true',
			NODE_ENV: 'test',
			LOG_LEVEL: 'ERROR',
		});
		const { Redis } = require('ioredis');
		const current = require('bullmq');
		const producer = producerRequire('bullmq');
		const { createBullMQConnection, detectConnection } = await checked(
			import(pathToFileURL(join(ROOT, 'dist/services/queue/keydb-detector.js')).href),
			'Compiled Redis helpers'
		);
		child = spawn(
			'redis-server',
			[
				'--port', '0', '--unixsocket', socketPath, '--unixsocketperm', '700',
				'--save', '', '--appendonly', 'no', '--dir', fixture, '--daemonize', 'no',
			],
			{ stdio: 'ignore' }
		);
		let spawnError;
		child.on('error', (error) => {
			spawnError = error;
		});
		childClosed = new Promise((resolve) => {
			child.once('close', (code, signal) => {
				if (!cleaning) fail(new Error('The isolated redis-server exited unexpectedly'));
				resolve({ code, signal });
			});
		});
		await until(() => {
			if (spawnError)
				throw new Error(
					spawnError.code === 'ENOENT'
						? 'redis-server is missing from PATH; install Redis before running this verifier'
						: 'redis-server could not start'
				);
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error('The isolated redis-server exited before startup');
			return child.pid !== undefined;
		}, 'Redis spawn');
		await checked((async () => {
			for (;;) {
				try {
					await access(socketPath);
					break;
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
					if (child.exitCode !== null || child.signalCode !== null)
						throw new Error('The isolated redis-server exited before creating its socket');
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
		})(), 'Redis socket startup');
		admin = new Redis(socketPath, {
			protocol: 2, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1,
		});
		clients.add(admin);
		admin.on('error', fail);
		await checked(admin.connect(), 'Redis admin connection');
		versions.redis = (await checked(admin.info('server'), 'Redis version'))
			.match(/redis_version:([^\r\n]+)/)?.[1];
		assert.ok(versions.redis);
		await checked(admin.acl('SETUSER', 'default', 'on', 'nopass', '~*', '+@all', '-hello'), 'Redis ACL');
		await assert.rejects(checked(admin.call('HELLO', '3'), 'Denied HELLO command'), /NOPERM/);
		proxy = createServer((incoming) => {
			const target = track(createConnection(socketPath));
			track(incoming).pipe(target).pipe(incoming);
			incoming.once('close', () => target.destroy());
			target.once('close', () => incoming.destroy());
		});
		proxy.on('error', fail);
		proxy.listen(0, '127.0.0.1');
		await checked(once(proxy, 'listening'), 'Loopback proxy startup');
		const address = proxy.address();
		assert.ok(address && typeof address === 'object');
		const url = `redis://127.0.0.1:${address.port}`;
		const detected = await checked(detectConnection([url]), 'Explicit Redis detection');
		assert.equal(detected.type, 'redis');
		assert.equal(detected.url, url);
		assert.equal(detected.isAvailable, true);
		checks.push('hello-denied-explicit-detection');
		const connect = () => {
			const client = createBullMQConnection(url);
			clients.add(client);
			client.on('error', fail);
			assert.equal(client.options.protocol, 2);
			assert.equal(client.options.maxRetriesPerRequest, null);
			return client;
		};
		const connection = connect();
		assert.equal(await checked(connection.ping(), 'Canonical Redis ping'), 'PONG');
		const prefix = `verify-${randomUUID()}`;
		const text = 'Café — 東京 😀';
		await checked(Promise.all([
			connection.setex(`${prefix}:scene:1`, 60, JSON.stringify({ text })),
			connection.setex(`${prefix}:scene:2`, 60, JSON.stringify({ text: 'Second scene' })),
			connection.setex(`${prefix}:other`, 60, 'keep'),
		]), 'Cache writes');
		assert.deepEqual(JSON.parse(await checked(connection.get(`${prefix}:scene:1`), 'Cache read')), { text });
		let cursor = '0';
		let pages = 0;
		const keys = new Set();
		do {
			assert.ok(++pages <= 100, 'Cache SCAN failed to terminate');
			const page = await checked(
				connection.scan(cursor, 'MATCH', `${prefix}:scene:*`, 'COUNT', 1), 'Cache SCAN'
			);
			cursor = page[0];
			for (const key of page[1]) keys.add(key);
		} while (cursor !== '0');
		assert.deepEqual([...keys].sort(), [`${prefix}:scene:1`, `${prefix}:scene:2`]);
		assert.equal(await checked(connection.del(...keys), 'Cache invalidation'), 2);
		assert.equal(await checked(connection.get(`${prefix}:scene:1`), 'Invalidated cache read'), null);
		assert.equal(await checked(connection.get(`${prefix}:other`), 'Unmatched cache read'), 'keep');
		checks.push('ioredis6-cache-roundtrip-scan-invalidation');
		const ready = once(connection, 'ready');
		connection.disconnect(true);
		await checked(ready, 'ioredis reconnect');
		assert.equal(await checked(connection.ping(), 'Reconnected ping'), 'PONG');
		checks.push('canonical-ioredis6-reconnect');

		const name = 'local-backend';
		const producerClients = [connection, connect(), connect()];
		const producerQueue = own(new producer.Queue(name, { connection, prefix }));
		const producerEvents = own(new producer.QueueEvents(name, { connection: producerClients[1], prefix }));
		const producerSeen = observe(producerEvents);
		const producerWorker = own(new producer.Worker(name, async (job) => {
			if (job.name === 'seed-failed' || job.name === 'retry') throw new Error('fixture failure');
			await job.updateProgress({ phase: 'producer', done: true });
			return { text: job.data.text, producer: true };
		}, { connection: producerClients[2], prefix }));
		await checked(Promise.all([producerQueue.waitUntilReady(), producerEvents.waitUntilReady(), producerWorker.waitUntilReady()]), 'Producer readiness');
		await checked(producerQueue.add('seed-completed', { text }, { jobId: 'completed' }), 'Completed seed');
		await checked(producerQueue.add('seed-failed', { text }, { jobId: 'failed' }), 'Failed seed');
		await checked(producerQueue.add('retry', { text, kind: 'retry' }, {
			jobId: 'retry', attempts: 2, backoff: { type: 'fixed', delay: 600_000 },
		}), 'Retry seed');
		await until(() => producerSeen.completed.has('completed') && producerSeen.failed.has('failed') && producerSeen.delayed.has('retry'), 'Producer completion, failure and retry events');
		await closeResource(producerWorker);
		await closeResource(producerEvents);
		await checked(producerQueue.add('queued', { text, kind: 'queued' }, { jobId: 'queued' }), 'Queued seed');
		await checked(producerQueue.add('delayed', { text, kind: 'delayed' }, { jobId: 'delayed', delay: 600_000 }), 'Delayed seed');
		await closeResource(producerQueue);
		await Promise.all(producerClients.map(closeClient));

		const consumerClients = [connect(), connect(), connect()];
		const queue = own(new current.Queue(name, { connection: consumerClients[0], prefix }));
		const events = own(new current.QueueEvents(name, { connection: consumerClients[1], prefix }));
		const seen = observe(events);
		await checked(Promise.all([queue.waitUntilReady(), events.waitUntilReady()]), 'Consumer readiness');
		const completed = await checked(queue.getJob('completed'), 'Persisted completed job');
		const failed = await checked(queue.getJob('failed'), 'Persisted failed job');
		assert.ok(completed && failed);
		assert.equal(await checked(completed.getState(), 'Completed state'), 'completed');
		assert.deepEqual(completed.returnvalue, { text, producer: true });
		assert.deepEqual(completed.progress, { phase: 'producer', done: true });
		assert.equal(await checked(failed.getState(), 'Failed state'), 'failed');
		assert.equal(failed.failedReason, 'fixture failure');
		assert.deepEqual(failed.data, { text });
		checks.push('producer-completed-failed-and-progress-persist');
		for (const kind of ['queued', 'delayed', 'retry']) {
			const job = await checked(queue.getJob(kind), `Persisted ${kind} job`);
			assert.ok(job);
			assert.deepEqual(job.data, { text, kind });
			assert.equal(await checked(job.getState(), `${kind} state`), kind === 'queued' ? 'waiting' : 'delayed');
			if (kind === 'retry') {
				assert.equal(job.attemptsMade, 1);
				assert.equal(job.opts.attempts, 2);
				assert.deepEqual(job.opts.backoff, { type: 'fixed', delay: 600_000 });
			}
			if (kind !== 'queued') await checked(job.promote(), `${kind} promotion`);
		}
		checks.push('queued-delayed-and-failed-retry-survive-producer-close');
		let started;
		const blockedStarted = new Promise((resolve) => { started = resolve; });
		const barrier = new Promise((resolve) => { releaseProcessor = resolve; });
		const worker = own(new current.Worker(name, async (job) => {
			if (job.name === 'blocked') {
				started();
				await deadline(barrier, 'Blocked processor release', 20_000);
				return { released: true };
			}
			assert.deepEqual(job.data, { text, kind: job.name });
			await job.updateProgress({ phase: 'consumer', words: 41 });
			return { kind: job.name, words: 42 };
		}, { connection: consumerClients[2], prefix }));
		await checked(worker.waitUntilReady(), 'Consumer worker readiness');
		await until(() => ['queued', 'delayed', 'retry'].every((id) => seen.completed.has(id) && seen.progress.has(id)), 'Consumer progress and completion events');
		for (const kind of ['queued', 'delayed', 'retry']) {
			const job = await checked(queue.getJob(kind), `Completed ${kind} job`);
			assert.ok(job);
			assert.deepEqual(job.returnvalue, { kind, words: 42 });
			assert.deepEqual(seen.progress.get(kind).data, { phase: 'consumer', words: 41 });
			if (kind === 'retry') assert.equal(job.attemptsMade, 2);
		}
		checks.push('real-retry-progress-and-completion-events');
		const blocked = await checked(queue.add('blocked', { text }, { jobId: 'blocked' }), 'Active fixture');
		await checked(blockedStarted, 'Blocked processor startup');
		await assert.rejects(checked(blocked.remove(), 'Active removal'), /lock/i);
		assert.equal(await checked(blocked.getState(), 'Blocked state'), 'active');
		releaseProcessor();
		await until(() => seen.completed.has('blocked'), 'Released processor completion');
		checks.push('active-job-removal-rejected-until-processor-release');
		assert.deepEqual(await checked(Promise.all([
			queue.getCompletedCount(), queue.getFailedCount(), queue.getWaitingCount(),
			queue.getActiveCount(), queue.getDelayedCount(),
		]), 'Queue state counts'), [5, 1, 0, 0, 0]);
		checks.push('current-queue-state-counts');
		if (args.length) checks.push('bullmq5-to-bullmq6-transfer');
		if (asyncError) throw asyncError;
	} catch (error) {
		originalError = error;
	} finally {
		cleaning = true;
		clearTimeout(overallTimer);
		releaseProcessor();
		for (const resource of [...resources].reverse()) {
			try { await closeResource(resource); } catch (error) {
				cleanupErrors.push(error);
				try { await deadline(resource.disconnect(), 'Forced BullMQ disconnect', 1_000); }
				catch (failure) { cleanupErrors.push(failure); }
			}
		}
		for (const client of [...clients].filter((client) => client !== admin)) {
			try { await closeClient(client); } catch (error) { cleanupErrors.push(error); }
		}
		if (admin?.status === 'ready') {
			try {
				const remaining = (await deadline(admin.client('LIST'), 'Redis client cleanup')).trim().split('\n');
				assert.equal(remaining.length, 1, 'BullMQ or ioredis connections leaked');
			} catch (error) { cleanupErrors.push(error); }
		} else if (!originalError) cleanupErrors.push(new Error('Redis admin connection closed before cleanup verification'));
		if (admin) {
			try { await closeClient(admin); } catch (error) { cleanupErrors.push(error); }
		}
		for (const socket of sockets) socket.destroy();
		if (proxy?.listening) {
			try { await deadline(new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve())), 'Proxy shutdown', 2_000); }
			catch (error) { cleanupErrors.push(error); }
		}
		if (child) {
			try {
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
				const result = await deadline(childClosed, 'Redis shutdown', 5_000);
				assert.deepEqual(result, { code: 0, signal: null });
			} catch (error) {
				cleanupErrors.push(error);
				child.kill('SIGKILL');
				await deadline(childClosed, 'Redis forced shutdown', 2_000).catch((failure) => cleanupErrors.push(failure));
			}
		}
		try {
			await deadline(rm(fixture, { recursive: true, force: true }), 'Fixture removal', 5_000);
			assert.equal(proxy?.listening ?? false, false);
			await until(() => sockets.size === 0, 'Proxy socket cleanup');
			assert.equal(sockets.size, 0, 'Proxy sockets leaked');
		} catch (error) { cleanupErrors.push(error); }
		process.removeListener('SIGINT', interrupted);
		process.removeListener('SIGTERM', interrupted);
	}
	if (originalError || cleanupErrors.length)
		throw new AggregateError([originalError, ...cleanupErrors].filter(Boolean), 'Redis backend verification failed');
	checks.push('connections-proxy-process-and-fixture-cleanup');
	return { ok: true, ...versions, checks };
}

try {
	process.stdout.write(`${JSON.stringify(await verify())}\n`);
} catch (error) {
	const failures = error instanceof AggregateError ? error.errors : [error];
	process.stderr.write(`${failures.map((failure) => failure.message).join('\n')}\n`);
	process.exitCode = 1;
	setTimeout(() => process.exit(1), 1_000).unref();
}
