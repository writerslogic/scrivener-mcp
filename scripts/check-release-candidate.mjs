import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';

const execute = promisify(execFile);
const REPOSITORY = 'writerslogic/scrivener-mcp';
const REPOSITORY_ID = 1049995250;
const WORKFLOW_ID = 186405613;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const SHA = /^[a-f0-9]{40}$/;

function requireCondition(condition, message) {
	if (!condition) throw new Error(message);
}

async function readReleaseFile(file, maximum) {
	const handle = await fs.open(
		file,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
	);
	try {
		const initial = await handle.stat({ bigint: true });
		const entry = await fs.lstat(file, { bigint: true });
		requireCondition(
			initial.isFile() && initial.size > 0n && initial.size <= BigInt(maximum),
			'Release input must be a regular nonempty file within its size limit'
		);
		requireCondition(
			entry.isFile() &&
				!entry.isSymbolicLink() &&
				initial.dev === entry.dev &&
				initial.ino === entry.ino,
			'Release input changed while opening'
		);
		const buffer = Buffer.alloc(Number(initial.size) + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		const [final, current] = await Promise.all([
			handle.stat({ bigint: true }),
			fs.lstat(file, { bigint: true }),
		]);
		requireCondition(
			current.isFile() &&
				!current.isSymbolicLink() &&
				[final, current].every(
					(info) =>
						info.dev === initial.dev &&
						info.ino === initial.ino &&
						info.size === initial.size &&
						info.mtimeNs === initial.mtimeNs &&
						info.ctimeNs === initial.ctimeNs
				) &&
				BigInt(size) === initial.size,
			'Release input changed while reading'
		);
		return buffer.subarray(0, size);
	} finally {
		await handle.close();
	}
}

async function releaseText(file, maximum) {
	const bytes = await readReleaseFile(file, maximum);
	const text = bytes.toString('utf8');
	requireCondition(Buffer.from(text).equals(bytes), 'Release metadata must be valid UTF-8');
	return text;
}

async function jsonFile(file) {
	return JSON.parse(await releaseText(file, 65536));
}

async function versions(root, tag) {
	requireCondition(
		typeof tag === 'string' &&
			tag.length <= 64 &&
			/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag),
		'Release tag must be a stable vMAJOR.MINOR.PATCH version'
	);
	const version = tag.slice(1);
	requireCondition(
		version.split('.').every((value) => Number.isSafeInteger(Number(value))),
		'Release version exceeds the supported integer range'
	);
	const [pkg, manifest] = await Promise.all([
		jsonFile(join(root, 'package.json')),
		jsonFile(join(root, 'manifest.json')),
	]);
	requireCondition(
		pkg.name === 'scrivener-mcp' && manifest.name === pkg.name,
		'Release package and MCPB names disagree'
	);
	requireCondition(
		pkg.mcpName === 'io.github.writerslogic/scrivener-mcp',
		'Release package must identify the official MCP namespace'
	);
	requireCondition(
		pkg.version === version && manifest.version === version,
		'Tag, package and MCPB manifest versions must agree'
	);
	return { version, pkg };
}

async function git(root, args) {
	try {
		return (
			await execute('git', args, { cwd: root, timeout: 15000, maxBuffer: 65536 })
		).stdout.trim();
	} catch {
		throw new Error('Release source Git identity or ancestry check failed');
	}
}

async function github(path, token, fetchImpl) {
	const response = await fetchImpl(
		`https://api.github.com/repos/${REPOSITORY}${path ? `/${path}` : ''}`,
		{
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(15000),
			headers: {
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2026-03-10',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
		}
	);
	requireCondition(
		response.ok && response.body,
		`GitHub release preflight request failed (HTTP ${response.status})`
	);
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			requireCondition(
				size <= 1024 * 1024,
				'GitHub release preflight response exceeds 1 MiB'
			);
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	try {
		return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
	} catch {
		throw new Error('GitHub release preflight returned invalid JSON');
	}
}

function officialRun(run, sha) {
	return (
		run &&
		Number.isSafeInteger(run.id) &&
		run.id > 0 &&
		Number.isSafeInteger(run.run_number) &&
		run.run_number > 0 &&
		Number.isSafeInteger(run.run_attempt) &&
		run.run_attempt > 0 &&
		run.workflow_id === WORKFLOW_ID &&
		run.path === WORKFLOW_PATH &&
		run.name === 'CI' &&
		run.event === 'push' &&
		run.head_branch === 'main' &&
		run.head_sha === sha &&
		run.repository?.id === REPOSITORY_ID &&
		run.repository?.full_name === REPOSITORY &&
		run.head_repository?.id === REPOSITORY_ID &&
		run.head_repository?.full_name === REPOSITORY
	);
}

export async function checkReleaseSource({ rootDirectory, tag, sha, token, fetchImpl = fetch }) {
	const root = resolve(rootDirectory);
	requireCondition(
		typeof sha === 'string' && SHA.test(sha),
		'Release commit must be an exact 40-character SHA'
	);
	const { version } = await versions(root, tag);
	const trigger = sha;
	sha = await git(root, ['rev-parse', `${trigger}^{commit}`]);
	requireCondition(SHA.test(sha), 'Release trigger does not resolve to a commit');
	requireCondition(
		(await git(root, ['rev-parse', 'HEAD'])) === sha,
		'Release checkout does not match the requested commit'
	);
	requireCondition(
		(await git(root, ['rev-parse', `refs/tags/${tag}^{commit}`])) === sha,
		'Release tag does not identify the checked-out commit'
	);
	requireCondition(
		trigger === sha || trigger === (await git(root, ['rev-parse', `refs/tags/${tag}`])),
		'Release trigger belongs to another tag object'
	);
	await git(root, ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
	await git(root, ['diff', '--exit-code', sha, '--', '.', ':(exclude)server.json']);
	requireCondition(
		(await git(root, [
			'ls-files',
			'--others',
			'--exclude-standard',
			'--',
			'src',
			'scripts',
			'assets',
			'vendor',
			'.github',
			'package.json',
			'package-lock.json',
			'manifest.json',
		])) === '',
		'Release inputs contain untracked source files'
	);
	const originalRegistry = JSON.parse(await git(root, ['show', `${sha}:server.json`]));
	const currentRegistry = await jsonFile(join(root, 'server.json'));
	const withoutVersions = (registry) => ({
		...registry,
		version: null,
		packages: registry.packages?.map((pkg) => ({ ...pkg, version: null })),
	});
	requireCondition(
		JSON.stringify(withoutVersions(originalRegistry)) ===
			JSON.stringify(withoutVersions(currentRegistry)),
		'Only registry version stamping may change tracked release metadata'
	);
	const api = (path) => github(path, token, fetchImpl);
	const [repository, branch, workflow, ref] = await Promise.all([
		api(''),
		api('branches/main'),
		api(`actions/workflows/${WORKFLOW_ID}`),
		api(`git/ref/tags/${tag}`),
	]);
	requireCondition(
		repository.id === REPOSITORY_ID && repository.full_name === REPOSITORY,
		'Release repository identity does not match the official repository'
	);
	requireCondition(
		branch.name === 'main' && branch.protected === true && SHA.test(branch.commit?.sha ?? ''),
		'Release source must be reachable from protected main'
	);
	requireCondition(
		workflow.id === WORKFLOW_ID &&
			workflow.path === WORKFLOW_PATH &&
			workflow.state === 'active',
		'Official CI workflow identity is unavailable'
	);
	requireCondition(ref.ref === `refs/tags/${tag}`, 'Official release tag identity is invalid');
	let object = ref.object;
	for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
		requireCondition(SHA.test(object.sha ?? ''), 'Release tag object is invalid');
		object = (await api(`git/tags/${object.sha}`)).object;
	}
	requireCondition(
		object?.type === 'commit' && object.sha === sha,
		'Official release tag points to another commit'
	);
	const comparison = await api(`compare/${sha}...${branch.commit.sha}`);
	requireCondition(
		['ahead', 'identical'].includes(comparison.status) &&
			comparison.merge_base_commit?.sha === sha,
		'Release commit is not an ancestor of current protected main'
	);
	const listing = await api(
		`actions/workflows/${WORKFLOW_ID}/runs?head_sha=${sha}&event=push&branch=main&per_page=100`
	);
	requireCondition(
		Array.isArray(listing.workflow_runs) &&
			Number.isSafeInteger(listing.total_count) &&
			listing.total_count > 0 &&
			listing.total_count <= 100 &&
			listing.workflow_runs.length === listing.total_count,
		'Exact-commit CI evidence is missing or exceeds the bounded history window'
	);
	requireCondition(
		listing.workflow_runs.every((run) => officialRun(run, sha)),
		'CI evidence contains a foreign or invalid workflow run'
	);
	requireCondition(
		new Set(listing.workflow_runs.map((run) => run.id)).size === listing.workflow_runs.length,
		'CI run evidence contains duplicate identities'
	);
	const newest = [...listing.workflow_runs].sort(
		(left, right) => right.run_number - left.run_number || right.run_attempt - left.run_attempt
	)[0];
	const current = await api(`actions/runs/${newest.id}`);
	requireCondition(
		officialRun(current, sha) &&
			current.id === newest.id &&
			current.run_attempt === newest.run_attempt,
		'CI evidence changed while checking the release'
	);
	requireCondition(
		current.status === 'completed' && current.conclusion === 'success',
		'Latest exact-commit official CI run has not completed successfully'
	);
	const jobs = await api(
		`actions/runs/${current.id}/attempts/${current.run_attempt}/jobs?per_page=100`
	);
	requireCondition(
		Array.isArray(jobs.jobs) &&
			Number.isSafeInteger(jobs.total_count) &&
			jobs.total_count > 0 &&
			jobs.total_count <= 100 &&
			jobs.jobs.length === jobs.total_count,
		'Official CI job evidence is incomplete'
	);
	const gates = jobs.jobs.filter((job) => job.name === 'Release verification');
	requireCondition(
		gates.length === 1 &&
			gates[0].run_id === current.id &&
			gates[0].head_sha === sha &&
			gates[0].workflow_name === 'CI' &&
			gates[0].status === 'completed' &&
			gates[0].conclusion === 'success',
		'Official Release verification job must complete successfully for this commit and run attempt'
	);
	return {
		version,
		sha,
		workflowId: WORKFLOW_ID,
		runId: current.id,
		runAttempt: current.run_attempt,
	};
}

export async function verifyFileSHA256(file, expected) {
	requireCondition(
		typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected),
		'Release artifact SHA-256 is invalid'
	);
	const bytes = await readReleaseFile(file, 512 * 1024 * 1024);
	requireCondition(
		createHash('sha256').update(bytes).digest('hex') === expected,
		'Release artifact SHA-256 does not match its recorded digest'
	);
	return bytes;
}

async function archiveJSON(archive, name) {
	const entry = archive.file(name);
	requireCondition(
		entry && !entry.dir && (!entry.unsafeOriginalName || entry.unsafeOriginalName === name),
		'Bundled release metadata entry is missing or ambiguous'
	);
	const stream = new Readable().wrap(entry.nodeStream('nodebuffer'));
	const timer = setTimeout(
		() => stream.destroy(new Error('Bundled metadata read timed out')),
		15000
	);
	try {
		const chunks = [];
		let size = 0;
		for await (const chunk of stream) {
			size += chunk.length;
			requireCondition(size <= 65536, 'Bundled release metadata exceeds 64 KiB');
			chunks.push(chunk);
		}
		return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
	} catch {
		throw new Error('Bundled release metadata is missing, invalid or exceeds 64 KiB');
	} finally {
		clearTimeout(timer);
		stream.destroy();
	}
}

export async function checkReleaseArtifacts({
	rootDirectory,
	directory,
	tag,
	stampRegistry = false,
}) {
	requireCondition(
		typeof stampRegistry === 'boolean',
		'Registry stamping requires an explicit boolean'
	);
	const root = resolve(rootDirectory);
	const { version, pkg } = await versions(root, tag);
	const name = `scrivener-mcp-${version}-macos-arm64.mcpb`;
	const expected = [name, `${name}.sha256`].sort();
	const files = (await readdir(directory)).sort();
	requireCondition(
		files.length === expected.length && files.every((file, index) => file === expected[index]),
		'Release assets must contain exactly the versioned MCPB and its SHA-256 sidecar'
	);
	const archive = join(resolve(directory), name);
	const checksum = join(resolve(directory), `${name}.sha256`);
	const record = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?$/.exec(
		await releaseText(checksum, 4096)
	);
	requireCondition(
		record && basename(record[2]) === name,
		'Release checksum sidecar names another artifact'
	);
	const bytes = await verifyFileSHA256(archive, record[1]);
	const [{ default: JSZip }, { archiveEntryCount }] = await Promise.all([
		import('jszip'),
		import('../dist/services/content-credentials/archive-preparation.js'),
	]);
	const declared = archiveEntryCount(bytes, 65534);
	const contents = await JSZip.loadAsync(bytes);
	requireCondition(
		Object.keys(contents.files).length === declared,
		'Release archive contains duplicate or ambiguous entry names'
	);
	const [manifest, bundledPackage] = await Promise.all([
		archiveJSON(contents, 'manifest.json'),
		archiveJSON(contents, 'server/package.json'),
	]);
	requireCondition(
		manifest.name === pkg.name &&
			manifest.version === version &&
			bundledPackage.name === pkg.name &&
			bundledPackage.version === version,
		'Tag, source package, bundled package and MCPB versions must agree'
	);
	const registryPath = join(root, 'server.json');
	const registry = await jsonFile(registryPath);
	requireCondition(
		registry.name === pkg.mcpName &&
			registry.repository?.url === `https://github.com/${REPOSITORY}` &&
			Array.isArray(registry.packages) &&
			registry.packages.length === 1 &&
			registry.packages[0].registryType === 'npm' &&
			registry.packages[0].identifier === pkg.name,
		'Registry metadata does not identify the released npm package'
	);
	if (stampRegistry) {
		registry.version = version;
		registry.packages[0].version = version;
		const temporary = join(root, `.server-release-${randomUUID()}.json`);
		try {
			await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
				flag: 'wx',
				mode: 0o644,
			});
			await rename(temporary, registryPath);
		} finally {
			await unlink(temporary).catch((error) => {
				if (error.code !== 'ENOENT') throw error;
			});
		}
	}
	const stamped = await jsonFile(registryPath);
	requireCondition(
		stamped.version === version &&
			stamped.packages?.length === 1 &&
			stamped.packages[0].version === version,
		'Registry metadata has not been stamped to the verified release version'
	);
	return { version, artifact: name, registryVersion: stamped.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [mode, ...args] = process.argv.slice(2);
		requireCondition(
			process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF_TYPE === 'tag',
			'Release preflight requires the official repository tag context'
		);
		if (mode === 'source' && args.length === 0) {
			const checked = await checkReleaseSource({
				rootDirectory: process.cwd(),
				tag: process.env.GITHUB_REF_NAME,
				sha: process.env.GITHUB_SHA,
				token: process.env.GH_TOKEN,
			});
			process.stdout.write(
				`Release source verified: ${checked.version}, ${checked.sha}, official CI run ${checked.runId} attempt ${checked.runAttempt}\n`
			);
		} else if (
			mode === 'artifacts' &&
			args.length === 3 &&
			args[0] === '--directory' &&
			args[2] === '--stamp-registry'
		) {
			const checked = await checkReleaseArtifacts({
				rootDirectory: process.cwd(),
				directory: resolve(args[1]),
				tag: process.env.GITHUB_REF_NAME,
				stampRegistry: true,
			});
			process.stdout.write(
				`Release artifacts verified: ${checked.artifact}, registry ${checked.registryVersion}\n`
			);
		} else
			throw new Error(
				'Usage: check-release-candidate.mjs source | artifacts --directory PATH --stamp-registry'
			);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : 'Release preflight failed'}\n`
		);
		process.exitCode = 1;
	}
}
