import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { captureInputFailureDiagnostics } from '../../helpers/native-input-diagnostics.js';
import { NarrativeContext } from '../../../src/services/editorial/narrative-context.js';
import {
	NARRATIVE_HEAP_MIB,
	NARRATIVE_INPUT_BYTES,
} from '../../../src/services/editorial/narrative-worker.js';
import { narrativeModulePath } from '../../../src/services/editorial/lens-native.cjs';

jest.mock('../../../src/services/editorial/lens-native.cjs', () => ({
	narrativeModulePath: jest.fn(),
}));

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function waitPid(path: string): Promise<number> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const text = await readFile(path, 'utf8').catch((error) => {
			if (error.code === 'ENOENT') return '';
			throw error;
		});
		if (/^[1-9][0-9]*$/.test(text)) return Number(text);
		await delay(20);
	}
	throw new Error('Native fixture did not start');
}

describe('persistent native analysis context', () => {
	let directory: string;
	let context: NarrativeContext;
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'lens-context-'));
		const module = join(directory, 'fixture.cjs');
		await writeFile(
			module,
			`
exports.ManuscriptContext = class {
  constructor(budgetBytes) { this.budgetBytes = budgetBytes; this.calls = 0; }
  analyze(input) {
    if (input.pid) require('node:fs').writeFileSync(input.pid, String(process.pid));
    if (input.decodeDelayMs) {
      const parse = JSON.parse;
      JSON.parse = (...args) => {
        JSON.parse = parse;
        require('node:fs').writeFileSync(input.decodePid, String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.decodeDelayMs);
        return parse(...args);
      };
    }
    if (input.mode === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    if (input.mode === 'exit') process.exit(9);
    if (input.mode === 'fail') { this.calls++; throw new Error('invalid evidence fixture'); }
    this.calls++;
    this.badStats = input.badStats;
    const result = { calls: this.calls, pid: process.pid, text: input.text || '🌙' };
    if (input.padding !== undefined) result.inputBytes = Buffer.byteLength(input.padding);
    if (input.targetBytes) {
      result.padding = '';
      result.padding = 'x'.repeat(input.targetBytes - Buffer.byteLength(JSON.stringify({ ok: true, report: result, stats: this.stats() })));
    }
    return result;
  }
  stats() {
    const stats = { reusedScenes: Math.max(0, this.calls - 1), recomputedScenes: this.calls ? 1 : 0, entries: this.calls ? 1 : 0, retainedBytes: this.calls, budgetBytes: this.budgetBytes, recomputedMetricsScenes: this.calls ? 1 : 0, recomputedGrammarScenes: this.calls ? 1 : 0, recomputedWorldScenes: this.calls ? 1 : 0 };
    if (this.badStats === 'array') return [];
    if (this.badStats === 'missing') delete stats.entries;
    if (this.badStats === 'negative') stats.entries = -1;
    if (this.badStats === 'nonfinite') stats.entries = NaN;
    if (this.badStats === 'budget') stats.budgetBytes++;
    if (this.badStats === 'overflow') stats.retainedBytes = this.budgetBytes + 1;
    return stats;
  }
};`
		);
		jest.mocked(narrativeModulePath).mockReturnValue(module);
	});
	beforeEach(() => {
		context = new NarrativeContext();
	});
	afterEach(async () => {
		await context.close();
	});
	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it('retains one native context and exposes actual initial and updated cache statistics', async () => {
		expect(await context.stats()).toMatchObject({
			entries: 0,
			retainedBytes: 0,
			budgetBytes: 16 * 1024 * 1024,
		});
		const first = (await context.analyzeAsync({} as never)) as unknown as {
			calls: number;
			pid: number;
			text: string;
		};
		const next = (await context.analyzeAsync({
			text: '🌙 é\nquote',
		} as never)) as unknown as typeof first;
		expect(next).toMatchObject({ calls: 2, pid: first.pid, text: '🌙 é\nquote' });
		const stats = await context.stats();
		expect(stats).toMatchObject({ entries: 1, reusedScenes: 1, retainedBytes: 2 });
		stats.entries = 99;
		expect((await context.stats()).entries).toBe(1);
		await context.close();
		expect(alive(first.pid)).toBe(false);
		await expect(context.stats()).rejects.toThrow(/closed/);
	});

	it.each([
		['timeout', 0],
		['timeout', 900],
		['abort', 0],
		['close', 0],
	] as const)(
		'hard-stops blocked native execution on %s after %i ms initialization before settling',
		async (action, startupDelayMs) => {
			if (startupDelayMs) {
				const delayedModule = join(directory, 'delayed-start.cjs');
				await writeFile(
					delayedModule,
					`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startupDelayMs});
module.exports = require('./fixture.cjs');`
				);
				jest.mocked(narrativeModulePath).mockReturnValueOnce(delayedModule);
			}
			await context.stats();
			const pidFile = join(directory, `${action}-${startupDelayMs}.pid`);
			const controller = new AbortController();
			const pending = context.analyzeAsync({ mode: 'block', pid: pidFile } as never, {
				signal: controller.signal,
				timeoutMs: action === 'timeout' ? 600 : 30000,
			});
			const rejected = expect(pending).rejects.toThrow(
				action === 'timeout' ? /terminated/ : action === 'abort' ? /cancelled/ : /closed/
			);
			await Promise.all([
				expect(context.analyzeAsync({} as never)).rejects.toThrow(/busy/),
				expect(context.stats()).rejects.toThrow(/busy/),
			]);
			const pid = await waitPid(pidFile);
			if (action === 'abort') controller.abort();
			if (action === 'close') await context.close();
			await rejected;
			expect(alive(pid)).toBe(false);
			expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
			if (action !== 'close') {
				const result = (await context.analyzeAsync({} as never)) as unknown as {
					pid: number;
					calls: number;
				};
				expect(result.calls).toBe(1);
				expect(result.pid).not.toBe(pid);
			}
		}
	);

	it.each(['fail', 'exit'] as const)(
		'discards context state after %s and recreates it for the next request',
		async (mode) => {
			await context.analyzeAsync({} as never);
			await expect(context.analyzeAsync({ mode } as never)).rejects.toThrow(
				mode === 'fail' ? /invalid evidence fixture/ : /exited/
			);
			expect(await context.stats()).toMatchObject({ entries: 0, retainedBytes: 0 });
			expect(await context.analyzeAsync({} as never)).toMatchObject({ calls: 1 });
		}
	);

	it('removes the admitted signal listener and disarms deadlines between successful calls', async () => {
		const controller = new AbortController();
		const replacement = new AbortController();
		const options = { signal: controller.signal, timeoutMs: 600 };
		const pending = context.analyzeAsync({} as never, options);
		options.signal = replacement.signal;
		const first = (await pending) as unknown as { pid: number };
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
		await delay(700);
		expect(alive(first.pid)).toBe(true);
		expect(await context.analyzeAsync({} as never)).toMatchObject({ pid: first.pid, calls: 2 });
	});

	it('serializes rapid sequential requests through output flush and watchdog disarm', async () => {
		let pid: number | undefined;
		for (let calls = 1; calls <= 30; calls++) {
			const result = (await context.analyzeAsync({} as never)) as unknown as {
				pid: number;
				calls: number;
			};
			pid ??= result.pid;
			expect(result).toMatchObject({ pid, calls });
		}
		expect(await context.stats()).toMatchObject({
			entries: 1,
			reusedScenes: 29,
			retainedBytes: 30,
		});
	});

	it.each(['array', 'missing', 'negative', 'nonfinite', 'budget', 'overflow'])(
		'rejects %s cache statistics and recreates the context',
		async (badStats) => {
			await expect(context.analyzeAsync({ badStats } as never)).rejects.toThrow(
				/statistics.*invalid/
			);
			expect(await context.stats()).toMatchObject({ entries: 0, retainedBytes: 0 });
		}
	);

	it.each([-1, 0, 1])('enforces the output byte limit at limit %+i', async (offset) => {
		const targetBytes = 16 * 1024 * 1024 + offset;
		const pending = context.analyzeAsync({ targetBytes } as never);
		if (offset > 0) {
			await expect(pending).rejects.toThrow(/exceeds 16 MiB/);
			expect(await context.stats()).toMatchObject({ entries: 0 });
		} else {
			const report = await pending;
			expect(
				Buffer.byteLength(
					JSON.stringify({ ok: true, report, stats: await context.stats() })
				)
			).toBe(targetBytes);
		}
	});

	it.each(['', '🌙'])(
		'enforces input byte boundaries with prefix %j before native execution',
		async (prefix) => {
			const stopDiagnostics = captureInputFailureDiagnostics('spawn');
			try {
				let admittedPid: number | undefined;
				for (const delta of [-1, 0, 1]) {
					const pid = join(
						directory,
						`input-${prefix ? 'unicode' : 'ascii'}-${delta}.pid`
					);
					const input = { pid, padding: '' };
					const overhead = Buffer.byteLength(
						JSON.stringify({
							module: narrativeModulePath(),
							cacheMaxBytes: 16 * 1024 * 1024,
							operation: 'analyze',
							input,
						})
					);
					const payloadBytes = NARRATIVE_INPUT_BYTES + delta - overhead;
					input.padding = prefix + 'x'.repeat(payloadBytes - Buffer.byteLength(prefix));
					const pending = context.analyzeAsync(input as never);
					input.padding = '';
					if (delta <= 0) {
						const result = (await pending) as unknown as {
							pid: number;
							calls: number;
							inputBytes: number;
						};
						expect(result).toMatchObject({
							calls: delta + 2,
							inputBytes: payloadBytes,
							text: '🌙',
						});
						expect(await waitPid(pid)).toBe(result.pid);
						if (admittedPid !== undefined) expect(result.pid).toBe(admittedPid);
						admittedPid = result.pid;
					} else {
						await expect(pending).rejects.toThrow('input exceeds 64 MiB');
						await expect(readFile(pid)).rejects.toMatchObject({ code: 'ENOENT' });
						expect(await context.analyzeAsync({} as never)).toMatchObject({
							calls: 3,
							pid: admittedPid,
						});
					}
				}
			} finally {
				stopDiagnostics();
			}
		}
	);

	it('preserves the deadline error when termination precedes input delivery and recovers', async () => {
		const processes =
			jest.requireActual<typeof import('node:child_process')>('node:child_process');
		const launched = jest.spyOn(processes, 'spawn');
		try {
			await expect(
				context.analyzeAsync({ mode: 'block' } as never, { timeoutMs: 1 })
			).rejects.toThrow(/exceeded 1 milliseconds and was terminated/);
			expect(launched).toHaveBeenCalledTimes(1);
			const child = launched.mock.results[0].value as ReturnType<typeof processes.spawn>;
			expect(child.pid).toBeGreaterThan(0);
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
			expect(alive(child.pid!)).toBe(false);
			expect(await context.analyzeAsync({} as never)).toMatchObject({ calls: 1 });
		} finally {
			launched.mockRestore();
		}
	});

	async function launchOwner(script: string) {
		const source = await readFile(
			join(__dirname, '../../../src/services/editorial/narrative-context.ts'),
			'utf8'
		);
		await writeFile(
			join(directory, 'context.cjs'),
			transpileModule(source, {
				compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
			}).outputText
		);
		await writeFile(
			join(directory, 'lens-native.cjs'),
			"exports.narrativeModulePath = () => require('node:path').join(__dirname, 'fixture.cjs');"
		);
		await writeFile(
			join(directory, 'narrative-worker.js'),
			`exports.NARRATIVE_INPUT_BYTES = ${NARRATIVE_INPUT_BYTES}; exports.NARRATIVE_HEAP_MIB = ${NARRATIVE_HEAP_MIB};`
		);
		await writeFile(join(directory, 'owner.cjs'), script);
		return spawn(process.execPath, [join(directory, 'owner.cjs')], { stdio: 'ignore' });
	}

	it('keeps the watchdog armed while output is blocked and the owner stalls', async () => {
		const pidFile = join(directory, 'blocked-output.pid');
		const resumedFile = join(directory, 'resumed-owner.pid');
		const owner = await launchOwner(`
const context = new (require('./context.cjs').NarrativeContext)();
(async () => {
  await context.stats();
  context.analyzeAsync({ pid: ${JSON.stringify(pidFile)}, targetBytes: 16 * 1024 * 1024 }, { timeoutMs: 400 }).catch(() => {});
  context.child.stdout.pause();
  const parentTimer = context.pending.timer;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
  clearTimeout(parentTimer);
  require('node:fs').writeFileSync(${JSON.stringify(resumedFile)}, String(process.pid));
})().catch(() => process.exit(1));`);
		const exited = once(owner, 'exit');
		let childPid: number | undefined;
		try {
			childPid = await waitPid(pidFile);
			await waitPid(resumedFile);
			// Let the resumed owner reap a child killed by its independent watchdog.
			await delay(100);
			expect(alive(childPid)).toBe(false);
		} finally {
			if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
			if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
			await exited;
		}
	});

	it('charges decoding to the same deadline after owner death', async () => {
		const decodePid = join(directory, 'decode-start.pid');
		const nativePid = join(directory, 'decode-native.pid');
		const owner = await launchOwner(`
const context = new (require('./context.cjs').NarrativeContext)();
(async () => {
  await context.analyzeAsync({ decodeDelayMs: 900, decodePid: ${JSON.stringify(decodePid)} });
  await context.analyzeAsync({ mode: 'block', pid: ${JSON.stringify(nativePid)} }, { timeoutMs: 1400 });
})().catch(() => {});`);
		const exited = once(owner, 'exit');
		let childPid: number | undefined;
		try {
			childPid = await waitPid(decodePid);
			const deadline = Date.now() + 1700;
			expect(await waitPid(nativePid)).toBe(childPid);
			owner.kill('SIGKILL');
			await exited;
			while (alive(childPid) && Date.now() < deadline) await delay(25);
			expect(alive(childPid)).toBe(false);
		} finally {
			if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
			if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
			await exited;
		}
	});

	it('honors a short deadline during blocked decoding after owner death', async () => {
		const decodePid = join(directory, 'blocked-decode-start.pid');
		const nativePid = join(directory, 'blocked-decode-native.pid');
		const owner = await launchOwner(`
const context = new (require('./context.cjs').NarrativeContext)();
(async () => {
  await context.analyzeAsync({ decodeDelayMs: 4000, decodePid: ${JSON.stringify(decodePid)} });
  await context.analyzeAsync({ pid: ${JSON.stringify(nativePid)} }, { timeoutMs: 400 });
})().catch(() => {});`);
		const exited = once(owner, 'exit');
		let childPid: number | undefined;
		try {
			childPid = await waitPid(decodePid);
			expect(alive(childPid)).toBe(true);
			owner.kill('SIGKILL');
			await exited;
			const deadline = Date.now() + 1000;
			while (alive(childPid) && Date.now() < deadline) await delay(25);
			expect(alive(childPid)).toBe(false);
			await expect(readFile(nativePid)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
			if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
			await exited;
		}
	});

	it.each(['idle', 'blocked'] as const)('exits after owner death while %s', async (mode) => {
		const pidFile = join(directory, `owner-${mode}.pid`);
		const owner = await launchOwner(
			`const context = new (require('./context.cjs').NarrativeContext)(); context.analyzeAsync({ mode: ${JSON.stringify(mode === 'blocked' ? 'block' : '')}, pid: ${JSON.stringify(pidFile)} }, { timeoutMs: 800 }).catch(() => {});`
		);
		const exited = once(owner, 'exit');
		let childPid: number | undefined;
		try {
			childPid = await waitPid(pidFile);
			if (mode === 'idle') await delay(100);
			owner.kill('SIGKILL');
			await exited;
			const deadline = Date.now() + 2500;
			while (alive(childPid) && Date.now() < deadline) await delay(25);
			expect(alive(childPid)).toBe(false);
		} finally {
			if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
			if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
			await exited;
		}
	});
});
