# Architecture

For a user-facing feature overview, see the
[capability map](../assets/infographics/capability-map.png).

## Overview

Scrivener MCP is a stdio-based MCP server written in TypeScript. It reads and writes Scrivener 3
project files directly (XML binder structure + RTF document files) and exposes 78 tools over the
Model Context Protocol via skill-based registration (progressive disclosure by default; eager
registration is opt-in via `SCRIVENER_MCP_EAGER_TOOLS`).

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

Entry point. Creates the MCP `Server` instance, initializes the skill registry, and routes incoming
`CallToolRequest` messages to the appropriate handler.

### Skill Registry (`src/handlers/skill-registry.ts`)

Tools are organized into skills that load progressively by default to minimize token overhead; set
`SCRIVENER_MCP_EAGER_TOOLS=1` to register every skill at startup.

| Skill           | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                   | Progressive load   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `project`       | open_project, discover_projects, get_structure, refresh_project, close_project, verify_project_integrity, get_compile_settings, get_manuscript_briefing, list_snapshots, read_snapshot, compare_snapshot, create_snapshot                                                                                                                                                                                                               | Startup (always)   |
| `documents`     | get_document_info, read_document, write_document, create_document, update_document, move_document, delete_document                                                                                                                                                                                                                                                                                                                      | After open_project |
| `search`        | search, semantic_search, find_mentions, list_trash, restore_document, read_annotations                                                                                                                                                                                                                                                                                                                                                  | After open_project |
| `analysis`      | analyze_document, check_consistency, enhance_content, generate_content, set_writing_goal, get_writing_goals, set_writing_preferences, get_writing_preferences, collect_feedback, analyze_craft_local, check_continuity_local, analyze_foreshadowing_local, measure_voice_drift_local, analyze_opening_local, check_style_local, find_repetition_local, analyze_rhythm_local, analyze_dialogue_tags_local, manuscript_style_report_local | On demand          |
| `compilation`   | compile_documents, export_project, get_statistics, generate_marketing_materials                                                                                                                                                                                                                                                                                                                                                         | On demand          |
| `memory`        | remember, recall                                                                                                                                                                                                                                                                                                                                                                                                                        | On demand          |
| `relationships` | add_relationship, find_relationships, discover_connections, character_network, get_entity_references, find_orphaned_entities, suggest_connections                                                                                                                                                                                                                                                                                       | On demand          |
| `advanced`      | queue_document_analysis, queue_project_analysis, suggest_improvements, analyze_writing_style, check_plot_consistency, get_job_status, cancel_job                                                                                                                                                                                                                                                                                        | On demand          |

Two meta-tools (`list_skills`, `use_skill`) are always available. In progressive mode, activating a
skill triggers `sendToolListChanged` to notify the client to re-fetch the tool list.

### Handlers (`src/handlers/`)

Each handler file defines a set of MCP tools as `ToolDefinition` objects with:

- `name` -- tool name exposed to the client
- `title` -- human-readable display name
- `description` -- structured description: what it does, what it returns, when to use it vs related
  tools, and preconditions
- `inputSchema` -- JSON Schema with a described parameter for each input (shared definitions in
  `shared-schemas.ts`)
- `annotations` -- MCP behavior hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`)
- `handler` -- async function that executes the tool

Arguments are validated using typed extractors (`getStringArg`, `getOptionalNumberArg`, etc.) from
`src/handlers/types.ts`.

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

Handles file-level operations: finding the `.scrivx` file within a `.scriv` package, parsing XML,
managing file locks, and saving.

### Content Search (`src/services/project-content.ts`)

Literal, case-sensitive, and regular-expression searches read the current document text and use
`CompilationService.searchInDocuments`, honoring metadata and Trash options. The binder lookup index
does not contain complete document text and is not used to filter these searches. The default
`search` tool uses the editorial passage search service for hybrid lexical and semantic retrieval.

### Document Cache (`src/core/cache.ts`)

The shared LRU cache uses Map insertion order to track recency without a second access-order
collection. Reads promote entries; membership checks do not. Replacing an entry releases its
previous byte and entry capacity before enforcing limits.

### Document Writes (`src/services/document-writer.ts`)

Buffered writes retain mutation IDs, undo links, snapshot titles, and revision expectations.
Concurrent flushes share a drain. Document shutdown rejects new writes and waits for admitted
buffered, immediate, and raw writes before closing the mutation journal; failed buffered writes
remain available for a close retry. The coordinator also drains admitted snapshots, binder commits,
and recovery before releasing its journal. The project loader waits for admitted saves and restores,
including their backup preparation, before releasing its coordinator. A newer buffered write may
follow the writer's own successful edit when its revision was inferred; explicit revision
expectations still reject stale content. Failed commits remain queued with the same mutation ID for
retry.

### RTF Handler

Parses Scrivener's RTF format to extract plain text and formatting. Handles Scrivener-specific
extensions (annotations, comments) and Unicode.

### Memory Manager (`src/memory-manager.ts`)

Persistent key-value storage for project memory (character profiles, plot threads, style guide,
writing stats). Stored as JSON in `.ai-memory/` within the project.

Only a missing memory file initializes empty state. Unreadable or invalid existing files fail
loading without replacing the current memory or overwriting the file. Saves are serialized, and each
primary file and daily backup use the same serialized snapshot. The embedded Redis-compatible store
follows the same load and save rules, preserves sorted-set scores across restarts, and keeps a
failed final save retryable with its background persistence timers restored.

### Content Analyzer (`src/analysis/`)

Writing quality analysis: readability scores (Flesch-Kincaid), sentence variety, vocabulary
complexity, pacing, emotional arc, quality indicators (cliches, filter words).

Each analyzer owns its predictive caches. Cache timers start on first use, and prefetching starts
only when a loader exists. Projects, queues, and async service generations dispose their analyzers
during shutdown; pending analyses may finish without retaining new cached results or pooled
resources afterward. Replacements count only their size delta. Loader results beyond capacity are
returned to callers without caching.

### Content Enhancer (`src/services/enhancements/`)

Applies targeted improvements to text (12+ enhancement types). Uses the style guide when available.

### Holographic Memory System (`src/services/memory/hhm/`)

The declared `holographic-memory` 0.6.4 dependency supplies platform binaries and its own types. A
small CommonJS bridge resolves it relative to the installed server, independently of the client's
working directory. It does not load an arbitrary module from the manuscript directory.

Passage retrieval uses native document batches, replacement/deletion and BM25 fused with supplied
story-concept embeddings. The model/revision/dimension identity is explicit; no model is downloaded.
The existing SQLite passage catalog remains authoritative. A durable pending-ID catalog covers
interrupted native updates; unchanged passages are reused. Native UTF-8 byte ranges are verified
against exact quotations before returning canonical UTF-16 manuscript locations and saved revisions.
The full-project keyword path preserves native postings optimizations; document scopes use explicit
allowlists and every returned passage is checked against current source provenance.

The cache lives under `.scrivener-mcp/cache/passage-hms-v2`. Compatible wrappers share a native
owner; release drains work and flushes before dropping the reference. HMS 0.6.4 exposes no close
method: native OS locks can remain until garbage collection or process exit. Weak idle references
allow same-process reuse without retaining every closed store indefinitely. Another server's native
lock selects a process-local fallback; corruption and incompatible configurations fail explicitly.

The fallback implements document BM25 and supplied-vector cosine; its document cache is volatile and
rehydrates from SQLite. Legacy text/triplet/analogy APIs retain a TF-IDF projection fallback.
Character trigram analogies are associative suggestions, not proof of general semantic reasoning.
The scoped vector-store adapter preserves document metadata and byte locations and closes owned
consumers.

The fallback stores text by memory ID and defers vector construction until retrieval. After an
insertion or replacement, the next query, analogy, or concept synthesis rebuilds corpus-wide IDF
weights and every stored vector together. This keeps query and document vectors consistent while
avoiding a corpus scan for every item in a batch. See the
[contributor benchmark](../CONTRIBUTING.md).

### Relationship Engine (`src/services/relationship-engine.ts`)

Legacy text/triplet storage retains an existing `.scrivener-hms.db` in the launch directory when
present; otherwise its default is `~/.scrivener-mcp/hms-v0.6.4`. Set `SCRIVENER_HMS_STORAGE_DIR` to
override that location. This legacy store is separate from the project-scoped passage cache and the
curated facts/series database.

Dual-write relationship storage that writes to HMS (always) and Neo4j (when connected). HMS handles
fast lookups via triplet queries. Neo4j adds advanced graph operations (PageRank, community
detection, shortest path) when available. Relationships persist in the local triplet store and can
be synced to Neo4j on demand.

### Database Service (`src/handlers/database/`)

SQLite for structured data (writing sessions, content analysis history, entity relationships).
Optional Neo4j for graph queries (character relationships, story structure, theme progression).

Document synchronization finishes optional graph I/O before an atomic SQLite upsert, keeping local
transactions out of remote waits. Queue synchronization commits each document independently and
reports individual failures, so a failed document cannot roll back a sibling already counted as
successful. Document and character upserts update existing rows by ID, preserving creation dates,
compile flags, character arcs, appearances, and dependent records. These stores do not provide a
distributed atomic commit; retries can repair a graph write followed by a local failure.

SQLite initialization, backup, and shutdown run in invocation order. Backups return a promise that
resolves after copying finishes; shutdown waits for admitted copies. Failed initialization releases
its connection, and failure to close an optional cache does not prevent closing SQLite. Callback
transactions must be synchronous and abort by throwing. Busy retries release their transaction
before backoff and cannot join an unrelated active transaction or reopened connection.

`DatabaseService` applies the same lifecycle ordering across SQLite and optional Neo4j resources,
including backups. Shutdown awaits every owner even when another fails, resets readiness, and
retains failed owners for cleanup retries. Reopening recreates its derived services against the new
connections; migration failures release partially initialized storage before an initialization
retry.

The legacy transaction-ticket API shares one physical transaction across nested tickets. Commits
follow reverse begin order; child commits remain subordinate to the root, and rolling back an active
ticket aborts the entire group. Finished or closed-connection tickets cannot commit or roll back
later work.

### Cross-Reference Engine (`src/services/document-references.ts`)

Pure, deterministic detection of which documents mention the project's registered characters and
locations, via exact whole-word case-insensitive matching -- no Neo4j or AI. Backs
`get_entity_references` (document→entities and entity→documents), `find_orphaned_entities`, and
`suggest_connections` (which infers missing links from cross-document co-occurrence), so those tools
work with no external services.

### Compile Settings (`src/services/compile-settings.ts`)

Defensive reader for Scrivener's undocumented `Settings/compile.xml` and the `.scrivx` taxonomy
(labels/statuses with colors, collections, section types), surfaced read-only via
`get_compile_settings`. Degrades to taxonomy-only when `compile.xml` is absent.

### Manuscript Exporters (`src/services/export/manuscript-exporters.ts`)

Pure-JS binary export of the compiled manuscript to DOCX (`docx`), EPUB (`epub-gen-memory`), and PDF
(`pdf-lib`), used by `export_project` alongside the inline Markdown/HTML/JSON paths.

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
  -> PassageSearch refreshes saved revisions in the SQLite catalog
  -> Incremental native document upserts/deletions with durable pending IDs
  -> HolographicMemorySystem.searchDocuments(query, scoped options)
  -> Native document BM25 and supplied local concept vectors
  -> Verify project, identity, source revision and UTF-8 byte ranges
  -> Return canonical UTF-16 manuscript context and relevance scores
```

## Logging

All logging goes to stderr (never stdout, which is reserved for JSON-RPC). The logger in
`src/core/logger.ts` writes to `process.stderr`.

## Error Handling

Errors use the `AppError` class with typed `ErrorCode` values. Handlers catch errors and return them
as MCP error responses. Missing native bindings and an externally owned native cache select local
fallback retrieval; corrupt stores, invalid data and incompatible configurations fail explicitly.

## Generated Types

HMS Node types come from its published NAPI-RS declarations. The wrapper narrows metadata to bounded
JSON and validates inputs for both backends; there is no parallel ambient declaration that can mask
an SDK change. Runtime fallback selection does not replace the published TypeScript contract.
