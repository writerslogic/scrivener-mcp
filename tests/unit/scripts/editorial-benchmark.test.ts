import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const repository = resolve(__dirname, '../../..');

test.each([
	['overwrite', 'Comparison output must not overwrite its baseline'],
	['labels', 'Cannot compare changed annotations'],
	['duplicate', 'Duplicate baseline cases'],
])('benchmark rejects %s without publishing a misleading comparison', async (kind, message) => {
	const directory = await mkdtemp(join(tmpdir(), 'editorial-baseline-guard-'));
	try {
		const baseline = JSON.parse(
			await readFile(
				join(repository, 'docs/benchmarks/editorial-quality-baseline.json'),
				'utf8'
			)
		);
		if (kind === 'labels') {
			baseline.predictions[0].expected++;
			baseline.predictions[0].fn++;
		}
		if (kind === 'duplicate') baseline.predictions.push(baseline.predictions[0]);
		const baselinePath = join(directory, 'baseline.json');
		const bytes = JSON.stringify(baseline);
		await writeFile(baselinePath, bytes);
		const output = kind === 'overwrite' ? baselinePath : join(directory, 'comparison.json');
		await expect(
			promisify(execFile)(
				process.execPath,
				[
					join(repository, 'scripts/benchmark-editorial.mjs'),
					'--baseline',
					baselinePath,
					'--output',
					output,
				],
				{ cwd: repository, timeout: 20000, maxBuffer: 128 * 1024 }
			)
		).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
		expect(await readFile(baselinePath, 'utf8')).toBe(bytes);
		if (kind !== 'overwrite')
			await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('added cases cannot mask a regression on a previously detected baseline case', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'editorial-paired-regression-'));
	try {
		const baseline = JSON.parse(
			await readFile(
				join(repository, 'docs/benchmarks/editorial-quality-baseline.json'),
				'utf8'
			)
		);
		const changed = baseline.predictions.find((row: { id: string }) =>
			row.id.endsWith('/pronoun')
		);
		changed.tp = 1;
		changed.fn = 0;
		changed.actual = 1;
		const preload = join(directory, 'inject-regression.mjs');
		const service = pathToFileURL(
			join(repository, 'dist/services/editorial/continuity-service.js')
		).href;
		await writeFile(
			preload,
			`import { ContinuityService } from ${JSON.stringify(service)};
const analyze = ContinuityService.prototype.analyze;
let suppressed = false;
ContinuityService.prototype.analyze = async function (...args) {
  const report = await analyze.apply(this, args);
  if (!suppressed && report.issues.some(issue => issue.evidence.some(passage =>
    passage.quote === 'Mara stepped forward. Her eyes were green'))) {
    report.issues = [];
    suppressed = true;
  }
  return report;
};`
		);
		const baselinePath = join(directory, 'baseline.json');
		const output = join(directory, 'comparison.json');
		await writeFile(baselinePath, JSON.stringify(baseline));
		await expect(
			promisify(execFile)(
				process.execPath,
				[
					'--import',
					preload,
					join(repository, 'scripts/benchmark-editorial.mjs'),
					'--baseline',
					baselinePath,
					'--output',
					output,
				],
				{ cwd: repository, timeout: 20000, maxBuffer: 128 * 1024 }
			)
		).rejects.toMatchObject({ code: 1 });
		const result = JSON.parse(await readFile(output, 'utf8'));
		expect(result.passed).toBe(false);
		expect(result.comparison.regressions).toEqual([changed.id]);
		expect(result.overall.recall).toBeGreaterThan(result.comparison.before.recall);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
