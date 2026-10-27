# Editorial implementation ledger

Objective: implement and validate the ten public-server improvements locally. Integration checkout: `/Volumes/A/scrivener-mcp`, branch `goal/editorial-20261027`. Baseline `e398195`; initial working tree clean. Other existing worktree is unrelated and must be preserved.

## Contracts and ownership

Manager owns shared types (`src/services/editorial/types.ts`), SQLite state (`persistent-store.ts`), project adapters, registration, dependencies/lockfile, UI, setup, exporters, CI, documentation and combined validation. Sources use canonical project identity, binder UUID, SHA-256 of saved raw RTF, UTF-16 passage offsets and one-based lines. SQLite transactions are synchronous and short; no await in transactions. All features use the existing project, RTF, snapshots, memory, retrieval and queue architecture.

| Worker | Isolated checkout | Owned paths |
| --- | --- | --- |
| review | `/Volumes/A/scrivener-mcp-review` | `review-service.ts`, `mutation-coordinator.ts`, existing `project-writer.ts`, `document-manager.ts`, `document-writer.ts`, focused review/conflict tests |
| story | `/Volumes/A/scrivener-mcp-story` | `continuity-service.ts`, `series-bible.ts`, `provenance.ts`, existing consistency handler, new story handlers/tests |
| retrieval/workflows | `/Volumes/A/scrivener-mcp-workflows` | `passage-search.ts`, `workflow-service.ts`, local search/workflow handlers, existing queue/async services as necessary, focused tests/fixture |

Workers do not edit shared files or run validation, installs, formatters, builds or packaging. Manager integrates and inspects before dependent integration.

## Acceptance matrix

| # | Outcome and principal gap | Required acceptance evidence | State |
| --- | --- | --- | --- |
| 1 | Durable proposed changes, review, batch and undo | Preview unchanged; selected edits; restart; formatting disclosure; snapshots; interrupted recovery; stale undo rejected | In progress |
| 2 | Continuity evidence and lifecycle | Quoted passages/UUID/revision/order; canon vs inference; confirm/dismiss/resolve/recheck; intentional/time exceptions | In progress |
| 3 | MCP Apps manuscript dashboard | Capability negotiation; accessible binder/context/appearances/pacing/findings/review; text fallback; protocol/UI smoke | Planned |
| 4 | Conflicting edits | Saved external refresh; stale write rejection; cross-process claims/crash recovery; ambiguous native guard explicit | In progress |
| 5 | Local conceptual passage search | No provider key; semantic relevance fixture; passages/context/locations; incremental revisions | In progress |
| 6 | Curated scoped series bible | Multi-project persistence; kinds/aliases/corrections/provenance/staleness; scope isolation | In progress |
| 7 | Guided durable workflows | Three workflows; progress/scope/usage/cost; cancel/resume; no duplicate completed steps or manuscript writes | In progress |
| 8 | Export presets/preflight | Submission, beta, ebook; manuscript scope/order/styles/front matter; validation of EPUB/DOCX; honest unsupported coverage | Planned |
| 9 | Installation and first session | Mac/Windows docs; isolated sample; real analysis/edit preview; client/provider/privacy guidance; redacted diagnostics | Planned |
| 10 | Release compatibility | Redistributable Mac/Windows fixtures; restored four excluded suites; Windows CI/runtime alignment; package/startup/protocol smoke; evidence matrix | Planned |

## Validation record

Verified baseline: Node `v26.8.1`, npm `11.19.0`, installed dependencies present, MCP SDK requirement `^1.29.0`, declared Node `>=18` inconsistent with modern dependencies; four suites excluded in Jest. Existing final gate commands retained. No full gate has yet run.

Primary MCP Apps sources consulted: [official extension specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx), [official SDK server helper reference](https://apps.extensions.modelcontextprotocol.io/api/functions/server-helpers.registerAppTool.html). Exact installed compatibility and UI smoke remain to verify.
