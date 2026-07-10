# Architecture

## Overview

Scrivener MCP is a stdio-based MCP server written in TypeScript. It reads and writes Scrivener 3 project files directly (XML binder structure + RTF document files) and exposes 53 tools over the Model Context Protocol via skill-based registration (progressive disclosure by default; eager registration is opt-in via `SCRIVENER_MCP_EAGER_TOOLS`).

```
Claude Desktop / Claude Code
        |
        | JSON-RPC over stdio
        |
   MCP Server (src/index.ts)
        |
   Handler Layer (src/handlers/)
        |
   +----+----+----+----+
   |    |    |    |    |
Project Memory  DB  Analysis  HMS
```

## Key Modules

### MCP Server (`src/index.ts`)

Entry point. Creates the MCP `Server` instance, initializes the skill registry, and routes incoming `CallToolRequest` messages to the appropriate handler.

### Skill Registry (`src/handlers/skill-registry.ts`)

Tools are organized into skills that load progressively by default to minimize token overhead; set `SCRIVENER_MCP_EAGER_TOOLS=1` to register every skill at startup.

| Skill | Tools | Progressive load |
|-------|-------|-------------|
| `project` | open_project, discover_projects, get_structure, refresh_project, close_project, verify_project_integrity, get_compile_settings | Startup (always) |
| `documents` | get_document_info, read_document, write_document, create_document, update_document, move_document, delete_document | After open_project |
| `search` | search, semantic_search, find_mentions, list_trash, restore_document, read_annotations | After open_project |
| `analysis` | analyze_document, check_consistency, enhance_content, generate_content, set_writing_goal, get_writing_goals, set_writing_preferences, get_writing_preferences, collect_feedback | On demand |
| `compilation` | compile_documents, export_project, get_statistics, generate_marketing_materials | On demand |
| `memory` | remember, recall | On demand |
| `relationships` | add_relationship, find_relationships, discover_connections, character_network, get_document_references, get_referencing_documents, find_orphaned_entities, suggest_connections | On demand |
| `advanced` | queue_document_analysis, queue_project_analysis, suggest_improvements, analyze_writing_style, check_plot_consistency, get_job_status, cancel_job | On demand |

Two meta-tools (`list_skills`, `use_skill`) are always available. In progressive mode, activating a skill triggers `sendToolListChanged` to notify the client to re-fetch the tool list.

### Handlers (`src/handlers/`)

Each handler file defines a set of MCP tools as `ToolDefinition` objects with:
- `name` -- tool name exposed to the client
- `title` -- human-readable display name
- `description` -- structured description: what it does, what it returns, when to use it vs related tools, and preconditions
- `inputSchema` -- JSON Schema with a described parameter for each input (shared definitions in `shared-schemas.ts`)
- `annotations` -- MCP behavior hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
- `handler` -- async function that executes the tool

Arguments are validated using typed extractors (`getStringArg`, `getOptionalNumberArg`, etc.) from `src/handlers/types.ts`.

### Response Formatting (`src/core/response-formatter.ts`)

All tool outputs are optimized for token efficiency:
- `compact()` -- JSON serialization with null stripping, no indentation
- `formatPayload()` -- large results (>4K chars) spill to disk, return tracker ID + preview
- `formatError()` -- masks stack traces and internal paths into short actionable messages

### Scrivener Project (`src/scrivener-project.ts`)

Core class that manages an open Scrivener project. Handles:
- Loading and parsing the `.scrivx` XML file
- Reading/writing RTF document files from `Files/Data/`
- Binder item traversal (finding documents by UUID)
- Metadata updates (synopsis, notes, labels, status, custom metadata)
- Project saves (writing modified XML back to disk)

### Project Loader (`src/services/project-loader.ts`)

Handles file-level operations: finding the `.scrivx` file within a `.scriv` package, parsing XML, managing file locks, and saving.

### RTF Handler

Parses Scrivener's RTF format to extract plain text and formatting. Handles Scrivener-specific extensions (annotations, comments) and Unicode.

### Memory Manager (`src/memory-manager.ts`)

Persistent key-value storage for project memory (character profiles, plot threads, style guide, writing stats). Stored as JSON in `.ai-memory/` within the project.

### Content Analyzer (`src/analysis/`)

Writing quality analysis: readability scores (Flesch-Kincaid), sentence variety, vocabulary complexity, pacing, emotional arc, quality indicators (cliches, filter words).

### Content Enhancer (`src/services/enhancements/`)

Applies targeted improvements to text (12+ enhancement types). Uses the style guide when available.

### Holographic Memory System (`src/services/memory/hhm/`)

TypeScript wrapper around the optional `holographic-memory` Rust binary. A built-in JS fallback engine provides the same features without the native binary. The Rust engine implements Binary Spatter Code (BSC) in a 10,000-dimensional vector space for:
- Semantic encoding of text via character trigrams
- Approximate nearest neighbor search
- Analogical reasoning via vector arithmetic
- Concept synthesis via clustering

The wrapper adds metadata tracking, result mapping, typed interfaces, and triplet storage for entity relationships. When the native binary is not installed, a JS fallback engine using TF-IDF random-projection vectors provides the same API surface.

### Relationship Engine (`src/services/relationship-engine.ts`)

Dual-write relationship storage that writes to HMS (always) and Neo4j (when connected). HMS handles fast lookups via triplet queries. Neo4j adds advanced graph operations (PageRank, community detection, shortest path) when available. Relationships persist in the local triplet store and can be synced to Neo4j on demand.

### Database Service (`src/handlers/database/`)

SQLite for structured data (writing sessions, content analysis history, entity relationships). Optional Neo4j for graph queries (character relationships, story structure, theme progression).

### Cross-Reference Engine (`src/services/document-references.ts`)

Pure, deterministic detection of which documents mention the project's registered characters and locations, via exact whole-word case-insensitive matching -- no Neo4j or AI. Backs `get_document_references`, `get_referencing_documents`, `find_orphaned_entities`, and `suggest_connections` (which infers missing links from cross-document co-occurrence), so those tools work with no external services.

### Compile Settings (`src/services/compile-settings.ts`)

Defensive reader for Scrivener's undocumented `Settings/compile.xml` and the `.scrivx` taxonomy (labels/statuses with colors, collections, section types), surfaced read-only via `get_compile_settings`. Degrades to taxonomy-only when `compile.xml` is absent.

### Manuscript Exporters (`src/services/export/manuscript-exporters.ts`)

Pure-JS binary export of the compiled manuscript to DOCX (`docx`), EPUB (`epub-gen-memory`), and PDF (`pdf-lib`), used by `export_project` alongside the inline Markdown/HTML/JSON paths.

## Data Flow

### Reading a Document

```
read_document(id)
  -> document-handlers.ts validates args
  -> ScrivenerProject.readDocument(id)
  -> ProjectLoader finds the binder item by UUID
  -> Reads RTF from Files/Data/{UUID}/content.rtf
  -> RTFHandler extracts plain text
  -> Returns text in MCP response
```

### Writing a Document

```
write_document(id, content)
  -> document-handlers.ts validates args
  -> ScrivenerProject.writeDocument(id, content)
  -> Writes content to Files/Data/{UUID}/content.rtf
  -> HMS memorizes content (zero-copy for large docs)
  -> Returns success
```

### Semantic Search

```
semantic_search(query)
  -> memory-handlers.ts generates traceId
  -> HolographicMemorySystem.queryText(query, k, traceId)
  -> native.query(text, k, traceId) [Rust via napi-rs]
  -> HmsCore encodes query as EntangledHVec
  -> Approximate nearest neighbor search
  -> Returns ranked results with similarity scores
```

## Logging

All logging goes to stderr (never stdout, which is reserved for JSON-RPC). The logger in `src/core/logger.ts` writes to `process.stderr`.

## Error Handling

Errors use the `AppError` class with typed `ErrorCode` values. Handlers catch errors and return them as MCP error responses. HMS failures are non-fatal; the server continues operating without semantic features.

## Generated Types

The HMS Rust crate auto-generates TypeScript types via `ts-rs` and JSON schemas via `schemars`. Generated files live in `src/types/generated/`. A type stub at `src/types/hms-native.d.ts` allows compilation when the native binary is unavailable.
