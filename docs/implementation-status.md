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

Follow-up authorization: merge/push main, merge reviewed open PRs, address quality findings,
consolidate code/tests, reduce redundant comments, and remove stray repository artifacts. The
original local-only delivery ended at `ac2f2f8`; this follow-up uses `cleanup/pre-main-20261027`
with the same manager and three existing isolated workers.

Initial remote audit found no open scanning alerts. Maintenance PRs #188 (SDK 1.32.2) and #187
(changelog) were inspected and merged after their required checks passed; the connector lacked merge
scope, so the authenticated GitHub CLI performed the merges. Repository rules currently require
retired Node 20 job names; final integration must retain strict protection while aligning required
checks with the six supported OS/runtime jobs.

Repository cleanup removes the obsolete ESLint legacy configuration and stops tracking the HMS
runtime database while preserving its local files. Runtime state stays ignored; npm's canonical
lockfile and sample-project Data directories remain visible to Git. Comment cleanup removed 592
dividers, section labels and restatements across 77 files, verified to preserve executable syntax.
Seven trivial environment/path-wrapper tests were removed; UUID cases share a parameterized table.
Focused formatter/utility checks: 55 tests passed. All three worker contributions were inspected and
integrated. Cached prepared statements and shared source snapshots remove redundant SQL/read work;
search uses linear token/chunk accounting, semantic-only requests avoid HMS, and changed-source HMS
caches are replaced safely. Recovery reconciles interrupted undo; provenance validates source
identity/Unicode bounds and retains foreign history; workflows protect cancellation/resume and
identical concurrent starts. Fixture restarts and repeated lifecycle cases are consolidated.

The maintenance candidate passes formatting, lint, typecheck, build, registry (75 tools), output
conformance (29 paths), HMS (seven cases), and audit (zero vulnerabilities). Jest passes 81 suites
with 859 tests and nine unchanged optional provider skips; a complete open-handle diagnostic run
also exits cleanly with no reported handles after a parallel worker-exit warning. Installed package
smoke passes all eleven checks on SDK 1.32.2; Chromium and both EPUBCheck fixtures pass. Logs use
`logs/implementation/maintenance-*`. Remote CI/scanning run on the integration branch; strict branch
checks require the six supported OS/runtime jobs before main integration. The GitHub Dependabot
deepmerge alert (#71) is addressed by the existing tested local security patch and should close when
the patched lockfile reaches main; it is not dismissed. Secret-scanning and code-scanning open-alert
queries returned no other findings.

Windows CI exposed Git checkout CRLF conversion against the repository’s LF formatting policy.
`.gitattributes` now enforces source LF while treating native `.scriv` fixtures as opaque bytes; CI
keeps all matrix jobs running to expose platform failures together. GitHub code quality found one
unused EPUBCheck-script import, now removed. The follow-up parallel Jest confirmation also passed
all 859 tests and exited normally without a worker warning.
