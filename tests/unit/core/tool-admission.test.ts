import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { ToolInvocationAdmission } from '../../../src/core/tool-admission.js';
import { ErrorCode } from '../../../src/utils/common.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const signal = () => new AbortController().signal;
const limits = {
	maxPending: 4,
	maxPendingBytes: 1024,
	maxConcurrent: 1,
	invocationsPerMinute: 120,
};

afterEach(() => {
	jest.restoreAllMocks();
});

describe.each([
	['modern', 1],
	['legacy', 2],
] as const)('%s invocation admission', (_era, maxConcurrent) => {
	it('admits count budget-1 and budget, rejects budget+1 before executing, and preserves order', async () => {
		const admission = new ToolInvocationAdmission({ ...limits, maxConcurrent });
		const gate = deferred();
		const started: number[] = [];
		const admitted = Array.from({ length: limits.maxPending - 1 }, (_, index) =>
			admission.run({}, signal(), async () => {
				started.push(index);
				await gate.promise;
			})
		);
		admitted.push(
			admission.run({}, signal(), async () => {
				started.push(3);
				await gate.promise;
			})
		);
		const excess = jest.fn(async () => {});
		await expect(admission.run({}, signal(), excess)).rejects.toMatchObject({
			code: ErrorCode.RESOURCE_EXHAUSTED,
		});
		expect(started).toHaveLength(maxConcurrent);
		expect(excess).not.toHaveBeenCalled();
		gate.resolve();
		await Promise.all(admitted);
		expect(started).toEqual([0, 1, 2, 3]);
		await expect(admission.run({}, signal(), async () => 'reused')).resolves.toBe('reused');
	});

	it.each([-1, 0, 1])(
		'checks aggregate serialized UTF-8 byte budget at limit%+d',
		async (delta) => {
			const first = { text: 'é' };
			const second = { text: '😀' };
			const budget =
				Buffer.byteLength(JSON.stringify(first)) +
				Buffer.byteLength(JSON.stringify(second));
			const admission = new ToolInvocationAdmission({
				...limits,
				maxConcurrent,
				maxPendingBytes: budget - delta,
			});
			const gate = deferred();
			const running = admission.run(first, signal(), () => gate.promise);
			const execute = jest.fn(async () => {});
			const next = admission.run(second, signal(), execute);
			if (delta > 0) {
				await expect(next).rejects.toMatchObject({ code: ErrorCode.RESOURCE_EXHAUSTED });
				expect(execute).not.toHaveBeenCalled();
			}
			gate.resolve();
			await running;
			if (delta <= 0) await expect(next).resolves.toBeUndefined();
			await expect(admission.run(second, signal(), async () => 'released')).resolves.toBe(
				'released'
			);
		}
	);

	it('rate limits completed calls at burst-1, burst, burst+1 and refills without a retained history', async () => {
		let now = 0;
		jest.spyOn(performance, 'now').mockImplementation(() => now);
		const admission = new ToolInvocationAdmission({
			...limits,
			maxConcurrent,
			invocationsPerMinute: 3,
		});
		const execute = jest.fn(async () => 'ok');
		for (let i = 0; i < 3; i++)
			await expect(admission.run({}, signal(), execute)).resolves.toBe('ok');
		await expect(admission.run({}, signal(), execute)).rejects.toMatchObject({
			code: ErrorCode.RATE_LIMITED,
		});
		expect(execute).toHaveBeenCalledTimes(3);
		now = 19_999;
		await expect(admission.run({}, signal(), execute)).rejects.toMatchObject({
			code: ErrorCode.RATE_LIMITED,
		});
		now = 20_000;
		await expect(admission.run({}, signal(), execute)).resolves.toBe('ok');
		now = 20_001;
		await expect(admission.run({}, signal(), execute)).rejects.toMatchObject({
			code: ErrorCode.RATE_LIMITED,
		});
	});

	it('holds a finite admitted workload during 10,000 rejected calls', async () => {
		const admission = new ToolInvocationAdmission({
			...limits,
			maxConcurrent,
			invocationsPerMinute: 20_000,
		});
		const gate = deferred();
		const execute = jest.fn(() => gate.promise);
		const admitted = Array.from({ length: 4 }, () => admission.run({}, signal(), execute));
		for (let i = 0; i < 10_000; i++)
			await expect(admission.run({}, signal(), execute)).rejects.toMatchObject({
				code: ErrorCode.RESOURCE_EXHAUSTED,
			});
		expect(execute).toHaveBeenCalledTimes(maxConcurrent);
		gate.resolve();
		await Promise.all(admitted);
		expect(execute).toHaveBeenCalledTimes(4);
	});
});

it('removes queued cancellation immediately, reclaims bytes/count, and never executes cancelled work', async () => {
	const params = { text: 'cancel me' };
	const bytes = Buffer.byteLength(JSON.stringify(params));
	const admission = new ToolInvocationAdmission({
		...limits,
		maxPending: 2,
		maxPendingBytes: bytes * 2,
	});
	const gate = deferred();
	const active = admission.run(params, signal(), () => gate.promise);
	const abort = new AbortController();
	const mutation = jest.fn(async () => {});
	const queued = admission.run(params, abort.signal, mutation);
	abort.abort();
	await expect(queued).rejects.toMatchObject({ code: ErrorCode.OPERATION_CANCELLED });
	const replacement = admission.run(params, signal(), async () => 'replacement');
	gate.resolve();
	await active;
	await expect(replacement).resolves.toBe('replacement');
	expect(mutation).not.toHaveBeenCalled();
});

it('does not free active capacity or start another operation when active work ignores cancellation', async () => {
	const admission = new ToolInvocationAdmission({ ...limits, maxPending: 1 });
	const gate = deferred();
	const abort = new AbortController();
	const entered = deferred();
	const active = admission.run({}, abort.signal, async () => {
		entered.resolve();
		await gate.promise;
	});
	await entered.promise;
	abort.abort();
	const mutation = jest.fn(async () => {});
	await expect(admission.run({}, signal(), mutation)).rejects.toMatchObject({
		code: ErrorCode.RESOURCE_EXHAUSTED,
	});
	expect(mutation).not.toHaveBeenCalled();
	gate.resolve();
	await active;
	await admission.run({}, signal(), mutation);
	expect(mutation).toHaveBeenCalledTimes(1);
});

it('rejects cancellation before execution and releases capacity after synchronous and asynchronous failures', async () => {
	const admission = new ToolInvocationAdmission({ ...limits, maxPending: 1 });
	const abort = new AbortController();
	const execute = jest.fn(async () => {});
	abort.abort();
	await expect(admission.run({}, abort.signal, execute)).rejects.toMatchObject({
		code: ErrorCode.OPERATION_CANCELLED,
	});
	expect(execute).not.toHaveBeenCalled();
	await expect(
		admission.run({}, signal(), () => {
			throw new Error('sync');
		})
	).rejects.toThrow('sync');
	await expect(
		admission.run({}, signal(), async () => {
			throw new Error('async');
		})
	).rejects.toThrow('async');
	await expect(admission.run({}, signal(), async () => 'ok')).resolves.toBe('ok');
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
	'rejects invalid admission budget %j',
	(value) => {
		for (const key of Object.keys(limits))
			expect(() => new ToolInvocationAdmission({ ...limits, [key]: value })).toThrow(
				RangeError
			);
	}
);
