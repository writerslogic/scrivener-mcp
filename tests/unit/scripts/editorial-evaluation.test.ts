import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const repository = resolve(__dirname, '../../..');
const runner = join(repository, 'scripts/evaluate-editorial.mjs');
const run = (args: string[]) =>
	promisify(execFile)(process.execPath, args, {
		cwd: repository,
		timeout: 20000,
		maxBuffer: 128 * 1024,
	});

test.each(['fingerprint', 'counts', 'duplicate', 'overwrite'])(
	'evaluation rejects invalid %s baseline without modifying it',
	async (kind) => {
		const directory = await mkdtemp(join(tmpdir(), 'evaluation-guard-'));
		try {
			const baseline = JSON.parse(
				await readFile(
					join(repository, 'docs/benchmarks/editorial-evaluation-baseline.json'),
					'utf8'
				)
			);
			if (kind === 'fingerprint') baseline.corpusSha256 = '0'.repeat(64);
			if (kind === 'counts') baseline.predictions[0].tp = -1;
			if (kind === 'duplicate') baseline.predictions[1] = baseline.predictions[0];
			const path = join(directory, 'baseline.json');
			const bytes = JSON.stringify(baseline);
			await writeFile(path, bytes);
			const output = kind === 'overwrite' ? path : join(directory, 'output.json');
			await expect(
				run([runner, '--baseline', path, '--output', output])
			).rejects.toMatchObject({ code: 1 });
			expect(await readFile(path, 'utf8')).toBe(bytes);
			if (kind !== 'overwrite')
				await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);

test.each(['miss', 'evidence', 'subject'])(
	'evaluation detects injected %s even when aggregate scores improve',
	async (kind) => {
		const directory = await mkdtemp(join(tmpdir(), 'evaluation-fault-'));
		try {
			const preload = join(directory, 'fault.mjs');
			const service = pathToFileURL(
				join(repository, 'dist/services/editorial/continuity-service.js')
			).href;
			await writeFile(
				preload,
				`import { ContinuityService } from ${JSON.stringify(service)};
const analyze = ContinuityService.prototype.analyze;
let injected = false;
ContinuityService.prototype.analyze = async function (...args) {
  const report = await analyze.apply(this, args);
  if (!injected && report.issues.length) {
    ${kind === 'miss' ? 'report.issues = [];' : kind === 'subject' ? "report.candidates[0].subject = 'Unrelated owner';" : "report.issues[0].evidence[0].quote = 'Fabricated quotation';"}
    injected = true;
  }
  return report;
};`
			);
			const output = join(directory, 'output.json');
			await expect(
				run([
					'--import',
					pathToFileURL(preload).href,
					runner,
					'--baseline',
					join(repository, 'docs/benchmarks/editorial-evaluation-baseline.json'),
					'--output',
					output,
				])
			).rejects.toMatchObject({
				code: 1,
				...(kind === 'evidence'
					? {
							stderr: expect.stringContaining(
								'Source quotation does not match the manuscript range'
							),
						}
					: {}),
			});
			if (kind !== 'evidence') {
				const report = JSON.parse(await readFile(output, 'utf8'));
				expect(report.comparison.regressions).toEqual(['narrated-color']);
				if (kind === 'subject')
					expect(report.predictions[0]).toMatchObject({ tp: 0, fp: 1, fn: 1 });
				expect(report.overall.recall).toBeGreaterThan(report.comparison.before.recall);
			} else await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);
