# Troubleshooting

Common issues and solutions for scrivener-mcp. If your problem isn't covered here, [open an issue](https://github.com/writerslogic/scrivener-mcp/issues).

## "Expected ',' or ']' after array element" / JSON parse errors

**Symptoms:** Claude Desktop shows `MCP scrivener: Expected ',' or ']' after array element in JSON at position 5 (line 1 column 6)`, or similar JSON parse errors appear when any tool is called.

**Cause:** In versions before v0.5.0, the server's logger wrote to stdout via `console.log()` and `console.info()`. The MCP protocol uses stdout for JSON-RPC, so log lines (starting with a timestamp like `[2026-`) were misinterpreted as JSON array elements, corrupting the stream.

**Fix:** Update to v0.5.0 or later, where all logging goes to stderr:

```bash
npm update -g scrivener-mcp
```

**Workaround (if you can't update):** Suppress most log output by setting:

```bash
LOG_LEVEL=ERROR npx scrivener-mcp
```

Or in your Claude Desktop config:

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "npx",
      "args": ["scrivener-mcp"],
      "env": { "LOG_LEVEL": "ERROR" }
    }
  }
}
```

**Related issues:** [#3](https://github.com/writerslogic/scrivener-mcp/issues/3), [#6](https://github.com/writerslogic/scrivener-mcp/issues/6), [#7](https://github.com/writerslogic/scrivener-mcp/issues/7), [#8](https://github.com/writerslogic/scrivener-mcp/issues/8)

## Tools execute but no data reaches Claude

**Symptoms:** Tools return confirmation messages ("Document read successfully") but Claude says it has no information, or tool results appear empty.

**Cause:** In early versions, the server attached structured data in a non-standard `data` field on tool results. MCP clients silently dropped the payload, so tools appeared to succeed but returned nothing useful.

**Fix:** Update to v0.5.0 or later:

```bash
npm update -g scrivener-mcp
```

**Related issues:** [#3](https://github.com/writerslogic/scrivener-mcp/issues/3), [#7](https://github.com/writerslogic/scrivener-mcp/issues/7)

## Project won't open

**Check the path format:**

- Point to the `.scriv` directory (the top-level package), not a file inside it. Example: `/Users/me/Documents/MyNovel.scriv`
- You can also pass the `.scrivx` file directly: `/Users/me/Documents/MyNovel.scriv/MyNovel.scrivx`
- The server finds the `.scrivx` file inside the `.scriv` package automatically

**Windows paths:**

- Use forward slashes: `C:/Users/me/Documents/MyNovel.scriv`
- Or escaped backslashes: `C:\\Users\\me\\Documents\\MyNovel.scriv`
- Avoid unescaped backslashes -- they're interpreted as escape characters in JSON

**"Project path must not contain null bytes":**

The path string contains invalid characters, usually from copy-pasting from a rich text source. Retype the path manually.

**"No project is currently open":**

You need to call `open_project` with a path before using document tools. The project stays open for the duration of the conversation -- you don't need to reopen it between tool calls.

**Related issues:** [#4](https://github.com/writerslogic/scrivener-mcp/issues/4), [#9](https://github.com/writerslogic/scrivener-mcp/issues/9)

## "Unknown tool" errors

Tools load progressively to minimize token overhead. At startup, only 15 tools are registered (the `project` skill + meta-tools). Calling a tool whose skill is not active yet now activates that skill on the fly, so a valid tool call no longer dead-ends on "Unknown tool" -- that error is reserved for genuinely unknown or intentionally hidden tools.

- Call `list_skills` to see all available skill groups and which are currently active
- Call `use_skill("analysis")` to activate a group up front (optional; calling its tools also activates it)
- The `documents` and `search` skill groups auto-activate after `open_project`

If a tool name is still reported unknown, check the spelling against `list_skills`.

**If activating a skill doesn't help** -- e.g. `create_document` keeps returning "No such tool available" even right after the `documents` skill activates -- your client isn't refreshing its tool list when the server adds tools. The server sends a `tools/list_changed` notification, but some clients (and older builds of this server) don't act on it. Force everything to register at startup instead:

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "npx",
      "args": ["scrivener-mcp"],
      "env": { "SCRIVENER_MCP_EAGER_TOOLS": "1" }
    }
  }
}
```

Restart the client. All tools are then present from the start, with no progressive activation.

## Claude doesn't see scrivener-mcp

**Restart Claude Desktop** after installation or configuration changes. The MCP server list is only read at startup.

**Check the config file location:**

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**Run the setup wizard** to auto-detect and configure your client:

```bash
npx scrivener-setup
```

The wizard detects Claude Desktop, Claude Code, and Cursor automatically. For manual copy-paste configs per client, see [MCP Client Setup](./CLIENT_SETUP.md).

**Verify the connection** by asking Claude:

> "What tools do you have?"

or

> "What Scrivener tools do you have?"

You should see the startup tools, including: `open_project`, `get_structure`, `refresh_project`, `close_project`, `discover_projects`, `detect_open_project`, `verify_project_integrity`, `get_compile_settings`, `list_skills`, and `use_skill`.

**Related issues:** [#2](https://github.com/writerslogic/scrivener-mcp/issues/2)

## Semantic search returns no results

- Documents must be opened/read at least once to be indexed in the vector store
- The JavaScript fallback engine builds its index in memory per session -- it starts empty
- Try opening the project and reading a few documents before searching
- Full-text search (`search`) works immediately without indexing; semantic search (`semantic_search`) requires the HMS index and a configured chat provider

## AI-powered features don't work

Provider-backed features (deep analysis, content enhancement, critique, generation, and the current `semantic_search` pipeline) require an Anthropic (Claude), OpenAI, or OpenRouter API key—or, for supported tools, an MCP client that can provide sampling. Claude is preferred for chat and generation when several keys are set (`AI_PROVIDER=openai` or `AI_PROVIDER=openrouter` overrides). HMS indexing and similarity scoring are local and do not use an external embedding API, but `semantic_search` still calls the configured chat provider for query interpretation and result explanations. The server checks multiple locations automatically for each provider:

1. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` environment variables
2. `~/.env` file
3. `~/.scrivener-mcp/.env` file
4. `~/.anthropic/key` / `~/.openai/key` / `~/.openrouter/key` files
5. macOS Keychain (macOS only; service names `anthropic-api-key` / `openai-api-key` / `openrouter-api-key`)

To set manually:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY=sk-...
```

Or in your MCP client config:

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "npx",
      "args": ["scrivener-mcp"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

Core features (read, write, search, structure, metadata, analysis) work without any API key. Only AI-enhanced features require one.

Configuring keys for more than one provider adds resilience: when the active provider fails with an account-level error (invalid key, exhausted credit, quota, outage), the request is retried on the next configured provider automatically.

## "HMS system not initialized"

The Holographic Memory System includes a JavaScript fallback and does not require the optional Rust binary. Open a project first so its memory/index layer can initialize, then activate the memory skill. Installing `holographic-memory` enables the faster Rust implementation automatically.

## Neo4j connection errors

Neo4j is entirely optional. Public relationship, character-network, and document-reference tools work without it; Neo4j adds graph persistence and advanced queries when configured.

If you want to use Neo4j:

1. Install and start Neo4j (Community Edition is sufficient)
2. Set the connection environment variables:

```bash
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=your-password
```

If you don't use Neo4j, you can safely ignore any Neo4j-related warnings in the logs.

## Scrivener shows old content after writing

Scrivener caches document content in memory. After the MCP server writes changes:

- Close and reopen the project in Scrivener, or
- Switch away from the modified document and back

Changes are written to disk immediately by `write_document` -- this is a Scrivener UI caching issue, not a data loss issue.

## Changes aren't saved

The server writes changes to disk immediately when you use `write_document` or `update_document`. If you want to be certain, ask Claude to "save the project" which explicitly flushes all pending changes.

## Getting more help

- Set `LOG_LEVEL=DEBUG` for verbose output (logs go to stderr, visible in your terminal)
- Check the [Getting Started](./getting-started.md) guide for setup instructions
- Review the [Architecture](./architecture.md) guide for how the server works internally
- [Open an issue](https://github.com/writerslogic/scrivener-mcp/issues) with your error message and scrivener-mcp version (`npx scrivener-mcp --version`)
