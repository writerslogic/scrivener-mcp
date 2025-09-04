# Scrivener MCP Setup Guide

## Manual Setup Instructions

Since automatic setup requires Node.js globals that may not be available in all environments, please follow these manual setup steps:

### 1. Locate your Claude Desktop configuration file

The configuration file is typically located at one of these paths:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%AppData%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/claude/claude_desktop_config.json`

### 2. Edit the configuration

Open the configuration file in a text editor and add the Scrivener MCP configuration:

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "npx",
      "args": ["scrivener-mcp"]
    }
  }
}
```

If you already have other MCP servers configured, just add the `scrivener` entry to your existing `mcpServers` object:

```json
{
  "mcpServers": {
    "existing-server": { ... },
    "scrivener": {
      "command": "npx",
      "args": ["scrivener-mcp"]
    }
  }
}
```

### 3. Restart Claude Desktop

After saving the configuration file, restart Claude Desktop for the changes to take effect.

### 4. Verify Installation

Once Claude Desktop restarts, you can verify the installation by asking Claude:
- "What Scrivener tools do you have available?"
- "Can you help me with my Scrivener project?"

## Alternative: Using the provided template

You can also copy the configuration from `scripts/config-template.json` in this package:

1. Copy the contents of `scripts/config-template.json`
2. Merge it with your existing `claude_desktop_config.json`
3. Restart Claude Desktop

## Troubleshooting

If the MCP server doesn't appear to be working:

1. **Check the configuration path**: Make sure you're editing the correct config file
2. **Validate JSON**: Ensure your configuration file is valid JSON (no trailing commas, proper quotes)
3. **Check npm installation**: Verify that `scrivener-mcp` is installed globally: `npm list -g scrivener-mcp`
4. **View logs**: Check Claude Desktop logs for any error messages

## Need Help?

If you encounter issues, please report them at: https://github.com/dcondrey/scrivener-mcp/issues