import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryManager } from '../../src/memory-manager.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';

test('excludes a live process, then recovers its committed memory after hard termination', async () => {
	const root = await mkdtemp(join(tmpdir(), 'scrivener-memory-owner-'));
	const repository = resolve(__dirname, '../..');
	const loader = createRequire(join(repository, 'package.json')).resolve('tsx');
	const module = pathToFileURL(join(repository, 'src/memory-manager.ts')).href;
	const child = spawn(
		process.execPath,
		[
			'--import',
			loader,
			'--input-type=module',
			'-e',
			`
		import { MemoryManager } from ${JSON.stringify(module)};
		const memory = new MemoryManager(process.argv[1]);
		await memory.initialize();
		await memory.remember({ memoryType: 'characters', data: { name: 'Mara' } });
		process.stdout.write('READY\\n');
		process.stdin.resume();
	`,
			root,
		],
		{
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				PATH: process.env.PATH,
				TMPDIR: tmpdir(),
				SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
				SCRIVENER_RUN_LIVE_AI_TESTS: '0',
				SCRIVENER_LOCAL_ONLY: 'true',
				UV_THREADPOOL_SIZE: '1',
				RAYON_NUM_THREADS: '1',
				OMP_NUM_THREADS: '1',
			},
		}
	);
	const exited = once(child, 'exit');
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + String(chunk)).slice(-2000);
	});
	const peer = new MemoryManager(root);
	let recovered: MemoryManager | undefined;
	try {
		await new Promise<void>((done, fail) => {
			const timer = setTimeout(
				() => fail(new Error(`Memory owner startup timed out: ${stderr}`)),
				15000
			);
			let output = '';
			child.stdout.on('data', (chunk) => {
				output = (output + String(chunk)).slice(-1000);
				if (output.includes('READY\n')) {
					clearTimeout(timer);
					done();
				}
			});
			child.once('error', (error) => {
				clearTimeout(timer);
				fail(error);
			});
			child.once('exit', () => {
				clearTimeout(timer);
				fail(new Error(`Memory owner exited before readiness: ${stderr}`));
			});
		});
		await expect(peer.initialize()).rejects.toThrow('already owned');
		await peer.stopAutoSave();
		child.kill('SIGKILL');
		await exited;
		recovered = new MemoryManager(root);
		await recovered.initialize();
		expect(recovered.getAllCharacters()).toEqual([expect.objectContaining({ name: 'Mara' })]);
		await recovered.remember({ memoryType: 'worldBuilding', data: { name: 'Port' } });
		expect(
			JSON.parse(await readFile(join(root, '.ai-memory/project-memory.json'), 'utf8'))
				.characters
		).toHaveLength(1);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		await exited;
		await peer.stopAutoSave();
		await recovered?.stopAutoSave();
		await rm(root, { recursive: true, force: true });
	}
});

test.each(['foreign-host', 'unknown-token', 'malformed'])(
	'does not steal ambiguous ownership: %s',
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), 'scrivener-memory-owner-'));
		const store = new PersistentStore(join(root, '.ai-memory/ownership.sqlite'));
		const owner =
			kind === 'malformed'
				? { token: 'bad' }
				: {
						token: 'unrecognized',
						ownerPid: process.pid,
						host: kind === 'foreign-host' ? `${hostname()}-other` : hostname(),
					};
		store.put('memory', 'owner', owner);
		const memory = new MemoryManager(root);
		try {
			await expect(memory.initialize()).rejects.toThrow(/ownership|owned/);
			await memory.stopAutoSave();
			expect(store.get('memory', 'owner')).toEqual(owner);
			await expect(
				readFile(join(root, '.ai-memory/project-memory.json'))
			).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await memory.stopAutoSave();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	}
);
