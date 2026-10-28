# Editorial implementation ledger

Objective: deliver all ten improvements through the public server and setup CLI, locally, without
publishing or changing real client configuration/manuscripts. Integration:
`/Volumes/A/scrivener-mcp`, branch `goal/editorial-20261027`, baseline `e398195` (initially clean).
The pre-existing `scrivener-mcp-checkout-20261025` worktree is unrelated and preserved.

## Acceptance matrix

| #   | Delivered interface and behavior                                                                                                                                                      | Acceptance evidence                                                                                                        | State                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | `review_changes`: persistent revision-bound proposals, pure before/after preview, selective reject/apply, recoverable batches, native snapshots and guarded exact-RTF undo            | `editorial-review.test.ts`; installed MCP selective/retry/snapshot/stale-undo/restart checks                               | Complete; verified locally |
| 2   | `check_consistency` / `continuity_findings`: stable quoted evidence, canon/candidate distinction, binder order, explicit story-time/intentional exceptions, author lifecycle/recheck  | `story-evidence.test.ts`, `project-source.test.ts`; actual MCP curation/correction/finding lifecycle                       | Complete; verified locally |
| 3   | `manuscript_dashboard`: capability-negotiated MCP Apps, binder filtering, scene synopsis/context, mentions, pacing, findings, shared review services and text fallback                | Actual installed SDK 1.32.1 sessions; Chromium handshake/navigation/escaped text/preview/consent/apply/undo/finding checks | Complete; verified locally |
| 4   | One mutation foundation for document/binder/snapshot commits, saved revision checks, fresh reads, cross-instance reservations and crash reconciliation                                | Review/loader-conflict/snapshot/RTF/compatibility tests; independent instances, external saves and stale undo              | Complete; verified locally |
| 5   | `search_passages`, existing `search` / `semantic_search`: local passage BM25 + bounded concept cosine + HMS, context/locations/revisions and incremental updates                      | Four zero-keyword-overlap relevance cases, incremental/restart tests; installed provider-free retrieval                    | Complete; verified locally |
| 6   | `manage_series` / `story_bible`: explicit membership/scope, aliases/characters/locations/rules/chronology, provenance, corrections and stale/unavailable source detection             | Actual two-project join/leave/isolation and restart checks; removed-source and copied-identity regressions                 | Complete; verified locally |
| 7   | `editorial_workflow`: chapter review, continuity audit, beta draft; durable steps, cancellation/resume, revision scope, usage/local cost, explicit beta export warning acknowledgment | Workflow/queue/lifecycle tests; all three actual MCP workflows and completed-resume checks                                 | Complete; verified locally |
| 8   | `export_manuscript`: submission DOCX, beta DOCX, EPUB 3, explicit front matter/styles, annotation isolation, preflight and archive validation                                         | Export preset regressions; installed export checks; EPUBCheck 5.4.0 passed Unicode/notes and empty fixtures                | Complete; verified locally |
| 9   | `scrivener-setup --demo`: original safe sample, actual MCP analysis and persistent edit preview; Mac/Windows paths, local-only privacy and redacted diagnostics                       | Real first session passed unchanged-manuscript assertion; isolated installed-consumer setup; runtime/redaction tests       | Complete; verified locally |
| 10  | CC0 representative fixtures, restored four excluded suites, Node/runtime alignment, Windows CI, installed-package/protocol smoke and compatibility matrix                             | All exclusions removed; synthetic Mac/Windows tests; package/browser/export smoke scripts; final gate below                | Complete; verified locally |

## Contracts and integration

The manager owns shared types/schemas, SQLite migration, adapters, registration, manifests/lockfile,
CI, UI, integration and validation. Three workers implemented disjoint domains in isolated
worktrees; no nested delegation or worker validation commands were used. Worker contributions were
inspected and integrated before dependent wiring.

`editorial/types.ts` is the common source/facts/provenance model. Sources carry stable project
identity, binder UUID, SHA-256 of saved raw RTF, UTF-16 offsets and one-based lines. Manuscript
enumeration excludes research/compile-excluded text; explicit active research reads can support
curated provenance. Per-document, document-count and total analysis budgets are bounded. Duplicate
identities fail explicitly.

`PersistentStore` uses the existing better-sqlite3 dependency, schema version one, WAL and
synchronous short transactions. No transaction spans an await or filesystem operation. Existing
state is retained; newer schemas are refused. Per-project editorial state contains proposals,
receipts, journals, facts/findings, indexes and workflow checkpoints. Shared series state is
separate and requires explicit membership. Back up editorial state with the manuscript; it is not
disposable cache data.

`MutationCoordinator` handles document, binder and native-snapshot persistence. Revision/ownership
conflicts cannot be overridden with native-app `force`. Recovery reconciles before/after hashes,
repairs known interrupted metadata and stops on unrelated saved bytes or ambiguous ownership.
Snapshot plans precede atomic RTF/index writes. Undo restores original raw RTF only against the
applied revision. Native unsaved buffers and safe simultaneous native writes are not promised.

Project retirement drains memory autosaves before closing the shared database. Queue transitions
lease active resources. Workflow checkpoints retain completed work and use stable proposal/export
identities. All guided workflows are local and report zero server-side provider requests/cost;
client chat charges remain outside that estimate.

## Verification record

Local environment: macOS arm64, Node `v26.8.1`, npm `11.19.0`, Java Temurin `17.0.19`. Supported
runtime floor is Node 22.13.0; CI covers macOS/Linux/Windows on 22.13.0 and 24. Node 18/20 claims
and shell-dependent Windows prepare/clean paths were corrected. No native Windows CI run is claimed
from this local session.

Verified integration evidence:

- Registry: 75 tools, zero duplicates, 55 data tools with documented output schemas.
- Output conformance: 29 actual handler paths passed, zero failures/skips; unexpected handler errors
  now fail the gate.
- Isolated installed-package smoke: all eleven named checks passed, including a real tarball
  install, ordinary consumer audit, actual text/Apps clients, two-project series isolation,
  review/undo, all workflows, validated exports and restart persistence.
- Real setup demo: protocol, local analysis, persistent edit preview and unchanged manuscript all
  passed.
- Chromium verified Apps handshake, accessible binder filtering/navigation, escaped text, source
  context, preview, explicit formatting acknowledgment, apply, undo and finding review. The rendered
  dashboard was visually inspected.
- EPUBCheck 5.4.0 passed both Unicode/notes and empty EPUB fixtures with zero errors. The initial
  exporter empty-description error was fixed. Validator distribution SHA-256:
  `33350c61038e71dfb3d45a76aed04bf5481e6d5500cb780f6e98db8bbd15a28c`.
- Full Jest result: 80 suites passed, 840 tests passed, nine optional live-provider tests skipped
  because no provider credentials were used. All four formerly excluded critical suites ran.
- Repository and installed-consumer audits: zero vulnerabilities. A newly reviewed development-only
  deepmerge advisory was addressed with a narrow, MIT-licensed vendored patch; see
  [patch provenance and removal criteria](../vendor/deepmerge/README.md). Security regressions
  resolve Jest’s actual dependency. An isolated frozen-lockfile `npm ci`, dependency-tree check and
  full audit passed; prior security overrides remain intact.

Primary protocol references:
[MCP Apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
[official protocol types](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/spec.types.ts),
[W3C EPUBCheck](https://www.w3.org/publishing/epubcheck/). The Apps view implements the documented
JSON-RPC bridge directly and uses the existing core SDK for server/client protocol operations.

The four previously excluded suites were restored against intended current behavior. Historical
Neo4j APIs referenced only by obsolete tests had no implementation/callers; replacement tests cover
real transactions, retries, cleanup and data integrity. New review requirements supersede
no-snapshot, ambiguous-native-write and cached-guard expectations. The real sample uncovered Unicode
fallback/control bugs, now covered by exact round-trip regressions. A diagnosed test-owned
ContextSync timer leak was fixed through teardown rather than forced process exit. The previously
skipped parent-folder guidance test now uses an actual parent/project layout and passes; valid
loose-manifest directories remain supported.

## Final gate

All required commands exited zero on the assembled candidate:

| Check                                            | Result                                                   |
| ------------------------------------------------ | -------------------------------------------------------- |
| `npm run format:check`                           | Pass                                                     |
| `npm run lint`                                   | Pass                                                     |
| `npm run typecheck`                              | Pass                                                     |
| `npm run build`                                  | Pass                                                     |
| `node scripts/check-tool-registry.mjs`           | 75 tools, zero duplicates, 55 data tools                 |
| `node scripts/check-output-conformance.mjs`      | 29 passed, zero failed/skipped                           |
| `node scripts/check-hms-compatibility.mjs`       | Seven passed                                             |
| `npm test -- --testTimeout=30000 --maxWorkers=2` | 80 suites, 840 passed, nine optional live-provider skips |
| `npm audit`                                      | Zero vulnerabilities                                     |
| `node scripts/check-release-smoke.mjs`           | Eleven installed-consumer/protocol checks passed         |
| `node scripts/check-dashboard.mjs`               | Chromium interaction checks passed                       |
| `node scripts/check-epub-export.mjs`             | Both EPUBCheck 5.4.0 fixtures passed, zero errors        |

Local command logs: `logs/implementation/final-candidate/`, `release-smoke-candidate.log`,
`dashboard-final.log`, `epubcheck-final.log`, and `frozen-dependencies.log` under
`logs/implementation`. These ignored logs contain disposable fixtures, not real manuscripts or
credentials. The evidence above is retained here so a fresh checkout does not depend on those logs.

## Coverage limits

See [compatibility](SCRIVENER_COMPATIBILITY.md), [editorial workflows](editorial-workflows.md),
[export coverage](export-presets.md), [first session](getting-started.md) and
[Windows installation](install-windows.md). Search is a transparent 30-concept English encoder, not
a general pretrained embedding model. Continuity automatically extracts only narrow explicit
attributes and needs curated facts for broader canon. Export preflight discloses media, layout and
anchor limits. Synthetic Windows layouts and configured CI do not certify a live native Windows
Scrivener session. Commercial host rendering is not certified by the protocol/simulated-host browser
checks.

## Maintenance and main integration

The follow-up authorizes merging/pushing main, merging open PRs, quality fixes, consolidation,
comment reduction and artifact cleanup. The original local delivery ended at `ac2f2f8`; maintenance
uses `cleanup/pre-main-20261027` and the same three isolated implementation workers. Reviewed
maintenance PRs [#188](https://github.com/writerslogic/scrivener-mcp/pull/188) (SDK 1.32.2) and
[#187](https://github.com/writerslogic/scrivener-mcp/pull/187) (changelog) are merged.

- Persistence reuses prepared SQL, closes failed initializations, rejects async transaction
  callbacks before invocation, and reconciles interrupted undo. Proposal creation reads/parses once.
- Continuity/bible requests reuse scoped source snapshots and document maps, validate source
  identity/Unicode ranges, and preserve historical foreign evidence and author decisions.
- Retrieval uses linear token/chunk accounting, reads each matched source once, avoids unused HMS
  work in semantic mode, and replaces stale owned caches. Workflows protect cancellation/resume,
  service closure, and identical concurrent starts without replaying completed work.
- Spooling shares one bounded writer, rejects path-shaped labels and preserves JSON data properties.
  Fixture restarts, lifecycle and UUID cases are consolidated; seven trivial path/environment
  wrapper tests are removed. The initial comment-only batch removed 592 restatements/dividers across
  77 files with unchanged executable syntax; necessary constraints and licenses remain.
- The obsolete ESLint legacy configuration and tracked HMS runtime database are removed from Git;
  local database files are preserved and ignored. Lockfiles and fixture Data directories remain
  trackable. LF source checkout is enforced while native fixtures retain exact saved bytes; a
  simulated CRLF checkout preserved all 37 fixture files byte-for-byte.
- Windows fixtures use native paths and disposable Node/npm layouts. Stable runtime lookup uses
  node.exe/junctions, and ProjectLoader teardown closes its SQLite owner before fixture deletion.
  The no-follow fallback compares bigint identities from two descriptors plus final path inode/type;
  it does not trust older Windows path-stat device values. Reads remain bounded and handles close on
  all paths; Windows concurrent replacement remains best effort. Conformance failures expose
  redacted nested causes rather than hiding the underlying error.

Final local gate: all ten release commands exited zero in
`logs/implementation/maintenance-final-verified/`: formatting, lint (zero warnings), typecheck,
build, registry (75 tools), output conformance (29 paths), HMS (seven cases), Jest (81 suites, 875
passed, nine optional provider skips), audit (zero vulnerabilities), and all eleven installed
package/protocol checks. Chromium and both EPUBCheck fixtures also pass. POSIX FIFO/no-follow checks
are explicitly inapplicable on Windows; native descriptor and fixture coverage stays enabled.

Security review: CodeQL #59 is fixed with descriptor-based reads and real race/special-file
regressions. Cache identity is strengthened to private process-keyed HMAC-SHA256 with credential
rotation coverage. Alerts #57 (configuration identity, never a persisted password/login verifier)
and #58/#60 (legacy 40-hex SHA-1 compatibility sidecar, never a security guard) are documented false
positives; no query or security check is disabled. All revision/conflict/undo guards use SHA-256.
Case-varied native checksum duplicates now collapse while preserving spelling, unrelated entries and
line endings. The existing tested deepmerge development patch addresses Dependabot #71; it is not
dismissed. Secret scanning returned no open findings.

[Integration PR #189](https://github.com/writerslogic/scrivener-mcp/pull/189) carries live CI,
security and code-quality evidence. Main integration requires all six supported OS/runtime jobs,
replacing retired Node 20 context names while retaining strict updates, deletion/force-push
protection and no bypass actors. No release tag, package publication or deployment is authorized.
