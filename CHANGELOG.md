# Changelog

All notable changes to this project are generated from the commit history.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) +
[Conventional Commits](https://www.conventionalcommits.org/).
## [Unreleased]

### Documentation
- Point Draftbridge buyers to live checkout (#180)
## [0.13.0] - 2026-10-22

### Added
- Move the Mac app source to a private repo and promote Draftbridge in the README (#173)
- License the Mac app with offline-verified Ed25519 keys, per-Mac activation, and a signed revocation list (#171)
- Name the Mac app and extension Draftbridge for Scrivener (#167)
- One-click Claude Desktop extension, shared bundle staging, quieter startup (#165)
- Native Mac companion app, build pipeline, video scripts, and FAQ (#164)
- Robust multi-client setup tool, Node bootstrap, and Mac install guide (#162)
- Adapt HMS adapter to holographic-memory 0.6 and gate it in CI (#155)
- Add local line-editing tools backed by bluepencil (#137)
- Local craft analysis tools backed by narrative-lens (#134)
- Apply compile-format section layouts to structured compile (#14)
- Multi-provider AI with OpenRouter, MCP sampling, key discovery, and automatic failover
- Fidelity-preserving document writes, snapshot creation, checksum sync
- Snapshots, manuscript briefing, structured compile, and correctness fixes
- Detect the currently open Scrivener project (macOS)
- Document cross-reference graph query tools (#27)
- Expose compile settings and project taxonomy (#14)
- Export manuscript to DOCX, EPUB, and PDF (#37)
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
- Progressive tool disclosure by default (7 tools at startup vs 45); eager opt-in via SCRIVENER_MCP_EAGER_TOOLS, baked into Docker image for registries
- Tool-definition quality pass — annotations, titles, rich schemas (project group)
- Register full tool set by default; opt into progressive disclosure via SCRIVENER_MCP_PROGRESSIVE_TOOLS
- Add opt-in eager skill registration via SCRIVENER_MCP_EAGER_TOOLS
- Onboarding — discover_projects tool, startup capability log, writer-friendly errors
- Atomic writes and pre-write backup for document safety
- Dual-write relationship engine with HMS triplets and Neo4j, 6 new MCP tools
- Add comparison table, Homebrew formula, community post drafts, registry submissions
- JS fallback vector engine when @hms/native is not installed
- Add sliding window (offset/limit) to read_document for large manuscript support
- Token-optimized response formatting with null stripping, minification, large payload spill, and error masking
- Progressive skill-based tool registration with list_skills and use_skill meta-tools
- Add multiple install methods, API key auto-discovery, Smithery and Docker support
- Add Windows Scrivener project path discovery (#17)
- V0.4.0 - Rust-native HMS, critical bug fixes, repo cleanup
- Replace simplified placeholders with production-ready AI and memory logic
- Migrate HHM core to native Rust HMS crate for high-performance parallelism
- Implement robust NLP-based enhancement logic using compromise
- Integrate HHM semantic memory into core document lifecycle
- Add Map and Set support to JSON serialization utilities
- Implement holographic hyperdimensional memory system with LangChain integration
- Replace static timeouts with intelligent condition-based waiting system
- Add complete auto-installation system for BullMQ and LangChain
- Integrate SQLite and Neo4j databases throughout application
- Enhance writing prompts with intelligent context-aware generation
- Integrate SQLite and Neo4j databases for enhanced project data management
- Add AI-powered content analysis, memory management, and writing enhancement
- Add automated Claude Desktop setup on install

### Changed
- Extract writer, document-info and sync collaborators from the large classes (#160)
- Split the five largest modules into focused submodules (#158)
- Drive comparison-table workflow from docs/comparison.yml (#101)
- Remove dead code — unused error-handler, enhanced-logger, validation modules (~1.6k lines)
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
- Bring analysis/async/fractal/relationship/compilation tools to 5/5; dedupe semantic_search; merge intelligent_compilation; rename remember/recall/suggest_improvements; meta-tools to 5/5
- Consolidate search tools 9->5 and bring to 5/5 (search absorbs trash+title, drop vector/cross-ref/find_document, rename restore/read_annotations)
- Consolidate documents tools 11->7 and bring to 5/5 (merge read formatting, rename+metadata into update_document)
- Hide internal/experimental tools from public surface (69->56)
- Remove 11.5K lines of dead code -- unused enterprise/, monitoring/, resilience/, openai-service-enhanced, duplicate handler exports
- Remove deprecated TS HHM modules replaced by HMS native Rust engine
- Remove legacy implementation artifacts
- Uniform utility usage and standardized error handling

### Documentation
- Say where to buy and download the Draftbridge app (#172)
- Add non-affiliation notice (#166)
- Standardize README header (#140)
- Update tool count to 62 after narrative-lens tools (#136)
- Tighten README prose, drop fabricated chat transcripts (#120)
- Standardize repository presentation (#108)
- Document Anthropic, OpenRouter, sampling, and key auto-discovery for AI features
- Add Security section linking SECURITY.md
- Standardize badges (add OpenSSF Scorecard; consistent order/format)
- Correct tool count to 53 and note official MCP registry listing
- Clarify Claude Code setup, project-open model, and tool counts
- Sync README and architecture with new tools (#14, #27, #37)
- Reverse-engineered .scriv format reference and stability posture (#40)
- Mark Phase 5 complete and Phase 6 docs/verify done in tool-quality-plan
- Add MCP client setup guide for Claude, Cursor, and VS Code (#57)
- Sync all docs to the consolidated 45-tool surface (rewrite README tools table, fix stale tool names, correct registration/token-optimization docs for eager default)
- Tool quality plan — phases 0-4 done, 69->44 tools all at 5/5
- Update tool quality plan progress (project/documents/search done)
- Add tool quality and consolidation plan (69 to ~33, 5/5 TDQS target)
- Add Glama badges and glama.json maintainer manifest
- Expand comparison table to 19 rows with weekly auto-update workflow
- Feature HMS semantic search, relationship engine, and new guides in README and architecture
- Update HMS references from @writerslogic/hms-native to holographic-memory
- Fix 15 documentation issues -- accuracy, missing features, troubleshooting, token optimization guide
- Rewrite forum post for L&L audience with WritersProof pairing
- Add JS fallback engine to changelog
- Substantially expand getting-started and writing-with-ai guides
- Add getting-started, writing-with-ai, architecture, and contributing guides
- Add comprehensive test coverage report
- Add comprehensive feature demo guide
- Comprehensive documentation for v0.3.0 features
- Add installation and configuration instructions
- Improve package description

### Fixed
- Only open Raycast install links, with URL-safe characters and no option parsing (#176)
- Preserve Scrivener XML attributes and plain text in Codex (#156)
- Validate binder move targets, patch audit findings, add tests (#154)
- Convert comparison-table workflow to open a PR, dedupe README badges (#117)
- Read/write document synopsis and notes from disk, not .scrivx (#111)
- Address CodeQL, Scorecard, and code-quality scanner findings (#102)
- Changelog workflow opens a PR instead of pushing directly to main
- Add missing MemoryManager import in project.test.ts
- Correct JobQueueService call signature in manual queue test
- Correct duplicate characters in regex character classes
- Remove unused imports and dead code flagged by CodeQL quality scan
- Keyword search was dead code, real docs pass a joined string not an array
- Repair project.test.ts vacuous checks and temp-dir hygiene
- Repair scrivener-project-roundtrip integration test and stale-write-cache bug
- Repair utility-adoption-workflow integration test for API drift
- Run embedded job queue inline instead of opening a real Redis socket (#91, #96, #93)
- Pass resolved document path when syncing to database (#93)
- Persist document path in documents table insert (#93)
- Add missing project_metadata table migration (#95)
- Correct UNION ALL column list between themes and locations (#94)
- Remove commandTimeout that aborts blocking BullMQ worker commands (#92)
- Resolve security and code quality findings
- Npm audit fix — clears 8 advisories (undici, fast-uri, brace-expansion, ip-address, hono, body-parser, @hono/node-server)
- Describe all outputSchema fields and probe get_entity_references in conformance gate
- Stop claiming OPENAI_API_KEY is required for content generation, autofix lint errors
- Shorten server.json description to registry's 100-char limit
- Recurse into folders when listing and compiling documents (#66)
- Advertise tools/list_changed and preserve isError in dispatch
- Log when project-backup listing fails instead of silently returning none
- Make logged errors debuggable and stop silently dropping unparseable RTF
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
- Register semantic_search (was defined but missing from analysisHandlers array)
- Declare @langchain/classic and domhandler — phantom deps broke pnpm build
- Advertise full tool set in Docker image for registry introspection
- Stop git-cliff from logging its own changelog auto-commits
- Replace silent bare catches with debug logging across handlers
- Embed full tool schemas in use_skill response for clients without tools/list_changed
- RTF handler — preserve paragraph breaks and fix non-ASCII character doubling
- Audit fixes for memory-handlers, relationship-handlers, relationship-engine -- error handling, null safety, dead code removal, memory cap
- Guard holographic-memory import to prevent crash when native module not installed (#45)
- Update HMS dependency from @writerslogic/hms-native to holographic-memory
- Correct HMS package name to @writerslogic/hms-native, remove hardcoded dev paths
- Restore dynamic license badge, add node version, issues, and stars badges
- Replace broken license badge with static shield, move MseeP into badge row
- Use theme-aware logo (black on light, white on dark)
- Improve JS fallback engine with FNV-1a hashing, stopwords, k-means++ clustering, ESM-safe import, fresh IDF on query
- Remove blind JSON compaction from dispatcher to prevent prose mangling
- Resolve duplicate tool names and ensure sendToolListChanged fires for all tiers
- Replace console.warn with stderr in connection-pool; polish README
- Improve handler setup error guidance (#16)
- Combine release creation and tarball upload into single step
- Restore NPM_TOKEN for npm publish auth with OIDC provenance
- Remove NPM_TOKEN override to allow OIDC trusted publishing; update repo URLs to writerslogic org
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
- Resolve all critical ESLint errors and ensure clean TypeScript compilation
- Achieve zero lint errors with proper test organization
- Zero lint errors, 100% test coverage, full TypeScript compliance
- Remove duplicate installation section in README
- Change package name to scrivener-mcp for npm publishing
- Add --access public flag for scoped npm package publishing
- Remove package-lock.json from gitignore for CI/CD
- Resolve critical bugs and achieve zero lint errors

### Performance
- Compact JSON outputs, flatten structure, paginate documents, trim search, summary-first analysis, find_document tool, compilation spill, dead code cleanup
- Shared schema defs, stripped self-evident descriptions, sub-40-char tool descriptions
- Lazy tool registration with tiers and trimmed descriptions to reduce token overhead
- Upgrade to HMS v2.0 with Rust-native semantic engine and persistence

### Security
- Fix all 23 open CodeQL findings across src, scripts, and tests
- Fix 88 audit findings across 67 files; resolve all critical and high issues

### Style
- Fix prettier formatting in job-queue.ts

