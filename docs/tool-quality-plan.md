# Tool Quality & Consolidation Plan

Goal: every tool scores 5/5 on all six Glama TDQS metrics (Purpose, Conciseness,
Completeness, Parameters, Behavior, Usage Guidelines) **and** the server-level
coherence metrics (Disambiguation, Naming, Tool Count) — by making the tool
surface genuinely easier for an agent to use, not by gaming the score.

## The 5/5 definition template

Every tool definition must provide:

1. **`title`** — human-readable, Title Case (e.g. "Open Scrivener Project").
2. **`description`** — structured, tight, and covering, in order:
   - one sentence of **purpose** (what it does);
   - what it **returns** (fields / shape);
   - **usage guidelines** — when to use it, when not to, and the related tool to
     prefer instead;
   - any precondition (e.g. "requires an open project").
3. **`inputSchema`** — every parameter has a real `description` (never circular
   like "Max depth"), states units/format/constraints, gives an example where
   non-obvious, and `required` is accurate. Use `enum` for closed sets.
4. **`annotations`** — `readOnlyHint`, `destructiveHint`, `idempotentHint`,
   `openWorldHint` set honestly (see rules below).
5. **`outputSchema` + `structuredContent`** — added in Phase 5 so Completeness is
   backed by a machine-readable result shape (handlers return both text and
   structuredContent for backward compatibility).

### Annotation rules

- `readOnlyHint: true` — pure read, no state change (get_*, search_*, list_*).
- `destructiveHint: true` — irreversible / data-losing (delete_document; trash is
  recoverable so delete is destructive but recover exists).
- `idempotentHint: true` — repeating the call lands the same state.
- `openWorldHint: true` — touches filesystem / network / external DB outside the
  in-memory project (open_project, discover_projects, refresh_project, sync_*).

## Consolidation remap (69 → ~33)

Legend: **keep** · **rename** · **merge→** (folds into another tool, usually via a
new param) · **hide** (internal plumbing, dropped from the public tool list).

### Project (5 — done, Phase 1)
open_project · get_structure · refresh_project · close_project · discover_projects — **keep**

### Documents (15 → 9)
- read_document — keep (absorbs read_document_formatted via `format` param)
- read_document_formatted — merge→ read_document
- get_document_annotations — rename → read_annotations
- get_document_info — keep (absorbs get_word_count)
- get_word_count — merge→ get_document_info
- write_document · create_document · delete_document · move_document — keep
- rename_document — merge→ update_document
- update_metadata — rename → update_document (absorbs rename_document)
- get_all_documents — merge→ get_structure (flat listing already covers it)

### Trash (3 → 2)
- list_trash — keep
- recover_document — rename → restore_document
- search_trash — merge→ search (`scope: "trash"`)

### Search & retrieval (10 → 3)
- search_content — rename → search (keyword/full-text, `scope` covers trash)
- semantic_search — keep (canonical embedding search)
- vector_search — merge→ semantic_search
- fractal_search — merge→ semantic_search (backend variant)
- find_document — merge→ search
- find_mentions — keep (entity occurrence finder)
- find_cooccurrences — merge→ analyze (co-occurrence is an analysis)
- find_analogies — hide (experimental HMS)
- cross_reference_analysis — merge→ find_relationships
- build_vector_store — hide (index built automatically on open/write)

### Analysis (11 → 4)
- analyze_document — keep (absorbs style/narrative via `aspects` param)
- analyze_writing_style — merge→ analyze_document
- analyze_narrative — merge→ analyze_document
- multi_agent_analysis — hide (internal orchestration; surfaced via analyze_document depth)
- check_consistency — keep (absorbs plot/character via `scope` param)
- check_plot_consistency — merge→ check_consistency
- check_character_continuity — merge→ check_consistency
- track_motifs — keep (distinct literary feature)
- generate_ai_suggestions — rename → suggest_improvements
- enhance_content · generate_content — keep (generative; distinct from analysis)

### Compilation & export (5 → 3)
- compile_documents — keep (absorbs intelligent via `mode` param)
- intelligent_compilation — merge→ compile_documents
- export_project — keep
- generate_marketing_materials — keep (rewrite description; niche but valid)
- get_statistics — merge→ get_structure (`summaryOnly`)

### Memory (8 → 3)
- update_memory — rename → remember
- get_memory — rename → recall
- get_memory_stats — keep (absorbs analytics)
- get_memory_analytics — merge→ get_memory_stats
- update_retrieval_policy — hide
- hhm_dream — hide
- ingest_document_fractal · ingest_project_fractal — hide (indexing is automatic)

### Relationships / knowledge graph (8 → 4)
- add_relationship — keep
- find_relationships — keep (absorbs discover_connections, cross_reference)
- discover_connections — merge→ find_relationships
- character_network — keep
- store_chapter_order — hide (internal ordering)
- sync_to_neo4j — hide (sync is automatic)

### Async jobs (3 → 2)
- get_job_status — keep (needed for long analyses)
- cancel_job — keep
- get_queue_stats — hide

### Realtime / feedback (2 → 0)
- start_realtime_assistance — hide (experimental)
- collect_feedback — hide (internal telemetry)

### Meta (2 → 2)
- list_skills · use_skill — keep (drive progressive disclosure when opted in)

Result: ~33 focused, consistently named tools; verbs drawn from a fixed set
(get / list / read / write / create / update / delete / move / search / analyze /
check / compile / export). Internal plumbing no longer competes for the agent's
attention.

## Phases

- [x] **Phase 0** — infrastructure: `ToolDefinition` carries title/annotations/outputSchema; list handler passes them through.
- [x] **Phase 1** — project group to 5/5 (pilot, proves the template).
- [x] **Phase 2** — documents group consolidated 11→7 and to 5/5 (73 tests pass).
- [x] **Phase 3** — consolidation (BREAKING → 0.7.0): hidden 15 internal tools; merged read-formatting, rename+metadata, trash/title search, intelligent_compilation, deduped semantic_search, hid fractal_search/get_memory_analytics. **69 → 44 tools.**
- [x] **Phase 4** — 5/5 on the consolidated set: every registered tool now carries title + structured description + per-param docs + annotations. Current surface is **47 public tools** (goals + personalization tools were added after the original 44 count). The skill grouping was later corrected so `remember`/`recall` sit in the `memory` skill and `semantic_search` in `search`. Hidden tools (`find_analogies`, `hhm_dream`, `build_vector_store`, `multi_agent_analysis`, `store_chapter_order`, `sync_to_neo4j`, `get_queue_stats`) are excluded from the public list via `HIDDEN_TOOLS` in skill-registry. Final param-doc gap (16 tools whose `documentId`/`content`/`query`/`maxResults`/`folderId`/`includeTrash` came from description-less `SHARED_DEFS` fragments) closed by documenting those shared fragments. Gate: `npm run check:tools` (registry probe — dup names, hidden-tool leaks, 5/5 coverage, and outputSchema coverage; tsc/eslint miss all of these).
- [x] **Phase 5** — outputSchema + structuredContent. All **27 data-returning tools** declare an `outputSchema` and return a matching `structuredContent` object alongside their text; the schema mirrors each handler's real return shape (no invented fields). The **20 prose/ack tools stay text-only** (MCP makes `outputSchema` optional; a structured shape for generated prose or a status ack would be gaming, not Completeness). `HandlerResult` carries an optional `structuredContent`; the CallTool responder forwards it. `npm run check:tools` enforces the split via a `TEXT_ONLY` allowlist.

### Deferred (optional, lower-impact)
A few tools were brought to 5/5 instead of cross-file-merged (analyze_writing_style, check_plot_consistency, analyze_narrative, discover_connections, get_statistics). Merging them would take 44 → ~37 and lift the coherence "tool count" metric further, but involves cross-file logic surgery with real regression risk. Per-tool TDQS (the dominant failing metric) is already maxed at 5/5 across all 44, so this is a judgment call, not a blocker.
- [~] **Phase 6** — verify: tsc/lint/tests green ✓, registry re-introspected via `npm run check:tools` ✓, README "All Tools" + all docs regenerated from the authoritative registry ✓, CHANGELOG auto-generated from commits by the changelog bot ✓. Remaining: re-run the external Glama build + score (out-of-band; not runnable from this repo).

Non-breaking work (Phases 1, 2, 5 on kept tools) ships continuously. The breaking
consolidation (Phase 3) lands as a single 0.7.0 with a migration note.
