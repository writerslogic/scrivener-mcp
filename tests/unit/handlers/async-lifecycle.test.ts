import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	initializeAsyncServices,
	shutdownAsyncServices,
	queueDocumentAnalysis,
} from '../../../src/handlers/async-handlers.js';

jest.mock('../../../src/services/queue/job-queue.js', () => {
	const instances: Array<{ closed: boolean; inFlight: number }> = [];
	class Queue {
		readonly generation = instances.length + 1;
		closed = false;
		inFlight = 0;
		gate?: Promise<void>;
		entered?: () => void;
		constructor() {
			instances.push(this);
		}
		async initialize(): Promise<void> {}
		getConnectionInfo() {
			return { type: 'embedded', isConnected: !this.closed };
		}
		async addJob(): Promise<string> {
			if (this.closed) throw new Error('A closed queue received work');
			this.inFlight++;
			this.entered?.();
			try {
				await this.gate;
				if (this.closed) throw new Error('Queue closed during an active operation');
				return `generation-${this.generation}`;
			} finally {
				this.inFlight--;
			}
		}
		async shutdown(): Promise<void> {
			if (this.inFlight) throw new Error('Attempted to close an active resource');
			this.closed = true;
		}
	}
	return {
		JobQueueService: Queue,
		JobType: { ANALYZE_DOCUMENT: 'analyze_document' },
		__instances: instances,
	};
});

jest.mock('../../../src/services/ai/ai-client.js', () => ({
	AIClient: class {
		readonly isAvailable = false;
	},
}));

interface QueueInstance {
	generation: number;
	closed: boolean;
	inFlight: number;
	gate?: Promise<void>;
	entered?: () => void;
}

describe('async service resource lifecycle', () => {
	const state = jest.requireMock('../../../src/services/queue/job-queue.js') as {
		__instances: QueueInstance[];
	};
	let releases: Array<() => void>;
	const request = {
		documentId: '00000000-0000-4000-8000-000000000001',
		content: 'A local analysis request.',
	};

	beforeEach(() => {
		releases = [];
	});
	afterEach(async () => {
		for (const release of releases) release();
		await shutdownAsyncServices();
		state.__instances.length = 0;
	});

	function blockQueue(queue: QueueInstance): { entered: Promise<void>; release: () => void } {
		let release!: () => void;
		const entered = new Promise<void>((notify) => {
			queue.entered = notify;
		});
		queue.gate = new Promise<void>((notify) => {
			release = notify;
		});
		releases.push(release);
		return { entered, release };
	}

	it('coalesces equivalent concurrent initializations into one usable service generation', async () => {
		const projectPath = join(tmpdir(), 'scrivener-lifecycle-same');
		await Promise.all([
			initializeAsyncServices({ projectPath }),
			initializeAsyncServices({ projectPath }),
			initializeAsyncServices({ projectPath }),
		]);
		expect((await queueDocumentAnalysis(request)).jobId).toBe('generation-1');
		expect(state.__instances).toHaveLength(1);
		expect(state.__instances[0].closed).toBe(false);
	});

	it('reuses equal credential configurations and replaces the service after credential rotation', async () => {
		const projectPath = join(tmpdir(), 'scrivener-lifecycle-credentials');
		await initializeAsyncServices({ projectPath, openaiApiKey: 'credential-fixture-one' });
		const original = state.__instances[0];
		await initializeAsyncServices({ projectPath, openaiApiKey: 'credential-fixture-one' });
		expect((await queueDocumentAnalysis(request)).jobId).toBe('generation-1');
		await initializeAsyncServices({ projectPath, openaiApiKey: 'credential-fixture-two' });
		expect((await queueDocumentAnalysis(request)).jobId).toBe('generation-2');
		expect(original.closed).toBe(true);
	});

	it('lets leased operations finish on the original generation before replacement and routes later work to the new project', async () => {
		await initializeAsyncServices({ projectPath: join(tmpdir(), 'scrivener-lifecycle-first') });
		const original = state.__instances[0];
		const gate = blockQueue(original);
		const firstRequest = queueDocumentAnalysis(request);
		await gate.entered;
		const changing = initializeAsyncServices({
			projectPath: join(tmpdir(), 'scrivener-lifecycle-second'),
		});
		const secondRequest = queueDocumentAnalysis(request);
		await new Promise<void>((notify) => setImmediate(notify));
		expect(original.closed).toBe(false);
		gate.release();
		expect((await firstRequest).jobId).toBe('generation-1');
		await changing;
		expect((await secondRequest).jobId).toBe('generation-2');
		expect(original.closed).toBe(true);
	});

	it('drains an active operation before shutdown and rejects work after the service has closed', async () => {
		await initializeAsyncServices({
			projectPath: join(tmpdir(), 'scrivener-lifecycle-shutdown'),
		});
		const original = state.__instances[0];
		const gate = blockQueue(original);
		const firstRequest = queueDocumentAnalysis(request);
		await gate.entered;
		const closing = shutdownAsyncServices();
		const laterOutcome = queueDocumentAnalysis(request).then(
			() => null,
			(error: unknown) => error
		);
		await new Promise<void>((notify) => setImmediate(notify));
		expect(original.closed).toBe(false);
		gate.release();
		expect((await firstRequest).jobId).toBe('generation-1');
		await closing;
		expect(await laterOutcome).toBeInstanceOf(Error);
		expect(original.closed).toBe(true);
	});
});
