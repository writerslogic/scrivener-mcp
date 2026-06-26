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

Tools load progressively to minimize token overhead. At startup, only 6 tools are registered (project management + meta-tools).

- Call `list_skills` to see all available skill groups and which are currently active
- Call `use_skill("analysis")` to activate analysis tools
- Call `use_skill("compilation")` to activate compilation tools
- The `documents` and `search` skill groups auto-activate after `open_project`

If a tool you expect isn't available, check which skills are active and activate the appropriate group.

## Claude doesn't see scrivener-mcp

**Restart Claude Desktop** after installation or configuration changes. The MCP server list is only read at startup.

**Check the config file location:**

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**Run the setup wizard** to auto-detect and configure your client:

```bash
npx scrivener-setup
```

The wizard detects Claude Desktop, Claude Code, and Cursor automatically.

**Verify the connection** by asking Claude:

> "What tools do you have?"

or

> "What Scrivener tools do you have?"

You should see at least six tools: `open_project`, `get_structure`, `refresh_project`, `close_project`, `list_skills`, and `use_skill`.

**Related issues:** [#2](https://github.com/writerslogic/scrivener-mcp/issues/2)

## Semantic search returns no results

- Documents must be opened/read at least once to be indexed in the vector store
- The JavaScript fallback engine builds its index in memory per session -- it starts empty
- Try opening the project and reading a few documents before searching
- Full-text search (`search_project`) works immediately without indexing; semantic search (`semantic_search`) requires the vector index

## AI-powered features don't work

AI-powered features (deep analysis, content enhancement, critique) require an API key. The server checks multiple locations automatically:

1. `OPENAI_API_KEY` environment variable
2. `~/.env` file
3. `~/.scrivener-mcp/.env` file
4. `~/.openai/key` file
5. macOS Keychain (macOS only)

To set manually:

```bash
export OPENAI_API_KEY=sk-...
```

Or in your MCP client config:

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "npx",
      "args": ["scrivener-mcp"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

Core features (read, write, search, structure, metadata, analysis) work without any API key. Only AI-enhanced features require one.

## "HHM system not initialized"

The Holographic Memory System (semantic search, analogies, dream mode) requires the optional `holographic-memory` Rust binary. All other features work without it. This message is expected if you installed from npm without building the native module.

## Neo4j connection errors

Neo4j is entirely optional. All features except story structure graph analysis work without it.

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
