#!/usr/bin/env node
/**
 * Interactive setup: configure scrivener-mcp for your MCP client.
 * Usage: npx scrivener-setup
 */

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const { homedir, platform } = require('os');
const { join, dirname } = require('path');
const readline = require('readline');

const SERVER_CONFIG = {
	command: 'npx',
	args: ['scrivener-mcp'],
};

// Known MCP client config locations
const CLIENTS = {
	'Claude Desktop': {
		darwin: join(
			homedir(),
			'Library',
			'Application Support',
			'Claude',
			'claude_desktop_config.json'
		),
		win32: join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
		linux: join(homedir(), '.config', 'claude', 'claude_desktop_config.json'),
	},
	'Claude Code': {
		// Claude Code reads MCP servers from ~/.claude.json (top-level mcpServers),
		// NOT ~/.claude/settings.json which is for permissions/hooks only.
		all: join(homedir(), '.claude.json'),
		// dirname(~/.claude.json) is the home dir (always exists), so detection
		// must key off a real install marker instead.
		detect: join(homedir(), '.claude'),
	},
	Cursor: {
		darwin: join(
			homedir(),
			'Library',
			'Application Support',
			'Cursor',
			'User',
			'globalStorage',
			'cursor.mcp',
			'config.json'
		),
		win32: join(
			homedir(),
			'AppData',
			'Roaming',
			'Cursor',
			'User',
			'globalStorage',
			'cursor.mcp',
			'config.json'
		),
		linux: join(
			homedir(),
			'.config',
			'Cursor',
			'User',
			'globalStorage',
			'cursor.mcp',
			'config.json'
		),
	},
};

function detectClients() {
	const found = [];
	for (const [name, paths] of Object.entries(CLIENTS)) {
		const configPath = paths.all || paths[platform()] || paths.linux;
		// A client is "installed" if its config file already exists, or a marker
		// directory does. Prefer an explicit `detect` marker; otherwise fall back
		// to the config's parent dir (valid only when it is client-specific).
		const marker = paths.detect || dirname(configPath);
		if (existsSync(configPath) || existsSync(marker)) {
			found.push({ name, configPath, exists: existsSync(configPath) });
		}
	}
	return found;
}

function configureClient(configPath) {
	let config = {};
	mkdirSync(dirname(configPath), { recursive: true });
	try {
		config = JSON.parse(readFileSync(configPath, 'utf8'));
	} catch (err) {
		if (err.code !== 'ENOENT') {
			console.log('  Warning: could not parse existing config, creating new one.');
		}
	}

	if (!config.mcpServers) config.mcpServers = {};

	if (config.mcpServers.scrivener) {
		console.log('  Already configured. Skipping.');
		return false;
	}

	config.mcpServers.scrivener = SERVER_CONFIG;
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	return true;
}

async function ask(rl, question) {
	return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
	console.log('\nScrivener MCP Setup\n');

	const detected = detectClients();

	if (detected.length === 0) {
		console.log("No MCP clients detected. Add this to your client's MCP config:\n");
		console.log(JSON.stringify({ mcpServers: { scrivener: SERVER_CONFIG } }, null, 2));
		console.log('\nSee https://github.com/writerslogic/scrivener-mcp#install for details.\n');
		return;
	}

	console.log('Detected MCP clients:\n');
	detected.forEach((c, i) => {
		console.log(`  ${i + 1}. ${c.name} ${c.exists ? '(config found)' : '(directory exists)'}`);
	});

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	const answer = await ask(rl, `\nConfigure all? (Y/n): `);
	rl.close();

	const configAll = !answer || answer.toLowerCase() !== 'n';
	let configured = 0;

	for (const client of detected) {
		if (!configAll) continue;
		console.log(`\n  Configuring ${client.name}...`);
		try {
			if (configureClient(client.configPath)) {
				console.log(`  Done. Config: ${client.configPath}`);
				configured++;
			}
		} catch (err) {
			console.log(`  Failed: ${err.message}`);
		}
	}

	if (configured > 0) {
		console.log(
			`\nConfigured ${configured} client(s). Restart them to activate Scrivener MCP.\n`
		);
	} else {
		console.log('\nNo changes made.\n');
	}
}

main().catch((err) => {
	console.error('Setup failed:', err.message);
	process.exit(1);
});
