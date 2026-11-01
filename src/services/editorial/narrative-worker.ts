import { execFile } from 'node:child_process';
import { narrativeModulePath } from './lens-native.cjs';

const WALL_CLOCK_MS = 30000;
export const NARRATIVE_INPUT_BYTES = 64 * 1024 * 1024;
// Decoding and parsing can overlap two UTF-16 copies of a 64 MiB input; this is not an RSS limit.
export const NARRATIVE_HEAP_MIB = 384;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const OPERATIONS = new Set([
	'compareManuscriptReports',
	'analyzeAuthorCausality',
	'analyzeAuthorEpistemics',
	'analyzeAuthorKnowledge',
	'analyzeHistoricalCatalogue',
	'analyzePromiseEvents',
	'analyzeSubtextAnnotations',
	'analyzeThematicAnnotations',
	'buildAuthorMentalModel',
	'resolveAuthorCoreference',
	'measureNarrativeUncertainty',
]);

// A process can be killed while the addon blocks in native code; Worker.terminate cannot guarantee this.
const PROGRAM = `
const { Worker } = require('node:worker_threads');
const watchdog = new Worker(\`
    const { parentPort, workerData } = require('node:worker_threads');
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), workerData);
    parentPort.postMessage('armed');
\`, { eval: true, workerData: Number(process.argv[1]) });
const armed = new Promise((resolve, reject) => {
    watchdog.once('message', resolve);
    watchdog.once('error', reject);
});
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
    try {
        await armed;
        watchdog.unref();
        let frame = Buffer.concat(chunks);
        chunks.length = 0;
        let source = frame.toString('utf8');
        frame = undefined;
        let request = JSON.parse(source);
        source = undefined;
        const result = require(request.module)[request.operation](...request.args);
        request = undefined;
        const serialized = JSON.stringify({ ok: true, result });
        if (Buffer.byteLength(serialized) > ${MAX_OUTPUT_BYTES}) throw new Error('Narrative result exceeds 16 MiB');
        process.stdout.write(serialized);
    } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, message: String(error.message).slice(0, 4096) }));
    }
});
`;

export async function narrativeWorker(
	operation: string,
	args: unknown[],
	{ signal, timeoutMs = WALL_CLOCK_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
	if (!OPERATIONS.has(operation)) throw new Error('Unsupported narrative operation');
	const timeout = timeoutMs;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > WALL_CLOCK_MS)
		throw new Error('Narrative timeout must be from 1 to 30000 milliseconds');
	signal?.throwIfAborted();
	let input = JSON.stringify({ module: narrativeModulePath(), operation, args });
	if (Buffer.byteLength(input) > NARRATIVE_INPUT_BYTES)
		throw new Error('Narrative operation input exceeds 64 MiB');
	return new Promise((resolve, reject) => {
		let aborted = false;
		let inputFailed = false;
		const child = execFile(
			process.execPath,
			[
				`--max-old-space-size=${NARRATIVE_HEAP_MIB}`,
				'--input-type=commonjs',
				'--eval',
				PROGRAM,
				String(timeout),
			],
			{
				timeout,
				killSignal: 'SIGKILL',
				maxBuffer: MAX_OUTPUT_BYTES,
				encoding: 'buffer',
				windowsHide: true,
				env: {
					UV_THREADPOOL_SIZE: '1',
					RAYON_NUM_THREADS: '1',
					...Object.fromEntries(
						['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].flatMap((key) =>
							process.env[key] ? [[key, process.env[key]!]] : []
						)
					),
				},
			},
			(error, stdout) => {
				signal?.removeEventListener('abort', abort);
				if (aborted) {
					reject(new Error('Narrative operation cancelled'));
					return;
				}
				if (inputFailed) {
					reject(new Error('Narrative process input failed'));
					return;
				}
				if (error) {
					reject(
						new Error(
							error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
								? 'Narrative process exceeded its output limit'
								: error.killed
									? `Narrative operation exceeded ${timeout} milliseconds and was terminated`
									: 'Narrative process failed or exceeded its output limit'
						)
					);
					return;
				}
				try {
					const message = JSON.parse(stdout.toString('utf8'));
					if (message.ok !== true)
						throw new Error(message.message ?? 'Narrative operation failed');
					resolve(message.result);
				} catch (failure) {
					reject(failure);
				}
			}
		);
		const abort = () => {
			aborted = true;
			child.kill('SIGKILL');
		};
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) abort();
		child.stdin!.on('error', () => {
			if (!child.killed) {
				inputFailed = true;
				child.kill('SIGKILL');
			}
		});
		child.stdin!.end(input);
		input = '';
	});
}
