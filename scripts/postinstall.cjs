#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function main() {
	if (process.env.CI || process.env.SCRIVENER_SKIP_POSTINSTALL === 'true') return;

	const { clientById, configureClient } = await import(
		pathToFileURL(path.join(__dirname, '../dist/setup/clients.js')).href
	);
	const client = clientById('claude-desktop');
	const candidates = [
		client.configPath(),
		path.join(
			os.homedir(),
			'Library',
			'Application Support',
			'Claude',
			'claude_desktop_config.json'
		),
		path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
		path.join(os.homedir(), '.config', 'claude', 'claude_desktop_config.json'),
	];
	const configPath =
		candidates.find((candidate) => {
			try {
				fs.lstatSync(candidate);
				return true;
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
				return false;
			}
		}) ?? client.configPath();
	const outcome = configureClient(
		{ ...client, configPath: () => configPath },
		{ command: 'npx', args: ['scrivener-mcp'] },
		{ repairExisting: false }
	);
	if (outcome.outcome === 'added') {
		console.error('scrivener-mcp: Configured for Claude Desktop. Restart Claude to activate.');
		if (outcome.message) console.error(`scrivener-mcp: ${outcome.message}`);
	} else if (outcome.outcome === 'failed') {
		console.error(`scrivener-mcp: ${outcome.message}`);
		console.error('scrivener-mcp: Run "npx scrivener-setup" to configure manually.');
	}
}

main().catch(() => {
	console.error(
		'scrivener-mcp: Automatic configuration unavailable. Run "npx scrivener-setup" after installation to configure manually.'
	);
});
