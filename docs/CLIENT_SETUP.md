# MCP Client Setup

Copy-paste configuration for connecting scrivener-mcp to common MCP clients. All clients use
**stdio** transport — you only need a `command` and `args`.

## Quick setup (recommended)

The setup tool finds your installed AI apps, adds Scrivener MCP to each one, and then starts the
server once to prove it works:

```bash
npx --package scrivener-mcp scrivener-setup
```

It supports Claude Desktop, Claude Code, Cursor, VS Code, LM Studio, and BoltAI, and opens an
install dialog for Raycast. What it does for you:

- **Fixes PATH problems.** Apps on macOS do not see your shell's PATH, which is the usual reason a
  server "fails to start". The tool writes the full path to `npx` and the matching PATH into each
  config.
- **Repairs old entries.** An older `npx scrivener-mcp` entry is updated instead of skipped.
- **Never damages a config.** Other servers and settings are kept, a dated backup is saved next to
  the file, and a file that is not valid JSON is left untouched.
- **Checks the result.** `npx --package scrivener-mcp scrivener-setup --check` reports each app's
  state and runs the start-up test without changing anything.

Useful options: `--client cursor` (one app only), `--remove`, `--links` (one-click install links),
`--print` (the JSON for manual setup), `--yes` (no questions), and `--json` (for scripts).

### No Node.js installed?

On a Mac without Node.js, run the one-line installer. It uses an existing Node 22.13 or newer if it
finds one. Otherwise it downloads the official Node.js build into `~/.scrivener-mcp/node`, checks
its SHA-256, and needs no administrator password:

```bash
curl -fsSL https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/scripts/bootstrap-mac.sh | sh
```

Add `-s -- --check` after `sh` to check instead of change. Remove the private runtime at any time by
deleting `~/.scrivener-mcp/node`.

## Standard server snippet

This is the config block every client needs. The wizard uses `npx` so you always get the latest
published version without a global install:

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

## Codex (local fork)

Build the checkout with `npm ci --ignore-scripts` and `npm run build`. If native dependencies need a
binary for your Node version, run `npm rebuild better-sqlite3`. The launcher keeps the server's
cache/database working directory in the checkout.

Add this block to `~/.codex/config.toml`, adjusting both absolute paths:

```toml
[mcp_servers.scrivener]
command = 'C:\path\to\node.exe'
args = ['C:\Coding\scrivener-mcp\scripts\codex-launcher.mjs']
startup_timeout_sec = 60

[mcp_servers.scrivener.env]
SCRIVENER_MCP_EAGER_TOOLS = "1"
SCRIVENER_QUIET = "true"
SCRIVENER_SKIP_SETUP = "true"
```

On macOS/Linux, use the corresponding absolute paths instead. Restart Codex after changing the
configuration. Eager registration makes document tools available during the initial handshake,
including on clients that do not refresh a changed tool list
([upstream issue #50](https://github.com/writerslogic/scrivener-mcp/issues/50)).

## Claude Desktop

### Config file location

| Platform | Path                                                              |
| -------- | ----------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows  | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Linux    | `~/.config/claude/claude_desktop_config.json`                     |

### Example

Merge the `scrivener` entry into the existing `mcpServers` object (create the file if it does not
exist):

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
3. You should see the 13 project tools plus `list_skills` and `use_skill` (15 startup tools total).
   These include `open_project`, `get_structure`, `refresh_project`, `close_project`, and
   `discover_projects`.

---

## Claude Code

### Config file location

Claude Code reads MCP servers from dedicated MCP config files — **not** from `settings.json`:

| Scope               | Path                                          |
| ------------------- | --------------------------------------------- |
| User (all projects) | `~/.claude.json` (top-level `mcpServers` key) |
| Project             | `.mcp.json` in your project root              |

> **Note:** `~/.claude/settings.json` and `.claude/settings.json` are for permissions, hooks, and
> other settings. Putting `mcpServers` there has no effect.

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

For user-wide setup, add the same `scrivener` entry under the top-level `mcpServers` key in
`~/.claude.json`.

### Verify

1. Start a new Claude Code session in the configured project (config is read at session start).
2. Run `/mcp` to confirm the server is connected, or ask: **"What Scrivener tools do you have?"**
3. You should see the 13 project tools plus `list_skills` and `use_skill` (15 startup tools total).
   These include `open_project`, `get_structure`, `refresh_project`, `close_project`, and
   `discover_projects`.

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

Cursor reads `~/.cursor/mcp.json` for every project. `npx --package scrivener-mcp scrivener-setup`
writes it for you, or paste the `mcpServers.scrivener` snippet above into that file yourself.

### Verify

1. Reload the Cursor window (**Developer: Reload Window**) or restart Cursor.
2. In Agent or Chat, ask: **"What Scrivener tools do you have?"**
3. Confirm the server connects and lists the startup tools.

---

## VS Code (GitHub Copilot MCP)

VS Code 1.99+ supports MCP through a workspace or user `mcp.json` file.

### Config file location

| Scope     | Path                                                                                          |
| --------- | --------------------------------------------------------------------------------------------- |
| Workspace | `.vscode/mcp.json` in your project root                                                       |
| User      | VS Code user profile `mcp.json` (see **MCP: Open User Configuration** in the Command Palette) |

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

Some older clients used a top-level `mcpServers` key instead of `servers`. VS Code 1.99+ expects the
`servers` format shown above.

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

| Variable             | Purpose                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LOG_LEVEL`          | Reduce log noise (`ERROR` recommended if you see JSON parse errors on old versions)                                                              |
| `ANTHROPIC_API_KEY`  | Enable AI-powered features with Claude (preferred chat provider)                                                                                 |
| `OPENAI_API_KEY`     | Enable provider-backed AI features with OpenAI; semantic indexing/scoring is local, but `semantic_search` still needs a configured chat provider |
| `OPENROUTER_API_KEY` | Enable AI-powered features via OpenRouter (any model in its catalog via `OPENROUTER_MODEL`)                                                      |
| `AI_PROVIDER`        | Chat provider when several keys are set (`anthropic`, `openai`, or `openrouter`)                                                                 |

Core read/write/search tools work without API keys. See
[Getting Started](./getting-started.md#environment-variables) for the full list.

---

## Troubleshooting

- **Server not listed:** Restart the client after editing config. MCP configs are read at startup.
- **JSON errors in Claude Desktop:** Update to scrivener-mcp v0.5.0+ or set `LOG_LEVEL=ERROR`. See
  [Troubleshooting](./troubleshooting.md).
- **Wizard did not find your client:** Use the manual snippets above for your platform.

For more help, see [Getting Started](./getting-started.md) and
[Troubleshooting](./troubleshooting.md).

---

## BoltAI

BoltAI keeps its servers in `~/.boltai/mcp.json`.
`npx --package scrivener-mcp scrivener-setup --client boltai` writes the entry. After it runs, open
**Settings > Plugins**, click the **...** menu, and choose **Reload Config**. You can also choose
**Import from Claude** or **Import from Cursor** in the same menu to copy servers you already set up
there.

## LM Studio

LM Studio reads `~/.lmstudio/mcp.json` (the **Edit mcp.json** button in its Program tab opens the
same file). Use `npx --package scrivener-mcp scrivener-setup --client lm-studio`, or
`npx --package scrivener-mcp scrivener-setup --links` for a one-click `lmstudio://` link.

## Raycast

Raycast stores servers in its own database, so there is no file to edit.
`npx --package scrivener-mcp scrivener-setup --client raycast` opens Raycast's **Install Server**
dialog with everything filled in. Click **Install** there. Raycast runs servers with the PATH from
your default shell, so `npx` must work in a new Terminal window.

## VS Code

VS Code uses a different file format from the other apps: a top-level `servers` key and an explicit
`"type": "stdio"`. The setup tool handles this and writes to
`~/Library/Application Support/Code/User/mcp.json` on a Mac. By hand, run `code --add-mcp` with the
JSON from `npx --package scrivener-mcp scrivener-setup --links`.

## One-click install links

`npx --package scrivener-mcp scrivener-setup --links` prints ready-made links for Cursor, LM Studio,
and Raycast, plus the `code --add-mcp` command for VS Code, each containing the full path to `npx`
on your machine. A link only opens the app's own install dialog and cannot install or repair
Node.js. If a link opens but the server fails to start, run the one-line installer above.

If you installed the Draftbridge Mac app, you do not need Node.js at all. The app carries its own
runtime, and you can generate links that point at it:

```bash
npx --package scrivener-mcp scrivener-setup --links \
  --node "/Applications/Draftbridge.app/Contents/Resources/runtime/bin/node" \
  --script "/Applications/Draftbridge.app/Contents/Resources/server/dist/index.js"
```

The same `--node` and `--script` options work with `--print` and with the setup itself.
