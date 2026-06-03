# Getting Started

## Prerequisites

- **Node.js 18+** -- check with `node -v`
- **Scrivener 3** -- the project must be a Scrivener 3 `.scriv` package
- **An MCP client** -- Claude Desktop, Claude Code, or any MCP-compatible client

## Installation

```bash
npm install -g scrivener-mcp
```

The installer automatically configures Claude Desktop. Restart Claude Desktop after installation.

## Verifying the Installation

After restarting Claude Desktop, ask Claude:

> "What MCP tools do you have available?"

You should see tools like `open_project`, `read_document`, `get_structure`, etc.

## Opening a Project

Ask Claude to open your Scrivener project by providing the path to the `.scriv` package:

> "Open my project at /Users/me/Documents/MyNovel.scriv"

On macOS, a `.scriv` project is a package directory. On Windows, it's a regular folder. The server finds the `.scrivx` file inside automatically.

## Your First Workflow

Once a project is open:

1. **Browse the structure** -- "Show me the project structure"
2. **Read a document** -- "Read the first chapter" (Claude will find the right document)
3. **Analyze writing** -- "Analyze this chapter for writing quality"
4. **Make improvements** -- "Strengthen the verbs in this chapter"
5. **Save** -- Changes are saved automatically when you write, but you can explicitly save with "Save the project"

## Configuration

### Claude Desktop

The installer writes to `claude_desktop_config.json`. If you need to configure manually:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging verbosity (DEBUG, INFO, WARN, ERROR) | INFO |
| `SCRIVENER_SKIP_SETUP` | Skip first-run setup | false |
| `OPENAI_API_KEY` | OpenAI API key (for AI features) | none |
| `ANTHROPIC_API_KEY` | Anthropic API key (for AI features) | none |

AI API keys are optional. All core Scrivener operations work without them. AI-powered features (analysis, enhancement, critique) use them when available.

### Optional Setup Wizard

```bash
npx scrivener-mcp setup
```

The wizard walks through configuring AI providers, database options, and advanced features interactively.

## Project Data Storage

The server stores data within your Scrivener project package:

```
MyNovel.scriv/
  MyNovel.scrivx          # Scrivener project file
  Files/                   # Scrivener document files
  .scrivener-databases/    # SQLite database (writing stats, analysis history)
  .ai-memory/              # Character profiles, plot threads, style guide
```

All data travels with the project and persists between sessions. Nothing is stored globally.

## Troubleshooting

**"No project is currently open"** -- You need to call `open_project` first with the path to your `.scriv` package.

**JSON parse errors in Claude Desktop** -- Make sure you're on v0.4.0+. Earlier versions had a bug where logs corrupted the protocol stream.

**"HHM system not initialized"** -- The Holographic Memory System requires the optional `@hms/native` Rust binary. Core features work without it.

**Tool results seem empty** -- Make sure you're on v0.4.0+. Earlier versions attached data in a non-standard field that MCP clients silently dropped.

## Next Steps

- [Tool Reference](./tool-reference.md) -- complete documentation for every tool
- [Writing with AI](./writing-with-ai.md) -- guide to using analysis and enhancement features
- [Architecture](./architecture.md) -- how the server works internally
