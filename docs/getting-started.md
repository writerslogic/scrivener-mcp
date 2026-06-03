# Getting Started

This guide walks you through installing scrivener-mcp, connecting it to Claude, and working with your first Scrivener project.

## Prerequisites

- **Node.js 18 or later** -- check with `node -v`
- **Scrivener 3** -- your project must be a Scrivener 3 `.scriv` package
- **An MCP client** -- Claude Desktop, Claude Code, or any MCP-compatible client

## Installation

```bash
npm install -g scrivener-mcp
```

The installer automatically detects Claude Desktop and writes the MCP configuration for you. Restart Claude Desktop after installation.

### Manual Configuration

If the automatic setup didn't work, or you're using a different MCP client, add scrivener-mcp to your client's configuration file.

**Claude Desktop** config locations:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

You can also run the interactive setup wizard:

```bash
npx scrivener-mcp setup
```

## Verifying the Connection

After restarting Claude Desktop, ask:

> "What Scrivener tools do you have?"

Claude should list tools like `open_project`, `read_document`, `get_structure`, and many others. If you don't see them, check the troubleshooting section below.

## Opening Your First Project

Tell Claude the path to your `.scriv` project:

> "Open my novel at /Users/me/Documents/MyNovel.scriv"

On macOS, a `.scriv` project appears as a single file in Finder but is actually a directory. On Windows, it shows as a normal folder. Either way, point to the top-level `.scriv` directory -- the server finds the `.scrivx` file inside automatically.

Once the project is open, it stays open for the duration of your conversation. You don't need to reopen it between tool calls.

## Working with Your Project

### Exploring the structure

> "Show me the project structure"

Claude calls `get_structure` and returns your binder hierarchy -- Draft, Research, Trash, and everything inside them. Each document has a UUID that other tools use to identify it.

You don't need to memorize UUIDs. Just describe what you want and Claude will find the right document:

> "Read the chapter called 'The Storm'"

### Reading and writing

> "Read the first scene in chapter 2"

Claude retrieves the document content as plain text. To see formatting:

> "Read chapter 1 with formatting preserved"

To edit:

> "Write this revised version to the document: [your text]"

Changes are written immediately to the Scrivener project file. Scrivener will see them the next time it reloads or syncs the project.

### Synopses and notes

Every document in Scrivener has a synopsis (the index card text) and notes. You can read and write both:

> "What's the synopsis for chapter 3?"

> "Update the synopsis for chapter 3: Elizabeth arrives at Pemberley and encounters Darcy unexpectedly."

To update many documents at once:

> "Set synopses for all the chapters in Part 1 based on their content."

Claude will read each chapter, generate a synopsis, and batch-update them.

### Searching

> "Search for all mentions of 'lighthouse' in the manuscript"

This searches document content across the entire project (excluding trash). You can also search just the trash:

> "Search the trash for documents about the deleted subplot"

### Metadata

> "Set the label for chapter 5 to 'Revised' and the status to 'Final Draft'"

You can also set custom metadata fields:

> "Add custom metadata to chapter 5: deadline = June 15, reviewer = Sarah"

## Project Memory

The server maintains persistent memory within your Scrivener project. This data is stored in a `.ai-memory` folder inside the `.scriv` package, so it travels with the project.

### What gets remembered

- **Character profiles** -- names, roles, traits, arcs, relationships
- **Plot threads** -- storylines with status and chapter ranges
- **Style guide** -- tone, voice, POV, tense preferences
- **Writing statistics** -- session logs, word counts, productivity metrics
- **Custom context** -- any key-value data you want to persist

### Setting up memory

At the start of a project, tell Claude about your characters and style:

> "Save a character profile for Marcus: he's the protagonist, a retired detective in his 60s, gruff but compassionate, his arc is about reconnecting with his estranged daughter."

> "Set the style guide: literary fiction, third-person limited, past tense, measured pacing, sparse dialogue."

Claude references this memory when analyzing your writing, making suggestions, and applying enhancements. It's worth spending a few minutes setting this up early -- it makes all the AI features more accurate.

## Where Data is Stored

Everything lives inside your Scrivener project package:

```
MyNovel.scriv/
  MyNovel.scrivx              # Scrivener's project file (XML)
  Files/Data/                  # Your document files (RTF)
  .scrivener-databases/        # SQLite (writing stats, analysis history)
  .ai-memory/                  # Character profiles, plot threads, style guide
```

Nothing is stored globally or sent to external servers. If you move, copy, or share the `.scriv` package, the AI memory comes with it. If you delete the `.ai-memory` folder, you lose the AI context but your Scrivener project is unaffected.

## Environment Variables

These are all optional:

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging verbosity (`DEBUG`, `INFO`, `WARN`, `ERROR`) | `INFO` |
| `SCRIVENER_SKIP_SETUP` | Skip first-run initialization | `false` |
| `OPENAI_API_KEY` | OpenAI key for AI-powered features | none |
| `ANTHROPIC_API_KEY` | Anthropic key for AI-powered features | none |

All core Scrivener operations (read, write, search, structure, metadata) work without any API keys. The AI-powered features (deep analysis, content enhancement, critique) use them when available and fall back to local heuristics when they're not.

## Troubleshooting

**"No project is currently open"**
You need to open a project first. Tell Claude the path to your `.scriv` file.

**JSON parse errors or "Expected ',' or ']'"**
You're running an older version. Update to v0.4.0+ (`npm update -g scrivener-mcp`). Earlier versions had a bug where log output corrupted the MCP protocol stream.

**Tool results seem empty or Claude says "I don't have that information"**
Also a pre-v0.4.0 bug. The server was attaching data in a way that MCP clients couldn't read. Update to the latest version.

**"HHM system not initialized"**
The Holographic Memory System (semantic search, analogies, dream mode) requires the optional `@hms/native` Rust binary. All other features work without it. This is expected if you installed from npm without building the native module.

**Scrivener shows old content after writing**
Scrivener caches document content in memory. Close and reopen the project in Scrivener, or switch away from the modified document and back, to see changes made by the MCP server.

**Changes aren't saved**
The server writes changes to disk immediately when you use `write_document` or `update_metadata`. If you want to be certain, ask Claude to "save the project" which explicitly flushes all pending changes.

## Next Steps

- [Writing with AI](./writing-with-ai.md) -- analysis, enhancement, memory, and semantic search
- [Architecture](./architecture.md) -- how the server works internally
- [Contributing](./contributing.md) -- development setup and how to add features
