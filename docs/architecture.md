# Architecture

For a user-facing feature overview, see the
[capability map](../assets/infographics/capability-map.png).

## Overview

Scrivener MCP is a stdio-based MCP server written in TypeScript. It reads and writes Scrivener 3
project files directly (XML binder structure + RTF document files) and exposes 82 tools over the
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

| Skill           | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Progressive load   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `project`       | open_project, get_structure, refresh_project, close_project, discover_projects, detect_open_project, get_compile_settings, get_manuscript_briefing, list_snapshots, read_snapshot, compare_snapshot, create_snapshot, verify_project_integrity, manuscript_dashboard                                                                                                                                                                                         | Startup (always)   |
| `documents`     | get_document_info, read_document, write_document, create_document, delete_document, move_document, update_document, review_changes                                                                                                                                                                                                                                                                                                                           | After open_project |
| `search`        | search, list_trash, restore_document, read_annotations, find_mentions, semantic_search, search_passages                                                                                                                                                                                                                                                                                                                                                      | After open_project |
| `analysis`      | analyze_document, enhance_content, generate_content, check_consistency, analyze_craft_local, check_continuity_local, analyze_foreshadowing_local, measure_voice_drift_local, analyze_opening_local, analyze_manuscript_local, analyze_narrative_annotations, check_style_local, find_repetition_local, analyze_rhythm_local, analyze_dialogue_tags_local, manuscript_style_report_local, set_writing_goal, get_writing_goals, set_writing_preferences, get_writing_preferences, collect_feedback, continuity_findings | On demand          |
| `compilation`   | compile_documents, export_project, get_statistics, generate_marketing_materials, export_manuscript                                                                                                                                                                                                                                                                                                                                                           | On demand          |
| `credentials`   | c2pa_capabilities, sign_content_credentials, validate_content_credentials                                                                                                                                                                                                                                                                                                                                                                                    | On demand          |
| `memory`        | remember, recall, manage_series, story_bible                                                                                                                                                                                                                                                                                                                                                                                                                 | On demand          |
| `relationships` | add_relationship, find_relationships, character_network, discover_connections, get_entity_references, find_orphaned_entities, suggest_connections                                                                                                                                                                                                                                                                                                            | On demand          |
| `advanced`      | queue_document_analysis, queue_project_analysis, suggest_improvements, analyze_writing_style, check_plot_consistency, get_job_status, cancel_job, get_queue_stats, editorial_workflow                                                                                                                                                                                                                                                                        | On demand          |

`list_skills`, `use_skill` and `read_result` are always available. In progressive mode, activating a
skill triggers `sendToolListChanged` to notify the client to fetch the tool list again. Clients
without notification support can use the complete descriptors returned by `use_skill`.

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
does not contain complete document text and is not used to filter these searches. All `search`
content modes use the same active-binder scope, including research and compile-excluded drafts.
`search_passages` and `semantic_search` use the editorial passage service for local hybrid or
bounded concept retrieval within the compilable manuscript. Source parsing caches are bounded and
keyed by freshly read raw-content hashes, preserving detection of saved external changes even when
file size and timestamps are unchanged.

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

The public `remember` contract validates and snapshots requests before queuing at most 32 writes.
Records use stable creation IDs; updates require existing IDs. The primary JSON file commits before
the new snapshot becomes visible or success is returned. `recall` binds its records to a canonical
snapshot revision and spools large responses. Missing profile, style and progress fields remain
unrecorded. Input JSON is bounded at 64 KiB, depth 32; complete memory is bounded at 16 MiB.

Reads use bounded regular-file descriptors, reject symlinks and invalid UTF-8, and preserve literal
JSON values. Invalid existing memory fails without a cleanup write. A missing primary with surviving
daily backups requires restoring a verified backup. Otherwise, initial loading can import the
optional SQLite snapshot or legacy tables using their actual columns. Secondary database mirrors
commit in one transaction with updates that preserve dependent rows; mirror failures are logged
after primary persistence. Primary JSON remains authoritative. Primary and daily backup use the same
snapshot.

A separate SQLite ownership record permits one live memory owner per project; short synchronous
transactions acquire and release ownership. Dead local processes can be recovered, while ambiguous
ownership fails explicitly. Files changed outside the owner fail revision checks before updates;
closing an unchanged session permits reopening the edited file. These checks do not provide an
atomic compare-and-swap against an external program that writes between revision verification and
rename.

The embedded Redis-compatible store follows the same load and save rules, preserves sorted-set
scores across restarts, and keeps a failed final save retryable with its background persistence
timers restored.

### Content Analyzer (`src/analysis/`)

Writing quality analysis: readability scores (Flesch-Kincaid), sentence variety, vocabulary
complexity, pacing, emotional arc, quality indicators (cliches, filter words).

Each analyzer owns its predictive caches. Cache timers start on first use, and prefetching starts
only when a loader exists. Projects, queues, and async service generations dispose their analyzers
during shutdown; pending analyses may finish without retaining new cached results or pooled
resources afterward. Replacements count only their size delta. Loader results beyond capacity are
returned to callers without caching.

`analyze_document` always reports saved-source revisions and complete decoded-text coverage.
Validated `analysisTypes` steer provider craft issues while readability and pacing remain baseline
assessments. The provider accepts whole sources up to 12000 UTF-16 characters; longer or empty
sources, provider errors and malformed reports use explicitly broad raw local analysis. Missing
provider fields are never filled with fabricated assessments, and malformed issues are never
silently discarded. Local analysis and grammar fail independently, preserving successful sibling
findings and declaring missing work. Saved revisions and project selection are rechecked before
returning results. Large reports use `read_result`; small reports retain their readable summary.

### Manuscript analysis (`src/services/editorial/`)

`NarrativeAnalysis` serializes project operations and owns a persistent `NarrativeContext` child.
The child owns the native 16 MiB manuscript cache; successful calls retain it, and terminating the
child discards it. Manuscript analysis, configured document analysis, control validation, finding
decisions and rechecks use this context. Annotation and comparison calls use separate short-lived
children. Each child request has a 30-second deadline; cancellation kills its child and waits for
exit. A child watchdog enforces the execution deadline if its owner dies. Closing the service drains
admitted operations before disposing its context. This is not a deadline for the complete workflow
or source I/O; workflow cancellation still takes effect between steps.

Child input/output limits are 64 MiB/16 MiB. The 384 MiB V8 old-generation setting accommodates
overlapping JSON source and decoded Unicode strings; it does not contain native RSS. A separate
one-vCPU Linux fixture verifies whole-workload cgroup OOM cleanup at 512 MiB with zero swap; the
application does not install that containment policy automatically. Its limits and platform scope
are recorded in the implementation ledger. Final source and cancellation checks precede synchronous
baseline persistence, and immutable paginated reports retain their source/configuration envelope.
The paged-report path retains comparison JSON produced by the trusted child serializer, avoiding a
second parsed comparison graph in the parent. Internal review callers still receive objects. The
combined report must fit the same 16 MiB limit before a baseline is committed. The annotation schema
is generated from the pinned source bundle in `assets/narrative-lens`; CI checks its version, source
hash and generated output without rewriting files.

### Content Enhancer (`src/services/enhancements/`)

The public `enhance_content` handler proposes a provider-generated rewrite for grammar, style,
clarity, expansion, summary or creative revision. It reads complete saved RTF through ProjectSource
and rejects sources beyond 12000 UTF-16 characters before provider use. Explicit editing options and
author preferences are included in the request identity; background context is fenced as data. The
saved revision is rechecked after generation. Exact input/output text and decoded-text coverage are
retained, with large results retrieved through `read_result`. Output is bounded at 64000 UTF-16
characters; token-limited, empty, malformed or failed provider output is explicitly unavailable. The
operation never writes a document. Native word counts and Flesch reading-ease differences are
measured independently; missing measurements are null without discarding the rewrite. No edit list,
quality score or applied-change count is invented. The unused local rewrite engine and its static
rewrite catalogs have been removed.

`generate_content` reads requested document context from saved RTF and character profiles from
project memory. It sends their actual contents to the provider, preserving the prompt and binding
source revisions, profile hashes, options and preferences to the common envelope. Document excerpts
are limited to 16000 UTF-16 characters without splitting a surrogate pair; coverage and truncation
are explicit. At most 32 profiles and 16 KiB of profile JSON are admitted. Selection and
source/profile revisions are checked before returning generated prose. Context-free generation reads
no manuscript text and declares a null project identity. Input limits follow JSON Schema Unicode
character counting: 16000 for the prompt and 1000 for the requested style. Target length is 1–2000
words; complete output is bounded at 64000 UTF-16 characters and uses `read_result` when large.
Token-limited or unavailable provider output remains an error; unavailable local word counting does
not discard generated prose.

### Warm memory integration (`src/services/memory/hhm/`)

The pinned `writerslogic-warm` 0.6.4 dependency supplies platform binaries and its own types. A
small CommonJS bridge resolves it relative to the installed server, independently of the client's
working directory. It does not load an arbitrary module from the manuscript directory.

Passage retrieval uses native document batches, replacement/deletion and BM25 fused with supplied
local ONNX model embeddings or the default story-concept vectors. Warm's official local embedding
and reranking factories load configured files only. The model/revision/dimension identity is
explicit; no model is downloaded. A local model requires the optional `@huggingface/transformers`
peer to be installed alongside the server; default installations omit Transformers and its ONNX
runtimes. The existing SQLite passage catalog remains authoritative. A durable pending-ID catalog
covers interrupted native updates; unchanged passages are reused. On
reopening, paged native document inventory repairs missing entries and removes stale owned passages.
Index maintenance follows changes. Native UTF-8 byte ranges are verified against exact quotations
before returning canonical UTF-16 manuscript locations and saved revisions. The full-project keyword
path preserves native postings optimizations; document scopes use explicit allowlists and every
returned passage is checked against current source provenance. Final verification selects all
returned documents from one fresh binder enumeration, rereads their saved bytes and checks revisions
and quotations. Documents moved outside Draft cause verification to fail; current titles and paths
accompany results after a rename.

The concept cache lives under `.scrivener-mcp/cache/passage-hms-v2`; configured models use
`passage-warm-<configuration SHA-256>` alongside it. Compatible wrappers share a native owner;
release drains work and flushes before dropping the reference. Warm 0.6.4 exposes no close method:
native OS locks can remain until garbage collection or process exit. Weak idle references allow
same-process reuse without retaining every closed store indefinitely. Another server's native lock
selects a process-local fallback; corruption and incompatible configurations fail explicitly.

The fallback implements document BM25 and supplied-vector cosine; its document cache is volatile and
rehydrates from SQLite. Legacy text/triplet/analogy APIs retain a TF-IDF projection fallback.
Character trigram analogies are associative suggestions, not proof of general semantic reasoning.
The legacy `similarityThreshold` option filters text, batch, analogy and triplet results before
ranks are assigned; it does not change document-search scoring. Values must be finite and within
[-1, 1]. Legacy `maxMemories`, `useGPU`, `autoEvolve` and `evolution` settings are rejected because
the adapter cannot enforce them. There is no global retention quota for the legacy store. Project
passage indexing retains its own bounded document, character and passage budgets. The scoped
vector-store adapter preserves document metadata and byte locations and closes owned consumers.

The fallback stores text by memory ID and defers vector construction until retrieval. After an
insertion or replacement, the next query, analogy, or concept synthesis rebuilds corpus-wide IDF
weights and every stored vector together. This keeps query and document vectors consistent while
avoiding a corpus scan for every item in a batch. See the
[contributor benchmark](../CONTRIBUTING.md).

### Relationship Engine (`src/services/relationship-engine.ts`)

Legacy text/triplet storage retains an existing `.scrivener-hms.db` in the launch directory when
present; otherwise its default is `~/.scrivener-mcp/hms-v0.6.4`. Set `SCRIVENER_WARM_STORAGE_DIR`
(or the legacy `SCRIVENER_HMS_STORAGE_DIR`) to override that location. This legacy store is separate
from the project-scoped passage cache and the curated facts/series database.

Public relationship tools use the project's existing editorial SQLite store, owned and closed by
`ScrivenerProject`. Deterministic SHA-256 identities bind typed endpoints and labels; idempotent
writes use synchronous transactions, and failures propagate as MCP tool errors. Queries match exact
stored endpoints. Networks read all stored character edges, including after reopening the project.
Discovery reuses the document-reference matcher against saved Draft text, reports measured document
co-occurrence and checks both saved-source and graph revisions before returning. It does not query
the shared legacy HMS store or infer entity identities from memory IDs. Legacy HMS data remains in
its original store without automatic attribution to a project.

Relationship output uses bounded result spooling. Storage is limited to 10000 edges; discovery is
limited to 256 recorded characters/locations, 1000 documents, 2 Mi UTF-16 source characters and the
source-character count multiplied by entity count at most 134217728. Internal chapter-sequence and
Neo4j-copy handlers remain hidden from MCP dispatch, as established by the tool registry; Neo4j is
not a dependency of public graph reads or writes.

Registry cross-reference tools read saved RTF through ProjectSource, with an explicit
selected-document or all-active-text scope. The latter includes Research and Draft items excluded
from Compile, while the default manuscript source remains Draft-only. Registry snapshots use
synchronous SQLite reads, bounded row/field admission and explicit availability for missing tables;
broken connections fail. Saved revisions, relevant binder metadata and registry identity are
rechecked after matching. Matchers are compiled once per analysis, use Unicode word boundaries and
preserve complete admitted offset lists. Full reference evidence is limited to 1000000 positions and
16 MiB of serialized mention records; co-occurrence discovery checks presence without allocating
offset arrays.

### Database Service (`src/handlers/database/`)

SQLite for structured data (writing sessions, content analysis history, entity relationships).
Optional Neo4j for graph queries (character relationships, story structure, theme progression).

Content analysis history preserves existing JSON records. New payloads of at least 4096 bytes use
versioned gzip/base64 storage when it is smaller; compressed records require a reader that supports
version 1. Writes and decoded history pages are limited to 64 MiB. Reads stream bounded rows and
reject corrupt encodings or excessive decompression. Up to 1000 history entries can be returned;
larger histories require explicit `limit`/`offset` pages, without deleting earlier records. Entries
with equal timestamps are ordered by descending insertion ID. Chapter context requests only the
latest entry.

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

Pure-JS binary export of the compiled manuscript to DOCX (`docx`), EPUB (JSZip and XML builders), and PDF
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
