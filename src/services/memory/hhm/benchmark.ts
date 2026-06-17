import { getLogger } from '../../../core/logger.js';

const logger = getLogger('hhm-benchmark');

export async function quickBenchmark(dimensions: number = 10000): Promise<void> {
	let NativeHMS;
	try {
		const mod = await import('holographic-memory');
		NativeHMS = mod.HolographicMemorySystem;
	} catch {
		logger.warn('holographic-memory not installed, skipping benchmark');
		return;
	}

	logger.info('Starting Native HMS Benchmark', { dimensions });

	const hms = new NativeHMS(dimensions, undefined);
	const iterations = 100;
	const startTime = performance.now();

	for (let i = 0; i < iterations; i++) {
		await hms.memorizeText(
			`id_${i}`,
			`This is a sample text for benchmarking iteration ${i}. It needs to be long enough to be meaningful.`
		);
	}

	const midTime = performance.now();

	for (let i = 0; i < iterations; i++) {
		await hms.query('sample text for benchmarking', 5);
	}

	const endTime = performance.now();

	const totalTime = endTime - startTime;
	const memorizeTime = midTime - startTime;
	const queryTime = endTime - midTime;

	console.error('\n=== Native HMS (Rust) Benchmark Results ===');
	console.error(`Dimensions: ${dimensions}`);
	console.error(`Iterations: ${iterations}`);
	console.error(`Total Time: ${totalTime.toFixed(2)}ms`);
	console.error(`Avg Memorize: ${(memorizeTime / iterations).toFixed(2)}ms`);
	console.error(`Avg Query: ${(queryTime / iterations).toFixed(2)}ms`);
	console.error(`Ops/sec: ${((iterations * 2) / (totalTime / 1000)).toFixed(0)}`);
	console.error('-------------------------------------------\n');
}
