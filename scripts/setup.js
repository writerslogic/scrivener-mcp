#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-console */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import process from 'process';

// Ensure console is available
if (typeof console === 'undefined') {
  // Running in an environment without console
  const noop = () => {};
  globalThis.console = {
    log: noop,
    error: noop,
    warn: noop,
    info: noop
  };
}

console.log('\n🚀 Setting up Scrivener MCP for Claude Desktop...\n');

// Possible config locations
const configPaths = [
  join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  join(homedir(), '.config', 'claude', 'claude_desktop_config.json'),
  join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
];

// Find existing config
let configPath = configPaths.find(p => existsSync(p));

if (!configPath) {
  // Try to create config in the most likely location based on platform
  const platform = process.platform;
  if (platform === 'darwin') {
    configPath = configPaths[0];
  } else if (platform === 'win32') {
    configPath = configPaths[2];
  } else {
    configPath = configPaths[1];
  }
  
  // Create directory if it doesn't exist
  const dir = join(configPath, '..');
  if (!existsSync(dir)) {
    console.log(`📁 Creating config directory: ${dir}`);
    mkdirSync(dir, { recursive: true });
  }
}

// Read or create config
let config = {};
if (existsSync(configPath)) {
  console.log(`📄 Found existing config at: ${configPath}`);
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('⚠️  Error reading config file:', err.message);
    console.log('Creating new config...');
  }
} else {
  console.log(`📝 Creating new config at: ${configPath}`);
}

// Ensure mcpServers exists
if (!config.mcpServers) {
  config.mcpServers = {};
}

// Check if scrivener is already configured
if (config.mcpServers.scrivener) {
  console.log('✅ Scrivener MCP is already configured!');
  console.log('\nCurrent configuration:');
  console.log(JSON.stringify(config.mcpServers.scrivener, null, 2));
  
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const answer = await new Promise((resolve) => {
    rl.question('\nDo you want to update the configuration? (y/N): ', resolve);
  });
  rl.close();
  
  if (answer.toLowerCase() !== 'y') {
    console.log('\n✨ Setup complete! Restart Claude Desktop to use Scrivener MCP.\n');
    process.exit(0);
  }
}

// Add scrivener configuration
config.mcpServers.scrivener = {
  command: 'npx',
  args: ['scrivener-mcp']
};

// Write config
try {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('\n✅ Successfully configured Scrivener MCP!');
  console.log(`📍 Configuration saved to: ${configPath}`);
  console.log('\n✨ Setup complete! Please restart Claude Desktop to use Scrivener MCP.\n');
  console.log('📚 You can now ask Claude to:');
  console.log('   - Open your Scrivener projects');
  console.log('   - Read and analyze your manuscripts');
  console.log('   - Help with writing and editing');
  console.log('   - Manage document structure\n');
} catch (err) {
  console.error('❌ Error writing config:', err.message);
  console.log('\n📋 Please manually add this to your claude_desktop_config.json:');
  console.log(JSON.stringify({ mcpServers: { scrivener: config.mcpServers.scrivener } }, null, 2));
  process.exit(1);
}