<p align="center">
  <img src="https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/assets/logo-white.svg" alt="Scrivener MCP Logo" width="200"/>
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
  <img src="https://img.shields.io/github/license/writerslogic/scrivener-mcp" alt="license"/>
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
npm install -g writerslogic/scrivener-mcp#v0.4.3
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

Core features (document management, analysis, search) work without any API key. For AI-powered enhancements, set your OpenAI key:

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

Find passages by what they're about, not just keyword matching. "Find scenes where the protagonist feels isolated" works even if the word "isolated" never appears.

> **You:** Find all scenes where Elena and Marcus are alone together.

### Compile and Export

Combine chapters into a single manuscript with configurable formatting, separators, and structure preservation.

## All Tools

75+ tools organized by workflow. Click to expand.

<details>
<summary><strong>Project</strong> -- open, browse, save</summary>

| Tool | What it does |
|------|-------------|
| `open_project` | Open a .scriv project (accepts .scriv folders or .scrivx files) |
| `get_structure` | Browse the binder hierarchy |
| `get_document_info` | Document metadata, parent path, location |
| `get_all_documents` | Flat list of every document |
| `save_project` | Save pending changes |
| `is_project_modified` | Check for unsaved work |

</details>

<details>
<summary><strong>Documents</strong> -- read, write, create, organize</summary>

| Tool | What it does |
|------|-------------|
| `read_document` | Read document content |
| `write_document` | Write or replace content |
| `create_document` | Create a new document or folder |
| `delete_document` | Move to trash |
| `move_document` | Reorganize in the binder |
| `rename_document` | Change title |
| `get_word_count` | Word and character counts |
| `get_document_annotations` | Read Scrivener annotations and footnotes |

</details>

<details>
<summary><strong>Metadata & Search</strong> -- synopses, labels, status, search</summary>

| Tool | What it does |
|------|-------------|
| `update_metadata` | Update synopsis, notes, label, status, custom metadata |
| `batch_update_synopsis_notes` | Update multiple documents at once |
| `search_content` | Full-text search across all documents |
| `semantic_search` | Find passages by meaning, not just keywords |
| `find_analogies` | Analogical reasoning (A is to B as C is to ?) |
| `list_trash` / `search_trash` | Browse and search trashed documents |
| `recover_document` | Restore from trash |

</details>

<details>
<summary><strong>Analysis</strong> -- readability, pacing, style, feedback</summary>

| Tool | What it does |
|------|-------------|
| `analyze_document` | AI-powered writing analysis |
| `deep_analyze_content` | Comprehensive metrics (readability, pacing, emotion, style) |
| `critique_document` | Constructive feedback on specific focus areas |
| `check_character_consistency` | Find contradictions across the manuscript |
| `analyze_story_structure` | Plot arc and structure analysis (requires Neo4j) |

</details>

<details>
<summary><strong>Enhancement</strong> -- improve your prose</summary>

| Tool | What it does |
|------|-------------|
| `enhance_content` | Apply a specific improvement to a document |
| `compile_documents` | Combine documents with formatting |

**Enhancement types:** `eliminate-filter-words`, `strengthen-verbs`, `vary-sentences`, `add-sensory-details`, `show-dont-tell`, `improve-flow`, `enhance-descriptions`, `strengthen-dialogue`, `fix-pacing`, `expand`, `condense`, `rewrite`

</details>

<details>
<summary><strong>Memory</strong> -- characters, plot, style</summary>

| Tool | What it does |
|------|-------------|
| `save_character_profile` | Store character details that persist across sessions |
| `get_character_profiles` | Retrieve all saved characters |
| `save_plot_thread` | Track plot lines and their status |
| `get_plot_threads` | View all plot threads |
| `update_style_guide` | Set tone, voice, POV, tense preferences |
| `get_style_guide` | View current style guide |
| `get_writing_stats` | Word counts, session history, progress |
| `export_project_memory` / `import_memory` | Backup and restore project memory |

Memory is stored within each .scriv project and travels with it.

</details>

<details>
<summary><strong>Database</strong> -- advanced queries and analytics</summary>

| Tool | What it does |
|------|-------------|
| `query_database` | Run custom SELECT queries on project data |
| `get_writing_statistics` | Writing stats over a time period |
| `find_character_relationships` | Character relationship graph (Neo4j) |
| `create_relationship` | Define relationships between entities |
| `backup_databases` | Backup project databases |

SQLite is included and automatic. Neo4j is optional for graph-based story analysis.

</details>

## Guides

- **[Getting Started](./docs/getting-started.md)** -- Installation, configuration, your first session
- **[Writing with AI](./docs/writing-with-ai.md)** -- Analysis workflows, enhancement strategies, memory management
- **[Architecture](./docs/architecture.md)** -- How the server works, module structure, data flow
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
  <a href="https://github.com/writerslogic/scrivener-mcp">GitHub</a> &middot;
  <a href="https://www.npmjs.com/package/scrivener-mcp">npm</a> &middot;
  <a href="https://github.com/writerslogic/scrivener-mcp/issues">Issues</a> &middot;
  <a href="./CHANGELOG.md">Changelog</a>
</p>
