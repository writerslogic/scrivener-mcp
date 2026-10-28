#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { homedir, platform } from 'node:os';
import {
	CLIENTS,
	clientById,
	configureClient,
	detectClients,
	inspectClient,
	removeFromClient,
	type ClientOutcome,
	type ClientSpec,
} from '../setup/clients.js';
import { handshake, type HandshakeResult } from '../setup/doctor.js';
import { firstSession } from '../setup/first-session.js';
import { redactDiagnostics } from '../setup/redaction.js';
import { installLinks } from '../setup/links.js';
import {
	MIN_NODE_VERSION,
	isSupportedRuntime,
	chooseRuntime,
	currentRuntime,
	probeRuntime,
	serverEntry,
	type NodeRuntime,
	type ServerEntry,
} from '../setup/runtime.js';

async function verifyServer(entry: ServerEntry): Promise<HandshakeResult> {
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	process.once('SIGINT', abort);
	process.once('SIGTERM', abort);
	try {
		return await handshake(entry, undefined, controller.signal);
	} finally {
		process.removeListener('SIGINT', abort);
		process.removeListener('SIGTERM', abort);
	}
}

interface Options {
	demo: boolean;
	demoDir?: string;
	check: boolean;
	remove: boolean;
	yes: boolean;
	json: boolean;
	links: boolean;
	print: boolean;
	verify: boolean;
	clients: string[];
	node?: string;
	script?: string;
}

function parseArgs(argv: string[]): Options | string {
	const opts: Options = {
		demo: false,
		check: false,
		remove: false,
		yes: false,
		json: false,
		links: false,
		print: false,
		verify: true,
		clients: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--check') opts.check = true;
		else if (arg === '--demo') opts.demo = true;
		else if (arg === '--demo-dir') {
			opts.demo = true;
			opts.demoDir = argv[++i];
			if (!opts.demoDir) return '--demo-dir requires a new directory path';
		} else if (arg === '--remove') opts.remove = true;
		else if (arg === '--yes' || arg === '-y') opts.yes = true;
		else if (arg === '--json') opts.json = true;
		else if (arg === '--links') opts.links = true;
		else if (arg === '--print') opts.print = true;
		else if (arg === '--no-verify') opts.verify = false;
		else if (arg === '--client') {
			const id = argv[++i];
			if (!id || !clientById(id)) {
				return `Unknown client "${id ?? ''}". Choose from: ${CLIENTS.map((c) => c.id).join(', ')}`;
			}
			opts.clients.push(id);
		} else if (arg === '--node') {
			opts.node = argv[++i];
		} else if (arg === '--script') {
			opts.script = argv[++i];
		} else if (arg === '--help' || arg === '-h') {
			return 'help';
		} else {
			return `Unknown option "${arg}"`;
		}
	}
	return opts;
}

const HELP = `scrivener-setup: connect Scrivener MCP to your AI apps

Usage: scrivener-setup [options]

  (no options)     Detect installed apps, add Scrivener MCP, and verify it starts
  --check          Report each app's status without changing anything
  --demo           Run a real local analysis and edit preview in a new sample copy
  --demo-dir <new>  Keep that sample in this new directory (never changes client config)
  --remove         Remove Scrivener MCP from the selected apps
  --client <id>    Only this app (repeatable): ${CLIENTS.map((c) => c.id).join(', ')}
  --yes, -y        Do not ask for confirmation
  --links          Print one-click install links
  --print          Print the JSON entry for manual setup
  --no-verify      Skip the start-up test
  --json           Machine-readable output (schemaVersion 1)
  --node <path> --script <path>
                   Launch the server with this exact Node and script instead of npx
                   (used by the Mac app, which bundles both)
`;

/** Opens a Raycast install link with macOS `open`. Nothing else is ever opened from here. */
function openUrl(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// The link embeds paths from the command line, so allow only the exact scheme and URL-safe characters,
		// and end option parsing so the argument can never be read as a flag.
		if (!/^raycast:\/\/mcp\/install\?[A-Za-z0-9%._~!*'()-]*$/.test(url)) {
			reject(new Error('refusing to open an unexpected link'));
			return;
		}
		execFile('open', ['--', url], (error) => (error ? reject(error) : resolve()));
	});
}

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`${question} (Y/n) `)).trim().toLowerCase();
		return answer === '' || answer === 'y' || answer === 'yes';
	} finally {
		rl.close();
	}
}

function nodeProblem(): string {
	const rt = currentRuntime();
	const seen = rt ? `This is Node ${rt.version}` : 'Node was not found';
	return `${seen}, but Scrivener MCP needs Node ${MIN_NODE_VERSION} or newer with npx.
Install it with the one-line installer, which needs no administrator password:
  curl -fsSL https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/scripts/bootstrap-mac.sh | sh`;
}

const tilde = (path: string): string => path.replace(homedir(), '~');

function describe(o: ClientOutcome): string {
	const where = o.path ? ` (${tilde(o.path)})` : '';
	switch (o.outcome) {
		case 'added':
			return `added${where}`;
		case 'repaired':
			return `repaired an out-of-date entry${where}`;
		case 'unchanged':
			return 'already set up';
		case 'removed':
			return `removed${where}`;
		case 'skipped':
			return o.message ?? 'skipped';
		default:
			return `FAILED: ${o.message ?? 'unknown error'}`;
	}
}

interface ClientReport {
	id: string;
	name: string;
	configPath: string | null;
	status?: string;
	outcome?: string;
	message?: string;
	backup?: string;
}

function resolveEntry(opts: Options): { runtime: NodeRuntime; entry: ServerEntry } | string {
	if (opts.node || opts.script) {
		if (!opts.node || !opts.script) return '--node and --script must be used together';
		if (!existsSync(opts.script)) return `Script not found: ${opts.script}`;
		const runtime = probeRuntime(opts.node, 'explicit');
		if (!runtime) return `Could not run ${opts.node}`;
		if (!isSupportedRuntime(runtime)) {
			return `${opts.node} is Node ${runtime.version}; Node ${MIN_NODE_VERSION} or newer is required`;
		}
		return { runtime, entry: { command: runtime.node, args: [opts.script] } };
	}
	const runtime = chooseRuntime();
	if (!runtime) return nodeProblem();
	return { runtime, entry: serverEntry(runtime) };
}

async function main(): Promise<number> {
	const parsed = parseArgs(process.argv.slice(2));
	if (typeof parsed === 'string') {
		process.stderr.write(
			parsed === 'help' ? HELP : String(redactDiagnostics(`${parsed}\n\n${HELP}`))
		);
		return parsed === 'help' ? 0 : 2;
	}
	const opts = parsed;
	const mode = opts.check ? 'check' : opts.remove ? 'remove' : 'setup';
	const resolved = resolveEntry(opts);

	if (typeof resolved === 'string') {
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify(redactDiagnostics({ schemaVersion: 1, mode, ok: false, error: resolved }))}\n`
			);
		} else {
			process.stderr.write(`${String(redactDiagnostics(resolved))}\n`);
		}
		return 2;
	}
	const { runtime, entry } = resolved;
	if (opts.demo) {
		const result = await firstSession(entry, opts.demoDir);
		process.stdout.write(
			opts.json
				? `${JSON.stringify(redactDiagnostics(result))}\n`
				: `First session passed: analysis and edit preview verified.\nSample project: ${result.projectPath}\n${result.privacy}\n`
		);
		return 0;
	}

	if (opts.print) {
		process.stdout.write(`${JSON.stringify({ mcpServers: { scrivener: entry } }, null, 2)}\n`);
		return 0;
	}
	if (opts.links) {
		const links = installLinks(entry);
		process.stdout.write(
			[
				`Cursor:    ${links.cursor}`,
				`LM Studio: ${links.lmStudio}`,
				`Raycast:   ${links.raycast}`,
				`VS Code:   ${links.vscodeCommand}`,
				'',
			].join('\n')
		);
		return 0;
	}

	const targets: ClientSpec[] = opts.clients.length
		? opts.clients.map((id) => clientById(id) as ClientSpec)
		: detectClients();

	const clients: ClientReport[] = [];
	let startup: HandshakeResult | undefined;
	let problems = 0;
	const say = (text: string): void => {
		if (!opts.json) process.stdout.write(`${text}\n`);
	};
	const finish = (): number => {
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify(redactDiagnostics({ schemaVersion: 1, mode, ok: problems === 0, runtime, clients, startup }))}\n`
			);
		}
		return problems === 0 ? 0 : 1;
	};

	say(`Using Node ${runtime.version} (${tilde(runtime.node)})`);

	if (targets.length === 0) {
		say(
			'\nNo supported AI apps were detected. Use --client <id> to force one, or --print for the JSON.'
		);
		if (opts.check && opts.verify) {
			startup = await verifyServer(entry);
			if (!startup.ok) problems++;
			say(
				startup.ok
					? `Server starts with ${startup.toolCount} tools. No supported client was detected.`
					: `Server startup failed: ${startup.error}`
			);
		}
		return finish();
	}

	if (opts.check) {
		for (const client of targets) {
			const state = inspectClient(client, entry);
			const hasFile = client.configPath() !== null;
			if (hasFile && state.status !== 'configured') problems++;
			clients.push({
				id: client.id,
				name: client.name,
				configPath: client.configPath(),
				status: hasFile ? state.status : 'link',
				message: state.detail,
			});
			say(
				`  ${client.name.padEnd(16)} ${hasFile ? state.status : 'install link'}${state.detail ? `: ${state.detail}` : ''}`
			);
		}
		if (opts.verify) {
			startup = await verifyServer(entry);
			if (!startup.ok) problems++;
			say(
				startup.ok
					? `\nStart-up test passed: ${startup.toolCount} tools in ${(startup.ms / 1000).toFixed(1)}s.`
					: `\nStart-up test FAILED: ${startup.error}`
			);
		}
		return finish();
	}

	say(
		`\n${opts.remove ? 'Removing from' : 'Setting up'}: ${targets.map((c) => c.name).join(', ')}`
	);
	if (!opts.yes && !opts.json && process.stdin.isTTY) {
		if (!(await confirm('Continue?'))) {
			say('No changes made.');
			return 0;
		}
	}

	let changed = 0;
	for (const client of targets) {
		const outcome = opts.remove ? removeFromClient(client) : configureClient(client, entry);
		if (outcome.outcome === 'failed') problems++;
		if (['added', 'repaired', 'removed'].includes(outcome.outcome)) changed++;
		clients.push({
			id: client.id,
			name: client.name,
			configPath: client.configPath(),
			outcome: outcome.outcome,
			message: outcome.message,
			backup: outcome.backup,
		});
		say(`  ${client.name.padEnd(16)} ${describe(outcome)}`);

		if (!opts.remove && client.id === 'raycast' && platform() === 'darwin') {
			try {
				await openUrl(installLinks(entry).raycast);
				say('  Raycast           opened its install dialog; confirm it there');
			} catch (error) {
				problems++;
				say(
					`  Raycast           FAILED to open the install link: ${(error as Error).message}`
				);
			}
		}
	}

	if (!opts.remove && opts.verify && problems === 0) {
		say(
			'\nTesting that the server starts (the first run can take a minute while it downloads)...'
		);
		startup = await verifyServer(entry);
		if (startup.ok) {
			say(
				`Start-up test passed: ${startup.toolCount} tools in ${(startup.ms / 1000).toFixed(1)}s.`
			);
		} else {
			problems++;
			say(`Start-up test FAILED: ${startup.error}`);
		}
	}

	if (changed > 0 && !opts.remove) {
		say('\nNext: restart these apps so they load Scrivener MCP.');
		for (const client of targets) say(`  ${client.name}: ${client.restartHint}`);
	}
	return finish();
}

main().then(
	(code) => process.exit(code),
	(error) => {
		process.stderr.write(
			`Setup failed: ${String(redactDiagnostics(error instanceof Error ? error.message : String(error)))}\n`
		);
		process.exit(1);
	}
);
