import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { publishConfigFile, readConfigFile } from './config-file.js';
import type { ServerEntry } from './runtime.js';

export const SERVER_NAME = 'scrivener';

export type ClientId =
	'claude-desktop' | 'claude-code' | 'cursor' | 'vscode' | 'lm-studio' | 'boltai' | 'raycast';

export interface ClientSpec {
	id: ClientId;
	name: string;
	/** Top-level key that holds the server map. */
	rootKey: 'mcpServers' | 'servers';
	/** Absolute config path, or null when the client has no file (Raycast) or this OS. */
	configPath: () => string | null;
	/** Paths whose existence shows the client is installed. */
	markers: () => string[];
	/** Whether a server entry needs an explicit transport type. */
	needsType?: boolean;
	restartHint: string;
}

const home = homedir();
const os = platform();

function appSupport(...parts: string[]): string {
	return join(home, 'Library', 'Application Support', ...parts);
}

function appData(...parts: string[]): string {
	return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), ...parts);
}

function apps(...names: string[]): string[] {
	return names.flatMap((n) => [join('/Applications', n), join(home, 'Applications', n)]);
}

export const CLIENTS: ClientSpec[] = [
	{
		id: 'claude-desktop',
		name: 'Claude Desktop',
		rootKey: 'mcpServers',
		configPath: () =>
			os === 'darwin'
				? appSupport('Claude', 'claude_desktop_config.json')
				: os === 'win32'
					? appData('Claude', 'claude_desktop_config.json')
					: join(home, '.config', 'Claude', 'claude_desktop_config.json'),
		markers: () => [...apps('Claude.app'), dirname(CLIENTS[0].configPath() ?? '')],
		restartHint: 'Quit Claude Desktop fully (Cmd+Q) and reopen it.',
	},
	{
		id: 'claude-code',
		name: 'Claude Code',
		rootKey: 'mcpServers',
		configPath: () => join(home, '.claude.json'),
		markers: () => [join(home, '.claude')],
		restartHint: 'Start a new Claude Code session.',
	},
	{
		id: 'cursor',
		name: 'Cursor',
		rootKey: 'mcpServers',
		configPath: () => join(home, '.cursor', 'mcp.json'),
		markers: () => [...apps('Cursor.app'), join(home, '.cursor')],
		restartHint: 'Restart Cursor.',
	},
	{
		id: 'vscode',
		name: 'VS Code',
		rootKey: 'servers',
		needsType: true,
		configPath: () =>
			os === 'darwin'
				? appSupport('Code', 'User', 'mcp.json')
				: os === 'win32'
					? appData('Code', 'User', 'mcp.json')
					: join(home, '.config', 'Code', 'User', 'mcp.json'),
		markers: () => [...apps('Visual Studio Code.app'), dirname(CLIENTS[3].configPath() ?? '')],
		restartHint: 'Reload the VS Code window.',
	},
	{
		id: 'lm-studio',
		name: 'LM Studio',
		rootKey: 'mcpServers',
		configPath: () => join(home, '.lmstudio', 'mcp.json'),
		markers: () => [...apps('LM Studio.app'), join(home, '.lmstudio')],
		restartHint: 'Restart LM Studio.',
	},
	{
		id: 'boltai',
		name: 'BoltAI',
		rootKey: 'mcpServers',
		configPath: () => (os === 'darwin' ? join(home, '.boltai', 'mcp.json') : null),
		markers: () => (os === 'darwin' ? [...apps('BoltAI.app'), join(home, '.boltai')] : []),
		restartHint: 'In BoltAI open Settings > Plugins > ... > Reload Config.',
	},
	{
		id: 'raycast',
		name: 'Raycast',
		rootKey: 'mcpServers',
		configPath: () => null,
		markers: () => (os === 'darwin' ? apps('Raycast.app') : []),
		restartHint: 'Confirm the Install Server dialog that Raycast opens.',
	},
];

export function clientById(id: string): ClientSpec | undefined {
	return CLIENTS.find((c) => c.id === id);
}

export function isInstalled(client: ClientSpec): boolean {
	const path = client.configPath();
	if (path && existsSync(path)) return true;
	return client.markers().some((m) => m && existsSync(m));
}

export function detectClients(): ClientSpec[] {
	return CLIENTS.filter(isInstalled);
}

function desiredEntry(client: ClientSpec, entry: ServerEntry): Record<string, unknown> {
	return client.needsType ? { type: 'stdio', ...entry } : { ...entry };
}

export type ConfigStatus = 'missing' | 'configured' | 'outdated' | 'unreadable';

export interface Inspection {
	status: ConfigStatus;
	detail?: string;
}

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

function parseConfig(text: string | null): Parsed {
	if (text === null || text.trim() === '') return { ok: true, value: {} };
	try {
		const value = JSON.parse(text) as unknown;
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			return { ok: false, reason: 'top level is not a JSON object' };
		}
		return { ok: true, value: value as Record<string, unknown> };
	} catch {
		return { ok: false, reason: 'invalid JSON syntax' };
	}
}

function serverMap(root: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const map = root[key];
	if (map === undefined) return {};
	return map !== null && typeof map === 'object' && !Array.isArray(map)
		? (map as Record<string, unknown>)
		: null;
}

function sameEntry(a: unknown, b: Record<string, unknown>): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Pure: report the state of the scrivener entry in a config file's text. */
export function inspectText(
	client: ClientSpec,
	text: string | null,
	entry: ServerEntry
): Inspection {
	const parsed = parseConfig(text);
	if (!parsed.ok) return { status: 'unreadable', detail: parsed.reason };
	const map = serverMap(parsed.value, client.rootKey);
	if (map === null)
		return { status: 'unreadable', detail: `"${client.rootKey}" is not an object` };
	if (!(SERVER_NAME in map)) return { status: 'missing' };
	return sameEntry(map[SERVER_NAME], desiredEntry(client, entry))
		? { status: 'configured' }
		: { status: 'outdated' };
}

export type ApplyResult =
	{ ok: true; text: string; changed: boolean } | { ok: false; reason: string };

/** Pure: return the config text with the scrivener entry added or repaired. */
export function applyText(
	client: ClientSpec,
	text: string | null,
	entry: ServerEntry
): ApplyResult {
	const parsed = parseConfig(text);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	const map = serverMap(parsed.value, client.rootKey);
	if (map === null) return { ok: false, reason: `"${client.rootKey}" is not an object` };
	const desired = desiredEntry(client, entry);
	if (sameEntry(map[SERVER_NAME], desired)) {
		return { ok: true, text: text ?? '', changed: false };
	}
	parsed.value[client.rootKey] = { ...map, [SERVER_NAME]: desired };
	return { ok: true, text: `${JSON.stringify(parsed.value, null, 2)}\n`, changed: true };
}

/** Pure: return the config text with the scrivener entry removed. */
export function removeText(client: ClientSpec, text: string | null): ApplyResult {
	const parsed = parseConfig(text);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	const map = serverMap(parsed.value, client.rootKey);
	if (map === null) return { ok: false, reason: `"${client.rootKey}" is not an object` };
	if (!(SERVER_NAME in map)) return { ok: true, text: text ?? '', changed: false };
	const { [SERVER_NAME]: _removed, ...rest } = map;
	parsed.value[client.rootKey] = rest;
	return { ok: true, text: `${JSON.stringify(parsed.value, null, 2)}\n`, changed: true };
}

export interface ClientOutcome {
	client: ClientSpec;
	outcome: 'added' | 'repaired' | 'unchanged' | 'removed' | 'skipped' | 'failed';
	path?: string;
	backup?: string;
	message?: string;
}

export function inspectClient(client: ClientSpec, entry: ServerEntry): Inspection {
	const path = client.configPath();
	if (!path) return { status: 'missing', detail: 'no config file; uses an install link' };
	return inspectText(client, readConfigFile(path).text, entry);
}

export function configureClient(
	client: ClientSpec,
	entry: ServerEntry,
	options: { repairExisting?: boolean } = {}
): ClientOutcome {
	const path = client.configPath();
	if (!path) return { client, outcome: 'skipped', message: 'uses an install link' };
	try {
		const snapshot = readConfigFile(path);
		const before = snapshot.text;
		const wasPresent = inspectText(client, before, entry).status;
		if (options.repairExisting === false && ['configured', 'outdated'].includes(wasPresent))
			return { client, outcome: 'unchanged', path };
		const result = applyText(client, before, entry);
		if (!result.ok) {
			return {
				client,
				outcome: 'failed',
				path,
				message: `Left ${path} untouched because it is not valid JSON (${result.reason}). Fix or move it, then run setup again.`,
			};
		}
		if (!result.changed) return { client, outcome: 'unchanged', path };
		const publication = publishConfigFile(path, snapshot, result.text);
		return {
			client,
			outcome: wasPresent === 'outdated' ? 'repaired' : 'added',
			path,
			...publication,
		};
	} catch (error) {
		return { client, outcome: 'failed', path, message: (error as Error).message };
	}
}

export function removeFromClient(client: ClientSpec): ClientOutcome {
	const path = client.configPath();
	if (!path) return { client, outcome: 'skipped', message: 'remove it from the app settings' };
	try {
		const snapshot = readConfigFile(path);
		const before = snapshot.text;
		if (before === null) return { client, outcome: 'unchanged', path };
		const result = removeText(client, before);
		if (!result.ok) {
			return {
				client,
				outcome: 'failed',
				path,
				message: `Left ${path} untouched because it is not valid JSON (${result.reason}). Fix or move it, then run setup again.`,
			};
		}
		if (!result.changed) return { client, outcome: 'unchanged', path };
		const publication = publishConfigFile(path, snapshot, result.text);
		return { client, outcome: 'removed', path, ...publication };
	} catch (error) {
		return { client, outcome: 'failed', path, message: (error as Error).message };
	}
}
