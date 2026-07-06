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
  <a href="https://github.com/writerslogic/scrivener-mcp/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/writerslogic/scrivener-mcp" alt="license"/>
  </a>
  <img src="https://img.shields.io/node/v/scrivener-mcp" alt="node version"/>
  <a href="https://github.com/writerslogic/scrivener-mcp/issues">
    <img src="https://img.shields.io/github/issues/writerslogic/scrivener-mcp" alt="issues"/>
  </a>
  <a href="https://github.com/writerslogic/scrivener-mcp/stargazers">
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

Scrivener MCP lets your AI assistant open, read, edit, analyze, and search your Scrivener projects directly. No copy-pasting. No exporting. Just open your novel and start working.

> **You:** Open my novel and analyze the pacing in Chapter 12.
>
> **Claude:** *Opens your .scriv project, reads Chapter 12, runs pacing analysis.*
> The first half moves well with short, tense paragraphs. The middle section slows
> considerably -- the three-page internal monologue starting at paragraph 14 stalls
> the momentum you built in the confrontation scene. Consider cutting it to a single
> paragraph and moving the backstory to Chapter 8 where Elena is first introduced.

Works with [Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), VS Code (Copilot/Continue), Cursor, and any MCP-compatible client. Scrivener 3 on macOS, Windows, and Linux.

## Install

Pick the method that works for you. All of them auto-configure Claude Desktop on install.

### npm (recommended)

```bash
npm install -g scrivener-mcp
```

Restart Claude Desktop. Done.

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
npm install -g writerslogic/scrivener-mcp#v0.5.1
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

Core features (document management, analysis, search) work without any API key. For AI-powered enhancements, the server automatically discovers your OpenAI key from common locations:

- `OPENAI_API_KEY` environment variable
- `~/.env`, `~/.scrivener-mcp/.env`, `~/.openai/key`
- macOS Keychain (service name `openai-api-key`)

To store your key in the macOS Keychain:

```bash
security add-generic-password -s openai-api-key -a openai -w sk-your-key-here
```

Or export it manually:

```bash
export OPENAI_API_KEY="sk-..."
```

This enables: content enhancement, semantic search, multi-agent analysis, character consistency checking, and intelligent compilation.

</details>

## What You Can Do

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

Find passages by what they're about, not just keyword matching. "Find scenes where the protagonist feels isolated" works even if the word "isolated" never appears. Powered by the [Holographic Memory System](https://www.npmjs.com/package/holographic-memory) -- works offline, no API key needed.

> **You:** Find all scenes where Elena and Marcus are alone together.

### Track Relationships

Store and query relationships between characters, locations, themes, and plot threads. No Neo4j required -- relationships live in the semantic memory engine and persist with your project.

> **You:** Who is connected to Marcus? What plot threads involve the lighthouse?

### Compile and Export

Combine chapters into a single manuscript with configurable formatting, separators, and structure preservation. Export the result inline as Markdown, HTML, or JSON, or write a DOCX, EPUB, or PDF file to disk for submission, e-readers, or print.

## All Tools

52 tools organized by workflow. To keep token usage low, tools load progressively -- project tools at startup, document and search tools when you open a project, and the rest on demand (your AI client activates them automatically). Set `SCRIVENER_MCP_EAGER_TOOLS=1` to load everything at once.

<details>
<summary><strong>Project</strong> -- open, browse, manage</summary>

| Tool | What it does |
|------|-------------|
| `open_project` | Open a .scriv project (accepts .scriv folders or .scrivx files) and make it active |
| `discover_projects` | Scan common locations for Scrivener projects when you don't know the path |
| `get_structure` | Browse the binder hierarchy (folders, documents, word counts) |
| `refresh_project` | Reload from disk after external edits |
| `close_project` | Close the active project and flush pending changes |
| `verify_project_integrity` | Read-only scan for structural problems (missing/duplicate UUIDs, unreadable content) |
| `get_compile_settings` | Read the project's compile formats and taxonomy -- labels/statuses (with colors), collections, section types |

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
| `semantic_search` | Find passages by meaning using embeddings, with similarity scores |
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
| `compile_documents` | Combine documents with formatting; `mode: "intelligent"` for AI-optimized output |
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
| `get_document_references` | List the registered characters/locations a document mentions, with counts and positions |
| `get_referencing_documents` | Find every document that mentions a given character or location, ranked by count |
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
- **[Contributing](./docs/contributing.md)** -- Development setup, code conventions, adding new tools

## Requirements

- **Node.js 18+**
- **Scrivener 3** project files (.scriv)
- macOS, Windows, or Linux
- Optional: OpenAI API key for AI-powered features
- Optional: Neo4j for character relationship graphs

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

Several Scrivener MCP servers exist. Here's how they compare:

<!-- comparison-start -->
| Feature | **scrivener-mcp** | jiayun | zaphodsdad | others |
|---------|:-:|:-:|:-:|:-:|
| Document read/write | 60+ tools | 29 tools | read-only | basic |
| RTF / rich text support | yes | no | no | no |
| Writing analysis | readability, pacing, style, emotion | basic metrics | no | no |
| Content enhancement | 12 types (filter words, verbs, show-don't-tell…) | no | no | no |
| Semantic search (offline) | vector + analogies + dream mode | no | no | no |
| Character consistency check | yes | no | no | no |
| Character / plot memory | persistent profiles, plot threads, style guide | no | no | no |
| Relationship graphs | HMS triplets + optional Neo4j | no | no | no |
| Multi-agent analysis | roundtable critique with specialised agents | no | no | no |
| Story structure analysis | yes (requires Neo4j) | no | no | no |
| Token optimisation | progressive skill loading, compact JSON | no | no | no |
| Batch document operations | yes | partial | no | no |
| Export / compilation | yes — multiple formats | basic | no | no |
| Windows support | full path handling + .scrivx discovery | partial | no | no |
| Install method | npm · Homebrew · Docker · Smithery | manual clone | manual clone | varies |
| Published to npm | yes (`npm i -g scrivener-mcp`) | no | no | no |
| License | AGPL-3.0 / commercial dual-license | MIT | — | varies |
| Active development | weekly | stale | occasional | stale |
| Community | ⭐ 30 · 14 forks · 13 issues | ⭐ ? | ⭐ 4 | minimal |
<!-- comparison-end -->

## Contributing

We welcome contributions of all sizes. Check the [issue tracker](https://github.com/writerslogic/scrivener-mcp/issues) for `good first issue` labels, or see the [contributing guide](./docs/contributing.md) for development setup.

**Areas where help is especially welcome:**
- Test coverage ([#18](https://github.com/writerslogic/scrivener-mcp/issues/18))
- Windows testing and path handling
- Scrivener 2 compatibility testing
- Documentation improvements ([#25](https://github.com/writerslogic/scrivener-mcp/issues/25))

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
