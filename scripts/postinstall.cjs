#!/usr/bin/env node
/**
 * Post-install: auto-configure Claude Desktop MCP client.
 * Runs silently. Never fails the install.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function main() {
	// Skip in CI or when explicitly disabled
	if (process.env.CI || process.env.SCRIVENER_SKIP_POSTINSTALL === 'true') {
		return;
	}

	// Find Claude Desktop config
	const configPaths = [
		path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
		path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
		path.join(os.homedir(), '.config', 'claude', 'claude_desktop_config.json'),
	];

	let configPath = configPaths.find((p) => fs.existsSync(p));

	if (!configPath) {
		// Create config in platform-appropriate location
		if (process.platform === 'darwin') configPath = configPaths[0];
		else if (process.platform === 'win32') configPath = configPaths[1];
		else configPath = configPaths[2];

		const dir = path.dirname(configPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	// Read existing config or start fresh
	let config = {};
	if (fs.existsSync(configPath)) {
		try {
			config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		} catch {
			// Corrupt config -- start fresh but don't overwrite
			console.error('scrivener-mcp: Could not parse ' + configPath + '. Run "npx scrivener-setup" to configure manually.');
			return;
		}
	}

	// Add scrivener MCP server if not already configured
	if (!config.mcpServers) config.mcpServers = {};

	if (config.mcpServers.scrivener) {
		// Already configured -- don't touch it
		return;
	}

	config.mcpServers.scrivener = {
		command: 'npx',
		args: ['scrivener-mcp'],
	};

	try {
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
		console.error('scrivener-mcp: Configured for Claude Desktop. Restart Claude to activate.');
	} catch {
		console.error('scrivener-mcp: Could not write config. Run "npx scrivener-setup" to configure manually.');
	}
}

try {
	main();
} catch {
	// Never fail the install
}
