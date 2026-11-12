import { performance } from 'node:perf_hooks';
import { processTree, selectProcessTree } from '../../../scripts/lib/benchmark-process-tree.js';

test('selects nested descendants before reading metrics from unrelated exiting processes', () => {
	const rows = '10 1 100 1:02.50\n11 10 20 0:00.02\n12 11 30 00:01:00.00\n13 10\n20 1\n';
	expect(selectProcessTree(rows, 10, 13)).toEqual([
		{ pid: 10, parent: 1, rssBytes: 102400, cpuMs: 62500 },
		{ pid: 11, parent: 10, rssBytes: 20480, cpuMs: 20 },
		{ pid: 12, parent: 11, rssBytes: 30720, cpuMs: 60000 },
	]);
});

test.each([
	'10 1',
	'10 1 100 0:00.00\n11 10',
	'10 1 100 0:99.00',
	'10 1 99999999999999999999 0:00.00',
])('fails when selected process resources are missing or invalid: %s', (rows) => {
	expect(() => selectProcessTree(rows, 10)).toThrow(/resource observation/);
});

test('fails on missing root or malformed identities rather than silently reporting an empty tree', () => {
	expect(() => selectProcessTree('11 1 0 0:00.00', 10)).toThrow('Root process missing');
	expect(() => selectProcessTree('10 invalid 0 0:00.00', 10)).toThrow('Invalid process identity');
});

(process.platform === 'win32' ? test.skip : test)(
	'retains observer output when the measured event loop stalls longer than two seconds',
	async () => {
		const observation = processTree();
		const until = performance.now() + 2200;
		while (performance.now() < until) {
			/* Deliberately reproduce an unresponsive measured loop. */
		}
		const rows = await observation;
		expect(rows.find((row) => row.pid === process.pid)?.rssBytes).toBeGreaterThan(0);
	}
);
