<!-- repo-header:start -->
<img src="https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/assets/logo-black.svg" alt="Scrivener MCP logo" width="120" align="left">

<h1>Scrivener MCP</h1>

<p><strong>The definitive MCP server for Scrivener — connect your novels, screenplays, and manuscripts to Claude, ChatGPT, and any AI assistant. 53 tools: document management, writing analysis, content enhancement, offline semantic search, and character/plot tracking.</strong></p>

<br clear="left">

[![CI](https://img.shields.io/github/actions/workflow/status/writerslogic/scrivener-mcp/release.yml?style=flat-square&labelColor=20232a&branch=main&label=CI)](https://github.com/writerslogic/scrivener-mcp/actions/workflows/release.yml) [![CodeQL](https://img.shields.io/github/actions/workflow/status/writerslogic/scrivener-mcp/codeql.yml?style=flat-square&labelColor=20232a&branch=main&label=CodeQL)](https://github.com/writerslogic/scrivener-mcp/actions/workflows/codeql.yml) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/writerslogic/scrivener-mcp?style=flat-square&labelColor=20232a&label=OpenSSF)](https://securityscorecards.dev/viewer/?uri=github.com/writerslogic/scrivener-mcp) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13976/badge)](https://www.bestpractices.dev/projects/13976) [![License](https://img.shields.io/github/license/writerslogic/scrivener-mcp?style=flat-square&labelColor=20232a&color=007ec6&label=license)](https://github.com/writerslogic/scrivener-mcp/blob/main/LICENSE) [![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-Contributor%20Covenant%202.1-6a4c93?style=flat-square&labelColor=20232a)](https://github.com/writerslogic/scrivener-mcp/blob/main/CODE_OF_CONDUCT.md) [![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Sponsor-EA4AAA?style=flat-square&labelColor=20232a)](https://github.com/sponsors/dcondrey)
<!-- repo-header:end -->

<a href="https://www.npmjs.com/package/scrivener-mcp">
    <img src="https://img.shields.io/npm/v/scrivener-mcp.svg?style=flat-square&labelColor=20232a&color=007ec6" alt="npm version"/>
  </a>
  <img src="https://img.shields.io/npm/dm/scrivener-mcp.svg?style=flat-square&labelColor=20232a&color=007ec6" alt="npm downloads"/>
  <img src="https://img.shields.io/node/v/scrivener-mcp?style=flat-square&labelColor=20232a&color=007ec6" alt="node version"/>
  
  <a href="https://github.com/writerslogic/scrivener-mcp">
    <img src="https://img.shields.io/github/stars/writerslogic/scrivener-mcp?style=flat-square&labelColor=20232a&color=6a4c93" alt="stars"/>
  </a>
  <a href="https://mseep.ai/app/writerslogic-scrivener-mcp">
    <img src="https://img.shields.io/badge/MseeP-verified-green.svg?style=flat-square&labelColor=20232a" alt="MseeP verified"/>
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

Scrivener MCP lets your AI assistant open, read, edit, analyze, and search your Scrivener projects directly. No exporting, no copy-pasting text back and forth. Tell it which project to open and start working.

> **You:** Open my novel and analyze the pacing in Chapter 12.
>
> **Claude:** *Opens the .scriv project, reads Chapter 12, runs pacing analysis.* The first half moves well, but the middle stalls — a three-page internal monologue starting at paragraph 14 kills the momentum you built in the confrontation scene. Consider cutting it to a paragraph and moving the backstory to Chapter 8.

Works with [Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), VS Code (Copilot/Continue), Cursor, and any MCP-compatible client. Scrivener 3 on macOS, Windows, and Linux. Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.writerslogic/scrivener-mcp`.

## Install

```bash
npm install -g scrivener-mcp
```

Restart Claude Desktop and it's ready. Other clients need one more step:

```bash
npx scrivener-setup
```

This finds Claude Code, Claude Desktop, and Cursor and configures them for you. To set up Claude Code by hand instead: `claude mcp add -s user scrivener -- npx scrivener-mcp`, then restart it (or run `/mcp`).

<details>
<summary><strong>Other ways to install</strong></summary>

**Smithery**
```bash
npx -y @smithery/cli install scrivener-mcp --client claude
```

**npx, no install**
```bash
npx scrivener-mcp
```
or add it to Claude Desktop's config directly:
```json
{
  "mcpServers": {
    "scrivener": { "command": "npx", "args": ["scrivener-mcp"] }
  }
}
```

**From GitHub**
```bash
npm install -g writerslogic/scrivener-mcp              # latest main
npm install -g writerslogic/scrivener-mcp#v0.12.0       # a specific release
```

**Homebrew (macOS)**
```bash
brew install writerslogic/tap/scrivener-mcp
```

**Docker**
```bash
docker build -t scrivener-mcp https://github.com/writerslogic/scrivener-mcp.git
docker run -i --rm -v /path/to/your/projects:/projects scrivener-mcp
```

Any other MCP client: point it at `npx scrivener-mcp` as a stdio server.

</details>

<details>
<summary><strong>Optional: AI-powered features</strong></summary>

Document management, deterministic analysis, keyword search, and project memory work with no API key at all. Writing analysis, generation, enhancement, and semantic search need one — Anthropic, OpenAI, or OpenRouter. Set more than one and Claude handles chat by default; override with `AI_PROVIDER=openai` or `AI_PROVIDER=openrouter` (OpenRouter defaults to `anthropic/claude-sonnet-4.6`, change it with `OPENROUTER_MODEL`). If the active provider fails on an account-level error — bad key, no credit, an outage — the server retries on the next one you've configured. If your MCP client supports [sampling](https://modelcontextprotocol.io/docs/concepts/sampling), chat-based features can run through the client's own model instead, no separate key needed. Semantic indexing itself always runs locally through the Holographic Memory System; only `semantic_search`'s query interpretation needs a provider.

Keys are picked up automatically from:
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`
- `~/.env` or `~/.scrivener-mcp/.env`
- `~/.anthropic/key`, `~/.openai/key`, `~/.openrouter/key`
- macOS Keychain (`anthropic-api-key` / `openai-api-key` / `openrouter-api-key`)

```bash
security add-generic-password -s anthropic-api-key -a anthropic -w sk-ant-your-key-here   # Keychain
export ANTHROPIC_API_KEY="sk-ant-..."                                                      # or export it directly
```

</details>

## What You Can Do

> Open a project first. The server has no link to the Scrivener app itself and can't see what's open there — say *"Open my Scrivener project at `~/Documents/My Novel.scriv`"*, or *"Discover my Scrivener projects"* if you don't know the path. On macOS, *"Use the project I have open in Scrivener"* works too (the first time, macOS will ask permission to control Scrivener). Do this once per conversation. If the project is also open and unsaved in Scrivener itself, save or close it there first, or the two can write over each other.

**Manage your manuscript.** Read chapters, create scenes, reorganize the binder, update synopses — all through conversation. *"Create a new scene called 'The Reveal' after Chapter 5, and move the old epilogue to the trash."*

**Analyze your writing.** Readability, pacing, style, dialogue quality, emotional arc — grounded in your actual prose, not generic advice. Ask whether a chapter's pacing is off and get specifics: which paragraphs stall, how the scene compares to your other chapters, filter-word density against your own average.

**Enhance your prose.** Targeted edits: cut filter words, strengthen verbs, vary sentence structure, add sensory detail, turn telling into showing, tighten dialogue, fix pacing.

**Track characters and plot.** Character profiles, plot threads, and style guides persist with the project across sessions. Save a profile for a character once; a consistency check months later catches contradictions — dialogue that doesn't sound like them, a limp that disappears for a chapter.

**Search by meaning.** "Find scenes where the protagonist feels isolated" works even if that word never appears. Indexing and similarity scoring run locally through the [Holographic Memory System](https://www.npmjs.com/package/holographic-memory); `semantic_search` also needs a configured AI provider to interpret the query and explain the results.

**Track relationships.** Query how characters, locations, themes, and plot threads connect. No Neo4j required — relationships live in the semantic memory engine and persist with the project; Neo4j adds deeper graph analysis if you have it.

**Compile and export.** Assemble chapters into one manuscript with your own formatting and structure preserved. Export inline as Markdown, HTML, or JSON, or write a DOCX, EPUB, or PDF to disk.

## All Tools

57 tools organized by workflow. To keep token usage low, tools load progressively — project tools at startup, document and search tools once a project is open, the rest on demand. Set `SCRIVENER_MCP_EAGER_TOOLS=1` to load everything up front.

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

A few Scrivener MCP servers exist. Feature claims below come from each project's own docs, published package, and advertised tools, last re-read on **2026-08-22**; stars, forks, activity, and published version were refreshed <!-- comparison-refreshed -->2026-09-15<!-- /comparison-refreshed -->. "No" means undocumented — not necessarily impossible through the connected AI client.

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
| Repository/package status | weekly activity; npm `0.12.0` | monthly activity | discontinued and unmaintained | occasional activity | occasional activity; no releases | occasional activity; no releases |
| Community | ⭐ 54 · 18 forks | ⭐ 7 | source repository unavailable | ⭐ 1 | ⭐ 0 | ⭐ 5 · 1 fork |
<!-- comparison-end -->

Counts and feature claims can change. Follow the linked projects for their own latest documentation. The table is generated from [`docs/comparison.yml`](./docs/comparison.yml) — edit claims there, not here.

### The alternative that isn't an MCP server

Scrivener can also **Sync to External Folder**, writing each document out as RTF or plain text, which any generic file-access MCP server (like [`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem)) can then read and write.

It's free and works today. What you lose is everything tied to the actual project — binder hierarchy, metadata, labels and status, snapshots, compile settings, RTF formatting — and edits land in the sync folder rather than the project itself, so a bad edit gets reconciled by Scrivener on the next sync instead of caught before it happens. Fine for occasional read-only help with prose; not if you want the structure to survive the round trip.

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
