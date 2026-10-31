import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ManuscriptContext } from 'narrative-lens';
import { narrativeModulePath } from './lens-native.cjs';
import { NARRATIVE_INPUT_BYTES } from './narrative-worker.js';

type Manuscript = Parameters<ManuscriptContext['analyze']>[0];
type Report = ReturnType<ManuscriptContext['analyze']>;
type CacheStats = ReturnType<ManuscriptContext['stats']>;
type Options = { signal?: AbortSignal; timeoutMs?: number };
const DEADLINE_MS = 30000;
const OUTPUT_BYTES = 16 * 1024 * 1024;
const HEADER_BYTES = 5;
const STAT_KEYS = [
	'reusedScenes',
	'recomputedScenes',
	'entries',
	'retainedBytes',
	'budgetBytes',
	'recomputedMetricsScenes',
	'recomputedGrammarScenes',
	'recomputedWorldScenes',
] satisfies (keyof CacheStats)[];

// Parent and child enforce execution deadlines; neither is a whole-workflow SLA.
// Child execution starts with a complete frame and spans decoding through output flush.
// Killing the child discards its warm cache.
const PROGRAM = `
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const watchdog = new Worker(\`
  const { parentPort } = require('node:worker_threads');
  const { performance } = require('node:perf_hooks');
  let timer, deadline;
  const terminate = () => process.kill(process.pid, 'SIGKILL');
  parentPort.on('message', ({ id, expires }) => {
    const now = performance.now();
    if (deadline != null && now >= deadline) return terminate();
    clearTimeout(timer);
    deadline = expires;
    if (expires !== null) {
      const remaining = expires - now;
      if (remaining <= 0) return terminate();
      timer = setTimeout(terminate, Math.ceil(remaining));
    }
    parentPort.postMessage(id);
  });
\`, { eval: true });
watchdog.on('error', () => process.exit(1));
watchdog.unref();
let control = 0;
const arm = expires => new Promise(resolve => {
  const id = ++control;
  watchdog.once('message', reply => reply === id ? resolve() : process.exit(1));
  watchdog.postMessage({ id, expires });
});
let context, busy = false, chunks = [], bytes = 0;
async function execute(frame) {
  if (busy) process.exit(1);
  busy = true;
  process.stdin.pause();
  const started = performance.now();
  const header = frame.toString('latin1', 0, ${HEADER_BYTES});
  const timeoutMs = Number(header);
  if (!/^[0-9]{${HEADER_BYTES}}$/.test(header) || timeoutMs < 1 || timeoutMs > ${DEADLINE_MS}) process.exit(1);
  let serialized;
  try {
    await arm(started + timeoutMs);
    const request = JSON.parse(frame.toString('utf8', ${HEADER_BYTES}));
    frame = undefined;
    context ??= new (require(request.module).ManuscriptContext)(request.cacheMaxBytes);
    let report;
    if (request.operation === 'analyze') report = context.analyze(request.input);
    else if (request.operation !== 'stats') throw new Error('Unsupported native context operation');
    serialized = JSON.stringify({ ok: true, report, stats: context.stats() });
    if (Buffer.byteLength(serialized) > ${OUTPUT_BYTES}) throw new Error('Narrative result exceeds 16 MiB');
  } catch (error) {
    serialized = JSON.stringify({ ok: false, message: String(error?.message ?? error).slice(0, 4096) });
  }
  await new Promise((resolve, reject) => {
    process.stdout.write(serialized + '\\n', error => error ? reject(error) : resolve());
  });
  await arm(null);
  busy = false;
  process.stdin.resume();
}
process.stdin.on('data', chunk => {
  const end = chunk.indexOf(10);
  const part = end < 0 ? chunk : chunk.subarray(0, end);
  bytes += part.length;
  if (bytes > ${NARRATIVE_INPUT_BYTES + HEADER_BYTES} || (end >= 0 && end !== chunk.length - 1)) process.exit(1);
  chunks.push(part);
  if (end >= 0) {
    const frame = Buffer.concat(chunks, bytes);
    chunks = []; bytes = 0;
    void execute(frame).catch(() => process.exit(1));
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(1));
process.stdout.on('error', () => process.exit(1));
`;

interface Pending {
	resolve: (report: unknown) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abort: () => void;
	timer: NodeJS.Timeout;
	error?: Error;
}

export class NarrativeContext {
	private child?: ChildProcessWithoutNullStreams;
	private exited?: Promise<void>;
	private pending?: Pending;
	private cachedStats?: CacheStats;
	private closed = false;
	private closing?: Promise<void>;

	constructor(private readonly cacheMaxBytes = 16 * 1024 * 1024) {
		if (
			!Number.isInteger(cacheMaxBytes) ||
			cacheMaxBytes < 1 ||
			cacheMaxBytes > 16 * 1024 * 1024
		)
			throw new Error('Narrative cache budget must be from 1 byte to 16 MiB');
	}

	async analyzeAsync(input: Manuscript, options: Options = {}): Promise<Report> {
		return (await this.request('analyze', input, options)) as Report;
	}

	async stats({ signal }: Pick<Options, 'signal'> = {}): Promise<CacheStats> {
		signal?.throwIfAborted();
		this.assertAvailable();
		if (!this.cachedStats) await this.request('stats', undefined, { signal });
		return { ...this.cachedStats! };
	}

	private assertAvailable(): void {
		if (this.closed) throw new Error('Narrative context is closed');
		if (this.pending) throw new Error('Narrative context is busy');
	}

	private request(
		operation: 'analyze' | 'stats',
		input: Manuscript | undefined,
		{ signal, timeoutMs = DEADLINE_MS }: Options
	): Promise<unknown> {
		this.assertAvailable();
		signal?.throwIfAborted();
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS)
			throw new Error('Narrative timeout must be from 1 to 30000 milliseconds');
		const serialized = JSON.stringify({
			module: narrativeModulePath(),
			cacheMaxBytes: this.cacheMaxBytes,
			operation,
			input,
		});
		if (Buffer.byteLength(serialized) > NARRATIVE_INPUT_BYTES)
			throw new Error('Narrative operation input exceeds 64 MiB');
		return new Promise((resolve, reject) => {
			const child = this.child ?? this.start();
			const abort = () => this.fail(new Error('Narrative operation cancelled'));
			const pending = (this.pending = {
				resolve,
				reject,
				signal,
				abort,
				timer: setTimeout(
					() =>
						this.fail(
							new Error(
								`Narrative operation exceeded ${timeoutMs} milliseconds and was terminated`
							)
						),
					timeoutMs
				),
			});
			signal?.addEventListener('abort', abort, { once: true });
			if (signal?.aborted) abort();
			if (!this.pending.error)
				child.stdin.write(
					`${String(timeoutMs).padStart(HEADER_BYTES, '0')}${serialized}\n`,
					(error) => {
						if (error && this.child === child && this.pending === pending)
							this.fail(new Error('Narrative process input failed'));
					}
				);
		});
	}

	private cleanPending(): Pending | undefined {
		const pending = this.pending;
		if (pending) {
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener('abort', pending.abort);
			this.pending = undefined;
		}
		return pending;
	}

	private fail(error: Error): void {
		if (this.pending) this.pending.error ??= error;
		this.cachedStats = undefined;
		this.child?.kill('SIGKILL');
	}

	private start(): ChildProcessWithoutNullStreams {
		const child = spawn(
			process.execPath,
			['--max-old-space-size=128', '--input-type=commonjs', '--eval', PROGRAM],
			{
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: {
					UV_THREADPOOL_SIZE: '1',
					RAYON_NUM_THREADS: '1',
					...Object.fromEntries(
						['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].flatMap((key) =>
							process.env[key] ? [[key, process.env[key]!]] : []
						)
					),
				},
			}
		);
		this.child = child;
		this.exited = new Promise((done) =>
			child.once('close', () => {
				if (this.child === child) {
					this.child = undefined;
					this.cachedStats = undefined;
					const pending = this.cleanPending();
					pending?.reject(pending.error ?? new Error('Narrative context process exited'));
				}
				done();
			})
		);
		child.on('error', () => {
			if (this.child === child) this.fail(new Error('Narrative context process failed'));
		});
		child.stdin.on('error', () => {
			if (this.child === child) this.fail(new Error('Narrative process input failed'));
		});
		let stderrBytes = 0;
		child.stderr.on('data', (chunk: Buffer) => {
			if (this.child !== child) return;
			stderrBytes += chunk.length;
			if (stderrBytes > OUTPUT_BYTES)
				this.fail(new Error('Narrative process exceeded its output limit'));
		});
		let chunks: Buffer[] = [],
			bytes = 0;
		child.stdout.on('data', (chunk: Buffer) => {
			if (this.child !== child || this.pending?.error) return;
			const end = chunk.indexOf(10);
			const part = end < 0 ? chunk : chunk.subarray(0, end);
			bytes += part.length;
			if (!this.pending || bytes > OUTPUT_BYTES || (end >= 0 && end !== chunk.length - 1)) {
				this.fail(new Error('Narrative context returned invalid or oversized output'));
				return;
			}
			chunks.push(part);
			if (end < 0) return;
			try {
				const response = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
				chunks = [];
				bytes = 0;
				if (response.ok !== true)
					throw new Error(response.message ?? 'Narrative analysis failed');
				if (
					!response.stats ||
					Array.isArray(response.stats) ||
					typeof response.stats !== 'object' ||
					STAT_KEYS.some(
						(key) =>
							!Number.isSafeInteger(response.stats[key]) || response.stats[key] < 0
					) ||
					response.stats.budgetBytes !== this.cacheMaxBytes ||
					response.stats.retainedBytes > this.cacheMaxBytes
				)
					throw new Error('Narrative cache statistics are unavailable or invalid');
				this.cachedStats = response.stats as CacheStats;
				stderrBytes = 0;
				this.cleanPending()!.resolve(response.report);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error('Invalid native response'));
			}
		});
		return child;
	}

	close(): Promise<void> {
		this.closed = true;
		return (this.closing ??= (async () => {
			const exited = this.exited;
			this.fail(new Error('Narrative context is closed'));
			await exited;
		})());
	}
}
