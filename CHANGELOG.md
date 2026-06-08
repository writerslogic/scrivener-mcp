# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-06-08

### Security
- Fix 10 command injection vulnerabilities: shell exec replaced with execFile/execFileSync across auto-installer, adaptive-timeout, condition-waiter, shared-patterns, permission-manager, ai-config-wizard.
- Fix 4 SQL/Cypher injection vulnerabilities: identifier escaping in query builders, FTS5 sanitization, Neo4j label/relationship validation.
- Fix 5 path traversal vulnerabilities: validation in RTF handler, setup wizard, project loader.
- Fix ReDoS in search service RegExp and RTF parser nested regex (replaced with iterative parser).
- Fix unsafe JSON-LD deserialization with schema validation.
- Restrict dashboard CORS from wildcard to localhost.
- Add API key masking in log output.
- Resolve all 31 npm dependency vulnerabilities (0 remaining).

### Added
- **Skill-based progressive tool registration**: only 6 tools at startup instead of 58. Skills hydrate on demand via `list_skills` and `use_skill` meta-tools with `sendToolListChanged` notifications. ~94% reduction in initial token overhead.
- **Sliding window reads**: `read_document` accepts `offset` and `limit` (word-based) for large manuscripts.
- **Flattened binder output**: `get_structure` defaults to compact `[id, title, type, depth, wordCount, hasChildren]` array format.
- **Paginated document listing**: `get_all_documents` with `offset`/`limit` (default 50).
- **`find_document` tool**: search by title pattern without fetching the full binder tree.
- **Summary-first analysis**: `analyze_document` returns compact scores + top 3 issues instead of full JSON blob.
- **Response formatter**: null stripping, error masking, large payload spill to disk with tracker IDs.
- **Compilation disk spill**: compiled manuscripts over 4K chars write to temp file, return metadata + path.
- **API key auto-discovery**: checks `~/.env`, `~/.openai/key`, `~/.scrivener-mcp/.env`, and macOS Keychain.
- **Multiple install methods**: npm, npx, Smithery, GitHub direct, Docker.
- **Smithery registry support** (`smithery.yaml`).
- **Dockerfile** for containerized deployment.
- **`COMMERCIAL_LICENSE.md`** for dual-license (AGPL-3.0 + commercial).
- **Windows Scrivener path discovery** (PR #17): case-insensitive .scrivx resolution, drive-letter path preservation.
- **Actionable handler error messages** (PR #16): document-not-found guidance, .scrivx path acceptance.

### Fixed
- 88 audit findings across 67 files (25 critical, 63 high severity).
- Race conditions: re-entrancy guards on scheduler, context-sync, memory-redis, singleton initialization, transaction state.
- Lock-free structures: removed fake CAS loops, added iteration limits, resize guard.
- Silent error handling: mock Math.random() recovery replaced with honest returns, floating promises caught, error context preserved.
- Timer leaks: intervals stored and cleared on shutdown in adaptive-memory, enhanced-logger, langchain-continuous-learning.
- N+1 queries: batched Neo4j queries, parallelized Redis operations, Promise.all for batch analysis and word counts.
- Performance: busy-wait replaced with async sleep, O(n^2) algorithms replaced with map lookups, unbounded caches capped.
- Stub implementations replaced: real disk/network metrics, real HTTP health checks, real document content reads.
- `console.warn` on stdout in connection-pool replaced with stderr.

### Changed
- License changed from MIT to AGPL-3.0 with commercial dual-license option.
- Tool descriptions trimmed to under 40 characters with shared schema definitions.
- JSON outputs use `compact()` (no indentation, nulls stripped) for data responses.
- Search results return 100-char snippets instead of full content.
- `enhance_content` returns "No changes suggested" instead of echoing full text on no-op.
- Postinstall auto-configures Claude Desktop silently (no wizard prompts).
- Setup wizard detects Claude Desktop, Claude Code, and Cursor.
- Dead tier-based registration code removed (handlers/index.ts: 149 lines to 7).

## [0.4.0] - 2026-06-03

### Fixed
- **Critical: Logging corrupts JSON-RPC stream** (#3, #6, #7, #8) - All logging now routes to stderr instead of stdout, which was causing Claude Desktop to fail with JSON parse errors and lose state between tool calls.
- **Critical: Tool results invisible to MCP clients** (#7) - Handler responses were attaching structured payloads in a non-standard `data` property on text content blocks, which clients silently drop. All ~40 locations now serialize payloads into the `text` field per the MCP spec.
- **`update_metadata` ignores custom metadata** (#5) - The `customMetadata` parameter is now accepted in the tool schema and wired through to `MetadataManager.updateCustomMetadata()`.
- Circuit breaker fix in HMS native module.
- SQL injection fix in database layer.
- Stale import fixes and type cleanup removing `as any` casts.

### Added
- **Rust-native Holographic Memory System (HMS) v2.0** with napi-rs bindings.
  - `ts-rs` + `schemars` auto-generate TypeScript types and JSON schemas from Rust structs.
  - Generated types: `ConceptCandidate`, `RetrievalResult`, `TextMetrics`, `MemorizeBatchItem`, `HmsError`.
  - Batch memorize API (`memorizeBatch`) with rayon parallel encoding.
  - Zero-copy Buffer ingestion (`memorizeTextBuffer`) avoiding UTF-8 copy at the napi boundary.
  - File path shunting (`memorizeFile`) via memmap2.
  - `thiserror`-based `HmsError` enum with JSON-RPC error codes.
  - Structured `traceId` support on key napi methods with `tracing` crate instrumentation.
- **Fractal Narrative Memory** - Multi-scale document segmentation (micro/meso/macro) with graph-boosted retrieval.
- Generated JSON schemas loaded at startup for HMS-facing MCP tool definitions.
- `memorizeTextBuffer` wrapper; document write handler uses zero-copy path for content > 10KB.

### Changed
- `indexSegments` calls `memorizeBatch` once per scale instead of looping `memorizeText` per segment.
- 11 `args as unknown as XxxArgs` double casts in fractal-memory-handlers replaced with typed extractors (`getStringArg`, `getOptionalNumberArg`, etc.).
- `readFileSync`/`writeFileSync` in config-manager, first-run, and ai-config-wizard converted to `fs/promises`.
- 18 `Date.now()+Math.random()` ID patterns replaced with `crypto.randomUUID()`.
- `RetrievalResult` renamed to `FractalRetrievalResult` in fractal-narrative-memory; `TextMetrics`/`getTextMetrics` renamed to `WritingTextMetrics`/`getWritingTextMetrics` in text-metrics to avoid collisions with generated HMS types.
- `registerHHMHandlers(_server: any)` now properly typed with `Server` from `@modelcontextprotocol/sdk`.

## [0.3.0] - 2024-01-04

### Added
- **Memory Management System**
  - Persistent project memory stored in `.ai-memory` folder within each project
  - Character profiles with relationships and arc tracking
  - Plot thread management with status tracking
  - Style guide for maintaining consistent voice and tone
  - Writing statistics and progress tracking
  - Automatic backups with 7-day history

- **Advanced Content Analysis**
  - Deep writing metrics (Flesch scores, readability grades)
  - Style analysis (sentence variety, vocabulary complexity)
  - Structure analysis (scene breaks, chapters, pacing)
  - Quality indicators (clichés, filter words, repetitiveness)
  - Emotional analysis and tension tracking
  - Actionable writing suggestions

- **Content Enhancement Engine**
  - 12+ enhancement types for prose improvement
  - Filter word elimination
  - Verb strengthening
  - Sentence variation
  - Sensory detail enhancement
  - Show don't tell conversions
  - Pacing adjustments
  - Content expansion/condensing

- **New MCP Tools**
  - `deep_analyze_content` - Comprehensive content analysis
  - `enhance_content` - Apply writing improvements
  - `save_character_profile` - Store character data
  - `get_character_profiles` - Retrieve characters
  - `update_style_guide` - Set writing preferences
  - `get_style_guide` - Get style settings
  - `save_plot_thread` - Track plot lines
  - `get_plot_threads` - View plot threads
  - `get_writing_stats` - Project statistics
  - `export_project_memory` - Export all memory

### Changed
- `analyze_document` now uses the new ContentAnalyzer for deeper insights
- `critique_document` provides more detailed, actionable feedback

### Technical
- Added TypeScript modules: `memory-manager.ts`, `content-analyzer.ts`, `content-enhancer.ts`
- Memory data persists within Scrivener projects for portability
- Automatic 5-minute save intervals for memory updates

## [0.2.0] - 2024-01-04

### Added
- Automated Claude Desktop setup on installation
- Postinstall script for automatic configuration
- Setup and uninstall scripts for easy management

## [0.1.x] - 2024-01-03

### Initial Release
- Core Scrivener project operations
- RTF parsing and generation
- Basic content analysis
- Document CRUD operations
- Project structure navigation

[0.5.0]: https://github.com/writerslogic/scrivener-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/writerslogic/scrivener-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/writerslogic/scrivener-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/writerslogic/scrivener-mcp/compare/v0.1.0...v0.2.0
[0.1.x]: https://github.com/writerslogic/scrivener-mcp/releases/tag/v0.1.0