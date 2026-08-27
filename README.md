<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/assets/logo-white.svg"/>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/assets/logo-black.svg"/>
    <img src="https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/assets/logo-black.svg" alt="Scrivener MCP Logo" width="200"/>
  </picture>
</p>

<h1 align="center">Scrivener MCP</h1>

<p align="center">
  <strong>Connect your Scrivener projects to Claude, ChatGPT, and other AI assistants</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/scrivener-mcp">
    <img src="https://img.shields.io/npm/v/scrivener-mcp.svg" alt="npm version"/>
  </a>
  <img src="https://img.shields.io/npm/dm/scrivener-mcp.svg" alt="npm downloads"/>
  <a href="https://github.com/writerslogic/scrivener-mcp/actions">
    <img src="https://github.com/writerslogic/scrivener-mcp/actions/workflows/ci.yml/badge.svg" alt="build"/>
  </a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/writerslogic/scrivener-mcp"><img src="https://api.securityscorecards.dev/projects/github.com/writerslogic/scrivener-mcp/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://www.bestpractices.dev/projects/13976"><img src="https://www.bestpractices.dev/projects/13976/badge" alt="OpenSSF Best Practices"></a>
  <a href="https://github.com/writerslogic/scrivener-mcp/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/writerslogic/scrivener-mcp" alt="license"/>
  </a>
  <img src="https://img.shields.io/node/v/scrivener-mcp" alt="node version"/>
  <a href="https://github.com/writerslogic/scrivener-mcp/issues">
    <img src="https://img.shields.io/github/issues/writerslogic/scrivener-mcp" alt="issues"/>
  </a>
  <a href="https://github.com/writerslogic/scrivener-mcp">
    <img src="https://img.shields.io/github/stars/writerslogic/scrivener-mcp" alt="stars"/>
  </a>
  <a href="https://mseep.ai/app/writerslogic-scrivener-mcp">
    <img src="https://img.shields.io/badge/MseeP-verified-green.svg" alt="MseeP verified"/>
  </a>
  <a href="https://glama.ai/mcp/servers/writerslogic/scrivener-mcp">
    <img src="https://glama.ai/mcp/servers/writerslogic/scrivener-mcp/badges/score.svg" alt="scrivener-mcp MCP server score"/>
  </a>
</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#what-you-can-do">What You Can Do</a> &middot;
  <a href="#all-tools">All Tools</a> &middot;
  <a href="#guides">Guides</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

Scrivener MCP lets your AI assistant open, read, edit, analyze, and search your Scrivener projects directly. No copy-pasting. No exporting. Tell your assistant which project to open, and start working.

> **You:** Open my novel and analyze the pacing in Chapter 12.
>
> **Claude:** *Opens your .scriv project, reads Chapter 12, runs pacing analysis.*
> The first half moves well with short, tense paragraphs. The middle section slows
> considerably -- the three-page internal monologue starting at paragraph 14 stalls
> the momentum you built in the confrontation scene. Consider cutting it to a single
> paragraph and moving the backstory to Chapter 8 where Elena is first introduced.

Works with [Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), VS Code (Copilot/Continue), Cursor, and any MCP-compatible client. Scrivener 3 on macOS, Windows, and Linux. Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.writerslogic/scrivener-mcp`.

## Install

Pick the method that works for you. Most auto-configure **Claude Desktop** on install. **Claude Code** and other clients need one extra step -- see [Claude Code](#claude-code) below.

### npm (recommended)

```bash
npm install -g scrivener-mcp
```

Restart Claude Desktop. Done.

### Claude Code

Installing the npm package does **not** register the server with Claude Code -- the install-time auto-config only writes Claude Desktop's config. After installing, register the server:

```bash
npx scrivener-setup
```

This detects Claude Code (along with Claude Desktop and Cursor) and writes the config for you. To register it manually instead:

```bash
claude mcp add -s user scrivener -- npx scrivener-mcp
```

Then restart Claude Code (or run `/mcp` to reconnect) and Scrivener MCP appears in the server list. Drop `-s user` to scope it to the current project instead of all projects.

### Smithery

```bash
npx -y @smithery/cli install scrivener-mcp --client claude
```

### npx (no install)

Use directly without installing globally:

```bash
npx scrivener-mcp
```

Or add to your Claude Desktop config manually:

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

### GitHub

Install directly from the repo (latest main):

```bash
npm install -g writerslogic/scrivener-mcp
```

Or a specific release:

```bash
npm install -g writerslogic/scrivener-mcp#v0.12.0
```

### Homebrew (macOS)

```bash
brew install writerslogic/tap/scrivener-mcp
```

### Docker

```bash
docker build -t scrivener-mcp https://github.com/writerslogic/scrivener-mcp.git
docker run -i --rm -v /path/to/your/projects:/projects scrivener-mcp
```

<details>
<summary><strong>Setup for other MCP clients</strong></summary>

Run the interactive setup to auto-detect and configure your client:

```bash
npx scrivener-setup
```

This detects Claude Desktop, Claude Code, and Cursor, and writes the config for you.

For other MCP clients, point them at `npx scrivener-mcp` as a stdio server.

</details>

<details>
<summary><strong>Optional: AI-powered features</strong></summary>

Core features (document management, deterministic analysis, keyword search, and project memory) work without any API key. AI-powered analysis, generation, enhancement, and semantic search work with an Anthropic (Claude), OpenAI, or OpenRouter key; when several are present, Claude handles chat and generation (set `AI_PROVIDER=openai` or `AI_PROVIDER=openrouter` to override). OpenRouter defaults to the `anthropic/claude-sonnet-4.6` model; set `OPENROUTER_MODEL` to use another model in its catalog. If the active provider fails with an account-level error (invalid key, exhausted credit, outage), the server automatically retries the request on the next configured provider. When your MCP client supports the [sampling capability](https://modelcontextprotocol.io/docs/concepts/sampling), supported chat-based AI features can also run through the client's own model—with no separately configured API key. Semantic indexing and similarity scoring use the local Holographic Memory System rather than an external embedding API, while the current `semantic_search` pipeline uses the configured chat provider to interpret queries and explain results. The server automatically discovers keys from common locations:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` environment variables
- `~/.env`, `~/.scrivener-mcp/.env`
- `~/.anthropic/key`, `~/.openai/key`, `~/.openrouter/key`
- macOS Keychain (service names `anthropic-api-key` / `openai-api-key` / `openrouter-api-key`)

To store a key in the macOS Keychain:

```bash
security add-generic-password -s anthropic-api-key -a anthropic -w sk-ant-your-key-here
```

Or export it manually:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY="sk-..."
```

This enables provider-backed writing analysis, content enhancement, generation, semantic search, character consistency checking, and intelligent compilation.

</details>

## What You Can Do

> **First, open a project.** The server acts on whatever `.scriv` project you point it at -- it has no link to the Scrivener app and can't see what you have open there. Start a conversation with *"Open my Scrivener project at `~/Documents/My Novel.scriv`"* (or *"Discover my Scrivener projects"* if you don't know the path), then give your commands. On macOS you can also just say *"Use the project I have open in Scrivener"* -- it detects the open project and opens it (the first time, macOS asks you to allow controlling Scrivener). Do this once at the start of each conversation; the examples below all assume a project is open. If the same project is also open and unsaved in the Scrivener app, save or close it there first to avoid conflicting writes.

### Manage Your Manuscript

Open any Scrivener project and work with it naturally. Read chapters, create new scenes, reorganize the binder, update synopses -- all through conversation.

> **You:** Create a new scene called "The Reveal" after Chapter 5, and move the old epilogue to the trash.

### Analyze Your Writing

Get detailed feedback on readability, pacing, style, dialogue quality, and emotional arc. Not generic advice -- analysis grounded in your actual prose.

> **You:** Analyze Chapter 3. Is the pacing too slow?
>
> **Claude:** Readability is good (Flesch-Kincaid grade 8.2), but pacing flags:
> - 4 consecutive paragraphs of internal monologue (lines 45-78) with no action or dialogue
> - The scene is 3,200 words with only 2 scene breaks -- your other chapters average 4
> - Filter word density is 2x your manuscript average ("felt", "seemed", "noticed")
> Specific suggestions: ...

### Enhance Your Prose

Apply targeted improvements: eliminate filter words, strengthen verbs, vary sentence structure, add sensory details, convert telling to showing, tighten dialogue, adjust pacing.

> **You:** Eliminate the filter words in Chapter 7 and strengthen the verbs.

### Track Characters and Plot

Store character profiles, plot threads, and style guides that persist with your project. The AI remembers your characters across sessions.

> **You:** Save a character profile for Marcus: retired detective, cynical but fair, walks with a limp from an old injury, speaks in clipped sentences.
>
> *Later...*
>
> **You:** Check if Marcus is consistent across all chapters.
>
> **Claude:** Found an inconsistency: Marcus walks "briskly" in Chapter 9 (line 34), but his limp is referenced in Chapters 2, 5, and 11. Also, his dialogue in Chapter 4 uses long flowing sentences, which contradicts the "clipped sentences" note in his profile.

### Search by Meaning

Find passages by what they're about, not just keyword matching. "Find scenes where the protagonist feels isolated" works even if the word "isolated" never appears. The project index and similarity scoring run locally through the [Holographic Memory System](https://www.npmjs.com/package/holographic-memory); the current search pipeline also uses your configured AI provider for query interpretation and result explanations, so `semantic_search` requires a provider.

> **You:** Find all scenes where Elena and Marcus are alone together.

### Track Relationships

Store and query relationships between characters, locations, themes, and plot threads. No Neo4j required -- relationships live in the semantic memory engine and persist with your project.

> **You:** Who is connected to Marcus? What plot threads involve the lighthouse?

### Compile and Export

Combine chapters into a single manuscript with configurable formatting, separators, and structure preservation. Export the result inline as Markdown, HTML, or JSON, or write a DOCX, EPUB, or PDF file to disk for submission, e-readers, or print.

## All Tools

57 tools organized by workflow. To keep token usage low, tools load progressively -- project tools at startup, document and search tools when you open a project, and the rest on demand (your AI client activates them automatically, or calls them directly and the owning skill activates on the fly). Set `SCRIVENER_MCP_EAGER_TOOLS=1` to load everything at once.

<details>
<summary><strong>Project</strong> -- open, browse, manage</summary>

| Tool | What it does |
|------|-------------|
| `open_project` | Open a .scriv project (accepts .scriv folders or .scrivx files) and make it active |
| `discover_projects` | Scan common locations for Scrivener projects when you don't know the path |
| `detect_open_project` | Detect the project currently open in the Scrivener app (macOS) so you don't need a path |
| `get_structure` | Browse the binder hierarchy (folders, documents, word counts) |
| `refresh_project` | Reload from disk after external edits |
| `close_project` | Close the active project and flush pending changes |
| `verify_project_integrity` | Read-only scan for structural problems (missing/duplicate UUIDs, unreadable content) |
| `get_compile_settings` | Read the project's compile formats and taxonomy -- labels/statuses (with colors), collections, section types |
| `get_manuscript_briefing` | One "where am I?" snapshot: words vs. target (% to goal), document/status/label counts, longest/shortest documents |
| `list_snapshots` | List Scrivener snapshots (title, date) for one document or the whole project |
| `read_snapshot` | Read a snapshot's text as plain text, with word count |
| `compare_snapshot` | Diff a snapshot against the current document (or another snapshot): paragraphs added/removed and net word change |
| `create_snapshot` | Take a Scrivener-native snapshot of a document (restorable from Scrivener's own Snapshots browser) before editing |

</details>

<details>
<summary><strong>Documents</strong> -- read, write, create, organize</summary>

| Tool | What it does |
|------|-------------|
| `get_document_info` | Metadata for one document (title, type, word count, synopsis, label, status) |
| `read_document` | Read content; `format: "formatted"` for rich text, `offset`/`limit` to page long docs |
| `write_document` | Replace a document's content (atomic, with pre-write backup) |
| `create_document` | Create a new text document or folder |
| `update_document` | Change title and/or metadata (synopsis, notes, label, status, custom fields) |
| `move_document` | Reorganize within the binder |
| `delete_document` | Move to trash (reversible) |

</details>

<details>
<summary><strong>Search</strong> -- find content, passages, and mentions</summary>

| Tool | What it does |
|------|-------------|
| `search` | Keyword/full-text search; `field: "title"` for titles, `scope: "trash"` for trash |
| `semantic_search` | Find passages by meaning using the local HMS index plus provider-backed query interpretation, with similarity scores |
| `find_mentions` | Locate every occurrence of a specific name or term, with context |
| `list_trash` | List trashed documents |
| `restore_document` | Restore a document from trash |
| `read_annotations` | Read a document's comments and footnotes |

</details>

<details>
<summary><strong>Analysis</strong> -- quality, consistency, structure</summary>

| Tool | What it does |
|------|-------------|
| `analyze_document` | AI writing analysis; focus with `aspects` (structure, style, pacing, themes...) |
| `check_consistency` | Project-wide continuity check; `scope` for plot, characters, or timeline |
| `analyze_writing_style` | Style-focused analysis |
| `check_plot_consistency` | Plot-thread consistency check |
| `suggest_improvements` | AI-generated improvement suggestions |
| `enhance_content` | Suggest a specific improvement to a document |
| `generate_content` | Generate new prose from a prompt and context |
| `set_writing_goal` | Set a word-count goal (daily, weekly, or whole project) with an optional target date |
| `get_writing_goals` | List goals with progress -- percent complete, words remaining, on-pace status |
| `set_writing_preferences` | Set author preferences (tone, complexity, length, POV, style guide) that steer AI output |
| `get_writing_preferences` | Show current preferences plus feedback insights and suggestions |
| `collect_feedback` | Record a rating/comment on an AI operation to inform those insights |

**Enhancement types:** `eliminate-filter-words`, `strengthen-verbs`, `vary-sentences`, `add-sensory-details`, `show-dont-tell`, `improve-flow`, `enhance-descriptions`, `strengthen-dialogue`, `fix-pacing`, `expand`, `condense`, `rewrite`

</details>

<details>
<summary><strong>Compile & Export</strong> -- assemble and ship the manuscript</summary>

| Tool | What it does |
|------|-------------|
| `compile_documents` | Combine documents; `mode: "structured"` compiles the Draft folder with the binder hierarchy as headings and honors "Include in Compile" (no AI), `mode: "intelligent"` for AI-optimized output |
| `export_project` | Write the manuscript to disk -- Markdown, HTML, JSON inline, or DOCX, EPUB, PDF as a file |
| `get_statistics` | Project-level word/document/character counts |
| `generate_marketing_materials` | Draft synopsis, query letter, pitch, and related materials |

</details>

<details>
<summary><strong>Memory</strong> -- persistent project knowledge</summary>

| Tool | What it does |
|------|-------------|
| `remember` | Store information that persists across sessions with the project |
| `recall` | Retrieve previously stored memory |

Memory is stored within each .scriv project and travels with it.

</details>

<details>
<summary><strong>Relationships</strong> -- entity connections and story graph</summary>

| Tool | What it does |
|------|-------------|
| `add_relationship` | Store a relationship between characters, locations, themes, or plot threads |
| `find_relationships` | Query entities related to a given character/theme/location |
| `discover_connections` | Find co-occurring entities across the manuscript |
| `character_network` | The character relationship network |
| `get_entity_references` | Trace the reference graph in either direction: entities a document mentions (by documentId), or documents mentioning an entity (by entity) |
| `find_orphaned_entities` | List registered characters/locations that no document actually mentions |
| `suggest_connections` | Suggest entities a document may be missing, inferred from cross-document co-occurrence |

Works without Neo4j -- relationships live in the Holographic Memory System and are available immediately. The document cross-reference tools are fully deterministic (exact whole-word matching, no AI) and need no external services; Neo4j adds advanced graph analysis when connected.

</details>

<details>
<summary><strong>Background Jobs</strong> -- long-running analysis</summary>

| Tool | What it does |
|------|-------------|
| `queue_document_analysis` | Enqueue an async analysis of one document; returns a job id |
| `queue_project_analysis` | Enqueue an async analysis of the whole project |
| `get_job_status` | Poll progress/results for a queued job |
| `cancel_job` | Cancel a queued or running job |

</details>

<details>
<summary><strong>Discovery</strong> -- explore capabilities</summary>

| Tool | What it does |
|------|-------------|
| `list_skills` | List the available tool groups and their tools |
| `use_skill` | Activate a tool group (most are pre-activated by default) |

</details>

## Guides

- **[Getting Started](./docs/getting-started.md)** -- Installation, configuration, your first session
- **[MCP Client Setup](./docs/CLIENT_SETUP.md)** -- Copy-paste config for Claude Desktop, Claude Code, Cursor, and VS Code
- **[Writing with AI](./docs/writing-with-ai.md)** -- Analysis workflows, enhancement strategies, memory management
- **[Troubleshooting](./docs/troubleshooting.md)** -- Common issues and fixes
- **[Token Optimization](./docs/token-optimization.md)** -- How the server minimizes context window usage
- **[Architecture](./docs/architecture.md)** -- How the server works, module structure, data flow
- **[Scrivener Compatibility](./docs/SCRIVENER_COMPATIBILITY.md)** -- Supported Scrivener versions, platforms, and format coverage
- **[Scrivener File Format](./docs/scrivener-format.md)** -- The reverse-engineered `.scriv` format, what we read vs. infer, and safe-modification guidance
- **[Fuzzing](./docs/fuzzing.md)** -- Jazzer.js target and OSS-Fuzz integration details
- **[Contributing](./docs/contributing.md)** -- Development setup, code conventions, adding new tools

## Requirements

- **Node.js 18+**
- **Scrivener 3** project files (.scriv)
- macOS, Windows, or Linux
- Optional: Anthropic, OpenAI, or OpenRouter API key for provider-backed AI features
- Optional: Neo4j for persistence and advanced graph queries; core relationship tools work without it

## Development

```bash
git clone https://github.com/writerslogic/scrivener-mcp.git
cd scrivener-mcp
npm install
npm run dev          # Development mode with hot reload
npm run build        # Compile TypeScript
npm test             # Run tests
npm run typecheck    # Type checking only
```

## Why This One?

Several Scrivener MCP servers exist. Feature claims below come from each project’s public documentation, published package, and advertised tool surface, last re-read on **2026-08-22**; stars, forks, activity, and published version were refreshed <!-- comparison-refreshed -->2026-08-22<!-- /comparison-refreshed -->. “No” means the project does not document that capability; it does not claim the capability is impossible through the connected AI client.

<!-- comparison-start -->
| Feature | **scrivener-mcp** | [jiayun](https://github.com/jiayun/scrivener-mcp) | [TwelveTake](https://www.npmjs.com/package/@twelvetake/scrivener-mcp) | [Scrivener Assistant](https://github.com/elnino1/scrivener-assistant) | [ricopicone](https://github.com/ricopicone/scrivener-mcp) | [zaphodsdad](https://github.com/zaphodsdad/scrivener-mcp) |
|---------|:-:|:-:|:-:|:-:|:-:|:-:|
| Public MCP tools | 57 | 29 | 22 | 38 | 18 | 10 |
| Manuscript access | read/write | read/write | read/write | read-only; writes sidecar data/metadata | read-only by default; opt-in content/notes/synopsis writes | read-only |
| RTF handling | formatted reads; fidelity-preserving span writes | reads/writes document content | reads/writes document content | converts RTF to text; manuscript read-only | RTF-to-text reads; snapshot-protected content writes | converts RTF to text; read-only |
| Built-in writing analysis | readability, pacing, style, emotion, AI critique | readability, style, sentiment | continuity comparison | agent-driven five-point review workflow | no dedicated analysis tool | no dedicated analysis tool |
| Content generation/enhancement | generation + 12 targeted enhancement types | no | no | brainstorm/draft agent workflow | no | no |
| Local semantic retrieval | HMS index and similarity search | no | no | no | no | no |
| Continuity/project memory | persistent memory + consistency checks | persistent notes + consistency checks | mention/description comparison | world bible, story state, characters, locations, review history | no persistent memory | no persistent memory |
| Relationship tooling | persistent relationships, networks, reference graph; optional Neo4j | no | no | human-editable relations data | no | no |
| Token optimization | progressive skill loading, compact output, paged reads | no documented equivalent | no documented equivalent | no documented equivalent | scoped binder/chapter reads | scoped overview/read tools |
| Export / compilation | Markdown, HTML, JSON, DOCX, EPUB, PDF | compile + whole-draft export | PDF | saves AI drafts; no manuscript export documented | no | no |
| Windows support | yes | yes (prebuilt binary) | yes | not documented | not documented | yes |
| Installation | npm, Homebrew, Docker, Smithery | Cargo or prebuilt binary | npm package (deprecated) | MCPB or source | source / `uv` | source / `pip install -e` |
| License | AGPL-3.0 / commercial dual-license | MIT | MIT | MIT | not declared | MIT |
| Repository/package status | weekly activity; npm `0.12.0` | weekly activity | discontinued and unmaintained | occasional activity | occasional activity; no releases | occasional activity |
| Community | ⭐ 46 · 13 forks | ⭐ 7 | source repository unavailable | ⭐ 1 | ⭐ 0 | ⭐ 5 · 1 fork |
<!-- comparison-end -->

Counts and feature claims can change. Follow the linked projects for their latest documentation.
The table is generated from [`docs/comparison.yml`](./docs/comparison.yml) — edit claims there, not here.

### The option that isn't an MCP server

Worth naming, because it is the real alternative for many writers: Scrivener can
**Sync to External Folder**, writing each document out as RTF or plain text, and any
general-purpose file MCP server (for example
[`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem))
can then read and write those files.

That costs nothing and works today. What it gives up is everything that depends on
understanding the project rather than the folder: the binder hierarchy, metadata,
labels and status, snapshots, compile settings, and RTF formatting all flatten away,
and edits land in the sync folder rather than the project — so a bad edit is
reconciled by Scrivener on the next sync rather than caught before it happens. Use the
sync-folder route for occasional read-only help with prose; use a Scrivener MCP server
when you want the structure to survive the round trip.

## Contributing

We welcome contributions of all sizes. Check the [issue tracker](https://github.com/writerslogic/scrivener-mcp/issues) for `good first issue` labels, or see the [contributing guide](./docs/contributing.md) for development setup.

**Areas where help is especially welcome:**
- Test coverage ([#18](https://github.com/writerslogic/scrivener-mcp/issues/18))
- Windows testing and path handling
- Scrivener 2 compatibility testing
- Documentation improvements ([#25](https://github.com/writerslogic/scrivener-mcp/issues/25))

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](./SECURITY.md).

## License

AGPL-3.0 &copy; [WritersLogic, Inc.](https://github.com/writerslogic)

Free for personal use and open-source projects. Commercial license available for proprietary integration. See [COMMERCIAL_LICENSE.md](./COMMERCIAL_LICENSE.md) for details.

<p align="center">
  <a href="https://glama.ai/mcp/servers/writerslogic/scrivener-mcp">
    <img src="https://glama.ai/mcp/servers/writerslogic/scrivener-mcp/badges/card.svg" alt="scrivener-mcp MCP server"/>
  </a>
</p>

<p align="center">
  <a href="https://github.com/writerslogic/scrivener-mcp">GitHub</a> &middot;
  <a href="https://www.npmjs.com/package/scrivener-mcp">npm</a> &middot;
  <a href="https://github.com/writerslogic/scrivener-mcp/issues">Issues</a> &middot;
  <a href="./CHANGELOG.md">Changelog</a>
</p>
