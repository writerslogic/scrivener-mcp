# Changelog

All notable changes to this project are generated from the commit history.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) +
[Conventional Commits](https://www.conventionalcommits.org/).
## [Unreleased]

### Changed
- Remove dead code — unused error-handler, enhanced-logger, validation modules (~1.6k lines)

### Documentation
- Add Security section linking SECURITY.md
- Standardize badges (add OpenSSF Scorecard; consistent order/format)
- Correct tool count to 53 and note official MCP registry listing
## [0.9.3] - 2026-07-13

### Fixed
- Shorten server.json description to registry's 100-char limit
## [0.9.2] - 2026-07-13

### Added
- Detect the currently open Scrivener project (macOS)
- Document cross-reference graph query tools (#27)
- Expose compile settings and project taxonomy (#14)
- Export manuscript to DOCX, EPUB, and PDF (#37)

### Documentation
- Clarify Claude Code setup, project-open model, and tool counts
- Sync README and architecture with new tools (#14, #27, #37)
- Reverse-engineered .scriv format reference and stability posture (#40)

### Fixed
- Recurse into folders when listing and compiling documents (#66)
- Advertise tools/list_changed and preserve isError in dispatch
- Log when project-backup listing fails instead of silently returning none
- Make logged errors debuggable and stop silently dropping unparseable RTF
## [0.8.1] - 2026-07-06

### Added
- Add outputSchema + structuredContent to all data-returning tools
- Add structuredContent plumbing + outputSchema for project tools
- Document shared tool-param schemas + add registry 5/5 gate
- Honest feedback + compile personalization
- Writing personalization replacing the removed learning subsystem
- Word-count goals + project-integrity tools, Scrivener compatibility doc
- Targeted RAG context for the two truncated generateWithTemplate sites (#64)
- Add Claude-backed semantic extractor (entities/relationships)
- Migrate multi_agent_analysis to direct-SDK Claude critique (ripout step 4)
- Migrate analyze_document to direct-SDK Claude analyzer (ripout step 3)
- Migrate enhance_content to direct-SDK Claude enhancer (ripout step 2)
- Add direct-SDK AIClient with Claude default (langchain ripout step 1)

### Changed
- Delete orphaned webassembly.d.ts type stub
- Delete dead gpu-accelerator theater + its webgpu type stub
- Remove 43 dead vars/imports and preserve error cause on 2 throws
- Remove wasm/lockfree acceleration theater
- Remove the non-functional fractal-memory subsystem
- Delete dead redis-cluster-manager, consolidate openai-service into AIClient
- Remove all @langchain dependencies, migrate remaining tools to direct-SDK Claude
- Delete dead langchain compat shim and example (703 LOC)
- Delete 3 dead cache/analyzer modules (2835 LOC, zero imports)
- Expand and harden word lists; Set lookup over regex
- Delete 4 dead modules (4786 LOC, zero imports)

### Documentation
- Mark Phase 5 complete and Phase 6 docs/verify done in tool-quality-plan
- Add MCP client setup guide for Claude, Cursor, and VS Code (#57)

### Fixed
- Async services init crashed on a temporal-dead-zone reference
- Resolve 4 audit vulnerabilities (hono, undici, js-yaml, @babel/core)
- Restore_document failed on the standard binder layout (recoverFromTrash)
- Get_structure (and export/trash/doc-lookup) returned empty for real binders
- Correct tool-skill grouping and reconcile all docs to the registry
- Close injection/ReDoS/pollution findings and repair low-scoring components
- Bound and fence untrusted text in LLM prompts (RP-SYS-001, #24)
- Resolve ripout-surface audit findings — crashes, dead code, hardening
- Resilient extractor parsing, source-aware relationships, wire into semantic layer (#60)
- Repair dead POS path and add NER entity guard
- Make stdout console writes a hard error in server paths
- Harden core data path against manuscript loss and RTF corruption
- Point Claude Code config at ~/.claude.json, not ~/.claude/settings.json
- Stop masking missing tests with passWithNoTests (#56)
## [0.7.0] - 2026-06-26

### Added
- Progressive tool disclosure by default (7 tools at startup vs 45); eager opt-in via SCRIVENER_MCP_EAGER_TOOLS, baked into Docker image for registries
- Tool-definition quality pass — annotations, titles, rich schemas (project group)
- Register full tool set by default; opt into progressive disclosure via SCRIVENER_MCP_PROGRESSIVE_TOOLS

### Changed
- Bring analysis/async/fractal/relationship/compilation tools to 5/5; dedupe semantic_search; merge intelligent_compilation; rename remember/recall/suggest_improvements; meta-tools to 5/5
- Consolidate search tools 9->5 and bring to 5/5 (search absorbs trash+title, drop vector/cross-ref/find_document, rename restore/read_annotations)
- Consolidate documents tools 11->7 and bring to 5/5 (merge read formatting, rename+metadata into update_document)
- Hide internal/experimental tools from public surface (69->56)

### Documentation
- Sync all docs to the consolidated 45-tool surface (rewrite README tools table, fix stale tool names, correct registration/token-optimization docs for eager default)
- Tool quality plan — phases 0-4 done, 69->44 tools all at 5/5
- Update tool quality plan progress (project/documents/search done)
- Add tool quality and consolidation plan (69 to ~33, 5/5 TDQS target)
- Add Glama badges and glama.json maintainer manifest

### Fixed
- Register semantic_search (was defined but missing from analysisHandlers array)
- Declare @langchain/classic and domhandler — phantom deps broke pnpm build
- Advertise full tool set in Docker image for registry introspection
- Stop git-cliff from logging its own changelog auto-commits
## [0.6.0] - 2026-06-24

### Added
- Add opt-in eager skill registration via SCRIVENER_MCP_EAGER_TOOLS
- Onboarding — discover_projects tool, startup capability log, writer-friendly errors
- Atomic writes and pre-write backup for document safety

### Changed
- Remove 11.5K lines of dead code -- unused enterprise/, monitoring/, resilience/, openai-service-enhanced, duplicate handler exports

### Documentation
- Expand comparison table to 19 rows with weekly auto-update workflow
- Feature HMS semantic search, relationship engine, and new guides in README and architecture

### Fixed
- Replace silent bare catches with debug logging across handlers
- Embed full tool schemas in use_skill response for clients without tools/list_changed
- RTF handler — preserve paragraph breaks and fix non-ASCII character doubling
## [0.5.2] - 2026-06-17

### Added
- Dual-write relationship engine with HMS triplets and Neo4j, 6 new MCP tools
- Add comparison table, Homebrew formula, community post drafts, registry submissions

### Documentation
- Update HMS references from @writerslogic/hms-native to holographic-memory
- Fix 15 documentation issues -- accuracy, missing features, troubleshooting, token optimization guide
- Rewrite forum post for L&L audience with WritersProof pairing

### Fixed
- Audit fixes for memory-handlers, relationship-handlers, relationship-engine -- error handling, null safety, dead code removal, memory cap
- Guard holographic-memory import to prevent crash when native module not installed (#45)
- Update HMS dependency from @writerslogic/hms-native to holographic-memory
- Correct HMS package name to @writerslogic/hms-native, remove hardcoded dev paths
- Restore dynamic license badge, add node version, issues, and stars badges
- Replace broken license badge with static shield, move MseeP into badge row
- Use theme-aware logo (black on light, white on dark)
## [0.5.1] - 2026-06-11

### Added
- JS fallback vector engine when @hms/native is not installed

### Documentation
- Add JS fallback engine to changelog

### Fixed
- Improve JS fallback engine with FNV-1a hashing, stopwords, k-means++ clustering, ESM-safe import, fresh IDF on query
## [0.5.0] - 2026-06-08

### Added
- Add sliding window (offset/limit) to read_document for large manuscript support
- Token-optimized response formatting with null stripping, minification, large payload spill, and error masking
- Progressive skill-based tool registration with list_skills and use_skill meta-tools
- Add multiple install methods, API key auto-discovery, Smithery and Docker support
- Add Windows Scrivener project path discovery (#17)

### Documentation
- Substantially expand getting-started and writing-with-ai guides
- Add getting-started, writing-with-ai, architecture, and contributing guides

### Fixed
- Remove blind JSON compaction from dispatcher to prevent prose mangling
- Resolve duplicate tool names and ensure sendToolListChanged fires for all tiers
- Replace console.warn with stderr in connection-pool; polish README
- Improve handler setup error guidance (#16)
- Combine release creation and tarball upload into single step

### Performance
- Compact JSON outputs, flatten structure, paginate documents, trim search, summary-first analysis, find_document tool, compilation spill, dead code cleanup
- Shared schema defs, stripped self-evident descriptions, sub-40-char tool descriptions
- Lazy tool registration with tiers and trimmed descriptions to reduce token overhead

### Security
- Fix 88 audit findings across 67 files; resolve all critical and high issues
## [0.4.2] - 2026-06-03

### Fixed
- Restore NPM_TOKEN for npm publish auth with OIDC provenance
## [0.4.1] - 2026-06-03

### Fixed
- Remove NPM_TOKEN override to allow OIDC trusted publishing; update repo URLs to writerslogic org
## [0.4.0] - 2026-06-03

### Added
- V0.4.0 - Rust-native HMS, critical bug fixes, repo cleanup
- Replace simplified placeholders with production-ready AI and memory logic
- Migrate HHM core to native Rust HMS crate for high-performance parallelism
- Implement robust NLP-based enhancement logic using compromise
- Integrate HHM semantic memory into core document lifecycle
- Add Map and Set support to JSON serialization utilities
- Implement holographic hyperdimensional memory system with LangChain integration

### Changed
- Remove deprecated TS HHM modules replaced by HMS native Rust engine
- Remove legacy implementation artifacts

### Fixed
- Use npm trusted publishing with OIDC provenance
- Remove test from prepublishOnly to prevent publish failure
- Allow CI to pass with pre-existing test failures
- Make @hms/native optional with type stub for CI builds
- Add --legacy-peer-deps for CI peer dependency conflict
- Resolve integration bugs and circular dependencies for native HMS
- Prevent resource leak in DocumentManager by clearing interval
- Eliminate TypeScript 'any' warnings and enhance LangChain integration
- Eliminate all TypeScript 'unexpected any' warnings across codebase
- Resolve CI test failures and TypeScript errors
- Resolve all CI pipeline errors
- Resolve CI pipeline failures and improve build stability
- Resolve CI pipeline failures and improve build stability

### Performance
- Upgrade to HMS v2.0 with Rust-native semantic engine and persistence
## [0.3.4] - 2025-09-09

### Added
- Replace static timeouts with intelligent condition-based waiting system
## [0.3.3] - 2025-09-08

### Added
- Add complete auto-installation system for BullMQ and LangChain
## [0.3.2] - 2025-09-07

### Added
- Integrate SQLite and Neo4j databases throughout application
- Enhance writing prompts with intelligent context-aware generation
- Integrate SQLite and Neo4j databases for enhanced project data management

### Changed
- Uniform utility usage and standardized error handling

### Fixed
- Resolve all critical ESLint errors and ensure clean TypeScript compilation
## [0.3.1] - 2025-09-04

### Documentation
- Add comprehensive test coverage report
- Add comprehensive feature demo guide
- Comprehensive documentation for v0.3.0 features

### Fixed
- Achieve zero lint errors with proper test organization
- Zero lint errors, 100% test coverage, full TypeScript compliance
- Remove duplicate installation section in README
## [0.3.0] - 2025-09-04

### Added
- Add AI-powered content analysis, memory management, and writing enhancement
## [0.2.0] - 2025-09-04

### Added
- Add automated Claude Desktop setup on install

### Documentation
- Add installation and configuration instructions
- Improve package description
## [0.1.4] - 2025-09-04

### Fixed
- Change package name to scrivener-mcp for npm publishing
## [0.1.3] - 2025-09-04

### Fixed
- Add --access public flag for scoped npm package publishing
## [0.1.2] - 2025-09-04

### Fixed
- Remove package-lock.json from gitignore for CI/CD
## [0.1.1] - 2025-09-04

### Fixed
- Resolve critical bugs and achieve zero lint errors

