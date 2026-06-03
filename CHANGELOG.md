# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.4.0]: https://github.com/dcondrey/scrivener-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/dcondrey/scrivener-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dcondrey/scrivener-mcp/compare/v0.1.0...v0.2.0
[0.1.x]: https://github.com/dcondrey/scrivener-mcp/releases/tag/v0.1.0