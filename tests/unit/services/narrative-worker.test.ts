import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getEventListeners } from 'node:events';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
	narrativeWorker,
	NARRATIVE_INPUT_BYTES,
} from '../../../src/services/editorial/narrative-worker.js';
import { narrativeModulePath } from '../../../src/services/editorial/lens-native.cjs';

jest.mock('../../../src/services/editorial/lens-native.cjs', () => ({
	narrativeModulePath: jest.fn(),
}));

describe('native process deadlines and cleanup', () => {
	let directory: string;
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'lens-worker-'));
		const module = join(directory, 'fixture.cjs');
		await writeFile(
			module,
			`exports.analyzeAuthorCausality = input => {
            if (input.pid) require('node:fs').writeFileSync(input.pid, String(process.pid));
            if (input.stats) process.on('exit', () => require('node:fs').writeFileSync(input.stats,
                JSON.stringify({ pid: process.pid, memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS })));
            if (input.mode === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
            if (input.mode === 'fail') throw new Error('invalid evidence fixture');
            if (input.mode === 'exit') process.exit(8);
            if (input.mode === 'bytes') return { value: 'x'.repeat(input.size) };
            return { value: '🌙'.repeat(input.size || 1) };
        }; exports.compareManuscriptReports = exports.analyzeAuthorCausality;`
		);
		jest.mocked(narrativeModulePath).mockReturnValue(module);
	});
	it('enforces the serialized output budget at limit minus one, limit and limit plus one', async () => {
		const limit = 16 * 1024 * 1024;
		const overhead = Buffer.byteLength(JSON.stringify({ ok: true, result: { value: '' } }));
		const samples = [];
		for (const delta of [-1, 0, 1]) {
			const stats = join(directory, `size-${delta}.json`);
			const size = limit + delta - overhead;
			const started = Date.now();
			const pending = narrativeWorker('analyzeAuthorCausality', [
				{ mode: 'bytes', size, stats },
			]);
			if (delta <= 0) {
				const result = (await pending) as { value: string };
				expect(result.value.length).toBe(size);
			} else await expect(pending).rejects.toThrow(/exceeds 16 MiB/);
			const sample = JSON.parse(await readFile(stats, 'utf8'));
			expect(() => process.kill(sample.pid, 0)).toThrow();
			samples.push({ bytes: limit + delta, elapsedMs: Date.now() - started, ...sample });
		}
		if (process.env.SCRIVENER_WORKER_RESOURCE_REPORT)
			await writeFile(
				process.env.SCRIVENER_WORKER_RESOURCE_REPORT,
				JSON.stringify(
					{
						scope: 'Process serialization/output boundary fixture, not native addon RSS containment.',
						node: process.version,
						platform: `${process.platform}-${process.arch}`,
						samples,
					},
					null,
					2
				) + '\n'
			);
	});
	it.each(['', '🌙'])(
		'enforces the serialized input budget with prefix %j at limit minus one, limit and limit plus one',
		async (prefix) => {
			const operation = 'analyzeAuthorCausality';
			const overhead = Buffer.byteLength(
				JSON.stringify({
					module: narrativeModulePath(),
					operation,
					args: [{ padding: '' }],
				})
			);
			for (const delta of [-1, 0, 1]) {
				const pending = narrativeWorker(operation, [
					{
						padding:
							prefix +
							'x'.repeat(
								NARRATIVE_INPUT_BYTES + delta - overhead - Buffer.byteLength(prefix)
							),
					},
				]);
				if (delta <= 0) await expect(pending).resolves.toEqual({ value: '🌙' });
				else await expect(pending).rejects.toThrow('input exceeds 64 MiB');
			}
		}
	);
	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	it('returns normal and large Unicode results without blocking the parent event loop', async () => {
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		try {
			expect(await narrativeWorker('analyzeAuthorCausality', [{}])).toEqual({ value: '🌙' });
			const result = (await narrativeWorker('analyzeAuthorCausality', [
				{ size: 250000 },
			])) as { value: string };
			expect(result.value.length).toBe(500000);
			expect(ticks).toBeGreaterThan(0);
		} finally {
			clearInterval(timer);
		}
	});
	it.each(['analyzeAuthorCausality', 'compareManuscriptReports'])(
		'waits for hard termination of blocked %s before rejecting the deadline',
		async (operation) => {
			const pid = join(directory, 'timeout.pid');
			const started = Date.now();
			await expect(
				narrativeWorker(operation, [{ mode: 'block', pid }], { timeoutMs: 400 })
			).rejects.toThrow(/terminated/);
			expect(Date.now() - started).toBeLessThan(2500);
			expect(() =>
				process.kill(Number(require('node:fs').readFileSync(pid, 'utf8')), 0)
			).toThrow();
		}
	);
	it.each([1, 2])(
		'reports the %i ms deadline when termination interrupts a pending input write',
		async (timeoutMs) => {
			await expect(
				narrativeWorker(
					'compareManuscriptReports',
					[{ mode: 'block', padding: 'x'.repeat(1024 * 1024) }],
					{ timeoutMs }
				)
			).rejects.toThrow(`exceeded ${timeoutMs} milliseconds and was terminated`);
		}
	);
	it.each(['analyzeAuthorCausality', 'compareManuscriptReports'])(
		'hard-cancels blocked %s and leaves no child running',
		async (operation) => {
			const pid = join(directory, 'cancel.pid');
			const controller = new AbortController();
			const pending = narrativeWorker(operation, [{ mode: 'block', pid }], {
				signal: controller.signal,
			});
			const rejected = expect(pending).rejects.toThrow(/cancelled/);
			const timer = setTimeout(() => controller.abort(), 400);
			try {
				await rejected;
			} finally {
				clearTimeout(timer);
			}
			const childId = Number(await readFile(pid, 'utf8'));
			expect(() => process.kill(childId, 0)).toThrow();
		}
	);
	it('enforces the deadline after its owner is killed while native work is blocked', async () => {
		const sourcePath = join(__dirname, '../../../src/services/editorial/narrative-worker.ts');
		await writeFile(
			join(directory, 'worker.cjs'),
			transpileModule(await readFile(sourcePath, 'utf8'), {
				compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
			}).outputText
		);
		await writeFile(
			join(directory, 'lens-native.cjs'),
			`exports.narrativeModulePath = () => ${JSON.stringify(join(directory, 'fixture.cjs'))};`
		);
		const pidPath = join(directory, 'orphan.pid');
		await writeFile(
			join(directory, 'owner.cjs'),
			`require('./worker.cjs').narrativeWorker('compareManuscriptReports', [{ mode: 'block', pid: ${JSON.stringify(pidPath)} }], { timeoutMs: 800 }).catch(() => {});`
		);
		const owner = spawn(process.execPath, [join(directory, 'owner.cjs')], { stdio: 'ignore' });
		const exited = once(owner, 'exit');
		let childId: number | undefined;
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		try {
			const enteredDeadline = Date.now() + 3000;
			while (Date.now() < enteredDeadline) {
				const contents = await readFile(pidPath, 'utf8').catch((error) => {
					if (error.code === 'ENOENT') return '';
					throw error;
				});
				if (/^[1-9][0-9]*$/.test(contents)) {
					childId = Number(contents);
					break;
				}
				await delay(20);
			}
			expect(childId).toBeDefined();
			expect(alive(childId!)).toBe(true);
			owner.kill('SIGKILL');
			await exited;
			const deadline = Date.now() + 2000;
			while (alive(childId!) && Date.now() < deadline) await delay(25);
			expect(alive(childId!)).toBe(false);
		} finally {
			if (childId && alive(childId)) process.kill(childId, 'SIGKILL');
			if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
			await exited;
		}
	});

	it('cleans up the admitted cancellation signal when caller options change', async () => {
		const admitted = new AbortController();
		const replacement = new AbortController();
		const options = { signal: admitted.signal };
		const pending = narrativeWorker('compareManuscriptReports', [{}], options);
		expect(getEventListeners(admitted.signal, 'abort')).toHaveLength(1);
		options.signal = replacement.signal;
		await expect(pending).resolves.toEqual({ value: '🌙' });
		expect(getEventListeners(admitted.signal, 'abort')).toHaveLength(0);
		expect(getEventListeners(replacement.signal, 'abort')).toHaveLength(0);
	});

	it('propagates native validation errors and abrupt exits, and remains reusable', async () => {
		await expect(narrativeWorker('analyzeAuthorCausality', [{ mode: 'fail' }])).rejects.toThrow(
			/invalid evidence/
		);
		await expect(narrativeWorker('analyzeAuthorCausality', [{ mode: 'exit' }])).rejects.toThrow(
			/process failed/
		);
		await expect(narrativeWorker('unknown', [])).rejects.toThrow(/Unsupported/);
		await expect(narrativeWorker('analyzeAuthorCausality', [{}])).resolves.toEqual({
			value: '🌙',
		});
	});
});
