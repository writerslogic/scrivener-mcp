import { ContentAnalyzer } from '../../../src/analysis/base-analyzer.js';
import { JobQueueService } from '../../../src/services/queue/job-queue.js';
import { PredictiveCache } from '../../../src/utils/predictive-cache.js';

describe('predictive cache resource ownership', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.restoreAllMocks();
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	it('imports all singleton exports and constructs caches without creating timers', () => {
		const intervals = jest.spyOn(global, 'setInterval');
		jest.isolateModules(() => {
			const module = jest.requireActual<
				typeof import('../../../src/utils/predictive-cache.js')
			>('../../../src/utils/predictive-cache.js');
			for (const cache of [
				module.analysisCache,
				module.documentCache,
				module.metadataCache,
			]) {
				expect(cache.getStats().entryCount).toBe(0);
			}
			new module.PredictiveCache();
		});
		expect(intervals).not.toHaveBeenCalled();
	});

	it('starts loader-free maintenance once on use and permanently stops on disposal', async () => {
		const cache = new PredictiveCache<string>();
		expect(jest.getTimerCount()).toBe(0);
		await cache.set('first', 'value');
		expect(jest.getTimerCount()).toBe(2);
		await cache.get('first');
		await cache.set('second', 'other');
		expect(jest.getTimerCount()).toBe(2);
		cache.dispose();
		cache.dispose();
		expect(jest.getTimerCount()).toBe(0);
		await cache.set('third', 'ignored');
		expect(await cache.get('first')).toBeUndefined();
		expect(cache.getStats()).toMatchObject({ size: 0, entryCount: 0 });
		expect(jest.getTimerCount()).toBe(0);
	});

	it('finishes an already-running loader without repopulating or restarting a disposed cache', async () => {
		let resolve!: (value: string) => void;
		const loader = jest.fn(
			() =>
				new Promise<string>((notify) => {
					resolve = notify;
				})
		);
		const cache = new PredictiveCache<string>(1024, loader);
		const pending = cache.get('pending');
		expect(jest.getTimerCount()).toBe(3);
		cache.dispose();
		resolve('loaded');
		expect(await pending).toBe('loaded');
		expect(await cache.get('pending')).toBeUndefined();
		expect(loader).toHaveBeenCalledTimes(1);
		expect(cache.getStats()).toMatchObject({ size: 0, entryCount: 0 });
		expect(jest.getTimerCount()).toBe(0);
	});

	it.each(['resolve', 'reject'])(
		'stops an in-flight prefetch after disposal when its loader %ss',
		async (outcome) => {
			jest.spyOn(Math, 'random').mockReturnValue(0.99);
			let resolve!: (value: string) => void;
			let reject!: (error: Error) => void;
			const loader = jest.fn(
				() =>
					new Promise<string>((accept, fail) => {
						resolve = accept;
						reject = fail;
					})
			);
			const cache = new PredictiveCache<string>(100 * 1024, loader);
			await cache.set('key'.repeat(2000), 'value');
			jest.advanceTimersByTime(5000);
			expect(loader).toHaveBeenCalledTimes(1);
			cache.dispose();
			if (outcome === 'resolve') resolve('prefetched');
			else reject(new Error('Synthetic prefetch failure'));
			await Promise.resolve();
			await Promise.resolve();
			jest.advanceTimersByTime(300000);
			expect(loader).toHaveBeenCalledTimes(1);
			expect(cache.getStats()).toMatchObject({ size: 0, entryCount: 0 });
			expect(cache.getPrefetchRecommendations()).toEqual([]);
			expect(jest.getTimerCount()).toBe(0);
		}
	);

	it('releases every cache owned by an analyzer after actual analysis', async () => {
		const analyzer = new ContentAnalyzer();
		expect(jest.getTimerCount()).toBe(0);
		const result = await analyzer.analyzeContentDirect(
			'The cat sat on the mat. The dog ran fast. We all had a lot of fun today.',
			'lifecycle-document'
		);
		expect(result.documentId).toBe('lifecycle-document');
		expect(jest.getTimerCount()).toBe(6);
		analyzer.dispose();
		analyzer.dispose();
		expect(jest.getTimerCount()).toBe(0);
	});

	it('releases an analyzer owned by the job queue on shutdown', async () => {
		const queue = new JobQueueService();
		try {
			await queue.analyzeDocument({
				documentId: 'queue-owned-analysis',
				content: 'The cat sat on the mat. The dog ran fast. We all had a lot of fun today.',
				options: { includeReadability: true },
			});
			expect(jest.getTimerCount()).toBe(6);
		} finally {
			await queue.shutdown();
		}
		expect(jest.getTimerCount()).toBe(0);
	});

	it('finishes in-flight analysis after disposal without retaining memoized results, pooled resources or timers', async () => {
		const analyzer = new ContentAnalyzer();
		const resources = analyzer as unknown as {
			memoizedCalculations: ReadonlyMap<string, unknown>;
			resourcePool: ReadonlyMap<string, unknown[]>;
		};
		const pending = analyzer.analyzeContentDirect(
			'The cat sat on the mat. The dog ran fast. We all had a lot of fun today.',
			'in-flight-document'
		);
		expect(jest.getTimerCount()).toBe(2);
		analyzer.dispose();
		const result = await pending;
		expect(result.documentId).toBe('in-flight-document');
		expect(result.metrics.wordCount).toBeGreaterThan(0);
		expect(resources.memoizedCalculations.size).toBe(0);
		expect(resources.resourcePool.size).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
	});
});
