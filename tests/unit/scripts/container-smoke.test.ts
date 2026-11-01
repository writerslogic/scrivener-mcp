import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const image = `sha256:${'a'.repeat(64)}`;
const containerId = 'b'.repeat(64);
const ownerLabel = 'io.scrivener-mcp.smoke';

// A subprocess fixture exercises MCP framing and lifecycle; it does not execute Docker.
const fakeDocker = String.raw`
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const take = flag => {
  const index = args.indexOf(flag);
  if (index < 0) throw new Error('Missing fixture argument: ' + flag);
  return args.splice(index, 2)[1];
};
const directory = take('--state');
const scenario = take('--scenario');
take('--config');
const file = name => join(directory, name);
const newline = String.fromCharCode(10);
const event = value => appendFileSync(file('events.jsonl'), JSON.stringify(value) + newline);
const read = name => JSON.parse(readFileSync(file(name), 'utf8'));
const write = (name, value) => writeFileSync(file(name), JSON.stringify(value));
const reply = value => console.log(JSON.stringify(value));
const value = flag => args[args.indexOf(flag) + 1];
const setting = flag => args.find(arg => arg.startsWith(flag + '='))?.slice(flag.length + 1);
const memoryBytes = flag => Number(setting(flag)?.replace(/m$/, '')) * 1024 * 1024;
const id = '${containerId}';
const label = '${ownerLabel}';
event({ kind: 'command', args });

if (args[0] === 'image' && args[1] === 'inspect') {
  const metadata = {
    Id: args[args.length - 1], Os: 'linux', Architecture: 'amd64',
    Config: { User: 'node', Entrypoint: ['node', 'dist/index.js'], Cmd: null }
  };
  reply(args.includes('--format') ? metadata : [metadata]);
} else if (args[0] === 'run') {
  const labels = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--label') continue;
    const [key, ...parts] = args[++index].split('=');
    labels[key] = parts.join('=');
  }
  const environment = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--env' || args[index] === '-e') environment.push(args[++index]);
  }
  const startupFailure = scenario === 'startup-failure' || scenario === 'late-create';
  write(scenario === 'late-create' ? 'pending.json' : 'container.json', {
    Id: id, Name: '/' + value('--name'), Image: args[args.length - 1],
    Config: { Labels: labels, User: 'node', Env: environment },
    HostConfig: {
      NanoCpus: Number(setting('--cpus')) * 1000000000,
      Memory: memoryBytes('--memory'), MemorySwap: memoryBytes('--memory-swap'),
      PidsLimit: Number(setting('--pids-limit')), NetworkMode: setting('--network'), AutoRemove: false
    }
  });
  write('running.json', { pid: startupFailure ? null : process.pid });
  event({ kind: scenario === 'late-create' ? 'creation-pending' : 'created', id });
  if (startupFailure) {
    process.stderr.write('Fixture failed after container creation, before cidfile' + newline);
    process.exitCode = 125;
  } else {
    writeFileSync(value('--cidfile'), id);
    const input = createInterface({ input: process.stdin });
    input.on('line', line => {
      const message = JSON.parse(line);
      event({ kind: 'protocol', method: message.method, id: message.id });
      if (message.id === undefined) return;
      let result;
      if (message.method === 'initialize') {
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'scrivener-mcp', version: 'fixture' }
        };
      } else if (message.method === 'tools/list') {
        result = {
          tools: ['open_project', 'read_result', 'analyze_manuscript_local'].map(name => ({
            name, inputSchema: { type: 'object', properties: {} }
          }))
        };
      } else {
        reply({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } });
        return;
      }
      reply({ jsonrpc: '2.0', id: message.id, result });
    });
    input.on('close', () => {
      event({ kind: 'eof', at: Date.now() });
      if (scenario === 'hung-after-eof') {
        setInterval(() => {}, 1000);
        return;
      }
      const code = scenario === 'nonzero-exit' ? 17 : 0;
      write('exit.json', { code });
      rmSync(file('running.json'), { force: true });
      event({ kind: 'natural-exit', code });
      process.exitCode = code;
    });
  }
} else if (args[0] === 'exec') {
  reply({
    uid: 1000,
    pid1Uids: scenario === 'root-pid1' ? [0, 0, 0, 0] : [1000, 1000, 1000, 1000],
    platform: 'linux', arch: 'x64', node: 'v24.22.2'
  });
} else if (args[0] === 'container' && args[1] === 'inspect') {
  if (existsSync(file('pending.json'))) {
    write('container.json', read('pending.json'));
    rmSync(file('pending.json'));
    event({ kind: 'late-created', id });
    process.stderr.write('No such container' + newline);
    process.exitCode = 1;
  } else if (!existsSync(file('container.json')) || existsSync(file('removed.json'))) {
    process.stderr.write('No such container' + newline);
    process.exitCode = 1;
  } else {
    const metadata = read('container.json');
    const requested = args[args.length - 1];
    if (requested !== id && requested !== metadata.Name.slice(1)) {
      throw new Error('Fixture inspection targeted an unknown container');
    }
    if (scenario === 'ownership-mismatch') metadata.Config.Labels[label] = 'another-owner';
    metadata.State = {
      Running: existsSync(file('running.json')),
      ExitCode: existsSync(file('exit.json')) ? read('exit.json').code : 0,
      OOMKilled: scenario === 'oom-killed'
    };
    reply(args.includes('--format') ? metadata : [metadata]);
  }
} else if (args[0] === 'container' && args[1] === 'rm') {
  const target = args[args.length - 1];
  if (target !== id) throw new Error('Removal must use the captured container ID');
  const forced = args.includes('--force') || args.includes('-f');
  if (existsSync(file('running.json'))) {
    if (!forced) throw new Error('Cannot remove a running container without force');
    const { pid } = read('running.json');
    if (pid !== null) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    rmSync(file('running.json'), { force: true });
  }
  write('removed.json', { target, forced });
  event({ kind: 'removed', target, forced, at: Date.now() });
  console.log(id);
} else {
  throw new Error('Unsupported fake Docker command: ' + JSON.stringify(args));
}
`;

interface Event {
	kind: string;
	method?: string;
	args?: string[];
	code?: number;
	forced?: boolean;
	target?: string;
	at?: number;
}

describe('container smoke subprocess boundaries (without Docker execution)', () => {
	let directory: string;
	let executable: string;
	let runner: string;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'scrivener-container-smoke-tests-'));
		executable = join(directory, 'fake-docker.mjs');
		runner = join(directory, 'runner.mjs');
		const script = pathToFileURL(
			resolve(__dirname, '../../../scripts/check-container-smoke.mjs')
		).href;
		await writeFile(executable, fakeDocker);
		await writeFile(
			runner,
			`import { checkContainerSmoke } from ${JSON.stringify(script)};
try {
  await checkContainerSmoke(JSON.parse(process.argv[2]));
  console.log(JSON.stringify({ outcome: 'resolved' }));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'rejected', message: error.message }));
  process.exitCode = 1;
}
`
		);
	});

	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	async function probe(scenario: string) {
		const state = await mkdtemp(join(directory, `${scenario}-`));
		const output = join(state, 'report.json');
		let code = 0;
		let stdout: string;
		try {
			try {
				({ stdout } = await execute(
					process.execPath,
					[
						runner,
						JSON.stringify({
							image,
							output,
							dockerCommand: process.execPath,
							dockerArguments: [executable, '--state', state, '--scenario', scenario],
						}),
					],
					{ timeout: 40_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }
				));
			} catch (error) {
				const failure = error as Error & { code: number; stdout: string; killed?: boolean };
				if (failure.killed || failure.code !== 1) throw error;
				code = failure.code;
				stdout = failure.stdout;
			}
			const lines = stdout.trim().split('\n');
			const outcome = JSON.parse(lines[lines.length - 1]) as {
				outcome: 'resolved' | 'rejected';
				message?: string;
			};
			const report = JSON.parse(await readFile(output, 'utf8')) as {
				status: 'passed' | 'failed';
				checks: unknown[];
			};
			const events = (await readFile(join(state, 'events.jsonl'), 'utf8'))
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line) as Event);
			return { code, outcome, report, events };
		} finally {
			const running = await readFile(join(state, 'running.json'), 'utf8').catch((error) => {
				if (error.code === 'ENOENT') return undefined;
				throw error;
			});
			if (running !== undefined) {
				const { pid } = JSON.parse(running) as { pid: number | null };
				try {
					if (pid !== null) process.kill(pid, 'SIGKILL');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
				}
			}
		}
	}

	it('initializes, lists real protocol tools, observes natural EOF and removes its container', async () => {
		const { code, outcome, report, events } = await probe('success');
		expect(code).toBe(0);
		expect(outcome.outcome).toBe('resolved');
		expect(report.status).toBe('passed');
		expect(report.checks.length).toBeGreaterThan(0);
		expect(report).toMatchObject({
			image,
			containerId,
			server: { name: 'scrivener-mcp', version: 'fixture' },
			toolCount: 3,
			runtime: { uid: 1000, pid1Uids: [1000, 1000, 1000, 1000] },
			exit: { code: 0, signal: null },
			limits: { cpus: 1, memoryBytes: 1536 * 1024 * 1024, swapBytes: 0 },
			cleanup: 'owned-container-removed',
		});
		expect(
			events.filter((event) => event.kind === 'protocol').map((event) => event.method)
		).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
		const naturalExit = events.findIndex((event) => event.kind === 'natural-exit');
		const removal = events.findIndex((event) => event.kind === 'removed');
		expect(naturalExit).toBeGreaterThan(events.findIndex((event) => event.kind === 'eof'));
		expect(removal).toBeGreaterThan(naturalExit);
		expect(events[removal]).toMatchObject({ target: containerId, forced: false });
	}, 50_000);

	it.each(['root-pid1', 'nonzero-exit', 'oom-killed'])(
		'rejects %s and still removes only its owned container',
		async (scenario) => {
			const { code, outcome, report, events } = await probe(scenario);
			expect(code).toBe(1);
			expect(outcome.outcome).toBe('rejected');
			expect(report.status).toBe('failed');
			expect(events.filter((event) => event.kind === 'removed')).toHaveLength(1);
			expect(events.find((event) => event.kind === 'removed')?.target).toBe(containerId);
			if (scenario === 'nonzero-exit')
				expect(events.find((event) => event.kind === 'natural-exit')?.code).toBe(17);
		},
		50_000
	);

	it('refuses to remove a container whose ownership label no longer matches', async () => {
		const { code, outcome, report, events } = await probe('ownership-mismatch');
		expect(code).toBe(1);
		expect(outcome.outcome).toBe('rejected');
		expect(report.status).toBe('failed');
		expect(events.some((event) => event.kind === 'created')).toBe(true);
		expect(events.some((event) => event.kind === 'removed')).toBe(false);
		expect(
			events.some(
				(event) =>
					event.kind === 'command' && event.args?.slice(0, 2).join(' ') === 'container rm'
			)
		).toBe(false);
	}, 50_000);

	it('recovers owned cleanup by name when startup fails before the cidfile is written', async () => {
		const { code, outcome, report, events } = await probe('startup-failure');
		expect(code).toBe(1);
		expect(outcome.outcome).toBe('rejected');
		expect(report.status).toBe('failed');
		expect(events.some((event) => event.kind === 'created')).toBe(true);
		expect(events.some((event) => event.kind === 'protocol')).toBe(false);
		expect(events.filter((event) => event.kind === 'removed')).toMatchObject([
			{ kind: 'removed', target: containerId, forced: true },
		]);
	}, 50_000);

	it('bounds a server hanging after EOF to five seconds and forces owned cleanup', async () => {
		const { code, outcome, report, events } = await probe('hung-after-eof');
		expect(code).toBe(1);
		expect(outcome.outcome).toBe('rejected');
		expect(outcome.message).toContain('within five seconds of EOF');
		expect(report).toMatchObject({
			status: 'failed',
			failureStage: 'eof',
			cleanup: 'owned-container-removed',
		});
		expect(events.some((event) => event.kind === 'natural-exit')).toBe(false);
		const eof = events.find((event) => event.kind === 'eof');
		const removal = events.find((event) => event.kind === 'removed');
		expect(eof?.at).toEqual(expect.any(Number));
		expect(removal).toMatchObject({
			target: containerId,
			forced: true,
			at: expect.any(Number),
		});
		const elapsed = removal!.at! - eof!.at!;
		expect(elapsed).toBeGreaterThanOrEqual(4900);
		expect(elapsed).toBeLessThan(12_000);
	}, 50_000);

	it('rechecks a missing container and removes a delayed owned creation', async () => {
		const { code, outcome, report, events } = await probe('late-create');
		expect(code).toBe(1);
		expect(outcome.outcome).toBe('rejected');
		expect(report).toMatchObject({ status: 'failed', cleanup: 'owned-container-removed' });
		expect(events.some((event) => event.kind === 'creation-pending')).toBe(true);
		expect(events.some((event) => event.kind === 'protocol')).toBe(false);
		const creation = events.findIndex((event) => event.kind === 'late-created');
		const removal = events.findIndex((event) => event.kind === 'removed');
		expect(creation).toBeGreaterThanOrEqual(0);
		expect(removal).toBeGreaterThan(creation);
		expect(events[removal]).toMatchObject({ target: containerId, forced: true });
		expect(
			events.filter(
				(event) =>
					event.kind === 'command' &&
					event.args?.slice(0, 2).join(' ') === 'container inspect'
			).length
		).toBeGreaterThanOrEqual(2);
	}, 50_000);

	it.each([`sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`, 'scrivener-mcp:latest'])(
		'rejects nonimmutable image ID %s before evidence creation or Docker invocation',
		async (invalidImage) => {
			const state = await mkdtemp(join(directory, 'image-boundary-'));
			const output = join(state, 'report.json');
			await expect(
				execute(
					process.execPath,
					[
						runner,
						JSON.stringify({
							image: invalidImage,
							output,
							dockerCommand: process.execPath,
							dockerArguments: [
								executable,
								'--state',
								state,
								'--scenario',
								'success',
							],
						}),
					],
					{ timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }
				)
			).rejects.toMatchObject({ code: 1 });
			for (const file of [output, join(state, 'events.jsonl')])
				await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		}
	);

	it('preserves existing evidence without starting Docker', async () => {
		const state = await mkdtemp(join(directory, 'existing-evidence-'));
		const output = join(state, 'report.json');
		const original = '{"retained":"previous evidence"}\n';
		await writeFile(output, original);
		await expect(
			execute(
				process.execPath,
				[
					runner,
					JSON.stringify({
						image,
						output,
						dockerCommand: process.execPath,
						dockerArguments: [executable, '--state', state, '--scenario', 'success'],
					}),
				],
				{ timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }
			)
		).rejects.toMatchObject({ code: 1 });
		expect(await readFile(output, 'utf8')).toBe(original);
		await expect(readFile(join(state, 'events.jsonl'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
});
