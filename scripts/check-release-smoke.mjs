#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createC2paTestSigner } from './create-c2pa-fixtures.mjs';

const APP_URI = 'ui://scrivener/manuscript-dashboard';
const APP_MIME = 'text/html;profile=mcp-app';
const SAMPLE_DOCUMENT = '10000000-0000-4000-8000-000000000003';
const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const checks = [];
let stage = 'arguments';

class SmokeFailure extends Error {}

function verify(condition, message) {
	if (!condition) throw new SmokeFailure(message);
}

async function check(name, operation) {
	stage = name;
	const result = await operation();
	checks.push(name);
	process.stdout.write(`OK ${name}\n`);
	return result;
}

function options(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		verify(
			['--package', '--installed-server', '--npm-cli'].includes(flag),
			'Use --package <absolute.tgz> or --installed-server <absolute-directory>, and optional --npm-cli <npm-cli.js>'
		);
		verify(
			typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--'),
			'A command-line option has no value'
		);
		parsed[flag.slice(2)] = argv[++index];
	}
	if (parsed.package)
		verify(
			isAbsolute(parsed.package) && parsed.package.endsWith('.tgz'),
			'--package requires an absolute .tgz file'
		);
	verify(
		!(parsed.package && parsed['installed-server']),
		'Choose a package or an installed server'
	);
	if (parsed['installed-server'])
		verify(
			isAbsolute(parsed['installed-server']),
			'--installed-server requires an absolute directory'
		);
	return parsed;
}

async function exists(file) {
	try {
		await access(file);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

function within(root, file) {
	const part = relative(root, resolve(file));
	return (
		!isAbsolute(part) &&
		part !== '..' &&
		!part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
	);
}

async function npmCli(explicit) {
	const candidates = [
		explicit,
		process.env.npm_execpath,
		join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
		join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
	];
	for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
		candidates.push(
			join(entry, 'npm'),
			join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js')
		);
	}
	for (const candidate of candidates.filter(Boolean)) {
		if (!(await exists(candidate))) continue;
		const file = await realpath(candidate);
		if (file.endsWith('npm-cli.js') && (await stat(file)).isFile()) return file;
	}
	throw new SmokeFailure(
		'Cannot locate npm-cli.js; supply --npm-cli with the installed npm JavaScript entry point'
	);
}

function cleanEnvironment(root) {
	const env = {};
	for (const name of [
		'PATH',
		'SystemRoot',
		'SYSTEMROOT',
		'WINDIR',
		'ComSpec',
		'COMSPEC',
		'PATHEXT',
		'PROCESSOR_ARCHITECTURE',
		'OS',
		'SystemDrive',
	]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	return {
		...env,
		HOME: join(root, 'isolated-home'),
		USERPROFILE: join(root, 'isolated-home'),
		APPDATA: join(root, 'isolated-home', 'AppData', 'Roaming'),
		LOCALAPPDATA: join(root, 'isolated-home', 'AppData', 'Local'),
		XDG_CONFIG_HOME: join(root, 'isolated-home', '.config'),
		XDG_CACHE_HOME: join(root, 'isolated-home', '.cache'),
		TMPDIR: join(root, 'temp'),
		TMP: join(root, 'temp'),
		TEMP: join(root, 'temp'),
		CI: 'true',
		SCRIVENER_SKIP_POSTINSTALL: 'true',
		SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
		SCRIVENER_SKIP_SETUP: 'true',
		SCRIVENER_QUIET: 'true',
		SCRIVENER_LOCAL_ONLY: 'true',
		SCRIVENER_DATA_DIR: join(root, 'server-state'),
		LOG_LEVEL: 'ERROR',
		NPM_CONFIG_CACHE: join(root, 'npm-cache'),
		NPM_CONFIG_USERCONFIG: join(root, 'npm-userconfig'),
		NPM_CONFIG_GLOBALCONFIG: join(root, 'npm-globalconfig'),
		NPM_CONFIG_AUDIT: 'false',
		NPM_CONFIG_FUND: 'false',
	};
}

function boundedCapture() {
	let tail = '';
	let bytes = 0;
	return {
		add(chunk) {
			bytes += chunk.length;
			tail = (tail + chunk.toString('utf8')).slice(-32768);
		},
		get bytes() {
			return bytes;
		},
		get npmCode() {
			return tail.match(/npm (?:error|ERR!) code ([A-Z0-9_]+)/u)?.[1];
		},
	};
}

async function runNpm(cli, args, cwd, env) {
	const captured = boundedCapture();
	await new Promise((resolveProcess, reject) => {
		const child = spawn(process.execPath, [cli, ...args], {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			detached: process.platform !== 'win32',
		});
		let timedOut = false;
		let force;
		const terminate = () => {
			if (!child.pid) return;
			if (process.platform === 'win32') {
				const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
					env,
					stdio: 'ignore',
					windowsHide: true,
				});
				killer.on('error', () => child.kill());
			} else {
				try {
					process.kill(-child.pid, 'SIGTERM');
				} catch {
					child.kill();
				}
				force = setTimeout(() => {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch {}
				}, 3000);
				force.unref();
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, 600000);
		timer.unref();
		child.stdout.on('data', (chunk) => captured.add(chunk));
		child.stderr.on('data', (chunk) => captured.add(chunk));
		child.once('error', () => {
			clearTimeout(timer);
			clearTimeout(force);
			reject(new SmokeFailure('Unable to start the npm JavaScript CLI'));
		});
		child.once('close', (code) => {
			clearTimeout(timer);
			clearTimeout(force);
			if (timedOut)
				reject(new SmokeFailure('npm operation exceeded the ten-minute deadline'));
			else if (code !== 0)
				reject(
					new SmokeFailure(
						`npm operation failed: exit ${Number.isInteger(code) ? code : 'unknown'}${captured.npmCode ? `, ${captured.npmCode}` : ''}; bounded output withheld`
					)
				);
			else resolveProcess();
		});
	});
}

async function tool(client, name, args, expectError = false) {
	let response;
	try {
		response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
	} catch {
		throw new SmokeFailure(`MCP request failed for ${name}; transport details withheld`);
	}
	if (expectError) {
		verify(response.isError === true, `${name} unexpectedly accepted a guarded operation`);
		return response;
	}
	verify(!response.isError, `${name} returned an error; response content withheld`);
	verify(
		Array.isArray(response.content) &&
			response.content.some(
				(item) =>
					item.type === 'text' && typeof item.text === 'string' && item.text.length > 0
			),
		`${name} returned no usable text fallback`
	);
	return response.structuredContent ?? {};
}

function passage(context, evidence) {
	verify(
		evidence.projectId === context.projectId && evidence.revision === context.revision,
		'Evidence identity or saved revision does not match its source'
	);
	verify(
		context.text.slice(evidence.start, evidence.end) === evidence.quote &&
			evidence.quote.length > 0,
		'Evidence does not quote the source at its recorded offsets'
	);
	return evidence;
}

async function hash(file) {
	return createHash('sha256')
		.update(await readFile(file))
		.digest('hex');
}

async function snapshotCount(projectPath, documentId) {
	const folder = join(projectPath, 'Snapshots', `${documentId}.snapshots`);
	if (!(await exists(folder))) return 0;
	return (await readdir(folder)).filter((name) => name.endsWith('.rtf')).length;
}

async function awaitWorkflow(client, id) {
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		const result = await tool(client, 'editorial_workflow', { action: 'get', workflowId: id });
		const workflow = result.workflows?.[0];
		verify(workflow && workflow.id === id, 'Workflow status lost its durable identity');
		if (workflow.state === 'completed') return workflow;
		verify(
			workflow.state === 'ready' || workflow.state === 'running',
			'Guided workflow failed or was interrupted; result content withheld'
		);
		await new Promise((notify) => setTimeout(notify, 200));
	}
	throw new SmokeFailure('Guided workflow did not finish within one minute');
}

async function main() {
	const opts = options(process.argv.slice(2));
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-release-smoke-')));
	try {
		const env = cleanEnvironment(root);
		for (const folder of ['isolated-home', 'temp', 'npm-cache', 'server-state', 'package'])
			await mkdir(join(root, folder), { mode: 0o700 });
		await writeFile(env.NPM_CONFIG_USERCONFIG, '');
		await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
		const cli = await npmCli(opts['npm-cli']);
		let installed = opts['installed-server'];
		if (!installed) {
			let tarball = opts.package;
			if (!tarball) {
				await check('pack-local-candidate', async () => {
					await runNpm(
						cli,
						[
							'pack',
							'--ignore-scripts',
							'--json',
							'--pack-destination',
							join(root, 'package'),
						],
						SOURCE_ROOT,
						env
					);
					const archives = (await readdir(join(root, 'package'))).filter((name) =>
						name.endsWith('.tgz')
					);
					verify(
						archives.length === 1,
						'npm pack did not create exactly one package archive'
					);
					tarball = join(root, 'package', archives[0]);
				});
			}
			verify(
				(await stat(tarball)).isFile() && (await stat(tarball)).size <= 128 * 1024 * 1024,
				'Package archive is missing or exceeds 128 MiB'
			);
			await writeFile(
				join(root, 'package.json'),
				JSON.stringify({ name: 'scrivener-release-smoke', version: '1.0.0', private: true })
			);
			await check('install-local-package', () =>
				runNpm(
					cli,
					['install', tarball, '--omit=dev', '--no-audit', '--no-fund'],
					root,
					env
				)
			);
			installed = join(root, 'node_modules', 'scrivener-mcp');
		}
		verify(
			JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).name ===
				'scrivener-mcp',
			'Installed server package identity is invalid'
		);
		await check('installed-consumer-dependency-audit', async () => {
			await runNpm(
				cli,
				['audit', '--omit=dev'],
				opts['installed-server'] ? installed : root,
				env
			);
		});
		const entry = join(installed, 'dist', 'index.js');
		await check('installed-cli-redacted-diagnostics', async () => {
			for (const mode of ['entry', 'arguments']) {
				const secret =
					mode === 'entry' ? 'sk-ant-private-fixture-value' : 'cHJpdmF0ZTpwYXNz';
				const args =
					mode === 'entry'
						? [
								'--json',
								'--node',
								process.execPath,
								'--script',
								join(env.HOME, `${secret}.js`),
							]
						: ['--client', `Basic ${secret}`];
				let result;
				try {
					await promisify(execFile)(
						process.execPath,
						[join(installed, 'dist/cli/setup.js'), ...args],
						{
							cwd: root,
							env,
							encoding: 'utf8',
							timeout: 20000,
							maxBuffer: 128 * 1024,
						}
					);
				} catch (error) {
					verify(
						error.code === 2,
						'CLI diagnostic did not return its expected error status'
					);
					result = error;
				}
				verify(result, 'CLI accepted an invalid diagnostic request');
				verify(
					!(result.stdout + result.stderr).includes(secret),
					'CLI diagnostic exposed a credential'
				);
				if (mode === 'entry') {
					const report = JSON.parse(result.stdout);
					verify(
						report.schemaVersion === 1 && !report.ok && !report.error.includes(root),
						'CLI diagnostic exposed its private home path or returned an invalid report'
					);
				}
			}
		});
		if (process.platform !== 'win32') {
			await check('installed-saved-reader-nonblocking-fifo', async () => {
				const project = join(root, 'fifo.scriv');
				const document = join(project, 'Files', 'Data', SAMPLE_DOCUMENT, 'content.rtf');
				await mkdir(dirname(document), { recursive: true, mode: 0o700 });
				await promisify(execFile)('mkfifo', [document], { cwd: root, env, timeout: 5000 });
				const script = `const [module, project, document] = process.argv.slice(1); const { MutationCoordinator } = await import(module); const coordinator = new MutationCoordinator(project); let result; try { await coordinator.readRaw(document); result = { unexpectedSuccess: true }; } catch (error) { result = { error: error.message }; } finally { coordinator.close(); } process.stdout.write(JSON.stringify(result), () => process.exit(0));`;
				const result = await promisify(execFile)(
					process.execPath,
					[
						'--input-type=module',
						'-e',
						script,
						pathToFileURL(
							join(installed, 'dist/services/editorial/mutation-coordinator.js')
						).href,
						project,
						SAMPLE_DOCUMENT,
					],
					{
						cwd: root,
						env,
						encoding: 'utf8',
						timeout: 8000,
						killSignal: 'SIGKILL',
						maxBuffer: 4096,
					}
				);
				verify(
					/regular file/i.test(JSON.parse(result.stdout).error ?? ''),
					'Installed reader did not reject a FIFO as a non-regular file'
				);
				const credentialResult = await promisify(execFile)(
					process.execPath,
					[
						'--input-type=module',
						'-e',
						'const [module, assetPath] = process.argv.slice(1); const {validateCredentialAsset} = await import(module); let result; try { await validateCredentialAsset({assetPath, mimeType:"application/octet-stream"}); result = {unexpectedSuccess:true}; } catch(error) { result = {error:error.message}; } process.stdout.write(JSON.stringify(result), () => process.exit(0));',
						pathToFileURL(
							join(installed, 'dist/services/content-credentials/service.js')
						).href,
						document,
					],
					{
						cwd: root,
						env,
						encoding: 'utf8',
						timeout: 8000,
						killSignal: 'SIGKILL',
						maxBuffer: 4096,
					}
				);
				verify(
					/regular file/i.test(JSON.parse(credentialResult.stdout).error ?? ''),
					'Installed credential reader did not reject a FIFO without blocking'
				);
			});
		}
		const requireInstalled = createRequire(join(installed, 'package.json'));
		await check('installed-native-c2pa-sdk', async () => {
			const result = await promisify(execFile)(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					'const {pathToFileURL} = await import("node:url"); const {getCredentialCapabilities} = await import(pathToFileURL(process.argv[1]).href); const result = await getCredentialCapabilities(); if (!result.available || !result.sdkVersion) process.exitCode = 1;',
					join(installed, 'dist/services/content-credentials/service.js'),
				],
				{ cwd: root, env, timeout: 40000, maxBuffer: 128 * 1024 }
			);
			verify(
				result.stdout.length === 0,
				'Installed C2PA probe wrote unexpected protocol output'
			);
		});
		const { Client, StdioClientTransport, firstSession } = await check(
			'installed-package-modules',
			async () => {
				await promisify(execFile)(
					process.execPath,
					[
						'-e',
						'require(process.argv[1]).loadNativeBinding()',
						join(installed, 'dist/services/memory/hhm/native-loader.cjs'),
					],
					{ cwd: root, env, timeout: 20000, maxBuffer: 128 * 1024 }
				);
				const clientModule = await import(
					pathToFileURL(
						requireInstalled.resolve('@modelcontextprotocol/sdk/client/index.js')
					).href
				);
				const transportModule = await import(
					pathToFileURL(
						requireInstalled.resolve('@modelcontextprotocol/sdk/client/stdio.js')
					).href
				);
				const setupModule = await import(
					pathToFileURL(join(installed, 'dist', 'setup', 'first-session.js')).href
				);
				verify(
					typeof clientModule.Client === 'function' &&
						typeof transportModule.StdioClientTransport === 'function' &&
						typeof setupModule.firstSession === 'function',
					'Installed package or SDK is missing a required runtime entry point'
				);
				return {
					Client: clientModule.Client,
					StdioClientTransport: transportModule.StdioClientTransport,
					firstSession: setupModule.firstSession,
				};
			}
		);
		const first = await check('installed-first-session-analysis-and-preview', async () => {
			verify((await stat(entry)).isFile(), 'Installed package is missing the startup entry');
			verify(
				(await readFile(join(installed, 'assets', 'manuscript-dashboard.html'))).length >
					100,
				'Installed package is missing its dashboard asset'
			);
			const result = await firstSession(
				{ command: process.execPath, args: [entry], env },
				join(root, 'first-session')
			);
			verify(
				result.ok &&
					result.checks?.protocol === true &&
					result.checks.analysis === true &&
					result.checks.editPreview === true &&
					result.checks.manuscriptUnchanged === true &&
					within(root, result.projectPath),
				'Installed first session failed or left its isolated sample'
			);
			verify(
				(await hash(
					join(result.projectPath, 'Files', 'Data', SAMPLE_DOCUMENT, 'content.rtf')
				)) ===
					(await hash(
						join(
							installed,
							'assets',
							'sample-project',
							'Welcome.scriv',
							'Files',
							'Data',
							SAMPLE_DOCUMENT,
							'content.rtf'
						)
					)),
				'First session changed the sample manuscript during its preview'
			);
			return result;
		});
		const projectPath = first.projectPath;
		const originalFile = join(projectPath, 'Files', 'Data', SAMPLE_DOCUMENT, 'content.rtf');
		const originalRaw = await readFile(originalFile, 'utf8');
		const originalRevision = await hash(originalFile);
		const credentialSigner = await createC2paTestSigner(join(root, 'credential-signer'));
		const credentialEnvironment = {
			...env,
			SCRIVENER_C2PA_CERT_PATH: credentialSigner.certificatePath,
			SCRIVENER_C2PA_KEY_PATH: credentialSigner.privateKeyPath,
			SCRIVENER_C2PA_KEY_PASSWORD: credentialSigner.password,
			SCRIVENER_C2PA_TRUST_ANCHORS_PATH: credentialSigner.trustAnchorsPath,
		};
		const openSession = async (apps, args = [entry], sessionEnvironment = env) => {
			const transport = new StdioClientTransport({
				command: process.execPath,
				args,
				cwd: root,
				env: sessionEnvironment,
				stderr: 'pipe',
			});
			const stderr = boundedCapture();
			transport.stderr?.on('data', (chunk) => stderr.add(chunk));
			const client = new Client(
				{ name: apps ? 'release-apps-smoke' : 'release-text-smoke', version: '1' },
				{
					capabilities: apps
						? {
								extensions: {
									'io.modelcontextprotocol/ui': { mimeTypes: [APP_MIME] },
								},
							}
						: {},
				}
			);
			try {
				await client.connect(transport);
			} catch {
				await transport.close();
				throw new SmokeFailure(
					'Installed server initialization failed; bounded stderr withheld'
				);
			}
			return client;
		};
		await check('installed-server-graceful-stdio-close', async () => {
			const marker = join(root, 'unexpected-sigterm');
			const exitStatus = join(root, 'stdio-exit-status');
			const observer = join(root, 'observe-termination.mjs');
			await writeFile(
				observer,
				`import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => writeFileSync(new URL('./unexpected-sigterm', import.meta.url), 'SIGTERM'));
process.once('exit', code => writeFileSync(new URL('./stdio-exit-status', import.meta.url), String(code)));
`,
				{ mode: 0o600 }
			);
			const session = await openSession(false, [
				'--import',
				pathToFileURL(observer).href,
				entry,
			]);
			try {
				verify(
					(await session.listTools()).tools.length > 0,
					'EOF fixture server listed no tools'
				);
			} finally {
				await session.close();
			}
			verify(!(await exists(marker)), 'Installed server required SIGTERM after stdin closed');
			verify(
				(await exists(exitStatus)) && (await readFile(exitStatus, 'utf8')) === '0',
				'Installed server failed to shut down cleanly after stdin closed'
			);
		});
		const client = await openSession(false);
		let seriesId;
		let workflowId;
		try {
			let contexts;
			let candidates;
			await check('text-client-progressive-tools-and-fallback', async () => {
				const initial = await client.listTools();
				verify(
					initial.tools.some((item) => item.name === 'open_project') &&
						!initial.tools.some((item) => item.name === 'review_changes'),
					'Startup tools do not use progressive disclosure'
				);
				const textDashboard = initial.tools.find(
					(item) => item.name === 'manuscript_dashboard'
				);
				verify(
					!textDashboard?._meta?.ui && !textDashboard?._meta?.['ui/resourceUri'],
					'Text client unexpectedly received MCP Apps metadata'
				);
				await tool(client, 'open_project', { path: projectPath });
				const listed = await client.listTools();
				verify(
					listed.tools.some((item) => item.name === 'review_changes') &&
						listed.tools.some((item) => item.name === 'search_passages'),
					'Opening a project did not expose its editing and search tools'
				);
				const dashboard = await tool(client, 'manuscript_dashboard', {
					documentId: SAMPLE_DOCUMENT,
				});
				verify(
					dashboard.uiSupported === false &&
						dashboard.context?.documentId === SAMPLE_DOCUMENT &&
						dashboard.context.revision === originalRevision,
					'Text dashboard did not return saved source context'
				);
				verify(
					(await client.listResources()).resources.length === 0,
					'Text client unexpectedly received app resources'
				);
				let denied = false;
				try {
					await client.readResource({ uri: APP_URI });
				} catch (error) {
					denied = error.code === -32602;
				}
				verify(denied, 'Unnegotiated app resource access was not rejected');
				contexts = new Map([[SAMPLE_DOCUMENT, dashboard.context]]);
				const saved = await tool(client, 'review_changes', { action: 'list' });
				verify(
					saved.result.proposals.some((proposal) => proposal.id === first.proposalId),
					'First-session proposal was not durable across server restart'
				);
			});
			await check('installed-local-concept-passage-search', async () => {
				const result = await tool(client, 'search_passages', {
					query: 'fear',
					mode: 'semantic',
					limit: 3,
				});
				const match = result.results?.find((item) => item.documentId === SAMPLE_DOCUMENT);
				verify(
					match &&
						match.semanticScore > 0 &&
						match.keywordScore === 0 &&
						match.context.includes(match.quote),
					'Local conceptual retrieval did not find a non-keyword passage'
				);
				passage(contexts.get(SAMPLE_DOCUMENT), match);
				verify(
					result.limitations.includes('bounded'),
					'Local retrieval did not disclose its concept coverage'
				);
			});
			await check('installed-facts-continuity-and-series-lifecycle', async () => {
				const analysis = await tool(client, 'check_consistency', {
					checkTypes: ['characters'],
				});
				candidates = analysis.candidates.filter((fact) => fact.predicate === 'eye-color');
				const left = candidates[0];
				const right = candidates.find(
					(fact) => fact.subject === left?.subject && fact.value !== left?.value
				);
				verify(
					left &&
						right &&
						left.confidence !== 'confirmed' &&
						right.confidence !== 'confirmed',
					'Sample continuity extraction did not return distinct inferred attributes'
				);
				for (const fact of [left, right])
					for (const evidence of fact.sources) {
						if (!contexts.has(evidence.documentId))
							contexts.set(
								evidence.documentId,
								(
									await tool(client, 'manuscript_dashboard', {
										documentId: evidence.documentId,
									})
								).context
							);
						passage(contexts.get(evidence.documentId), evidence);
					}
				const projectId = contexts.get(SAMPLE_DOCUMENT).projectId;
				const scope = { kind: 'project', id: projectId };
				const fact = (candidate, id) => ({
					id,
					kind: candidate.kind,
					subject: candidate.subject,
					predicate: candidate.predicate,
					value: candidate.value,
					confidence: 'confirmed',
					sources: candidate.sources,
					storyTime: 'release-smoke-same-time',
				});
				await tool(client, 'story_bible', {
					action: 'curate',
					scope,
					fact: fact(left, 'release-canon-left'),
				});
				await tool(client, 'story_bible', {
					action: 'curate',
					scope,
					fact: fact(right, 'release-canon-right'),
				});
				const confirmed = (
					await tool(client, 'check_consistency', { checkTypes: ['characters'] })
				).issues.find(
					(item) =>
						item.confidence === 'confirmed' &&
						item.factIds.includes('release-canon-left') &&
						item.factIds.includes('release-canon-right')
				);
				verify(
					confirmed?.evidence.length >= 2 && confirmed.basis === 'canon-conflict',
					'Confirmed continuity findings lost their supporting passages'
				);
				for (const [action, status] of [
					['confirm', 'confirmed'],
					['dismiss', 'dismissed'],
					['resolve', 'resolved'],
				]) {
					const changed = await tool(client, 'continuity_findings', {
						action,
						findingId: confirmed.id,
						note: 'Synthetic release fixture review',
					});
					verify(
						changed.findings[0]?.status === status,
						'Continuity review state was not persisted'
					);
				}
				verify(
					(
						await tool(client, 'continuity_findings', {
							action: 'recheck',
							findingId: confirmed.id,
						})
					).findings.some((item) => item.id === confirmed.id),
					'Finding recheck lost its stable identity'
				);
				const corrected = await tool(client, 'story_bible', {
					action: 'correct',
					scope,
					factId: 'release-canon-right',
					patch: { value: left.value, sources: left.sources },
				});
				verify(
					corrected.facts[0]?.supersedes === 'release-canon-right',
					'Fact correction did not preserve provenance history'
				);
				seriesId = (
					await tool(client, 'manage_series', {
						action: 'create',
						name: 'Synthetic release series',
					})
				).series[0]?.id;
				verify(typeof seriesId === 'string', 'Series creation returned no identity');
				await tool(client, 'story_bible', {
					action: 'curate',
					scope: { kind: 'series', id: seriesId },
					fact: fact(left, 'release-series-fact'),
				});
				const projectFacts = await tool(client, 'story_bible', { action: 'list', scope });
				verify(
					!projectFacts.facts.some((item) => item.id === 'release-series-fact'),
					'Series facts leaked into the explicit project scope'
				);
				const secondProject = join(root, 'Second.scriv');
				await cp(
					join(installed, 'assets', 'sample-project', 'Welcome.scriv'),
					secondProject,
					{ recursive: true, errorOnExist: true, force: false }
				);
				await tool(client, 'close_project', {});
				await tool(client, 'open_project', { path: secondProject });
				verify(
					(await tool(client, 'manage_series', { action: 'list' })).series.length === 0,
					'A new project automatically inherited unrelated series membership'
				);
				await tool(client, 'manage_series', { action: 'join', seriesId });
				const shared = await tool(client, 'story_bible', {
					action: 'list',
					scope: { kind: 'series', id: seriesId },
				});
				verify(
					shared.facts.some((item) => item.id === 'release-series-fact' && !item.stale),
					'Explicit series join could not resolve the other project provenance'
				);
				await tool(client, 'manage_series', { action: 'leave', seriesId });
				await tool(
					client,
					'story_bible',
					{ action: 'list', scope: { kind: 'series', id: seriesId } },
					true
				);
				await tool(client, 'close_project', {});
				await tool(client, 'open_project', { path: projectPath });
			});
			await check('installed-review-select-retry-snapshots-and-guarded-undo', async () => {
				const context = contexts.get(SAMPLE_DOCUMENT);
				const request = {
					action: 'propose',
					documentId: SAMPLE_DOCUMENT,
					expectedRevision: originalRevision,
					title: 'Synthetic release edit',
					idempotencyKey: 'release-review',
					edits: [
						{ start: 0, end: 0, text: 'A different opening. ' },
						{
							start: context.text.length,
							end: context.text.length,
							text: ' A closing thought.',
						},
					],
				};
				const proposal = (await tool(client, 'review_changes', request)).result;
				verify(
					(await tool(client, 'review_changes', request)).result.id === proposal.id,
					'Proposal retry created duplicate review state'
				);
				const preview = (
					await tool(client, 'review_changes', {
						action: 'preview',
						proposalId: proposal.id,
						editIds: [proposal.edits[0].id],
					})
				).result;
				verify(
					preview.before !== preview.after &&
						(await hash(originalFile)) === originalRevision,
					'Review preview changed the manuscript or lacked a real diff'
				);
				verify(
					preview.fidelity.mode === 'preserved' && preview.fidelity.atRisk.length === 0,
					'A clean sample insertion could not preserve original formatting'
				);
				const operationId = randomUUID();
				const applyArgs = {
					action: 'apply',
					proposalId: proposal.id,
					editIds: [proposal.edits[0].id],
					force: true,
					operationId,
				};
				const applied = (await tool(client, 'review_changes', applyArgs)).result;
				verify(
					applied.state === 'committed' && applied.id === operationId,
					'Review application was not durably committed'
				);
				const appliedRaw = await readFile(originalFile, 'utf8');
				verify(
					appliedRaw !== originalRaw &&
						(
							await tool(client, 'manuscript_dashboard', {
								documentId: SAMPLE_DOCUMENT,
							})
						).context.text === preview.after,
					'Selective acceptance did not apply exactly the previewed edit'
				);
				const savedSnapshots = await snapshotCount(projectPath, SAMPLE_DOCUMENT);
				verify(
					savedSnapshots > 0 && applied.fidelity.snapshotId,
					'Reviewed application did not create a native snapshot'
				);
				verify(
					(await tool(client, 'review_changes', applyArgs)).result.id === operationId &&
						(await readFile(originalFile, 'utf8')) === appliedRaw &&
						(await snapshotCount(projectPath, SAMPLE_DOCUMENT)) === savedSnapshots,
					'Application retry duplicated a manuscript write or snapshot'
				);
				const rejected = (
					await tool(client, 'review_changes', {
						action: 'reject',
						proposalId: proposal.id,
						editIds: [proposal.edits[1].id],
					})
				).result;
				verify(
					rejected.edits.find((edit) => edit.id === proposal.edits[1].id)?.status ===
						'rejected',
					'Selective rejection was not persisted'
				);
				const externallySaved = appliedRaw.replace('Mara', 'ExternallySavedMara');
				verify(
					externallySaved !== appliedRaw,
					'Synthetic external revision fixture did not change'
				);
				await writeFile(originalFile, externallySaved);
				await tool(
					client,
					'review_changes',
					{ action: 'undo', operationId, force: true },
					true
				);
				verify(
					(await readFile(originalFile, 'utf8')) === externallySaved,
					'Stale undo overwrote a subsequent saved edit'
				);
				const refreshed = await tool(client, 'manuscript_dashboard', {
					documentId: SAMPLE_DOCUMENT,
				});
				verify(
					refreshed.context.revision !== applied.afterRevision &&
						refreshed.context.text.includes('ExternallySavedMara'),
					'Saved external changes did not refresh manuscript reads'
				);
				await writeFile(originalFile, appliedRaw);
				await tool(client, 'review_changes', { action: 'undo', operationId, force: true });
				verify(
					(await readFile(originalFile, 'utf8')) === originalRaw,
					'Guarded undo did not restore exact native RTF bytes'
				);
			});
			await check('installed-guided-workflows-and-export-validation', async () => {
				const otherDocument = [...contexts.keys()].find((id) => id !== SAMPLE_DOCUMENT);
				verify(otherDocument, 'Sample has no second manuscript scene');
				for (const kind of ['review-chapter', 'audit-continuity', 'beta-reader-draft']) {
					const scope =
						kind === 'beta-reader-draft' ? [otherDocument] : [SAMPLE_DOCUMENT];
					const started = await tool(client, 'editorial_workflow', {
						action: 'start',
						kind,
						documentIds: scope,
						idempotencyKey: `release-${kind}`,
					});
					const workflow = await awaitWorkflow(client, started.workflows[0].id);
					verify(
						workflow.progress === 100 &&
							workflow.cost.actual === 0 &&
							workflow.usage.providerRequests === 0 &&
							workflow.steps.every((step) => step.state === 'completed'),
						'Guided workflow did not report real local progress and usage'
					);
					const resumed = (
						await tool(client, 'editorial_workflow', {
							action: 'resume',
							workflowId: workflow.id,
						})
					).workflows[0];
					verify(
						resumed.state === 'completed' &&
							resumed.usage.localSteps === workflow.usage.localSteps,
						'Resuming a completed workflow replayed its steps'
					);
					if (kind === 'beta-reader-draft') {
						const artifact = workflow.steps.find(
							(step) => step.kind === 'export'
						)?.result;
						verify(
							artifact?.path &&
								within(root, artifact.path) &&
								Array.isArray(artifact.metadata?.validation) &&
								artifact.metadata.validation.length > 0,
							'Beta workflow returned no validated local artifact'
						);
						verify(
							(await readFile(artifact.path)).subarray(0, 2).toString() === 'PK',
							'Beta export is not a ZIP-based DOCX'
						);
						workflowId = workflow.id;
					}
				}
				for (const preset of ['submission-manuscript', 'ebook']) {
					const preflight = (
						await tool(client, 'export_manuscript', {
							action: 'preflight',
							preset,
							documentIds: [otherDocument],
						})
					).result;
					verify(
						preflight.ready &&
							preflight.findings.every((item) => item.severity !== 'error'),
						'Clean sample export did not pass preflight'
					);
					const outputPath = join(
						root,
						`${preset}.${preset === 'ebook' ? 'epub' : 'docx'}`
					);
					const exported = (
						await tool(client, 'export_manuscript', {
							action: 'export',
							preset,
							documentIds: [otherDocument],
							outputPath,
						})
					).result;
					verify(
						exported.path === outputPath &&
							exported.bytes > 0 &&
							exported.bytes === (await stat(outputPath)).size &&
							exported.metadata.validation.length > 0,
						'Preset exporter did not report real archive validation'
					);
					verify(
						(await readFile(outputPath)).subarray(0, 2).toString() === 'PK',
						'Preset output is not a valid archive container'
					);
				}
			});
			await tool(client, 'close_project', {});
		} finally {
			await client.close();
		}
		const credentialArtifacts = [];
		const credentials = await openSession(false, [entry], credentialEnvironment);
		try {
			await check('installed-export-credential-sign-and-validate', async () => {
				await tool(credentials, 'use_skill', { name: 'credentials' });
				const capability = await tool(credentials, 'c2pa_capabilities', {});
				verify(
					capability.available &&
						capability.signerConfigured &&
						capability.conformance.status === 'not-assessed',
					'MCP credential capabilities do not reflect the installed SDK and configured signer'
				);
				await tool(credentials, 'open_project', { path: projectPath });
				const pdfPath = join(root, 'credential-export.pdf');
				const pdf = await tool(credentials, 'export_project', {
					format: 'pdf',
					outputPath: pdfPath,
				});
				verify(
					pdf.path === pdfPath && pdf.bytes > 0,
					'Existing PDF exporter returned no artifact'
				);
				await tool(credentials, 'close_project', {});
				for (const file of [
					'submission-manuscript.docx',
					'ebook.epub',
					'credential-export.pdf',
				]) {
					const assetPath = join(root, file);
					const revision = await hash(assetPath);
					const outputPath = join(root, `credential-${file}`);
					const signed = await tool(credentials, 'sign_content_credentials', {
						assetPath,
						outputPath,
						mode: 'embedded',
					});
					verify(
						signed.outputPath === outputPath &&
							signed.sourceRevision === revision &&
							signed.validation.integrity === 'valid' &&
							signed.validation.trust === 'trusted' &&
							!('report' in signed.validation),
						'MCP signing did not verify its actual output or omitted-report contract'
					);
					verify(
						(await hash(assetPath)) === revision,
						'Credential signing changed the exported source'
					);
					const validation = await tool(credentials, 'validate_content_credentials', {
						assetPath: outputPath,
					});
					verify(
						validation.state === 'valid' &&
							validation.trust === 'trusted' &&
							validation.sourceRevision === (await hash(outputPath)),
						'MCP validation did not authenticate the produced artifact'
					);
					const duplicate = await credentials.callTool({
						name: 'sign_content_credentials',
						arguments: { assetPath, outputPath, mode: 'embedded' },
					});
					verify(
						duplicate.isError === true &&
							(await hash(outputPath)) === validation.sourceRevision,
						'Signing overwrote an existing output'
					);
					credentialArtifacts.push({
						assetPath: outputPath,
						revision: validation.sourceRevision,
					});
				}
				const first = credentialArtifacts[0];
				await tool(credentials, 'sign_content_credentials', {
					assetPath: first.assetPath,
					outputPath: join(root, 'credential-history.docx'),
					mode: 'embedded',
				});
			});
		} finally {
			await credentials.close();
		}
		const credentialRestart = await openSession(false, [entry], credentialEnvironment);
		try {
			await check('installed-credential-validation-after-restart', async () => {
				await tool(credentialRestart, 'use_skill', { name: 'credentials' });
				for (const artifact of credentialArtifacts) {
					const validation = await tool(
						credentialRestart,
						'validate_content_credentials',
						{ assetPath: artifact.assetPath }
					);
					verify(
						validation.state === 'valid' &&
							validation.trust === 'trusted' &&
							validation.sourceRevision === artifact.revision,
						'Credential validation changed after an actual MCP restart'
					);
				}
			});
		} finally {
			await credentialRestart.close();
		}
		const app = await openSession(true);
		try {
			await check('apps-client-resource-negotiation-and-durable-restart', async () => {
				const listing = await app.listTools();
				const dashboard = listing.tools.find(
					(item) => item.name === 'manuscript_dashboard'
				);
				verify(
					dashboard?._meta?.ui?.resourceUri === APP_URI,
					'Apps client did not receive the dashboard resource link'
				);
				verify(
					(await app.listResources()).resources.some(
						(item) => item.uri === APP_URI && item.mimeType === APP_MIME
					),
					'Apps client resource discovery lost the declared MIME type'
				);
				const resource = (await app.readResource({ uri: APP_URI })).contents.find(
					(item) => item.uri === APP_URI
				);
				verify(
					resource?.mimeType === APP_MIME &&
						resource.text.includes('aria-live') &&
						resource.text.includes('ui/initialize'),
					'Installed dashboard asset lacks accessible content or the Apps bridge'
				);
				verify(
					resource._meta?.ui?.csp?.connectDomains?.length === 0 &&
						resource._meta.ui.csp.resourceDomains.length === 0,
					'Dashboard resource did not declare its local-only CSP'
				);
				await tool(app, 'open_project', { path: projectPath });
				const reopenedSearch = await tool(app, 'search_passages', {
					query: 'fear',
					mode: 'semantic',
					limit: 3,
				});
				verify(
					reopenedSearch.index.changedDocuments === 0 &&
						reopenedSearch.results.some(
							(item) =>
								item.documentId === SAMPLE_DOCUMENT &&
								item.revision === originalRevision &&
								item.semanticScore > 0 &&
								item.context.includes(item.quote)
						),
					'Installed passage search lost persisted source context or reindexed unchanged sources after restart'
				);
				verify(
					(await tool(app, 'manuscript_dashboard', { documentId: SAMPLE_DOCUMENT }))
						.uiSupported === true,
					'Dashboard handler lost negotiated client capability'
				);
				verify(
					(await tool(app, 'manage_series', { action: 'list' })).series.some(
						(item) => item.id === seriesId
					),
					'Selected series membership was not durable across server restart'
				);
				const restored = (
					await tool(app, 'editorial_workflow', { action: 'get', workflowId })
				).workflows[0];
				verify(
					restored.state === 'completed' && restored.progress === 100,
					'Completed workflow did not survive server restart'
				);
				verify(
					(await readFile(originalFile, 'utf8')) === originalRaw,
					'Read-only analyses or workflows changed manuscript bytes'
				);
				await tool(app, 'close_project', {});
			});
		} finally {
			await app.close();
		}
		process.stdout.write(
			`${JSON.stringify({ ok: true, platform: process.platform, node: process.version, checks })}\n`
		);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}

try {
	await main();
} catch (error) {
	const code =
		typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
			? ` (${error.code})`
			: '';
	process.stderr.write(
		`FAIL ${stage}: ${error instanceof SmokeFailure ? error.message : `Unexpected failure${code}; raw diagnostics and manuscript content withheld`}\n`
	);
	process.exitCode = 1;
}
