import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = pathToFileURL(
	resolve(__dirname, '../../../scripts/check-output-conformance.mjs')
).href;
const tool = {
	outputSchema: {
		type: 'object',
		properties: { value: { type: 'integer' } },
		required: ['value'],
		additionalProperties: false,
	},
};

async function assess(result: unknown, expectedError?: string) {
	const { stdout } = await execute(process.execPath, [
		'--input-type=module',
		'-e',
		`
import { assessResult } from ${JSON.stringify(script)};
const [tool, result, expected] = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(assessResult(tool, result, expected)));
`,
		JSON.stringify([tool, result, expectedError]),
	]);
	return JSON.parse(stdout);
}

it('fails an unexpected error even when its structured payload satisfies the success schema', async () => {
	expect(
		await assess({
			isError: true,
			structuredContent: { value: 1 },
			content: [{ type: 'text', text: 'Unavailable' }],
		})
	).toMatchObject({ status: 'FAIL', outcome: 'returned-error', schema: 'valid' });
});

it('records expected provider refusal without pretending an absent payload was schema-validated', async () => {
	expect(
		await assess(
			{
				isError: true,
				content: [{ type: 'text', text: 'Local-only mode disabled generation' }],
			},
			'disabled generation'
		)
	).toMatchObject({ status: 'PASS', outcome: 'returned-error', schema: 'not-returned' });
});

it('fails a different refusal reason or unexpected successful return', async () => {
	expect(
		await assess(
			{ isError: true, content: [{ type: 'text', text: 'Disk full' }] },
			'disabled generation'
		)
	).toMatchObject({ status: 'FAIL' });
	expect(
		await assess({ structuredContent: { value: 1 }, content: [] }, 'disabled generation')
	).toMatchObject({ status: 'FAIL' });
});

it('rejects malformed structured refusal and successful results', async () => {
	for (const isError of [true, false])
		expect(
			await assess(
				{
					isError,
					structuredContent: { value: 'bad' },
					content: [{ type: 'text', text: 'unavailable' }],
				},
				isError ? 'unavailable' : undefined
			)
		).toMatchObject({ status: 'FAIL', schema: 'invalid' });
});

it('distinguishes thrown expected refusals from unrelated failures', async () => {
	const { stdout } = await execute(process.execPath, [
		'--input-type=module',
		'-e',
		`
import { assessThrown } from ${JSON.stringify(script)};
process.stdout.write(JSON.stringify([
assessThrown(new Error('Stale revision'), 'revision'),
assessThrown(new Error('Disk full'), 'revision'),
assessThrown(new Error('Stale revision'))]));
`,
	]);
	expect(JSON.parse(stdout)).toEqual([
		expect.objectContaining({
			status: 'PASS',
			outcome: 'thrown-error',
			schema: 'not-returned',
		}),
		expect.objectContaining({ status: 'FAIL' }),
		expect.objectContaining({ status: 'FAIL' }),
	]);
});

it('restores command lookup after successful and failed controlled native absence checks', async () => {
	const { stdout } = await execute(process.execPath, [
		'--input-type=module',
		'-e',
		`
import { withUnavailableCommands } from ${JSON.stringify(script)};
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const previous = process.env.PATH;
const empty = mkdtempSync(join(tmpdir(), 'conformance-path-'));
const observed = [];
try {
  observed.push(await withUnavailableCommands(empty, async () => {
    try { await promisify(execFile)('osascript', ['-e', 'error "must not run"']); }
    catch (error) { return error.code; }
    throw new Error('Native command unexpectedly executed');
  }));
  observed.push(process.env.PATH === previous);
  try { await withUnavailableCommands(empty, async () => { throw new Error('fixture failure'); }); }
  catch (error) { observed.push(error.message); }
  observed.push(process.env.PATH === previous);
  delete process.env.PATH;
  await withUnavailableCommands(empty, async () => {});
  observed.push(Object.hasOwn(process.env, 'PATH'));
} finally {
  if (previous === undefined) delete process.env.PATH;
  else process.env.PATH = previous;
  rmSync(empty, { recursive: true });
}
process.stdout.write(JSON.stringify(observed));
`,
	]);
	expect(JSON.parse(stdout)).toEqual(['ENOENT', true, 'fixture failure', true, false]);
});

it('holds an unavailable loopback Redis port until cleanup without accepting Redis commands', async () => {
	const { stdout } = await execute(process.execPath, [
		'--input-type=module',
		'-e',
		`
import { createUnavailableRedisServer } from ${JSON.stringify(script)};
import { createConnection, createServer } from 'node:net';
const fixture = await createUnavailableRedisServer();
const port = Number(new URL(fixture.url).port);
const observed = [];
try {
  observed.push(await new Promise((resolve, reject) => {
    const contender = createServer();
    contender.once('error', (error) => resolve(error.code));
    contender.listen(port, '127.0.0.1', () => contender.close(() => reject(new Error('Fixture port was not held'))));
  }));
  observed.push(await new Promise((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => { client.destroy(); reject(new Error('Fixture socket did not close')); }, 1000);
    client.on('data', () => { client.destroy(); reject(new Error('Fixture returned Redis data')); });
    client.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    client.on('close', () => { clearTimeout(timeout); resolve('closed'); });
  }));
} finally { await fixture.close(); }
await new Promise((resolve, reject) => {
  const replacement = createServer();
  replacement.once('error', reject);
  replacement.listen(port, '127.0.0.1', () => replacement.close(resolve));
});
observed.push('released');
process.stdout.write(JSON.stringify(observed));
`,
	]);
	expect(JSON.parse(stdout)).toEqual(['EADDRINUSE', 'closed', 'released']);
});
