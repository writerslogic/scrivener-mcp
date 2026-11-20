import { describe, expect, it } from '@jest/globals';
import { parse } from 'smol-toml';
import {
	CLIENTS,
	applyText,
	inspectText,
	removeText,
	type ClientSpec,
} from '../../../src/setup/clients.js';
import type { ServerEntry } from '../../../src/setup/runtime.js';

const entry: ServerEntry = {
	command: '/opt/homebrew/bin/npx',
	args: ['-y', 'scrivener-mcp'],
	env: { PATH: '/opt/homebrew/bin:/usr/bin' },
};

const byId = (id: string): ClientSpec => CLIENTS.find((c) => c.id === id) as ClientSpec;

describe('client config text', () => {
	it('adds the entry to an empty or missing file', () => {
		for (const text of [null, '', '  \n']) {
			const result = applyText(byId('claude-desktop'), text, entry);
			expect(result.ok && result.changed).toBe(true);
			const parsed = JSON.parse((result as { text: string }).text);
			expect(parsed.mcpServers.scrivener).toEqual(entry);
		}
	});

	it('preserves unrelated keys and other servers', () => {
		const before = JSON.stringify({
			preferences: { a: 1 },
			mcpServers: { other: { command: 'x', args: [] } },
		});
		const result = applyText(byId('cursor'), before, entry);
		const parsed = JSON.parse((result as { text: string }).text);
		expect(parsed.preferences).toEqual({ a: 1 });
		expect(parsed.mcpServers.other).toEqual({ command: 'x', args: [] });
		expect(parsed.mcpServers.scrivener).toEqual(entry);
	});

	it('is idempotent once the entry is current', () => {
		const first = applyText(byId('cursor'), null, entry) as { text: string };
		const second = applyText(byId('cursor'), first.text, entry);
		expect(second.ok && second.changed).toBe(false);
		expect(inspectText(byId('cursor'), first.text, entry).status).toBe('configured');
	});

	it('repairs the old bare-npx entry instead of skipping it', () => {
		const old = JSON.stringify({ mcpServers: { scrivener: { command: 'npx', args: ['scrivener-mcp'] } } });
		expect(inspectText(byId('claude-desktop'), old, entry).status).toBe('outdated');
		const fixed = applyText(byId('claude-desktop'), old, entry) as { text: string; changed: boolean };
		expect(fixed.changed).toBe(true);
		expect(JSON.parse(fixed.text).mcpServers.scrivener).toEqual(entry);
	});

	it('uses the servers key and an explicit stdio type for VS Code', () => {
		const result = applyText(byId('vscode'), null, entry) as { text: string };
		const parsed = JSON.parse(result.text);
		expect(parsed.mcpServers).toBeUndefined();
		expect(parsed.servers.scrivener).toEqual({ type: 'stdio', ...entry });
	});

	it('refuses to touch a file it cannot parse', () => {
		const result = applyText(byId('claude-desktop'), '{ "mcpServers": ', entry);
		expect(result.ok).toBe(false);
		expect(inspectText(byId('claude-desktop'), '{ nope', entry).status).toBe('unreadable');
	});

	it('refuses a server map that is not an object', () => {
		expect(applyText(byId('cursor'), '{"mcpServers": []}', entry).ok).toBe(false);
		expect(applyText(byId('cursor'), '[]', entry).ok).toBe(false);
	});

	it('removes only the scrivener entry', () => {
		const before = JSON.stringify({
			mcpServers: { scrivener: entry, keep: { command: 'k', args: [] } },
		});
		const result = removeText(byId('boltai'), before) as { text: string; changed: boolean };
		expect(result.changed).toBe(true);
		const parsed = JSON.parse(result.text);
		expect(parsed.mcpServers.scrivener).toBeUndefined();
		expect(parsed.mcpServers.keep).toBeDefined();
		expect(removeText(byId('boltai'), result.text)).toMatchObject({ ok: true, changed: false });
	});
});

describe('Grok Build TOML config', () => {
	const grok = byId('grok');
	const existing = [
		'# my settings',
		'model = "grok-4" # inline comment',
		'',
		'[mcp_servers.other]',
		'command = "other-mcp"',
		'args = ["--x"] # keep me',
		'',
		'[ui]',
		'theme = "dark"',
		'',
	].join('\n');

	it('appends the server and leaves every other byte in place', () => {
		const result = applyText(grok, existing, entry) as {
			ok: true;
			text: string;
			changed: boolean;
		};
		expect(result).toMatchObject({ ok: true, changed: true });
		expect(result.text.startsWith(existing)).toBe(true);
		const parsed = parse(result.text) as { mcp_servers: Record<string, unknown> };
		expect(parsed.mcp_servers.scrivener).toEqual(entry);
		expect(parsed.mcp_servers.other).toEqual({ command: 'other-mcp', args: ['--x'] });
		expect(inspectText(grok, result.text, entry).status).toBe('configured');
		expect(applyText(grok, result.text, entry)).toMatchObject({ ok: true, changed: false });
	});

	it('creates a config from nothing', () => {
		const result = applyText(grok, null, entry) as { text: string };
		expect(parse(result.text)).toEqual({ mcp_servers: { scrivener: entry } });
	});

	it('replaces an outdated entry and its subtables in place without duplicating it', () => {
		const old = [
			'[mcp_servers.scrivener]',
			'command = "npx"',
			'args = ["scrivener-mcp"]',
			'startup_timeout_sec = 5',
			'',
			'[mcp_servers.scrivener.env]',
			'STALE = "1"',
			'',
			'[ui] # after',
			'theme = "dark"',
			'',
		].join('\n');
		expect(inspectText(grok, old, entry).status).toBe('outdated');
		const fixed = applyText(grok, old, entry) as { text: string };
		expect(fixed.text.match(/\[mcp_servers\.scrivener\]/g)).toHaveLength(1);
		expect(fixed.text).toContain('[ui] # after');
		expect(fixed.text.indexOf('[mcp_servers.scrivener]')).toBeLessThan(
			fixed.text.indexOf('[ui]')
		);
		expect(parse(fixed.text)).toEqual({
			mcp_servers: { scrivener: { ...entry, startup_timeout_sec: 5 } },
			ui: { theme: 'dark' },
		});
	});

	it('keeps settings Grok Build owns, such as a disabled server', () => {
		const added = (applyText(grok, null, entry) as { text: string }).text;
		const disabled = added.replace(
			/^(args = .*)$/m,
			'$1\nenabled = false\nstartup_timeout_sec = 60'
		);
		expect(inspectText(grok, disabled, entry).status).toBe('configured');
		const moved = { ...entry, command: '/new/node' };
		expect(inspectText(grok, disabled, moved).status).toBe('outdated');
		const repaired = applyText(grok, disabled, moved) as { text: string };
		expect(parse(repaired.text)).toEqual({
			mcp_servers: { scrivener: { ...moved, enabled: false, startup_timeout_sec: 60 } },
		});
	});

	it('preserves CRLF line endings', () => {
		const result = applyText(grok, 'a = 1\r\n', entry) as { text: string };
		expect(result.text.replace(/\r\n/g, '')).not.toContain('\n');
	});

	it('leaves invalid TOML and non-table server maps untouched', () => {
		expect(applyText(grok, 'model = ', entry)).toEqual({
			ok: false,
			reason: 'invalid TOML syntax',
		});
		expect(inspectText(grok, 'model = ', entry).status).toBe('unreadable');
		expect(applyText(grok, 'mcp_servers = 3\n', entry).ok).toBe(false);
	});

	it.each([
		['inline table', 'mcp_servers = { scrivener = { command = "npx" } }\n'],
		['dotted keys', '[mcp_servers]\nscrivener.command = "npx"\n'],
	])('refuses to rewrite a server defined with %s', (_label, text) => {
		const result = applyText(grok, text, entry) as { ok: false; reason: string };
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('grok mcp remove scrivener');
		expect(removeText(grok, text).ok).toBe(false);
	});

	it('removes only the scrivener tables', () => {
		const added = (applyText(grok, existing, entry) as { text: string }).text;
		const removed = removeText(grok, added) as { text: string; changed: boolean };
		expect(removed.changed).toBe(true);
		expect(removed.text).toBe(existing);
		expect(removeText(grok, removed.text)).toMatchObject({ ok: true, changed: false });
	});

	it('honours GROK_HOME', () => {
		const saved = process.env.GROK_HOME;
		try {
			process.env.GROK_HOME = '/custom/grok';
			expect(grok.configPath()).toBe('/custom/grok/config.toml');
			process.env.GROK_HOME = '  ';
			expect(grok.configPath()).toMatch(/\.grok\/config\.toml$/);
		} finally {
			if (saved === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = saved;
		}
	});
});
