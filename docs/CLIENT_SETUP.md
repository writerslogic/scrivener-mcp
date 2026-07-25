# MCP Client Setup

Copy-paste configuration for connecting scrivener-mcp to common MCP clients. All clients use **stdio** transport — you only need a `command` and `args`.

## Quick setup (recommended)

The interactive wizard detects installed clients and writes the config for you:

```bash
npx scrivener-setup
```

It configures Claude Desktop, Claude Code, and Cursor when their config directories exist.

## Standard server snippet

This is the config block every client needs. The wizard uses `npx` so you always get the latest published version without a global install:

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

If you installed globally (`npm install -g scrivener-mcp`), you can use the binary directly:

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "scrivener-mcp",
      "args": []
    }
  }
}
```

For local development from a git checkout, point at the built entry file:

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "node",
      "args": ["/absolute/path/to/scrivener-mcp/dist/index.js"]
    }
  }
}
```

Run `npm run build` in the repo before using the local path.

---

## Claude Desktop

### Config file location

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

### Example

Merge the `scrivener` entry into the existing `mcpServers` object (create the file if it does not exist):

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

### Verify

1. **Quit and restart** Claude Desktop (MCP servers load only at startup).
2. Open a new chat and ask: **"What Scrivener tools do you have?"**
3. You should see at least seven startup tools, including `open_project`, `get_structure`, `refresh_project`, `close_project`, `discover_projects`, `list_skills`, and `use_skill`.

---

## Claude Code

### Config file location

Claude Code reads MCP servers from dedicated MCP config files — **not** from `settings.json`:

| Scope | Path |
|-------|------|
| User (all projects) | `~/.claude.json` (top-level `mcpServers` key) |
| Project | `.mcp.json` in your project root |

> **Note:** `~/.claude/settings.json` and `.claude/settings.json` are for permissions, hooks, and other settings. Putting `mcpServers` there has no effect.

The CLI writes to the correct file automatically:

```bash
claude mcp add scrivener -- npx scrivener-mcp
```

### Example (project scope)

Create `.mcp.json` in your project root:

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

For user-wide setup, add the same `scrivener` entry under the top-level `mcpServers` key in `~/.claude.json`.

### Verify

1. Start a new Claude Code session in the configured project (config is read at session start).
2. Run `/mcp` to confirm the server is connected, or ask: **"What Scrivener tools do you have?"**
3. You should see at least seven startup tools, including `open_project`, `get_structure`, `refresh_project`, `close_project`, `discover_projects`, `list_skills`, and `use_skill`.

---

## Cursor

Cursor supports MCP via a project config file or a global config written by `scrivener-setup`.

### Project-level (recommended)

Create or edit `.cursor/mcp.json` in your project root:

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

### Global config

| Method | Path |
|--------|------|
| Manual global | `~/.cursor/mcp.json` (same `mcpServers` snippet as above) |
| Setup wizard | See platform paths below |

When you run `npx scrivener-setup`, Cursor is configured here:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/cursor.mcp/config.json` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\cursor.mcp\config.json` |
| Linux | `~/.config/Cursor/User/globalStorage/cursor.mcp/config.json` |

Use the same `mcpServers.scrivener` snippet in any of these files.

### Verify

1. Reload the Cursor window (**Developer: Reload Window**) or restart Cursor.
2. In Agent or Chat, ask: **"What Scrivener tools do you have?"**
3. Confirm the server connects and lists the startup tools.

---

## VS Code (GitHub Copilot MCP)

VS Code 1.99+ supports MCP through a workspace or user `mcp.json` file.

### Config file location

| Scope | Path |
|-------|------|
| Workspace | `.vscode/mcp.json` in your project root |
| User | VS Code user profile `mcp.json` (see **MCP: Open User Configuration** in the Command Palette) |

### Example (workspace)

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "scrivener": {
      "type": "stdio",
      "command": "npx",
      "args": ["scrivener-mcp"]
    }
  }
}
```

Some older clients used a top-level `mcpServers` key instead of `servers`. VS Code 1.99+ expects the `servers` format shown above.

### Verify

1. Reload the VS Code window.
2. Open Copilot Chat and ask: **"What Scrivener tools do you have?"**
3. Confirm tools are listed and `open_project` works with a `.scriv` path.

---

## Optional environment variables

Pass env vars through your client config when needed:

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "npx",
      "args": ["scrivener-mcp"],
      "env": {
        "LOG_LEVEL": "ERROR",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

| Variable | Purpose |
|----------|---------|
| `LOG_LEVEL` | Reduce log noise (`ERROR` recommended if you see JSON parse errors on old versions) |
| `ANTHROPIC_API_KEY` | Enable AI-powered features with Claude (preferred chat provider) |
| `OPENAI_API_KEY` | Enable AI-powered features with OpenAI; embeddings/semantic search need this or `OPENROUTER_API_KEY` |
| `OPENROUTER_API_KEY` | Enable AI-powered features via OpenRouter (any model in its catalog via `OPENROUTER_MODEL`) |
| `AI_PROVIDER` | Chat provider when several keys are set (`anthropic`, `openai`, or `openrouter`) |

Core read/write/search tools work without API keys. See [Getting Started](./getting-started.md#environment-variables) for the full list.

---

## Troubleshooting

- **Server not listed:** Restart the client after editing config. MCP configs are read at startup.
- **JSON errors in Claude Desktop:** Update to scrivener-mcp v0.5.0+ or set `LOG_LEVEL=ERROR`. See [Troubleshooting](./troubleshooting.md).
- **Wizard did not find your client:** Use the manual snippets above for your platform.

For more help, see [Getting Started](./getting-started.md) and [Troubleshooting](./troubleshooting.md).
