<p align="center">
  <img src="https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/assets/logo.svg" alt="Scrivener MCP Logo" width="200"/>
</p>

<h1 align="center">Scrivener MCP Server</h1>

<p align="center">
  <strong>A Model Context Protocol (MCP) server for seamless Scrivener integration with Claude AI</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/scrivener-mcp">
    <img src="https://img.shields.io/npm/v/scrivener-mcp.svg" alt="npm version"/>
  </a>
  <img src="https://img.shields.io/npm/dm/scrivener-mcp.svg" alt="npm monthly downloads"/>
  <a href="https://github.com/writerslogic/scrivener-mcp/actions">
    <img src="https://github.com/writerslogic/scrivener-mcp/actions/workflows/ci.yml/badge.svg" alt="build status"/>
  </a>
  <img src="https://img.shields.io/github/license/writerslogic/scrivener-mcp" alt="license"/>
  <img src="https://img.shields.io/node/v/scrivener-mcp" alt="node version"/>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#available-tools">Tools</a> &middot;
  <a href="#usage-examples">Usage</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

An MCP server that gives Claude AI full read/write access to Scrivener projects. Manage documents, analyze writing, track characters and plot threads, and search by semantic meaning -- all from within Claude.

> **v0.4** -- Major reliability and performance update. See [CHANGELOG.md](./CHANGELOG.md).

## Quick Start

```bash
npm install -g scrivener-mcp
```

Restart Claude Desktop. The package auto-configures itself. No Redis, no external services, no API keys required for core features.

<details>
<summary><strong>Manual configuration</strong></summary>

If automatic setup didn't work, add to your `claude_desktop_config.json`:

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

Or run the setup script: `npx scrivener-mcp setup`

</details>

## Features

**Core Scrivener Operations** -- Open projects, read/write/create/delete/move documents, navigate the binder hierarchy, update metadata (including custom metadata), manage synopses and notes.

**RTF Support** -- Full parsing and generation of Scrivener's RTF format with annotations, Unicode, and formatting preservation.

**AI Writing Analysis** -- Readability scores, style assessment, pacing analysis, emotional arc tracking, cliche/filter word detection, and actionable suggestions.

**Content Enhancement** -- 12+ enhancement types: filter word elimination, verb strengthening, sentence variation, sensory details, show-don't-tell, pacing control, expansion/condensing, and full rewrites.

**Project Memory** -- Persistent character profiles, plot threads, style guides, and writing statistics stored within each Scrivener project.

**Holographic Memory System (HMS)** -- Rust-native semantic search engine with 10,000-dimensional vector space, analogical reasoning, batch APIs, zero-copy ingestion, and end-to-end tracing.

**Document Compilation** -- Combine multiple documents with configurable separators and format preservation.

**Database Tools** -- SQLite for writing statistics and content history. Optional Neo4j for character relationship graphs and story structure analysis.

## Available Tools

The server provides 75+ tools. Click a category to expand.

<details>
<summary><strong>Project Operations</strong></summary>

| Tool | Description |
|------|-------------|
| `open_project(path)` | Open a Scrivener project |
| `get_structure(options?)` | Get hierarchical binder structure |
| `get_document_info(documentId)` | Get document metadata with parent hierarchy |
| `get_project_metadata()` | Get project-level metadata |
| `get_all_documents(includeTrash?)` | Flat list of all documents |
| `save_project()` | Save pending changes |
| `is_project_modified()` | Check for unsaved changes |

</details>

<details>
<summary><strong>Document Operations</strong></summary>

| Tool | Description |
|------|-------------|
| `read_document(documentId)` | Read plain text content |
| `read_document_formatted(documentId)` | Read with RTF formatting |
| `read_document_rtf(documentId)` | Read raw RTF |
| `write_document(documentId, content)` | Write content |
| `create_document(parentId?, title, type?)` | Create document or folder |
| `delete_document(documentId)` | Delete document |
| `move_document(documentId, newParentId?)` | Move document |
| `get_document_annotations(documentId)` | Get Scrivener annotations |
| `get_word_count(documentId?)` | Word/character counts |

</details>

<details>
<summary><strong>Metadata & Search</strong></summary>

| Tool | Description |
|------|-------------|
| `update_metadata(documentId, metadata)` | Update metadata (synopsis, notes, label, status, customMetadata) |
| `update_document_synopsis_notes(documentId, synopsis?, notes?)` | Update synopsis and notes |
| `batch_update_synopsis_notes(updates)` | Batch update multiple documents |
| `search_content(query, options?)` | Search across all documents |
| `list_trash()` | List trashed documents |
| `search_trash(query, options?)` | Search within trash |
| `recover_document(documentId, targetParentId?)` | Recover from trash |

</details>

<details>
<summary><strong>Analysis & Enhancement</strong></summary>

| Tool | Description |
|------|-------------|
| `analyze_document(documentId)` | AI-powered content analysis |
| `deep_analyze_content(documentId)` | Comprehensive writing metrics |
| `critique_document(documentId, focusAreas?)` | Constructive feedback |
| `enhance_content(documentId, enhancementType, options?)` | Apply improvements |
| `compile_documents(documentIds, separator?, preserveFormatting?)` | Compile documents |

Enhancement types: `eliminate-filter-words`, `strengthen-verbs`, `vary-sentences`, `add-sensory-details`, `show-dont-tell`, `improve-flow`, `enhance-descriptions`, `strengthen-dialogue`, `fix-pacing`, `expand`, `condense`, `rewrite`

</details>

<details>
<summary><strong>Memory Management</strong></summary>

| Tool | Description |
|------|-------------|
| `save_character_profile(name, role, ...)` | Store character data |
| `get_character_profiles()` | Retrieve all characters |
| `update_style_guide(tone?, voice?, pov?, tense?)` | Set writing preferences |
| `get_style_guide()` | Get current style guide |
| `save_plot_thread(name, description, status?, ...)` | Track plot lines |
| `get_plot_threads()` | View all plot threads |
| `get_writing_stats()` | Project statistics |
| `export_project_memory()` | Export all memory data |
| `import_memory(memoryData)` | Import memory data |
| `update_document_context(documentId, ...)` | Update document context |
| `add_custom_context(key, value)` | Add custom context |
| `get_custom_context(key?)` | Get custom context |
| `update_writing_session(wordsWritten, duration?)` | Record writing session |

</details>

<details>
<summary><strong>Semantic Memory (HMS)</strong></summary>

| Tool | Description |
|------|-------------|
| `semantic_search(query, k?, threshold?)` | Find documents by meaning |
| `find_analogies(a, b, c)` | Analogical reasoning (A:B :: C:?) |
| `hhm_dream()` | Creative concept recombination |

Documents are automatically memorized in the HMS vector space on write.

</details>

<details>
<summary><strong>Database Tools (Advanced)</strong></summary>

| Tool | Description |
|------|-------------|
| `get_database_status()` | SQLite and Neo4j status |
| `query_database(query, params?)` | Execute SELECT queries |
| `get_writing_statistics(days?)` | Writing stats for period |
| `record_writing_session(...)` | Record a session |
| `analyze_story_structure()` | Story structure analysis (Neo4j) |
| `find_character_relationships(characterId)` | Character relationships |
| `create_relationship(...)` | Create entity relationships |
| `get_content_analysis_history(documentId, ...)` | Historical analysis |
| `backup_databases(backupPath?)` | Backup project databases |

</details>

## Usage Examples

<details>
<summary><strong>Basic workflow</strong></summary>

```javascript
// Open a project
open_project("/path/to/MyNovel.scriv")

// Browse structure
get_structure()

// Read and analyze a chapter
read_document("UUID-OF-DOCUMENT")
deep_analyze_content("UUID-OF-DOCUMENT")

// Improve the prose
enhance_content("UUID-OF-DOCUMENT", "strengthen-verbs")
```

</details>

<details>
<summary><strong>Character and style management</strong></summary>

```javascript
// Save character profile
save_character_profile({
  name: "Elizabeth Bennet",
  role: "protagonist",
  description: "Intelligent and witty young woman",
  traits: ["independent", "prejudiced", "romantic"],
  arc: "Overcomes initial prejudice to find true love"
})

// Set style guide
update_style_guide({
  tone: ["witty", "romantic", "formal"],
  voice: "Jane Austen-esque",
  pov: "third-limited",
  tense: "past"
})

// Track a plot thread
save_plot_thread({
  name: "Murder Mystery",
  description: "Central whodunit spanning chapters 1-5",
  status: "in-progress"
})
```

</details>

<details>
<summary><strong>Synopsis and notes management</strong></summary>

```javascript
// Single document
update_document_synopsis_notes("UUID-OF-CHAPTER", {
  synopsis: "Elizabeth meets Mr. Darcy at the assembly ball.",
  notes: "First impression scene - sets up central conflict"
})

// Batch update
batch_update_synopsis_notes([
  { documentId: "UUID-1", synopsis: "Introduction to the family" },
  { documentId: "UUID-2", synopsis: "The Netherfield ball" }
])
```

</details>

## Architecture

<details>
<summary><strong>Core components</strong></summary>

- **ScrivenerProject** -- Project operations and binder management
- **RTFHandler** -- RTF parsing and generation
- **DatabaseService** -- SQLite and Neo4j operations
- **MemoryManager** -- Persistent project memory
- **ContentAnalyzer** -- Writing analysis and metrics
- **ContentEnhancer** -- AI-powered improvements
- **HolographicMemorySystem** -- Rust-native semantic memory engine
- **MCP Server** -- Tool definitions and JSON-RPC handling

</details>

<details>
<summary><strong>Data storage</strong></summary>

- **SQLite** -- `.scrivener-databases/scrivener.db` within each project (documents, characters, plot threads, writing sessions, analysis history)
- **Neo4j** -- Optional graph database for relationship analysis (falls back gracefully)
- **Memory files** -- `.ai-memory` folder for quick-access project memory
- All data persists between sessions and travels with the project

</details>

## Development

```bash
npm run dev        # Development mode with hot reload
npm run build      # Build TypeScript
npm run typecheck  # Type checking
npm run lint       # ESLint
npm test           # Run tests
```

**Requirements:** Node.js 18+, TypeScript 5.0+, Scrivener 3 project files

## Documentation

- [Getting Started](./docs/getting-started.md) -- installation, configuration, first steps
- [Writing with AI](./docs/writing-with-ai.md) -- analysis, enhancement, memory, semantic search
- [Architecture](./docs/architecture.md) -- how the server works internally
- [Contributing](./docs/contributing.md) -- development setup, code conventions, adding tools

## Contributing

Contributions are welcome. See the [contributing guide](./docs/contributing.md) and our [issue tracker](https://github.com/writerslogic/scrivener-mcp/issues) for good first issues.

## License

MIT (c) [WritersLogic, Inc.](https://github.com/writerslogic)

## Links

- [GitHub Repository](https://github.com/writerslogic/scrivener-mcp)
- [NPM Package](https://www.npmjs.com/package/scrivener-mcp)
- [Issue Tracker](https://github.com/writerslogic/scrivener-mcp/issues)
- [Changelog](./CHANGELOG.md)
