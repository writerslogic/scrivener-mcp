import { describe, expect, it } from '@jest/globals';
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
