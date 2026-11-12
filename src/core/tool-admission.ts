import { AppError, ErrorCode, RateLimiter } from '../utils/common.js';

export const TOOL_ADMISSION_LIMITS = Object.freeze({
	maxPending: 32,
	maxPendingBytes: 16 * 1024 * 1024,
	maxConcurrent: 8,
	invocationsPerMinute: 120,
});

interface AdmissionLimits {
	maxPending: number;
	maxPendingBytes: number;
	maxConcurrent: number;
	invocationsPerMinute: number;
}

interface PendingInvocation {
	start(): void;
}

export class ToolInvocationAdmission {
	private readonly queue = new Set<PendingInvocation>();
	private readonly rateLimiter: RateLimiter;
	private readonly limits: AdmissionLimits;
	private active = 0;
	private pending = 0;
	private pendingBytes = 0;

	constructor(limits: AdmissionLimits = TOOL_ADMISSION_LIMITS) {
		for (const [name, value] of Object.entries(limits)) {
			if (!Number.isSafeInteger(value) || value < 1)
				throw new RangeError(`${name} must be a positive safe integer`);
		}
		if (limits.maxConcurrent > limits.maxPending)
			throw new RangeError('maxConcurrent must not exceed maxPending');
		this.limits = { ...limits };
		this.rateLimiter = new RateLimiter(limits.invocationsPerMinute, 60_000);
	}

	async run<T>(
		params: Record<string, unknown>,
		signal: AbortSignal,
		execute: () => Promise<T>
	): Promise<T> {
		if (signal.aborted) throw this.cancelled();
		if (!this.rateLimiter.tryRemove())
			throw new AppError(
				`Tool invocation rate exceeded. Retry after at least ${Math.ceil(60_000 / this.limits.invocationsPerMinute)} ms.`,
				ErrorCode.RATE_LIMITED
			);
		if (this.pending >= this.limits.maxPending)
			throw new AppError(
				`Tool invocation capacity exceeded (${this.limits.maxPending} active or queued calls). Wait for a call to finish or cancel a queued call before retrying.`,
				ErrorCode.RESOURCE_EXHAUSTED
			);
		const bytes = Buffer.byteLength(JSON.stringify(params));
		if (bytes > this.limits.maxPendingBytes - this.pendingBytes)
			throw new AppError(
				`Tool invocation byte capacity exceeded (${this.limits.maxPendingBytes} UTF-8 JSON bytes across active and queued parameters). Use a smaller request or wait for pending calls to finish.`,
				ErrorCode.RESOURCE_EXHAUSTED
			);

		this.pending++;
		this.pendingBytes += bytes;
		return new Promise<T>((resolve, reject) => {
			const release = () => {
				this.pending--;
				this.pendingBytes -= bytes;
			};
			const cancel = () => {
				if (!this.queue.delete(entry)) return;
				signal.removeEventListener('abort', cancel);
				release();
				reject(this.cancelled());
			};
			const finish = () => {
				this.active--;
				release();
				this.drain();
			};
			const entry: PendingInvocation = {
				start: () => {
					signal.removeEventListener('abort', cancel);
					this.active++;
					// Active work owns its capacity until settlement, even if it ignores cancellation.
					void Promise.resolve()
						.then(() => {
							if (signal.aborted) throw this.cancelled();
							return execute();
						})
						.then(
							(result) => {
								finish();
								resolve(result);
							},
							(error: unknown) => {
								finish();
								reject(error);
							}
						);
				},
			};
			this.queue.add(entry);
			signal.addEventListener('abort', cancel, { once: true });
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < this.limits.maxConcurrent && this.queue.size > 0) {
			const entry = this.queue.values().next().value!;
			this.queue.delete(entry);
			entry.start();
		}
	}

	private cancelled(): AppError {
		return new AppError(
			'Tool request cancelled before execution',
			ErrorCode.OPERATION_CANCELLED
		);
	}
}
