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

function versionParts(version: string): number[] | null {
	if (typeof version !== 'string' || version.length > 64) return null;
	const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
	if (!match) return null;
	const parts = match.slice(1).map(Number);
	return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareRuntimes(left: NodeRuntime, right: NodeRuntime): number {
	if ((left.source === 'private') !== (right.source === 'private'))
		return left.source === 'private' ? -1 : 1;
	const a = versionParts(left.version)!;
	const b = versionParts(right.version)!;
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return b[index] - a[index];
	}
	return 0;
}

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
		const parts = versionParts(version);
		if (!parts) return null;
		const major = parts[0];
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
		let identity: string;
		try {
			identity = realpathSync(path);
		} catch {
			continue;
		}
		if (seen.has(identity)) continue;
		seen.add(identity);
		const rt = probeRuntime(path, source);
		if (rt) found.push(rt);
	}
	return found.sort(compareRuntimes);
}

/** Pick the runtime to write into client configs: the running one if usable, else the best found. */
export function chooseRuntime(
	candidates: NodeRuntime[] = findRuntimes(),
	current: NodeRuntime | null = currentRuntime()
): NodeRuntime | null {
	const usable = (rt: NodeRuntime | null): rt is NodeRuntime =>
		rt !== null && isSupportedRuntime(rt) && rt.npx !== null;
	if (usable(current)) return current;
	let best: NodeRuntime | null = null;
	for (const candidate of candidates) {
		if (usable(candidate) && (!best || compareRuntimes(candidate, best) < 0)) best = candidate;
	}
	return best;
}

export function isSupportedRuntime(runtime: NodeRuntime): boolean {
	const parts = versionParts(runtime.version);
	if (!parts || runtime.major !== parts[0]) return false;
	const minimum = versionParts(MIN_NODE_VERSION)!;
	for (let index = 0; index < parts.length; index++) {
		if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
	}
	return true;
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
