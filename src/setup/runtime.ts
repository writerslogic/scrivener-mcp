import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_VERSION = '22.13.0';

export interface NodeRuntime {
	node: string;
	npx: string | null;
	version: string;
	major: number;
	source: string;
}

export interface ServerEntry {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Prefer a stable symlink (for example /opt/homebrew/bin/node) over the versioned file it
 * points to (/opt/homebrew/Cellar/node/26.8.1/bin/node), which disappears on the next upgrade.
 */
export function stablePath(
	node: string,
	pathDirs: string[] = (process.env.PATH ?? '').split(delimiter)
): string {
	let real: string;
	try {
		real = realpathSync(node);
	} catch {
		return node;
	}
	const dirs = [...pathDirs, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
	for (const dir of dirs) {
		const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
		try {
			if (existsSync(candidate) && realpathSync(candidate) === real) return candidate;
		} catch {
			// ignore unreadable PATH entries
		}
	}
	return node;
}

export function probeRuntime(rawNode: string, source: string): NodeRuntime | null {
	if (!existsSync(rawNode)) return null;
	const node = stablePath(rawNode);
	try {
		const version = execFileSync(node, ['-v'], { encoding: 'utf8', timeout: 5000 }).trim();
		const major = Number.parseInt(version.replace(/^v/, ''), 10);
		if (!Number.isFinite(major)) return null;
		const npx = join(dirname(node), process.platform === 'win32' ? 'npx.cmd' : 'npx');
		return { node, npx: existsSync(npx) ? npx : null, version, major, source };
	} catch {
		return null;
	}
}

function versionDirs(root: string, sub: string): string[] {
	try {
		return readdirSync(root)
			.sort()
			.reverse()
			.map((v) => join(root, v, sub, 'node'));
	} catch {
		return [];
	}
}

/** The Node that is running this process. Always valid when setup runs through npx or node. */
export function currentRuntime(): NodeRuntime | null {
	return probeRuntime(process.execPath, 'current');
}

/** Every Node install we can find, newest-major first, with the private runtime preferred. */
export function findRuntimes(): NodeRuntime[] {
	const home = homedir();
	const candidates: Array<[string, string]> = [
		[join(home, '.scrivener-mcp', 'node', 'bin', 'node'), 'private'],
		['/opt/homebrew/bin/node', 'homebrew'],
		['/usr/local/bin/node', 'homebrew-intel'],
		[join(home, '.volta', 'bin', 'node'), 'volta'],
		['/usr/bin/node', 'system'],
	];
	for (const p of versionDirs(join(home, '.nvm', 'versions', 'node'), 'bin')) {
		candidates.push([p, 'nvm']);
	}
	for (const p of versionDirs(join(home, '.fnm', 'node-versions'), join('installation', 'bin'))) {
		candidates.push([p, 'fnm']);
	}
	for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
		candidates.push([join(dir, process.platform === 'win32' ? 'node.exe' : 'node'), 'path']);
	}

	const seen = new Set<string>();
	const found: NodeRuntime[] = [];
	for (const [path, source] of candidates) {
		if (seen.has(path)) continue;
		seen.add(path);
		const rt = probeRuntime(path, source);
		if (rt) found.push(rt);
	}
	return found;
}

/** Pick the runtime to write into client configs: the running one if usable, else the best found. */
export function chooseRuntime(
	candidates: NodeRuntime[] = findRuntimes(),
	current: NodeRuntime | null = currentRuntime()
): NodeRuntime | null {
	const usable = (rt: NodeRuntime | null): rt is NodeRuntime =>
		rt !== null && isSupportedRuntime(rt) && rt.npx !== null;
	if (usable(current)) return current;
	return candidates.find(usable) ?? null;
}

export function isSupportedRuntime(runtime: NodeRuntime): boolean {
	const parts = runtime.version.replace(/^v/, '').split('.').map(Number);
	return runtime.major > MIN_NODE_MAJOR || (runtime.major === MIN_NODE_MAJOR && parts[1] >= 13);
}

/**
 * Server launch command that does not depend on the client's PATH. GUI apps on macOS do not
 * inherit the shell PATH, so a bare "npx" is the most common reason a server fails to start.
 */
export function serverEntry(runtime: NodeRuntime): ServerEntry {
	const binDir = dirname(runtime.node);
	if (process.platform === 'win32' && runtime.npx) {
		const npxCli = join(binDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
		if (!existsSync(npxCli))
			throw new Error(
				'npm npx-cli.js was not found beside Node; reinstall the official Node distribution'
			);
		return {
			command: runtime.node,
			args: [npxCli, '-y', 'scrivener-mcp'],
			env: { PATH: [binDir, process.env.PATH ?? ''].join(delimiter) },
		};
	}
	return {
		command: runtime.npx ?? runtime.node,
		args: runtime.npx ? ['-y', 'scrivener-mcp'] : [],
		env: { PATH: [binDir, ...SYSTEM_PATH].join(delimiter) },
	};
}
