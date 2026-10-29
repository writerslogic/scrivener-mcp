import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const execute = promisify(execFile);
const script = resolve('scripts/check-release-candidate.mjs');
const tag = 'v1.2.3';
let root: string;
let sha: string;
const originals = new Map<string, string>();
const gitEnvironment = {
	...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: devNull,
};

function fixtureGit(args: string[]) {
	return execute('git', args, { env: gitEnvironment, timeout: 15000, maxBuffer: 65536 });
}

const runner = `
import { pathToFileURL } from 'node:url';
const module = await import(pathToFileURL(process.argv[2]).href);
const input = JSON.parse(process.argv[3]);
const commitSha = input.commitSha ?? input.sha;
const repository = { id: 1049995250, full_name: 'writerslogic/scrivener-mcp' };
const good = { id: 20, run_number: 4, run_attempt: 1, workflow_id: 186405613, path: '.github/workflows/ci.yml', name: 'CI', event: 'push', head_branch: 'main', head_sha: commitSha, repository, head_repository: repository, status: 'completed', conclusion: 'success' };
const listed = input.change?.startsWith('newer-') ? [{ ...good, id: 21, run_number: 5, status: input.change === 'newer-pending' ? 'queued' : 'completed', conclusion: input.change === 'newer-failed' ? 'failure' : null }, good] : [good];
const altered = { ...listed[0] };
if (input.change === 'foreign-workflow') altered.workflow_id = 9;
if (input.change === 'lookalike-path') altered.path = '.github/workflows/untrusted.yml';
if (input.change === 'foreign-repository') altered.head_repository = { id: 9, full_name: 'other/scrivener-mcp' };
if (input.change === 'pr-only') altered.event = 'pull_request';
if (input.change === 'wrong-sha') altered.head_sha = 'f'.repeat(40);
listed[0] = altered;
let requests = 0;
const fetchImpl = async (url, options) => {
  if (options.method !== 'GET' || options.redirect !== 'error') throw new Error('Unsafe transport');
  requests++;
  const path = new URL(url).pathname.replace('/repos/writerslogic/scrivener-mcp', '');
  let body;
  if (path === '') body = repository;
  else if (path === '/branches/main') body = { name: 'main', protected: input.change !== 'unprotected', commit: { sha: commitSha } };
  else if (path === '/actions/workflows/186405613') body = { id: 186405613, path: '.github/workflows/ci.yml', state: 'active' };
  else if (path === '/git/ref/tags/v1.2.3') body = { ref: 'refs/tags/v1.2.3', object: input.change === 'annotated-tag' ? { type: 'tag', sha: input.sha } : { type: 'commit', sha: input.change === 'remote-tag' ? 'f'.repeat(40) : commitSha } };
  else if (path.startsWith('/git/tags/')) body = { object: { type: 'commit', sha: commitSha } };
  else if (path.startsWith('/compare/')) body = { status: input.change === 'not-main' ? 'diverged' : 'identical', merge_base_commit: { sha: input.change === 'not-main' ? 'f'.repeat(40) : commitSha } };
  else if (path.endsWith('/runs')) body = input.change === 'missing-run' ? { total_count: 0, workflow_runs: [] } : { total_count: listed.length, workflow_runs: listed };
  else if (path.endsWith('/jobs')) body = { total_count: 1, jobs: [{ name: input.change === 'lookalike-job' ? 'Release verification (untrusted)' : 'Release verification', run_id: input.change === 'foreign-job-run' ? 99 : altered.id, workflow_name: 'CI', head_sha: commitSha, status: input.change === 'pending-job' ? 'in_progress' : 'completed', conclusion: input.change === 'skipped-job' ? 'skipped' : input.change === 'failed-job' ? 'failure' : 'success' }] };
  else if (path.startsWith('/actions/runs/')) body = { ...altered, run_attempt: input.change === 'changed-attempt' ? 2 : altered.run_attempt };
  else throw new Error('Unexpected fixture request');
  if (input.change === 'api-denied') return new Response('PRIVATE TRANSPORT BODY', { status: 403 });
  if (input.responseBytes) {
    body = structuredClone(body);
    body.padding = '';
    body.padding = 'x'.repeat(input.responseBytes - Buffer.byteLength(JSON.stringify(body)));
  }
  return Response.json(body);
};
try {
  const result = input.mode === 'artifacts'
    ? await module.checkReleaseArtifacts({ rootDirectory: input.root, directory: input.directory, tag: input.tag, stampRegistry: input.stamp })
    : await module.checkReleaseSource({ rootDirectory: input.root, tag: input.tag, sha: input.sha, token: 'never-print-fixture-token', fetchImpl });
  process.stdout.write(JSON.stringify({ ok: true, result, requests }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, requests }));
}
`;

async function run(input: Record<string, unknown> = {}) {
	const result = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			runner,
			'release-fixture',
			script,
			JSON.stringify({ root, tag, sha, ...input }),
		],
		{
			timeout: 15000,
			maxBuffer: 65536,
			env: gitEnvironment,
		}
	);
	return JSON.parse(result.stdout) as {
		ok: boolean;
		error?: string;
		requests: number;
		result?: Record<string, unknown>;
	};
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'scrivener-release-candidate-'));
	await mkdir(join(root, 'src'));
	await Promise.all([
		writeFile(join(root, 'src/server.ts'), 'export const releaseFixture = true;\n'),
		writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'scrivener-mcp',
				version: '1.2.3',
				mcpName: 'io.github.writerslogic/scrivener-mcp',
			})
		),
		writeFile(
			join(root, 'manifest.json'),
			JSON.stringify({ name: 'scrivener-mcp', version: '1.2.3' })
		),
		writeFile(
			join(root, 'server.json'),
			JSON.stringify({
				name: 'io.github.writerslogic/scrivener-mcp',
				description: 'Preserved source metadata',
				repository: { url: 'https://github.com/writerslogic/scrivener-mcp' },
				version: '1.2.2',
				packages: [{ registryType: 'npm', identifier: 'scrivener-mcp', version: '1.2.2' }],
			})
		),
	]);
	for (const name of ['package.json', 'manifest.json', 'server.json', 'src/server.ts'])
		originals.set(name, await readFile(join(root, name), 'utf8'));
	const hooks = join(root, 'empty-hooks');
	await mkdir(hooks);
	await fixtureGit(['-c', `init.templateDir=${hooks}`, 'init', '--initial-branch=main', root]);
	await fixtureGit(['-C', root, 'add', '.']);
	await fixtureGit([
		'-C',
		root,
		'-c',
		'user.name=Release Fixture',
		'-c',
		'user.email=release@example.invalid',
		'-c',
		'commit.gpgsign=false',
		'-c',
		`core.hooksPath=${hooks}`,
		'commit',
		'-m',
		'Original synthetic release fixture',
	]);
	sha = (await fixtureGit(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
	await fixtureGit(['-C', root, '-c', 'tag.gpgsign=false', 'tag', tag]);
	await fixtureGit(['-C', root, 'update-ref', 'refs/remotes/origin/main', sha]);
});

beforeEach(async () => {
	await Promise.all([...originals].map(([name, text]) => writeFile(join(root, name), text)));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

it('requires exact local source, protected official ancestry and successful exact-attempt CI evidence', async () => {
	const checked = await run();
	expect(checked).toMatchObject({
		ok: true,
		result: { version: '1.2.3', sha, workflowId: 186405613, runId: 20, runAttempt: 1 },
	});
});

it.each([
	'unprotected',
	'not-main',
	'remote-tag',
	'foreign-workflow',
	'lookalike-path',
	'foreign-repository',
	'pr-only',
	'wrong-sha',
	'newer-pending',
	'changed-attempt',
	'newer-failed',
	'missing-run',
	'foreign-job-run',
	'lookalike-job',
	'pending-job',
	'skipped-job',
	'failed-job',
	'api-denied',
])('fails closed for %s evidence without exposing response bodies or tokens', async (change) => {
	const checked = await run({ change });
	expect(checked.ok).toBe(false);
	expect(checked.error).toBeTruthy();
	expect(checked.error).not.toMatch(/PRIVATE TRANSPORT BODY|never-print-fixture-token/);
});

it('resolves an official annotated tag to the checked commit', async () => {
	await fixtureGit([
		'-C',
		root,
		'-c',
		'user.name=Release Fixture',
		'-c',
		'user.email=release@example.invalid',
		'-c',
		'tag.gpgsign=false',
		'-c',
		`core.hooksPath=${join(root, 'empty-hooks')}`,
		'tag',
		'--force',
		'--annotate',
		'-m',
		'Original fixture annotation',
		tag,
		sha,
	]);
	try {
		const object = (
			await fixtureGit(['-C', root, 'rev-parse', `refs/tags/${tag}`])
		).stdout.trim();
		expect(await run({ change: 'annotated-tag', sha: object, commitSha: sha })).toMatchObject({
			ok: true,
			result: { sha },
		});
	} finally {
		await fixtureGit(['-C', root, 'update-ref', `refs/tags/${tag}`, sha]);
	}
});

it.each([1048575, 1048576, 1048577])(
	'bounds GitHub response allocation at %i bytes',
	async (responseBytes) => {
		const checked = await run({ responseBytes });
		expect(checked.ok).toBe(responseBytes <= 1048576);
		if (!checked.ok) expect(checked.error).toMatch(/exceeds 1 MiB/);
	}
);

it('rejects local manifest or source changes before requesting remote evidence', async () => {
	await writeFile(
		join(root, 'manifest.json'),
		JSON.stringify({ name: 'scrivener-mcp', version: '1.2.4' })
	);
	expect(await run()).toMatchObject({ ok: false, requests: 0 });
	await writeFile(
		join(root, 'manifest.json'),
		JSON.stringify({ name: 'scrivener-mcp', version: '1.2.3' })
	);
	await writeFile(join(root, 'src/server.ts'), 'export const releaseFixture = false;\n');
	expect(await run()).toMatchObject({ ok: false, requests: 0 });
});

it('rejects untracked release inputs and registry changes beyond version stamping', async () => {
	const untracked = join(root, 'src/untracked.ts');
	await writeFile(untracked, 'export const unexpected = true;\n');
	try {
		expect(await run()).toMatchObject({ ok: false, requests: 0 });
	} finally {
		await rm(untracked);
	}
	const registry = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));
	registry.description = 'Unreviewed registry metadata';
	await writeFile(join(root, 'server.json'), JSON.stringify(registry));
	expect(await run()).toMatchObject({ ok: false, requests: 0 });
});

it.each(['v01.2.3', 'v1.2.3-beta', 'v9007199254740992.2.3'])(
	'rejects invalid release tag %s before remote requests',
	async (invalid) => {
		expect(await run({ tag: invalid })).toMatchObject({ ok: false, requests: 0 });
	}
);

async function bundle(change?: 'version' | 'checksum' | 'extra', metadataBytes?: number) {
	const directory = await mkdtemp(join(root, 'artifacts-'));
	const zip = new JSZip();
	const manifest = { name: 'scrivener-mcp', version: '1.2.3', padding: '' };
	if (metadataBytes)
		manifest.padding = 'x'.repeat(metadataBytes - Buffer.byteLength(JSON.stringify(manifest)));
	zip.file('manifest.json', JSON.stringify(manifest));
	zip.file(
		'server/package.json',
		JSON.stringify({ name: 'scrivener-mcp', version: change === 'version' ? '1.2.2' : '1.2.3' })
	);
	const bytes = await zip.generateAsync({ type: 'nodebuffer' });
	const name = 'scrivener-mcp-1.2.3-macos-arm64.mcpb';
	await writeFile(join(directory, name), bytes);
	const digest = createHash('sha256').update(bytes).digest('hex');
	await writeFile(
		join(directory, `${name}.sha256`),
		`${change === 'checksum' ? '0'.repeat(64) : digest}  /previous/runner/dist-mcpb/${name}\n`
	);
	if (change === 'extra') await writeFile(join(directory, 'unexpected.mcpb'), bytes);
	return directory;
}

it('verifies real archive bytes and internal package versions before atomically stamping registry metadata', async () => {
	const directory = await bundle();
	expect(await run({ mode: 'artifacts', directory, stamp: false })).toMatchObject({ ok: false });
	expect(await run({ mode: 'artifacts', directory, stamp: true })).toMatchObject({
		ok: true,
		result: { registryVersion: '1.2.3' },
	});
	const registry = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));
	expect(registry).toMatchObject({
		version: '1.2.3',
		description: 'Preserved source metadata',
		packages: [{ version: '1.2.3' }],
	});
	expect(await run()).toMatchObject({ ok: true });
});

it.each(['version', 'checksum', 'extra'] as const)(
	'rejects %s artifact corruption without stamping registry metadata',
	async (change) => {
		const directory = await bundle(change);
		expect(await run({ mode: 'artifacts', directory, stamp: true })).toMatchObject({
			ok: false,
		});
		expect(JSON.parse(await readFile(join(root, 'server.json'), 'utf8')).version).toBe('1.2.2');
	}
);

it.each([65535, 65536, 65537])(
	'bounds inflated MCPB metadata at %i bytes',
	async (metadataBytes) => {
		const directory = await bundle(undefined, metadataBytes);
		expect(await run({ mode: 'artifacts', directory, stamp: true })).toMatchObject({
			ok: metadataBytes <= 65536,
		});
	}
);
