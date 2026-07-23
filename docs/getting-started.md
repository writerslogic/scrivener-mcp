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

The installer automatically configures **Claude Desktop** only, then restart Claude Desktop. **Claude Code** and other clients are not configured by the install step -- run `npx scrivener-setup` (below) or add the server manually.

### Manual Configuration

If the automatic setup didn't work, or you're using a different MCP client, add scrivener-mcp to your client's configuration file. See **[MCP Client Setup](./CLIENT_SETUP.md)** for tested, copy-paste snippets for Claude Desktop, Claude Code, Cursor, and VS Code (Copilot), including config file paths and verification steps.

You can also run the interactive setup wizard:

```bash
npx scrivener-setup
```

The setup wizard detects Claude Desktop, Claude Code, and Cursor automatically.

### Other install methods

```bash
# Smithery
npx -y @smithery/cli install scrivener-mcp --client claude

# Direct from GitHub
npm install -g writerslogic/scrivener-mcp
```

### Docker

```bash
docker build -t scrivener-mcp https://github.com/writerslogic/scrivener-mcp.git
docker run -i --rm -v /path/to/projects:/projects scrivener-mcp
```

Mount your Scrivener projects directory so the server can access them. Inside the container, your projects will be available under `/projects`.

## Verifying the Connection

After restarting Claude Desktop, ask:

> "What Scrivener tools do you have?"

Claude should list ten tools: the `project` skill (`open_project`, `get_structure`, `refresh_project`, `close_project`, `discover_projects`, `detect_open_project`, `verify_project_integrity`, `get_compile_settings`) plus two meta-tools (`list_skills`, `use_skill`). If you don't see the startup tools, check the troubleshooting section below.

### How skills activate

The server uses progressive tool loading to keep conversations fast by only loading what you need. If the model calls a tool whose skill is not active yet, the server activates that skill on the fly, so a valid call never dead-ends:

1. **At startup:** the `project` skill (`open_project`, `get_structure`, `refresh_project`, `close_project`, `discover_projects`, `detect_open_project`, `verify_project_integrity`, `get_compile_settings`, `get_manuscript_briefing`, `list_snapshots`, `read_snapshot`, `compare_snapshot`) plus `list_skills` and `use_skill`.
2. **After opening a project:** the `documents` and `search` skills auto-activate, adding read, write, create, delete, move, rename, search, and find tools (roughly 18 more tools).
3. **On demand:** say "activate analysis tools" or Claude calls `use_skill("analysis")` to load additional skill groups. Available on-demand skills:
   - **analysis** -- writing quality, pacing, style, critique, character consistency
   - **compilation** -- compile manuscripts, export, statistics
   - **memory** -- semantic search, analogies, dream mode (HMS)
   - **advanced** -- fractal memory, async job queue, batch operations

You can see all available skills and which are active by asking Claude to call `list_skills`.

## Opening Your First Project

Tell Claude the path to your `.scriv` project:

> "Open my novel at /Users/me/Documents/MyNovel.scriv"

On macOS, a `.scriv` project appears as a single file in Finder but is actually a directory. On Windows, it shows as a normal folder. Either way, point to the top-level `.scriv` directory -- the server finds the `.scrivx` file inside automatically.

**Windows paths** work natively -- no escaping or conversion needed:

> "Open my novel at C:\Users\me\Documents\MyNovel.scriv"

The server handles case-insensitive `.scrivx` file discovery, which is important for projects moved between Mac and Windows (where the filename casing may differ). You can pass either the `.scriv` folder or the `.scrivx` file directly.

Once the project is open, it stays open for the duration of your conversation. You don't need to reopen it between tool calls.

## Working with Your Project

### Exploring the structure

> "Show me the project structure"

Claude calls `get_structure` and returns your binder hierarchy in a compact format -- each entry shows the ID, title, type, and depth. Each document has a UUID that other tools use to identify it.

You can also search for documents by title without browsing the full tree:

> "Find the document called 'The Storm'"

This uses `search` with `field: "title"`, which matches against document titles (case-insensitive) and returns matching documents with each document's ID, title, type, and path.

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

## Semantic Search

Semantic search, analogies, and dream mode work out of the box without installing any native binary. A built-in JavaScript vector engine handles this automatically using TF-IDF with cosine similarity. You can search by meaning, find analogical relationships between concepts, and use dream mode to surface unexpected connections across your manuscript -- all with zero configuration.

If the optional `holographic-memory` package is installed, the server transparently upgrades to a faster Rust-based engine. You do not need to change any settings or commands; the upgrade is automatic. Most users will never need the native engine -- the JS fallback is fast enough for typical novel-length projects.

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

### API key auto-discovery

You do not need to manually export your OpenAI key in most cases. The server automatically checks the following locations, in order:

1. The `OPENAI_API_KEY` environment variable (standard `export`)
2. `~/.env`
3. `~/.scrivener-mcp/.env`
4. `~/.config/openai/key`
5. `~/.openai/key`
6. **macOS Keychain** (looks for a generic password with service name `openai-api-key`)

To store your key in the macOS Keychain:

```bash
security add-generic-password -s openai-api-key -a openai -w sk-your-key-here
```

If none of these locations contain a key, you can always fall back to a manual export:

```bash
export OPENAI_API_KEY="sk-..."
```

## Optional: Neo4j

Neo4j enables character relationship graphs and story structure analysis. It is completely optional -- all other features work without it.

To install:

```bash
# macOS
brew install neo4j

# Other platforms: download from https://neo4j.com/download/
```

Set the following environment variables to connect:

| Variable | Description |
|----------|-------------|
| `NEO4J_URI` | Connection URI (e.g., `bolt://localhost:7687`) |
| `NEO4J_USER` | Neo4j username |
| `NEO4J_PASSWORD` | Neo4j password |

Neo4j is optional. The relationship tools (`add_relationship`, `find_relationships`, `discover_connections`, `character_network`) work without it -- relationships are stored in the Holographic Memory System and available immediately. Connecting Neo4j adds advanced graph analysis (PageRank, shortest path, communities).

## Troubleshooting

**"No project is currently open"**
You need to open a project first. Tell Claude the path to your `.scriv` file.

**JSON parse errors or "Expected ',' or ']'"**
You're running an older version. Update to v0.4.0+ (`npm update -g scrivener-mcp`). Earlier versions had a bug where log output corrupted the MCP protocol stream.

**Tool results seem empty or Claude says "I don't have that information"**
Also a pre-v0.4.0 bug. The server was attaching data in a way that MCP clients couldn't read. Update to the latest version.

**"HHM system not initialized"**
The Holographic Memory System (semantic search, analogies, dream mode) works with a built-in JS engine by default. This error means the HMS has not been loaded yet -- activate the memory skill with `use_skill("memory")` or ask Claude to do so. If `holographic-memory` is installed, it uses the faster Rust engine automatically, but the native module is not required.

**Scrivener shows old content after writing**
Scrivener caches document content in memory. Close and reopen the project in Scrivener, or switch away from the modified document and back, to see changes made by the MCP server.

**Changes aren't saved**
The server writes changes to disk immediately when you use `write_document` or `update_document`. If you want to be certain, ask Claude to "save the project" which explicitly flushes all pending changes.

## Next Steps

- [Writing with AI](./writing-with-ai.md) -- analysis, enhancement, memory, and semantic search
- [Architecture](./architecture.md) -- how the server works internally
- [Contributing](./contributing.md) -- development setup and how to add features

## More Resources

- [Troubleshooting](./troubleshooting.md) -- solutions for JSON parse errors, project opening issues, missing tools, and other common problems
- [Token Optimization](./token-optimization.md) -- how the server minimizes context window usage with progressive loading, compact responses, and sliding window reads

## License

Scrivener MCP is licensed under AGPL-3.0 for personal and open-source use. Commercial license available for proprietary integration. See [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md).
