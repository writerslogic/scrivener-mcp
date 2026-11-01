#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

console.log('\n🗑️  Removing Scrivener MCP from Claude Desktop...\n');

// Possible config locations
const configPaths = [
  join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  join(homedir(), '.config', 'claude', 'claude_desktop_config.json'),
  join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
];

const configPath = configPaths.find(p => existsSync(p));

if (!configPath) {
  console.log('⚠️  No Claude Desktop configuration found.');
  console.log('Scrivener MCP may not have been configured.');
  process.exit(0);
}

try {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  
  if (!config.mcpServers || !config.mcpServers.scrivener) {
    console.log('ℹ️  Scrivener MCP was not configured in Claude Desktop.');
    process.exit(0);
  }
  
  delete config.mcpServers.scrivener;
  
  // If mcpServers is now empty, remove it
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  console.log('✅ Successfully removed Scrivener MCP from Claude Desktop configuration.');
  console.log('📍 Configuration updated at:', configPath);
  console.log('\n✨ Please restart Claude Desktop to apply changes.\n');
} catch (err) {
  console.error('❌ Error updating config:', err.message);
  process.exit(1);
}