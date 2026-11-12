import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const { values } = parseArgs({
	options: {
		repo: { type: 'string', default: process.cwd() },
		output: { type: 'string' },
		'scope-mode': { type: 'string', default: 'metadata' },
	},
});
assert(values.output, '--output is required');
assert(['metadata', 'argument'].includes(values['scope-mode']));
const repository = resolve(values.repo);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const files = execFileSync(
	'git',
	[
		'ls-files',
		'--cached',
		'--others',
		'--exclude-standard',
		'-z',
		'src',
		'package.json',
		'package-lock.json',
	],
	{ cwd: repository, encoding: 'utf8' }
)
	.split('\0')
	.filter(Boolean)
	.sort();
const manifest = await Promise.all(
	files.map(async (file) => [file, hash(await readFile(join(repository, file)))])
);
const root = await mkdtemp(join(tmpdir(), 'scrivener-token-workflow-'));
const project = join(root, 'Token.scriv');
const documentId = '22222222-2222-4222-8222-222222222222';
const binder = `<ScrivenerProject Identifier="token-fixture"><Binder><BinderItem UUID="11111111-1111-4111-8111-111111111111" Type="DraftFolder"><Title>Manuscript</Title><Children><BinderItem UUID="${documentId}" Type="Text"><Title>Harbor</Title></BinderItem></Children></BinderItem></Binder></ScrivenerProject>`;
const raw = String.raw`{\rtf1\ansi Mara entered the harbor.\tab Rain tapped the windows.\par She folded the map and waited for the boat.\par The lantern stayed bright.}`;
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [
		'--import',
		pathToFileURL(createRequire(join(repository, 'package.json')).resolve('tsx')).href,
		join(repository, 'src/index.ts'),
	],
	cwd: root,
	stderr: 'pipe',
	maxBufferSize: 8 * 1024 * 1024,
	env: {
		...getDefaultEnvironment(),
		HOME: root,
		USERPROFILE: root,
		APPDATA: root,
		LOCALAPPDATA: root,
		XDG_CONFIG_HOME: root,
		XDG_DATA_HOME: root,
		SCRIVENER_DATA_DIR: join(root, 'state'),
		SCRIVENER_HMS_ENGINE: 'fallback',
		SCRIVENER_LOCAL_ONLY: 'true',
		SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
		SCRIVENER_SKIP_SETUP: 'true',
		NODE_ENV: 'test',
		LOG_LEVEL: 'ERROR',
	},
});
const metadata = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientInfo': { name: 'token-workflow-fixture', version: '1' },
	'io.modelcontextprotocol/clientCapabilities': {},
};
const pending = new Map();
const samples = [];
let sequence = 0;
let stderr = '';
let projectHandle;
transport.onmessage = (message) => pending.get(message.id)?.(message);
async function request(method, params = {}) {
	const id = ++sequence;
	const outgoing = {
		jsonrpc: '2.0',
		id,
		method,
		params: {
			...params,
			_meta: {
				...metadata,
				...(projectHandle && values['scope-mode'] === 'metadata'
					? { 'com.writerslogic/project': projectHandle }
					: {}),
			},
		},
	};
	let timeout;
	try {
		const response = new Promise((resolveReply, reject) => {
			pending.set(id, resolveReply);
			timeout = setTimeout(
				() => reject(new Error(`Timed out ${method}; ${stderr}`)),
				id === 1 ? 60000 : 15000
			);
		});
		await transport.send(outgoing);
		const incoming = await response;
		samples.push({
			label: params.name
				? `${params.name}${params.arguments?.action ? ':' + params.arguments.action : ''}`
				: method,
			request: outgoing,
			response: incoming,
			serializedRequest: JSON.stringify(outgoing),
			serializedResponse: JSON.stringify(incoming),
		});
		assert(!incoming.error, JSON.stringify(incoming.error));
		assert(!incoming.result?.isError, JSON.stringify(incoming.result));
		return incoming.result;
	} finally {
		clearTimeout(timeout);
		pending.delete(id);
	}
}
async function call(name, args = {}) {
	return request('tools/call', {
		name,
		arguments: {
			...args,
			...(projectHandle && values['scope-mode'] === 'argument' ? { projectHandle } : {}),
		},
	});
}
try {
	await mkdir(join(project, 'Files/Data', documentId), { recursive: true });
	await writeFile(join(project, 'Token.scrivx'), binder);
	const contentPath = join(project, 'Files/Data', documentId, 'content.rtf');
	await writeFile(contentPath, raw);
	await transport.start();
	transport.stderr?.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-8192);
	});
	await request('server/discover');
	const catalog = await request('tools/list');
	assert(Array.isArray(catalog.tools));
	const opened = await call('open_project', { path: project });
	projectHandle =
		values['scope-mode'] === 'argument'
			? opened.structuredContent?.projectHandle
			: opened._meta?.['com.writerslogic/project'];
	assert.equal(typeof projectHandle, 'string');
	await call('get_structure');
	const page = await call('read_document', { documentId, offset: 0, limit: 10 });
	assert(page.structuredContent.text.includes('harbor'));
	const start = page.structuredContent.text.indexOf('harbor');
	const proposed = await call('review_changes', {
		action: 'propose',
		documentId,
		expectedRevision: page.structuredContent.revision,
		edits: [{ start, end: start + 6, text: 'quay' }],
		rationale: 'Original synthetic measurement fixture.',
	});
	const proposalId = proposed.structuredContent.result.id;
	await call('review_changes', { action: 'preview', proposalId });
	const applied = await call('review_changes', { action: 'apply', proposalId, force: true });
	await call('review_changes', {
		action: 'undo',
		operationId: applied.structuredContent.result.id,
		force: true,
	});
	assert.equal(
		await readFile(contentPath, 'utf8'),
		raw,
		'Undo must restore the exact fixture bytes'
	);
	await call('close_project');
	const report = {
		version: 1,
		measuredAt: new Date().toISOString(),
		repository,
		revision: execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: repository,
			encoding: 'utf8',
		}).trim(),
		sourceSha256: hash(JSON.stringify(manifest)),
		sourceManifest: manifest,
		runtime: process.version,
		client: '@modelcontextprotocol/client 2.4.0 StdioClientTransport',
		protocol: '2026-07-28',
		scopeMode: values['scope-mode'],
		fixtureSha256: hash(binder + raw),
		toolCount: catalog.tools.length,
		calls: samples.length,
		samples,
		limitations: [
			'Original tiny manuscript fixture; not a representative novel or commercial host.',
			'Records complete JSON-RPC payloads, including duplicated text/structured content and volatile IDs/timings; model-facing selection and billing vary by client.',
			'No latency or performance claim; one workflow sample per invocation.',
			'No model/provider requests; local fallback and isolated state only.',
		],
	};
	await mkdir(dirname(resolve(values.output)), { recursive: true });
	await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
	process.stdout.write(
		`Recorded ${samples.length} calls and ${catalog.tools.length} tool definitions; exact undo verified.\n`
	);
} finally {
	await transport.close();
	await rm(root, { recursive: true, force: true });
}
