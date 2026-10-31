export function captureInputFailureDiagnostics(method: 'spawn' | 'execFile'): () => void {
	const processes = jest.requireActual<typeof import('node:child_process')>('node:child_process');
	const execute = processes[method];
	let active = true;
	const spy = jest.spyOn(processes, method).mockImplementation((...args) => {
		const child = Reflect.apply(execute, processes, args) as ReturnType<typeof execute>;
		let tail = '',
			heapOutOfMemory = false;
		child.stderr?.on('data', (chunk: Buffer) => {
			const diagnostic = tail + chunk.toString('utf8');
			heapOutOfMemory ||=
				/FATAL ERROR:[^\r\n]{0,1024}(?:heap out of memory|Allocation failed)/i.test(
					diagnostic
				);
			tail = diagnostic.slice(-4096);
		});
		child.once('close', (code, signal) => {
			if (active && (code !== 0 || signal))
				process.stderr.write(
					'Native input-boundary child failure ' +
						JSON.stringify({
							code,
							signal,
							fatal: heapOutOfMemory ? 'v8-heap-out-of-memory' : 'not-observed',
						}) +
						'\n'
				);
		});
		return child;
	});
	return () => {
		active = false;
		spy.mockRestore();
	};
}
