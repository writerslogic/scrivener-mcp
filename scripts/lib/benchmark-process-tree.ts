import { execFile } from 'node:child_process';

export const PROCESS_OBSERVER_TIMEOUT_MS = 30000;

export interface ProcessReading {
	pid: number;
	parent: number;
	rssBytes: number;
	cpuMs: number;
}

export function selectProcessTree(
	output: string,
	rootPid: number,
	observerPid?: number
): ProcessReading[] {
	const rows = output
		.trim()
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => {
			const [pidText, parentText, ...metrics] = line.trim().split(/\s+/);
			const pid = Number(pidText),
				parent = Number(parentText);
			if (![pid, parent].every((value) => Number.isSafeInteger(value) && value >= 0))
				throw new Error('Invalid process identity observation');
			return { pid, parent, metrics };
		});
	if (!rows.some((row) => row.pid === rootPid))
		throw new Error('Root process missing from resource observation');
	const selected = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows)
			if (row.pid !== observerPid && selected.has(row.parent) && !selected.has(row.pid)) {
				selected.add(row.pid);
				changed = true;
			}
	}
	return rows
		.filter((row) => selected.has(row.pid))
		.map(({ pid, parent, metrics }) => {
			const [rss, time] = metrics;
			if (
				typeof rss !== 'string' ||
				!/^\d+$/.test(rss) ||
				typeof time !== 'string' ||
				!/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(time)
			)
				throw new Error(`Incomplete resource observation for selected process ${pid}`);
			const components = time.split(':').map(Number);
			const cpuMs = components.reduce((total, part) => total * 60 + part, 0) * 1000;
			const rssBytes = Number(rss) * 1024;
			if (
				!Number.isSafeInteger(rssBytes) ||
				!Number.isFinite(cpuMs) ||
				components.slice(1).some((part) => part >= 60)
			)
				throw new Error(`Invalid resource observation for selected process ${pid}`);
			return { pid, parent, rssBytes, cpuMs };
		});
}

export function processTree(): Promise<ProcessReading[]> {
	return new Promise((resolveTree, reject) => {
		const observer = execFile(
			'ps',
			['-axo', 'pid=,ppid=,rss=,time='],
			{ encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: PROCESS_OBSERVER_TIMEOUT_MS },
			(error, output) => {
				if (error) {
					reject(error);
					return;
				}
				try {
					resolveTree(selectProcessTree(output, process.pid, observer.pid));
				} catch (failure) {
					reject(failure);
				}
			}
		);
	});
}
