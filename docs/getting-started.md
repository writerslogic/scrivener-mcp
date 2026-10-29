# Getting Started

This guide walks you through installing scrivener-mcp, connecting it to Claude, and working with
your first Scrivener project.

## Prerequisites

- **Stable Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`** -- check with `node -v`; 24.22.1 or newer
  on Node 24 is recommended
- **Scrivener 3** -- your project must be a Scrivener 3 `.scriv` package
- **An MCP client** -- Claude Desktop, Claude Code, or any MCP-compatible client

The pinned CAI native SDK requires these patched releases for its Node TLS paths, in addition to
SQLite 13's Node-API 10 requirement. Node 23/25 and older patches on 22/24/26 are rejected. See the
[runtime policy](forward-compatibility.md#runtime-and-dependency-changes).

## Installation

```bash
npm install -g scrivener-mcp
```

The installer automatically configures **Claude Desktop** only, then restart Claude Desktop.
**Claude Code** and other clients are not configured by the install step -- run
`npx --package scrivener-mcp scrivener-setup` (below) or add the server manually.

### Manual Configuration

If the automatic setup didn't work, or you're using a different MCP client, add scrivener-mcp to
your client's configuration file. See **[MCP Client Setup](./CLIENT_SETUP.md)** for tested,
copy-paste snippets for Claude Desktop, Claude Code, Cursor, and VS Code (Copilot), including config
file paths and verification steps.

You can also run the interactive setup wizard:

```bash
npx --package scrivener-mcp scrivener-setup
```

The setup tool detects Claude Desktop, Claude Code, Cursor, VS Code, LM Studio, and BoltAI
automatically, opens Raycast's install dialog, and runs a start-up test. New to the terminal or
missing Node.js? Follow the [Mac install guide](./install-mac.md).

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

Mount your Scrivener projects directory so the server can access them. Inside the container, your
projects will be available under `/projects`.

## Verifying the Connection

After restarting Claude Desktop, ask:

> "What Scrivener tools do you have?"

Claude should list 16 startup tools: the 14 tools in the `project` skill plus two meta-tools
(`list_skills`, `use_skill`). If you don't see the startup tools, check the troubleshooting section
below.

### How skills activate

The server uses progressive tool loading to keep conversations fast by only loading what you need.
If the model calls a tool whose skill is not active yet, the server activates that skill on the fly,
so a valid call never dead-ends:

1. **At startup:** the `project` skill (`open_project`, `get_structure`, `refresh_project`,
   `close_project`, `discover_projects`, `detect_open_project`, `verify_project_integrity`,
   `get_compile_settings`, `get_manuscript_briefing`, `list_snapshots`, `read_snapshot`,
   `compare_snapshot`, `create_snapshot`, `manuscript_dashboard`) plus `list_skills` and
   `use_skill`.
2. **After opening a project:** the `documents` and `search` skills auto-activate, adding read,
   write, create, delete, move, local passage search and review tools.
3. **On demand:** say "activate analysis tools" or Claude calls `use_skill` with
   `{"name":"analysis"}` to load additional skill groups. Available on-demand skills:
    - **analysis** -- writing quality, pacing, style, critique, character consistency
    - **compilation** -- compile manuscripts, export, statistics
    - **credentials** -- inspect local C2PA capabilities, sign assets, validate Content Credentials
    - **memory** -- persistent project facts and local HMS-backed memory
    - **advanced** -- fractal memory, async job queue, batch operations

You can see all available skills and which are active by asking Claude to call `list_skills`.

### Content Credentials for exports

Activate `credentials` with `use_skill` and `{"name":"credentials"}`, then call `c2pa_capabilities`
with `{}`. The group exposes `c2pa_capabilities`, `sign_content_credentials` and
`validate_content_credentials` without opening a project.

To credential a manuscript, open the project, export a PDF with `export_project` or use an
`export_manuscript` preset, then sign the saved file to an explicit new output path. Validate the
signed output for embedded mode, or validate the original asset with `manifestPath` for a supported
detached sidecar. PDF, MP3, FLAC, DOCX and EPUB use embedded mode with the pinned SDK; their
sidecars are unsupported. DOCX/EPUB preparation preserves ZIP entry payloads in a separate STORE
copy and records the original SHA-256; it does not change the source export.

Signing requires administrator-provided certificates and an encrypted private key; never pass a key
or password in tool arguments. Raw reports are omitted unless `includeReport` is true. Validation
separates integrity from trust and makes no human-authorship or formal-conformance claim. See
[Content Credentials](content-credentials.md) for the exact workflow, environment variables,
compressed-manifest coverage and per-format evidence.

## Opening Your First Project

Tell Claude the path to your `.scriv` project:

> "Open my novel at /Users/me/Documents/MyNovel.scriv"

On macOS, a `.scriv` project appears as a single file in Finder but is actually a directory. On
Windows, it shows as a normal folder. Either way, point to the top-level `.scriv` directory -- the
server finds the `.scrivx` file inside automatically.

**Windows paths** work natively -- no escaping or conversion needed:

> "Open my novel at C:\Users\me\Documents\MyNovel.scriv"

The server handles case-insensitive `.scrivx` file discovery, which is important for projects moved
between Mac and Windows (where the filename casing may differ). You can pass either the `.scriv`
folder or the `.scrivx` file directly.

Once the project is open, it stays open for the duration of your conversation. You don't need to
reopen it between tool calls.

## Working with Your Project

### Exploring the structure

> "Show me the project structure"

Claude calls `get_structure` and returns your binder hierarchy in a compact format -- each entry
shows the ID, title, type, and depth. Each document has a UUID that other tools use to identify it.

You can also search for documents by title without browsing the full tree:

> "Find the document called 'The Storm'"

This uses `search` with `field: "title"`, which matches against document titles (case-insensitive)
and returns matching documents with each document's ID, title, type, and path.

You don't need to memorize UUIDs. Just describe what you want and Claude will find the right
document:

> "Read the chapter called 'The Storm'"

### Reading and writing

> "Read the first scene in chapter 2"

Claude retrieves the document content as plain text. To see formatting:

> "Read chapter 1 with formatting preserved"

To edit:

> "Write this revised version to the document: [your text]"

Changes are written immediately to the Scrivener project file. Scrivener will see them the next time
it reloads or syncs the project.

### Synopses and notes

Every document in Scrivener has a synopsis (the index card text) and notes. You can read and write
both:

> "What's the synopsis for chapter 3?"

> "Update the synopsis for chapter 3: Elizabeth arrives at Pemberley and encounters Darcy
> unexpectedly."

To update many documents at once:

> "Set synopses for all the chapters in Part 1 based on their content."

Claude will read each chapter, generate a synopsis, and batch-update them.

### Searching

> "Search for all mentions of 'lighthouse' in the manuscript"

This searches document content across the entire project (excluding trash). You can also search just
the trash:

> "Search the trash for documents about the deleted subplot"

### Metadata

> "Set the label for chapter 5 to 'Revised' and the status to 'Final Draft'"

You can also set custom metadata fields:

> "Add custom metadata to chapter 5: deadline = June 15, reviewer = Sarah"

## Semantic Search

Holographic Memory 0.6.4 is installed with the server and selects the published native binary for
your platform. Passage search combines BM25 with local story-concept vectors and returns exact
quotations, source locations and saved revisions. `search_passages` and `semantic_search` work
without an API key; provider-assisted interpretation and explanations are optional.

Conceptual matching covers a bounded English story vocabulary, not a downloaded language model. Use
keyword mode for unfamiliar names or concepts. No model is downloaded and no external embedding
service receives manuscript text. A JavaScript BM25/concept-vector fallback remains available when
the native binding is unavailable or another server owns the native cache. Set
`SCRIVENER_HMS_ENGINE=fallback` to select it explicitly.

## Project Memory

The server maintains persistent memory within your Scrivener project. This data is stored in a
`.ai-memory` folder inside the `.scriv` package, so it travels with the project.

### What gets remembered

- **Character profiles** -- names, roles, traits, arcs, relationships
- **Plot threads** -- storylines with status and chapter ranges
- **Style guide** -- tone, voice, POV, tense preferences
- **Writing statistics** -- session logs, word counts, productivity metrics
- **Custom context** -- any key-value data you want to persist

### Setting up memory

At the start of a project, tell Claude about your characters and style:

> "Save a character profile for Marcus: he's the protagonist, a retired detective in his 60s, gruff
> but compassionate, his arc is about reconnecting with his estranged daughter."

> "Set the style guide: literary fiction, third-person limited, past tense, measured pacing, sparse
> dialogue."

Claude references this memory when analyzing your writing, making suggestions, and applying
enhancements. It's worth spending a few minutes setting this up early -- it makes all the AI
features more accurate.

## Where Data is Stored

Everything lives inside your Scrivener project package:

```
MyNovel.scriv/
  MyNovel.scrivx              # Scrivener's project file (XML)
  Files/Data/                  # Your document files (RTF)
  .scrivener-databases/        # SQLite (writing stats, analysis history)
  .ai-memory/                  # Character profiles, plot threads, style guide
```

Project memory and Scrivener data remain in the `.scriv` package by default. Deterministic tools and
HMS indexing/scoring do not send manuscript text to an external embedding service. Provider-backed
analysis, generation, enhancement, semantic-query interpretation/explanations, and MCP sampling can
send the relevant prompt and document excerpts to the configured provider or MCP client model. If
you move, copy, or share the `.scriv` package, its AI memory comes with it. If you delete the
`.ai-memory` folder, you lose that AI context but the Scrivener project itself remains intact.

## Environment Variables

These are all optional:

| Variable               | Description                                                                      | Default                         |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| `LOG_LEVEL`            | Logging verbosity (`DEBUG`, `INFO`, `WARN`, `ERROR`)                             | `INFO`                          |
| `SCRIVENER_SKIP_SETUP` | Skip first-run initialization                                                    | `false`                         |
| `ANTHROPIC_API_KEY`    | Anthropic (Claude) key for AI-powered features                                   | none                            |
| `OPENAI_API_KEY`       | OpenAI key for provider-backed AI features                                       | none                            |
| `OPENROUTER_API_KEY`   | OpenRouter key for AI-powered features                                           | none                            |
| `AI_PROVIDER`          | Chat provider when several keys are set (`anthropic`, `openai`, or `openrouter`) | `anthropic` when its key exists |
| `OPENROUTER_MODEL`     | Model id used via OpenRouter                                                     | `anthropic/claude-sonnet-4.6`   |

All core Scrivener operations (read, write, keyword search, structure, metadata), deterministic
analysis, project memory, and HMS indexing/scoring work without API keys. Provider-backed deep
analysis, content enhancement, critique, generation, and the current `semantic_search` query
pipeline use a configured provider. Chat and generation prefer Claude when `ANTHROPIC_API_KEY` is
set, and supported tools can also run through the MCP client's model with no separately configured
key when the client supports sampling.

### API key auto-discovery

You do not need to manually export your key in most cases. The server automatically checks the
following locations for each provider, in order:

1. The `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` environment variables (standard
   `export`)
2. `~/.env`
3. `~/.scrivener-mcp/.env`
4. `~/.config/anthropic/key` / `~/.config/openai/key` / `~/.config/openrouter/key`
5. `~/.anthropic/key` / `~/.openai/key` / `~/.openrouter/key`
6. **macOS Keychain** (generic passwords with service names `anthropic-api-key` / `openai-api-key` /
   `openrouter-api-key`)

To store a key in the macOS Keychain:

```bash
security add-generic-password -s anthropic-api-key -a anthropic -w sk-ant-your-key-here
security add-generic-password -s openai-api-key -a openai -w sk-your-key-here
```

If none of these locations contain a key, you can always fall back to a manual export:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY="sk-..."
```

## Optional: Neo4j

Neo4j adds persistent graph storage and advanced relationship queries. It is completely optional;
the public relationship, character-network, and document-reference tools work without it.

To install:

```bash
# macOS
brew install neo4j

# Other platforms: download from https://neo4j.com/download/
```

Set the following environment variables to connect:

| Variable         | Description                                    |
| ---------------- | ---------------------------------------------- |
| `NEO4J_URI`      | Connection URI (e.g., `bolt://localhost:7687`) |
| `NEO4J_USER`     | Neo4j username                                 |
| `NEO4J_PASSWORD` | Neo4j password                                 |

Neo4j is optional. The relationship tools (`add_relationship`, `find_relationships`,
`discover_connections`, `character_network`) work without it -- relationships are stored in the
Holographic Memory System and available immediately. Connecting Neo4j adds advanced graph analysis
(PageRank, shortest path, communities).

## Troubleshooting

**"No project is currently open"** You need to open a project first. Tell Claude the path to your
`.scriv` file.

**JSON parse errors or "Expected ',' or ']'"** You're running an older version. Update to v0.4.0+
(`npm update -g scrivener-mcp`). Earlier versions had a bug where log output corrupted the MCP
protocol stream.

**Tool results seem empty or Claude says "I don't have that information"** Also a pre-v0.4.0 bug.
The server was attaching data in a way that MCP clients couldn't read. Update to the latest version.

**"HMS system not initialized"** The Holographic Memory System has a built-in JavaScript fallback.
This error usually means no project is open or the memory/index layer has not initialized yet. Open
a project, then activate the memory skill with `use_skill("memory")` or ask the client to do so. If
the native binding is available, the server uses it automatically; the local JavaScript fallback
does not require a native binary.

**Scrivener shows old content after writing** Scrivener caches document content in memory. Close and
reopen the project in Scrivener, or switch away from the modified document and back, to see changes
made by the MCP server.

**Changes aren't saved** The server writes changes to disk immediately when you use `write_document`
or `update_document`. If you want to be certain, ask Claude to "save the project" which explicitly
flushes all pending changes.

## Next Steps

- [Writing with AI](./writing-with-ai.md) -- analysis, enhancement, memory, and semantic search
- [Architecture](./architecture.md) -- how the server works internally
- [Contributing](./contributing.md) -- development setup and how to add features

## More Resources

- [Troubleshooting](./troubleshooting.md) -- solutions for JSON parse errors, project opening
  issues, missing tools, and other common problems
- [Token Optimization](./token-optimization.md) -- how the server minimizes context window usage
  with progressive loading, compact responses, and sliding window reads

## License

Scrivener MCP is licensed under AGPL-3.0 for personal and open-source use. Commercial license
available for proprietary integration. See [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md).

## First successful editorial session

The public server provides persistent edit review, source-backed continuity, an optional MCP Apps
dashboard, local passage retrieval, an explicitly scoped series bible, durable editorial workflows
and export presets. No paid application is required. See
[editorial workflows](editorial-workflows.md) and [export coverage](export-presets.md).

Run `scrivener-setup --demo` after installation. It starts the actual MCP server in a new sample
copy, runs a real local analysis, persists a proposed edit and verifies that preview leaves the
sample manuscript unchanged. It changes no client configuration. Use the printed sample path with
`open_project` in your client, then call `manuscript_dashboard` or ask “Review this chapter.” Keep
the sample until you are ready to use your own project.

For an unpublished checkout, run `npm ci`, `npm run build`, then:

```bash
node dist/cli/setup.js --demo --node "$(command -v node)" --script "$PWD/dist/index.js"
```

On Windows, follow the [PowerShell installation path](install-windows.md). The sample is original
CC0 material under `assets/sample-project`; the fixture license is included in the package. Existing
destination directories are refused. Tests and demos never configure the developer's actual client
or edit an original manuscript.

## Provider and privacy choices

Local passage retrieval, continuity comparisons, the bible, pacing, review/undo, workflows and
exports work without a provider key. Search uses a bounded English story-concept vocabulary with
explicit coverage limits; it is not a general pretrained embedding model. Provider-supported writing
interpretation remains optional through existing AI tools and client conversation.

Set `SCRIVENER_LOCAL_ONLY=true` in the MCP server environment to disable provider requests, provider
key discovery and client sampling. Otherwise explicit keys or the existing key-discovery paths can
enable Anthropic, OpenAI or OpenRouter, and a sampling-capable client can supply its model. Such
calls can send selected manuscript text to that provider/client and may incur charges. Client chat
subscriptions are separate from server-side workflow costs. `SCRIVENER_DISABLE_KEY_DISCOVERY=1`
disables automatic key discovery while allowing explicit keys.

`SCRIVENER_DATA_DIR` selects the server's local series registry directory (default
`~/.scrivener-mcp`). Only explicitly joined projects contribute series facts. Per-project review
history, source evidence and workflow checkpoints live in `.scrivener-mcp/editorial.sqlite`; back up
that directory with the manuscript. Do not delete it as though it were only a cache.
`scrivener-setup --check --json` emits redacted diagnostics without changing client configuration.

All reads concern saved files. Close the project in Scrivener before applying edits. Ambiguous
native detection requires explicit acknowledgment; revisions and server-instance conflicts remain
enforced even with `force: true`. The server cannot read unsaved native buffers or guarantee safe
simultaneous native/server writes.
