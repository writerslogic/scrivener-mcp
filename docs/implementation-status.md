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
and shell-dependent Windows prepare/clean paths were corrected. The local delivery evidence below is
supplemented by the native Windows/macOS/Linux CI results in the maintenance record.

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
CodeQL #61 was independently reviewed: the second read-only descriptor verifies identity after
opening, and all content reads use the validated original descriptor. Descriptor/path substitution
and handle cleanup regressions pass; Windows pathname confinement remains best effort. Case-varied
native checksum duplicates now collapse while preserving spelling, unrelated entries and line
endings. The existing tested deepmerge development patch addresses Dependabot #71; it is not
dismissed. Secret scanning returned no open findings.

[CI run 40617784860](https://github.com/writerslogic/scrivener-mcp/actions/runs/40617784860) passed
all six native OS/runtime jobs at `eecbe98`: macOS, Linux and Windows on Node 22.13.0 and 24. Each
ran the complete release gate and installed-package/protocol checks; Linux Node 24 also ran Chromium
and EPUBCheck. CodeQL security, JavaScript/TypeScript and Ruby code quality, dependency review and
the extension build passed. These are remote CI observations, separate from local measurements and
native Scrivener GUI certification.

[Integration PR #189](https://github.com/writerslogic/scrivener-mcp/pull/189) carries live CI,
security and code-quality evidence. Main integration requires all six supported OS/runtime jobs,
replacing retired Node 20 context names while retaining strict updates, deletion/force-push
protection and no bypass actors. No release tag, package publication or deployment is authorized.

## Forward compatibility and Draftbridge quality

The follow-up requests application longevity and confirms the desktop product is Draftbridge for
Scrivener. Public integration uses `quality/future-integration-20261028` in
`/Volumes/A/scrivener-mcp-future` from `a998746`; private desktop integration is isolated at
`/Volumes/A/draftbridge-quality` from `d79932d`. Existing deleted files in `apps/mac` are unrelated
and preserved. Private source stays in the private repository.

| Concern                    | Contract / acceptance                                                                                                                                                           | Ownership / state                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Protocol diagnostics       | Use the installed SDK client for negotiation and schema validation; failed/empty/malformed listings never succeed; pagination, timeout, output bounds and redaction are tested  | Diagnostics worker; integrated      |
| Runtime drift              | Package, setup and CI floors must agree; stable versions are compared fully; malformed/prerelease/mismatched versions fail; newer runtimes get scheduled compatibility coverage | Manager; verified locally           |
| Desktop helper lifecycle   | Bounded concurrent stdout/stderr consumption, validated exit/report agreement, cancellation, timeout with kill escalation and cleanup; no real client changes in tests          | Manager; verified locally           |
| Desktop evidence / updates | Schema compatibility and unknown states fail honestly; diagnostics redact local/credential information; release candidates and destinations are validated                       | Private evidence worker; integrated |
| Desktop interactions       | Serialize mutations, reject stale refreshes, preserve errors and verification status; visible progress/cancellation and accessible controls                                     | Private UI worker; integrated       |
| Integration                | Actual public CLI report decoded by the private app; Swift/core/license tests, app builds, rendered light/dark screens and complete public release gate                         | Manager; verified locally           |

The manager owns public dependencies, CI and runtime policy plus the private process foundation.
Private report/error types and their tests are explicitly delegated to the evidence worker; private
interaction state is delegated to the UI worker. Workers use disjoint worktrees, do not validate or
install dependencies, and request shared changes. Changes remain local during implementation.

Validation uses the isolated checkouts above; concurrent unrelated changes in the original public
checkout and deleted private files remain untouched. No dependency manifests or lockfiles changed.

The complete local public gate passed in `logs/implementation/future-final/`: formatting, lint,
types, build, runtime policy, registry (75 tools), output conformance (29 paths), HMS compatibility
(seven cases), Jest (82 suites, 920 passed, nine optional-provider skips), audit (zero
vulnerabilities) and fourteen installed-package checks. A separate serial open-handle run found no
retained handles. Jest now caps worker concurrency at four. The FIFO regression runs against
installed compiled code with its original eight-second bound, avoiding source-loader startup
contention. Setup and logger redaction share one implementation; the previous setup import remains a
compatible re-export.

The unsigned Apple-silicon Draftbridge DMG built with checksum-verified Node 24.22.1. Its pruned
production server passed all twelve bundled-package/MCP checks, and `hdiutil verify` accepted the
image checksum. An intentionally corrupt Node cache entry was replaced by a checksum-valid archive.
Disposable build sources were removed and the source license configuration stayed unchanged. The
desktop suite passed 90 tests, including real helper decoding and cancellation of the helper's MCP
child. Thirty-six light/dark previews were rendered; progress, cancellation, error and bounded
settings layouts were inspected. Signing, notarization, live VoiceOver and native Scrivener GUI
interactions have not been performed for this candidate.

The packed MCPB also passed manifest validation and an actual SDK-negotiated startup using its
extracted command and bundled runtime (16 progressively loaded tools). Its SHA-256 is
`aa3d386eb60370d5997bfc3e1492a7312b8bc1fedc537a516f2e3cfd2a626846`. The final desktop gate passed
all 90 tests against the staged production helper, a release build and four license tests.

Integration policy requires `Release verification`, dependent on the complete eight-job matrix;
promote that stable context after its first green CI run, retaining strict updates and the existing
deletion/force-push protections. Remote evidence is attached to the integration PR for
`quality/future-integration-20261028` and its
[branch checks](https://github.com/writerslogic/scrivener-mcp/actions?query=branch%3Aquality%2Ffuture-integration-20261028).
No paid provider calls, release publication, signing, notarization or deployment are part of this
verification. Private CI must remain within the organization's verified free Actions allowance.

The expanded Windows run exposed a raw drive path passed to Node's ESM `--import` option in the
shutdown smoke fixture. The observer now uses a file URL; the clean-stdin-exit and no-forced-signal
assertions remain enabled on every platform.

## Verified integration and Redis driver compatibility

Public [PR #190](https://github.com/writerslogic/scrivener-mcp/pull/190) merged to main as
`72ade1c`; its eight-job matrix passed both before merging and on main in
[run 40707022045](https://github.com/writerslogic/scrivener-mcp/actions/runs/40707022045). Branch
protection now requires the stable aggregate `Release verification`, retaining strict updates,
deletion protection and force-push protection.

Private [Draftbridge PR #4](https://github.com/writerslogic/draftbridge/pull/4) merged as `3ae3025`.
[Main CI run 40707855355](https://github.com/writerslogic/draftbridge/actions/runs/40707855355)
passed all 90 Swift tests, the release build and ten license/build-configuration tests. The added
generator preserves padded rotated public keys, rejects malformed settings without disclosing their
values, and compiles generated settings through Swift and CryptoKit. Private scanning remains
unavailable because that GitHub feature is not enabled; no paid scanning feature was enabled.

The post-merge dependency review in
[PR #191](https://github.com/writerslogic/scrivener-mcp/pull/191) upgrades ioredis to 6. Its
[migration guide](https://github.com/redis/ioredis/wiki/Upgrading-from-v5-to-v6) changes the default
wire protocol to RESP3; both production constructors explicitly retain RESP2 for existing proxies
and ACLs that deny `HELLO`. BullMQ keeps its own declared compatible ioredis version. The portable
`redis-compatibility.test.ts` regression exercises actual detection and PING through a HELLO-denying
loopback endpoint, without constructor mocks.

An isolated local Redis 8.10.2 server passed detection, cache set/get/SCAN invalidation, reconnect,
a real BullMQ job and completion event, and shutdown using root ioredis 6.0.0 with BullMQ 5.81.5. It
used a disposable Unix socket and loopback proxy, not a developer's Redis data or client
configuration. Integration validation runs in `/Volumes/A/scrivener-mcp-dependency`; logs remain
under `/Volumes/A/scrivener-mcp-future/logs/implementation/future-final/dependency-*` and
`redis-backend-check.log`. The existing dependency security overrides and vendored patch remain
unchanged.

The early ad hoc verifier's `hello-denied-detection` label overstated its ACL setup: Redis exempts
`HELLO` from ACL command checks. That run established functional backend behavior; NOPERM handshake
compatibility was established by the portable loopback fixture. The maintained real-backend verifier
disables `HELLO` in its private Redis process and explicitly checks the rejection before testing
connections. It uses a fresh password, bounded Redis request buffers and explicit targets so it does
not contact an existing Redis instance.

The dependency candidate passed the complete local release gate: formatting, lint, types, build,
runtime policy, registry (75 tools), output conformance (29 paths), HMS compatibility (seven cases),
83 Jest suites (921 passed; nine optional-provider skips), zero-vulnerability audit and all fourteen
installed-package checks. The private app's two real-helper contract tests also passed against this
updated public checkout. Remote evidence for the final dependency candidate is attached to PR #191.

## Coordinated major dependency integration

After PR #191, Dependabot surfaced eight additional major upgrades. The manager integrates their
exact PR heads in `quality/dependency-batch-20261028` at
`/Volumes/A/scrivener-mcp-dependency-batch`, preserving their ancestry while reconciling one
manifest and lockfile. Original source PR checks are superseded by the combined candidate's full
compatibility gate, rather than treated as passed.

| PR   | Upgrade         | Required integration                                                                                 |
| ---- | --------------- | ---------------------------------------------------------------------------------------------------- |
| #192 | OpenAI 7        | Real SDK wire/embedding/error tests, bounded body consumption and no automatic replay                |
| #193 | Jest globals 30 | Align the existing Jest 30 runner; retain typed mock and critical suite coverage                     |
| #194 | Chalk 6         | Preserve supported ESM/color callers and actual CLI startup                                          |
| #195 | Domhandler 6    | Verify Cheerio DOM type compatibility and actual offline HTML extraction                             |
| #196 | Anthropic 1     | Omit removed temperature, verify new auth/version headers and existing fallback behavior             |
| #197 | SQLite 13       | Node-API 10 range, shipped-binding proof and real v12 database/WAL upgrade fixtures                  |
| #198 | BullMQ 6        | Keep protocol-2 adapter, select the valid typed Worker overload and verify real queue-state transfer |
| #199 | Node 26 types   | Preserve actual minimum-runtime checks; declarations do not establish runtime availability           |

The canonical runtime range becomes `^22.14.0 || >=23.6.0`, excluding unsupported early Node 23. The
exact 22.14 minimum replaces 22.13 across all three OS jobs; Node 24, latest 22 and Node 26 coverage
remain. SQLite's schema and mutation/recovery contracts stay unchanged. Three reused workers own
disjoint runtime, native-fixture and AI-client paths; the manager owns dependencies, CI, schemas,
registration, integration and all validation.

SDK requests use per-request abort deadlines and disable SDK replay, while the existing explicit
account/service fallback remains. No live-provider opt-in, paid API call, release or deployment is
authorized for these checks. Native v12 fixtures contain original synthetic state, with provenance
and CC0 dedication; source fixtures are never opened for writing by tests.

The assembled local candidate passed formatting, lint, types, build, runtime policy, registry (75
tools), output conformance (29 paths), HMS compatibility (seven cases), the full 87-suite Jest run
(979 passed; nine explicitly gated live-provider skips), zero-vulnerability audit and all fourteen
installed-package/MCP checks. `batch-*` logs are retained in
`/Volumes/A/scrivener-mcp-future/logs/implementation/future-final/`.

Actual locked upgrades are Anthropic 1.3.0, OpenAI 7.45.1, SQLite driver 13.0.3, BullMQ 6.5.1,
Jest/globals 30.5.2, Chalk 6.0.1, Domhandler 6.0.1 and Node types 26.6.5. The core MCP SDK stays at
1.32.2. Empty Cheerio/ioredis type stubs were removed after verifying that the runtime packages own
their declarations. Lockfile package entries fell from 1,094 to 740; security overrides and the
vendored patch are unchanged.

Both current/current and BullMQ 5.81.5-to-6.5.1 real Redis checks passed, including persisted
completed/failed/queued/delayed/retry jobs, progress and completion events, active-job removal
rejection, scoped cache invalidation, reconnect and checked resource cleanup. The verifier is wired
into Linux Node 24 CI. Explicit candidate lists are validated and bounded; local-only demo and
diagnostic sessions now bypass automatic Redis discovery, preventing them from consuming another
installation's jobs. Redis logs identify endpoints without echoing URL credentials or fragments. The
inspected Apple-silicon SQLite prebuild targets macOS 11; this does not certify live macOS 14 or
Scrivener GUI behavior.

Concurrent security PR #200 was preserved through an ordinary main merge, and changelog PR #201's
head is retained as a merge parent. Its three redaction regressions and all fourteen
installed-package checks passed after integration. Public code-scanning, dependency and
secret-scanning alerts and Code Quality findings were empty at the October 28 review.

The first combined CI candidate passed seven matrix jobs, CodeQL, Code Quality, dependency review
and MCPB validation. Its minimum Windows job exposed npm 10's frozen-lock native rebuild against an
unsupported Visual Studio 2026 toolchain. Minimal frozen installs reproduced the automatic rebuild
with npm 10 and 11; a fresh registry install with npm 10 used the shipped binary without rebuilding.
The minimum Windows job now uses Visual Studio 2022 on `windows-2022`; the Node 24 job retains
`windows-latest`. All eight cases and the strict aggregate remain required. Final candidate results
are attached to PR #202; the failed original run is not counted as passing evidence.

## Holographic Memory 0.6.4 integration

The manager works in `/Volumes/A/scrivener-mcp-hms064` on `quality/hms-064-20261028`, preserving the
original dirty checkouts. The published 0.6.4 npm package and release sources establish the
integration contract; no model downloads or paid providers are part of development verification.

| Acceptance                  | Implementation and verification target                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed native library    | Declare 0.6.4, use its published types, resolve from the installed server, and verify native and forced fallback from unrelated working directories.                               |
| Effective passage retrieval | Use native document BM25 and supplied story-concept embeddings, stable project/source revisions and scoped queries; preserve exact UTF-16 source context.                          |
| Incremental durable index   | Replace/delete changed passages, recover an interrupted synchronization from the existing SQLite store, and reuse a versioned project cache without rebuilding unchanged passages. |
| Honest lifecycle            | Share compatible native owners safely, flush on release, and retain a weak idle reference for reopen; native 0.6.4 has no deterministic close API.                                 |
| Consumers                   | Preserve vector-store metadata and scoped text after restart, use native batches and close owned consumers; keep analogy/triplet compatibility.                                    |
| Release gate                | Focused provenance/relevance/restart/input cases, native/fallback compatibility, all existing release checks, installed-package MCP interactions and dependency audit.             |

The manager owns dependencies, types, native loading/ownership, fallback and compatibility gates.
One worker owns only `passage-search.ts` and its regression file; another owns the vector-store
adapter and its direct consumers/tests. Their common wrapper contract is `memorizeDocuments`,
`searchDocuments`, `deleteDocument`, published document result fields, an explicit embedding-space
identity, and a forced-fallback configuration. SQLite remains authoritative; native indexes are
derived, and source versions are checked by Scrivener services rather than treated as native CAS.

The manager inspected and integrated consumer commit `c466a27` and passage commit `b44ffe1`. Native
package loading was verified from `/`; Transformers was absent and the published binary did not
export the feature-gated `LocalEmbedder`. Eight fallback and nine native compatibility cases passed,
followed by a fresh-process native reopen retaining text, relationships and scoped document
metadata. Fourteen isolated installed-package/MCP checks passed with the actual native dependency.

Focused integration passed 41 tests, with 30 workflow/queue regressions passing after fixing a
cross-realm filesystem-absence check and updating the queue's lifecycle fixture. Pure semantic
scores retain absolute concept cosine so existing thresholds remain meaningful; native fusion owns
hybrid ranking. Cache schema 2 intentionally replaces temporary per-revision indexes with a durable
derived index. Closed wrappers reject operations, and callers await consumer cleanup. Complete final
gate results and remote CI evidence will be attached to this section's integration PR.

The complete local gate passed: formatting, lint, types, build, runtime policy, 75-tool registry, 29
output-conformance paths, eight fallback/nine native cases plus native process restart, 90 Jest
suites (1,013 passed; nine explicitly gated live-provider skips), and a zero-vulnerability audit. A
frozen install succeeded with real-client configuration disabled. The installed package also
exercises retrieval after a real MCP server restart, checking unchanged source revisions and exact
manuscript context. Logs are retained in `logs/hms-064/` in the integration checkout.

Integration PR [#203](https://github.com/writerslogic/scrivener-mcp/pull/203) carries the remote
compatibility evidence. Its installed-package module check explicitly loads the production native
binding, so packaging and post-pruning bundle checks cannot silently pass using the fallback.

The post-merge scan surfaced SDK transitive dependency advisory
[GHSA-rmxm-3fg6-px4f](https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f).
The security follow-up sets the `@hono/node-server` override floor to 2.1.3 and resolves 2.1.5 in
the lockfile, preserving the existing YAML and deepmerge fixes. npm audit reports no vulnerabilities
with the patched tree; the same full compatibility, package and protocol gates apply.

Primary contracts:
[0.6.4 release](https://github.com/writerslogic/holographic-memory/releases/tag/v0.6.4),
[Node declarations](https://github.com/writerslogic/holographic-memory/blob/v0.6.4/index.d.ts) and
[native store ownership](https://github.com/writerslogic/holographic-memory/blob/v0.6.4/src/core/store_lock.rs).

## C2PA format support

Integration [PR #207](https://github.com/writerslogic/scrivener-mcp/pull/207), based on main
485b1a2. Feature version 0.14.0 is not npm-published. The original public checkout's 70 pending
paths and private Mac checkout's 35 pending deletions are preserved. No application, legal
agreement, production certificate purchase or deployment has been performed.

| Acceptance            | Implementation and evidence                                                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared operations     | Three progressively loaded credentials tools use one domain service and one pinned official SDK 0.9.11 worker; no manuscript edits or parallel exporter.                                                                                                                     |
| Real format coverage  | 86 declared MIME types; 48 synthetic CC0 MIME fixtures pass actual native roundtrips: 25 embedded and 37 detached paths. Untested profiles remain outside intake claims.                                                                                                     |
| Archive integrity     | DOCX/XLSX/PPTX/EPUB/ODT/ODS/ODP/ODG prepare unsigned input as bounded STORE copies, preserve document parts and record source SHA-256/repackaging. Unsafe paths, duplicates, inconsistent directories, corrupt CRCs and allocation/entry limits fail closed.                 |
| Honest validation     | Current signature and asset-binding successes are required; configured-root trust is separate. Compressed c2cm/brob validation passes; compressed generation, streaming and attestation are absent. Conformance is not assessed; AL1 is a target, not an awarded level.      |
| Safe publication      | Stable descriptor reads, saved-source revision rechecks, private staging, encrypted administrator keys, isolated timed native children and exclusive publication. Concurrent output attempts produce one valid artifact and one conflict; wrong passwords produce no output. |
| Actual interfaces     | Installed MCP export/sign/validate succeeds for DOCX/EPUB/PDF, preserves history, rejects overwrite and verifies again after a real server restart. UI/editorial services retain their existing contracts.                                                                   |
| Runtime and packaging | Node floors 22.23.4 /24.22.1 /26.12.1 include official SDK TLS fixes plus SQLite API10. The bundle explicitly installs the platform SDK binary before pruning and probes its real installed native entry point.                                                              |
| Intake and identity   | All 30 questions have evidence-based answers in [Content Credentials](content-credentials.md); CN scrivener-mcp, O WritersLogic, Inc., C US, OU blank. Production identity/trust issuance and program assessment remain external prerequisites.                              |

The complete local gate passed: formatting, lint, types, build, runtime policy, 78-tool registry, 32
output-conformance paths, native/fallback HMS compatibility, C2PA compatibility, 96 Jest suites
(1,138 passed; nine existing live-provider skips), zero-vulnerability npm audit, 17 installed
package/MCP checks, and EPUBCheck 5.4.0 on unsigned/signed Unicode-notes and empty ebooks.
[Native evidence snapshot](compatibility/c2pa-0.14.0-macos-arm64.json) records SDK/runtime/platform,
fixture-index digest, trust policy, exact per-MIME modes, source preservation and negative checks.
The Mac bundle separately passes 15 installed-package/MCP checks under Node 24.22.2 after explicit
arm64 SDK installation and pruning. CI retains the corresponding report in every compatibility job;
protected integration requires the complete eight-job matrix. Validation uses local/free resources
only. Both tool audits now enumerate the canonical eager registry instead of maintaining separate
skill/handler lists, so all 78 tools and the three new output schemas are included.

Manager-owned shared contracts, dependencies, CI and integration are complete. Isolated workers
contributed the native worker, format fixtures, filesystem/archive regressions and documentation;
all contributions were inspected and integrated before dependent checks. Local validation logs are
retained under logs/c2pa-0.14.0-20261028 in the canonical checkout after worktree cleanup.
Future-proofing bf53f0b is already in public main. After protected integration, preserve bundle/log
artifacts and remove owned temporary worktrees while retaining all unrelated edits and checkouts.

Credential reads use one descriptor-first helper across the parent, native worker and fixture
tooling. Both Windows descriptors are acquired before pathname checks, existing files remain
read-only, and temporary creation modes are explicitly private. Growth/replacement tests and bounded
FIFO probes exercise the installed reader. The native gate hashes and stages the same verified
fixture buffer. CI checks the latest selected release instead of an obsolete cached runner runtime;
exact minimum-version coverage remains unchanged.

## Repository consolidation

The requested final state is one Scrivener MCP checkout on main, synchronized with origin/main, with
no other local branches, linked worktrees or stashes. The original 70 pending paths were captured in
c48c43d and merged with the current C2PA/HMS/security baseline. Pending database, saved-write,
memory-persistence, cache and lifecycle improvements were genuinely absent upstream; 137 focused
regressions pass after integration. Current security floors and asynchronous HMS cleanup remain
intact.

All 35 original branch heads are reachable from the integration history. Patch-equivalent heads and
twelve semantically superseded commits were audited before retaining their history without
reintroducing obsolete implementations. A verified Git bundle, original binary patch and untracked
file archive are retained under logs/repository-consolidation-20261028. Full release verification,
protected remote integration and final worktree removal follow before the cleanup is complete.

The consolidated candidate passes formatting, lint without warnings, TypeScript, build, runtime
policy, the 78-tool registry and output contracts, HMS compatibility and native C2PA compatibility.
All 102 suites pass: 1,301 tests passed and nine explicitly opted-in live-provider tests were
skipped. An initial run incorrectly forced local-only mode onto mocked provider-selection tests; the
corrected run removes that override and all real provider credentials, with live tests disabled. The
dependency audit reports zero vulnerabilities. Fresh package installation and 17 actual
CLI/MCP/App/restart checks, the dashboard browser exercise and all three EPUBCheck cases pass. The
user explicitly included the separate private Draftbridge repository in consolidation; its source,
original deletion patch and build artifacts remain private and independent of this history.

The real Redis 8.10.2/BullMQ 6.5.1/ioredis 6.0.0 lifecycle gate passes all nine checks. An initial
Redis startup timed out during host filesystem stalls; a clean retry passed without changing its
60-second deadline. Changelog rendering deduplicates identical commit messages within release groups
so preserving already-integrated branch history does not repeat release notes.

## Native analysis libraries, 2026-10-29

Scrivener MCP now declares `bluepencil-node ^0.2.0` and `narrative-lens ^0.2.0`; the lockfile pins
both wrappers and every declared native platform package to 0.2.0. Holographic Memory was already
declared, locked and installed at 0.6.4; its dependency record and existing native/fallback
integration are retained. No unrelated dependency records or security overrides changed.

The existing five Bluepencil and five Narrative Lens MCP handlers continue to call the libraries
directly with their existing public contracts. The new Narrative Lens manuscript facade is not
introduced as a parallel continuity or review implementation. Installed-package verification now
invokes both native editorial analyzers through an actual MCP client and checks that the saved
manuscript is unchanged. All demonstration projects and client homes are disposable.

Validation uses Node 24.22.2 and local/free resources. The 19 focused handler regressions and
TypeScript checks passed against the published 0.2.0 binaries; final gate results are retained in
`logs/analysis-libraries-0.2.0-20261029/`. This dependency update does not resolve the separate
correctness and safety findings identified by the quality audit.

## Audit remediation, 2026-10-29

Baseline: main `6fc0f9e`, including verified Bluepencil/Narrative Lens 0.2.0 and HMS 0.6.4. The user
authorized implementation of the audit's highest-value improvements and continued main integration.
Contributions used temporary isolated worker checkouts, now removed after verification and archival;
the final state retains only canonical main. Production fixes, verification and intentional limits
are recorded here.

| Finding                    | Acceptance                                                                                                                     | Owner / status                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| C1 RTF integrity           | Styled edits retain valid group/control structure; unsafe mappings disclose regeneration; independent boundary regressions     | Integrated; styled/Unicode/binary boundary regressions pass                                                                 |
| C2 Snapshot containment    | Content/index/directory reads reuse guarded bounded source I/O; links, special files and growth fail safely                    | Integrated; symlink/junction, special-file and enumeration boundary regressions pass                                        |
| C3 Binder admission/CAS    | Native guard precedes mutation; expected revision belongs to immutable admitted content; overlapping saves conflict            | Guard/CAS/compound creation integrated; fault/recovery tests pass, legacy parent-race fixtures adapted to atomic CAS        |
| C4 Queue isolation         | Canonical project identity/path scope, owner-validated envelopes and IDs; real two-project Redis proof                         | Integrated; real Redis/SQLite isolation, restart, envelope rejection and cleanup pass                                       |
| C5 Text exports            | Public Markdown/HTML contain actual ordered saved manuscript prose; JSON coverage explicit                                     | Integrated; ordered full-body exports, local standard compilation and failed-read rejection pass                            |
| C6 Analysis cache          | Context/position identity preserves warm/fresh equivalence, with bounded caching                                               | Integrated; equal-length/shared-prefix/position regressions pass                                                            |
| C7 Equivalent interfaces   | Search scope, async continuity, scheduling and retrievable large results have explicit consistent contracts                    | Integrated; canonical queued evidence/stale rejection, UTF-8 paging and installed MCP checks pass                           |
| C8 Publication recovery    | Export intent binds source revisions/output digest; interrupted retries do not overwrite changed artifacts                     | Same-journal publication integrated; interruption, changed-source/output, owner and path tests pass                         |
| C9 Retrieval fusion        | Zero semantic evidence cannot outrank a genuine literal hit before truncation                                                  | Integrated; real fallback zero/opposite/positive relevance regressions pass                                                 |
| C10 Resource behavior      | Bounded appearance/history results; avoid quadratic source acquisition while retaining freshness                               | SQL-projected cursors, 101-match cap, linear source-acquisition fixtures, browser and installed MCP checks pass             |
| C11 API contracts          | Validate complete published input schemas before effects; correct protocol/discovery/unavailable results                       | Direct schemas and real source MCP protocol pass; honest generation tests pass                                              |
| C12 Release verification   | Patched runtime, exact source/version/gate identity and pinned verified publisher                                              | 47 preflight regressions, actionlint, real publisher signature, fresh MCPB and packed launch pass                           |
| C13 Diagnostic privacy     | Malformed provider replies and JSON parser error excerpts never enter logs; retain safe failure metadata                       | Metadata-only diagnostics implemented; real logger and AI caller regressions pass                                           |
| C14 Bootstrap file safety  | Release metadata, checksums and archive bytes come from bounded stable descriptors; links, replacement and modification reject | Integrated; 47 release regressions and 15 publication regressions pass                                                      |
| C15 Diagnostic correctness | Recovery errors retain both failures; lint warnings fail CI; security findings receive evidence-based triage                   | Recovery cause corrected; aggregate errors retained in logs; strict lint enabled; CodeQL #75 classified as a false positive |

Shared contracts: one `MutationCoordinator` journal and guarded saved reader; one existing
`PersistentStore` and validated `identity/project` UUID for source and queues; existing source
provenance and facts model; review/application services remain the manuscript mutation boundary.
Root owns shared types/schemas/migrations, registrations, dependencies, CI, integration and all
validation. Workers edit only assigned modules/tests and do not install, format or run checks. No
locks or SQLite transactions span awaits/I/O; retries must identify prior work.

Validation starts with combined focused regressions for each integration batch, followed by the
complete release gate and installed-package/MCP interactions. Only local/free resources are used;
provider calls, publication/deployment, real client settings and manuscripts are excluded.
Performance and broader semantic quality stay ungraded until representative evidence exists. Formal
conformance, native GUI/hardware certification and a new MCP major remain separate investigations
rather than inferred successes from source changes.

Integration evidence is retained in `logs/audit-remediation-20261029/`. The controlled 3/8-scene
fixtures measure source text acquisitions, not end-to-end latency or native RSS. Raw files are still
read/hashed to detect external changes; the bounded cache avoids repeated parsing only. History list
contracts intentionally return bounded summaries and stable-ID cursors; full proposal or workflow
content remains available through explicit `get`. `get_queue_stats` is now public so scope and
excluded legacy work are inspectable. Standard compilation performs no provider calls. A
source-entry protocol regression also exposed and fixed a type-only database barrel export that
prevented the documented `tsx` development entry point from starting.

Queue state now uses the existing SQLite job history exclusively; its unused parallel MemoryRedis
connection, periodic empty JSON persistence and associated mock were removed. Project-local state
paths reuse the mutation guard, and SQLite targets reject links/directories/FIFOs before opening.
Queue counts aggregate in SQL without loading historical result bodies. Focused state/restart/path
checks pass. Canonical passage identity includes its quote, so equal-length parser interpretation
changes cannot leave stale HMS records behind an unchanged raw-file revision.

The full integrated suite passes all 114 suites and 1,534 tests, with nine explicitly opted-in live
provider tests skipped; `--runInBand --detectOpenHandles` reports no leaked handles. The
source-entry protocol regression allows 30 seconds for cold `tsx` initialization (16.7 seconds
observed), retaining 10-second tool deadlines and its 60-second overall test budget. This is a
bounded semantic test, not a startup performance benchmark. Malformed model JSON diagnostics now
retain only response length and the failure category; response previews and parser messages that may
quote private text are excluded. A stopped pre-fix bundle is not release evidence; packaging
restarts from current source.

Final local evidence (Node 24.22.2) is retained in `logs/audit-remediation-20261029/`:

| Gate                                   | Result                                                                                                                      | Evidence                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Formatting, lint, TypeScript and build | Pass; strict lint enforces zero warnings (C15 corrects the earlier report)                                                  | `diagnostics-final-gates.json`                   |
| Complete suite and resource cleanup    | 114 suites, 1,534 tests pass; nine live tests skipped; no detected open handles                                             | `candidate-tests.log`                            |
| Privacy change and AI callers          | Seven suites, 101 tests pass; six opt-in live tests skipped                                                                 | `post-privacy-privacy.log`                       |
| Tool registry and output contracts     | 80 tools, zero duplicate names; all metadata complete; 32 output checks pass                                                | `candidate-registry.log`, `candidate-output.log` |
| HMS and runtime policy                 | Native/fallback restart checks pass at HMS 0.6.4; patched runtime requirements agree                                        | `final-hms.log`, `final-runtime.log`             |
| Native C2PA compatibility              | 48 format fixtures pass, 25 embedded and 37 detached roundtrips, compressed PNG validation and negative/trust checks        | `final-c2pa-evidence.json`                       |
| Real Redis project isolation           | 15 checks pass with Redis 8.10.2, BullMQ 6.5.1 and ioredis 6.0.0                                                            | `final-redis.log`                                |
| Fresh consumer installation            | All 23 CLI, native-library, actual MCP, Apps, Unicode, review, export and restart checks pass                               | `candidate-installed-smoke.log`                  |
| Fresh Mac extension                    | 21 staged checks, schema validation, packing and actual archived startup pass                                               | `candidate-mcpb.log`                             |
| Release artifact preflight             | Actual MCPB checksum, bounded archive/metadata and version checks pass; temporary registry stamping leaves source unchanged | `candidate-artifact-preflight.json`              |
| Browser and EPUB                       | Dashboard navigation/review/paging exercise passes; four EPUBCheck 5.4.0 cases pass                                         | `dashboard-retest.log`, `candidate-epub.log`     |
| Dependency and hosted alerts           | Zero npm vulnerabilities; baseline main had zero open alerts; subsequent PR findings are addressed below                    | `final-audit.json`; GitHub alert APIs            |

The extension was built at `build/audit-remediation-20261029/mcpb-artifacts/`. No npm package,
release tag, deployment or C2PA application was published. Formal conformance and assurance status
remain unassessed. Synthetic signing certificates establish local test behavior only. Native
Scrivener GUI acceptance, unsaved-buffer access, broad semantic relevance, large-project latency and
native-memory benchmarks are not established by these checks. The privacy fix followed the full
local suite and received the focused caller checks above; protected CI runs the complete final
source again before integration.

PR #210 CodeQL identified two real bootstrap path-check/path-read races. Release metadata, checksum
sidecars and archive hashes now use one bounded descriptor reader with native no-follow/nonblocking
flags where available, regular-file checks, pathname/descriptor identity checks, and stable
size/mtime/ctime checks. UTF-8 metadata must roundtrip exactly. This bootstrap reader uses only Node
built-ins because source eligibility must be verified before installing or executing package
dependencies. The publication regression keeps its intentional absence-before-recovery assertion
using a negative read instead of a misleading stat/read pattern; no check was suppressed.

All 62 combined release/publication regressions pass with open-handle detection, including size
boundaries, symlinks, POSIX FIFO rejection, replacement after opening and modification during a read
even when the digest would match. Evidence: `release-reader-regressions.log`; actual artifact
verification uses the new reader in `descriptor-artifact-preflight.json`. Superseded CI was
cancelled and the final source must pass CodeQL and the complete compatibility matrix before
integration.

The Windows matrix exposed a fixture-only portability issue: Git for Windows rejects Node
`os.devNull` (`\\.\nul`) as `GIT_CONFIG_GLOBAL`. Release fixtures now create a real empty
configuration file inside their disposable directory while disabling system configuration and
filtering inherited `GIT_*` variables. No real Git/client configuration is read or changed, and the
Windows checks remain enabled. CodeQL passes with no open PR alerts after the descriptor fix.

The corrected Git fixture passes all 47 release cases locally (`release-portable-config.log`). The
CI-built extension from source `3b6dc9b` also passes the descriptor-based artifact preflight
(`ci-artifact-preflight.json`); subsequent changes affect only tests and this ledger.

A final log review corrected the earlier zero-warning claim: ESLint had exited successfully with one
`preserve-caught-error` warning in compound creation recovery. The aggregate now identifies the
immediate recovery failure as its cause while retaining the publication failure in `errors`; the
logger preserves that array. A fault-injection regression proves both errors survive and the
prepared operation can subsequently recover. `npm run lint` now uses `--max-warnings=0`, so warnings
cannot pass the required gate. The script change requires no dependency or lockfile update.

CodeQL alert #75 (`js/insufficient-password-hash`) was reviewed against every consumer of the
configuration identifier in `src/handlers/async-handlers.ts`. It is an in-memory HMAC-SHA256 ID
keyed by `crypto.randomBytes(32)` for this process, compared only to reuse initialized services and
reset on shutdown. The key and digest are neither persisted, logged nor returned through an API. It
is not a password-verifier store, so the
[query's password-storage threat model](https://codeql.github.com/codeql-query-help/javascript/js-insufficient-password-hash/)
does not apply. The alert was dismissed as a documented false positive; the query remains enabled
and no code-level suppression or unnecessary password KDF was introduced.

The diagnostics follow-up passes formatting, strict zero-warning lint, types/build and 26 focused
creation/logger checks (`diagnostics-final-gates.json`). Extension CI now covers all runtime source,
shipped assets/vendor code, scripts and package/build metadata rather than only `src/index.ts`; its
Node setup checks the latest patched release. Actionlint passes for the touched workflow.

## C2PA application preparation: 29 October 2026

Preparation is for the public scrivener-mcp 0.14.0 at source
`9b673e010a7e3250b0e7ad9b2b75fdb37346cda7`. Production code and dependencies are unchanged. The
[readiness assessment](conformance/readiness.md) is the canonical account of the application gates;
the [GPSA](conformance/GPSA-scrivener-mcp.md) follows every section of the official v0.2
architecture template and explicitly distinguishes AL1's target from an awarded assurance level.

The private local packet is at `build/c2pa-preflight-20261029/packet/`. It contains populated
applicant details, 35 signed format examples with inputs and sidecars, the administrator's six
official source ingredients, native reports, independent c2patool crJSON, official rubric results,
source/native hashes, a 325-component CycloneDX npm SBOM, a zero-vulnerability npm audit and five
passing isolated key-rotation/plaintext-rejection checks. Test signing keys were deleted; public
test certificates are explicitly untrusted and the leaf validity is 24 hours. Official sample media
and private applicant details are not committed or published.

The format examples pass all 35 registered-handler roundtrips. c2patool 0.26.68 exports crJSON for
27 of them; its installed build does not support the eight tested embedded Office/ODF/EPUB types.
The C2PA public 0.2/specification 2.4 rubric runs on those 27 samples plus the successful MP3
ingredient example: 28 reports, zero evaluator errors, 28 passing traits and three failed traits per
report. The failures confirm absent `claim_generator_info.specVersion` and absent action
`allActionsIncluded` metadata. The eight independently unassessed formats are not treated as passing
the rubric.

Additional open gates are the product's missing crJSON/separate signing-and-TSA Trust Lists/time
assessment harness, incomplete ingredient evidence and native/NVD vulnerability coverage, and
deployment-specific key-protection evidence. Only one of six official-library ingredients completed
signing under synthetic test roots; the other source failures do not prove defective official media.
A complete official-list follow-up fails the existing PEM-only/32-certificate configuration parser.
No failed check was weakened or relabeled as formal conformance.

Evidence and preparation scripts are under `build/c2pa-preflight-20261029/`; concise run logs are
`logs/c2pa-preflight-20261029-*.log`. The archive is deliberately labeled **NOT-SUBMISSION-READY**.
The administrator's assessment, approval, Notice of Conformance and CA issuance remain external. No
application, email, external upload, purchase, release or deployment was performed.

The final private archive, `build/c2pa-preflight-20261029/GPSA-scrivener-mcp-0.14.0-readiness.zip`,
contains 253 files. All 252 payload hashes, ZIP CRCs, sample/source mappings and all 30 template
section identifiers pass the packaging checks; no private key or credential-bearing URL is present.
The archive SHA-256 is `eb5d24338fd54182c311f02881f8d036913374481bbe79bfd66b0a837abe226c`. Evidence:
`logs/c2pa-preflight-20261029-verification.json`. Touched documentation formatting, local links and
script syntax pass. These artifact checks do not turn the failed conformance rubric into a passing
product result.

## C2PA readiness remediation: 30 October 2026

Canonical acceptance: [C2PA-01 through C2PA-06](conformance/readiness.md). The failing 29 October
packet remains unchanged. Current evidence is under `build/c2pa-remediation-20261030/packet/` and
`logs/c2pa-remediation-*`. Archive checksums, candidate revision and retained CI results are
recorded in `build/c2pa-remediation-20261030/{packet-verification,ci-verification}.json` after
packaging.

One source-built c2pa-rs 0.91.7 WASM binding now serves Builder, Reader and genuine crJSON through
the existing domain service and one-request workers. Node's established signing callback retains
private keys outside WASM. The former Node SDK is removed, with runtime security floors unchanged.
An exact upstream crate archive and locked graph are shipped; a small before/after-hashed SDK patch
restricts signing and timestamp policies to their respective trust-anchor purposes. Generated engine
artifacts and all six source inputs are verified at build/package time. The source-reader shortcut
was replaced with a proper SDK Ingredient carrying the source manifest and actual validation
results, so detached history survives. New actions are correctly attributed to created assertions.

Local acceptance evidence:

- 41 actual product CLI crJSON reports (35 signed-source MIME choices plus six supplied ingredients)
  pass all 31 pinned program 0.2/specification 2.4 rubric traits, with zero evaluator errors.
- All 48 redistributable format fixtures pass their applicable roundtrips, tamper and preservation
  checks. Cross-role signing/TSA roots are rejected, supplied before-validity/future clocks fail,
  the CLI agrees with service crJSON, and four reference assets validate expired signing
  certificates using trusted timestamps. Invalid historical PNG credentials are rejected by default
  and explicitly preserved with signed disclosures when requested; later summaries retain them.
- Key policy enforces PBES2/AES256/PBKDF2-SHA256 (600k–2m iterations, 16–64 salt bytes), ownership
  or Windows ACLs, private publication, strong key generation and identity-preserving migration.
- Verified Syft 1.55.0 / Grype 0.121.0 produce and scan five inventories: npm, core Rust, editorial
  native source associations, all eight upstream HMS native SBOMs and the actual runtime. The
  release gate uses fresh NVD-aware data, unfiltered findings and explicit bounded VEX decisions.
  Reviewed exceptions concern the fixed Node Brotli issue, historical V8 matching, development-only
  URI/glob packages and fixed EPUB template control. Other applicable high/critical findings remain
  blockers. npm registry verification covers 239 signatures and 33 attestations; npm audit reports
  zero.
- The complete required local gate passes: formatting, zero-warning lint, types/build, tool
  registry, output conformance, HMS, 118 Jest suites / 1,629 passing tests (nine existing opt-in
  skips), npm audit and 23 isolated installation/protocol smoke checks. A subsequent portable-path
  adjustment to the ASN.1 Jest transformer is checked with POSIX and Windows paths plus its focused
  crypto suites.

Worker ownership was confined to the SCA verifier, inventory producer and their/provenance tests;
root inspected and integrated all contributions, owned shared contracts/manifests/CI and ran every
check. Workers ran no installs, builds, scans or tests. Worker worktrees/branches are removed;
integration follows the required Release verification check. Windows subprocesses share an explicit
OS bootstrap environment, exclude credentials and startup injection settings, and restrict
PowerShell module lookup both before and after shell initialization. The real key-access regression
and installed package smoke exercise these boundaries. Credential filesystem operations also reject
UNC/device paths before I/O, including canonical output resolution. The CI security job verifies
pinned scanner downloads, retains raw evidence and is required by the release gate alongside the
full platform matrix. Final-candidate Windows/Linux results must be checked in the retained CI
artifacts for that revision; local measurements do not imply platform results.

Remaining external boundaries: the published 2.4 full crJSON schema is an unresolved include, so
full official-schema validation awaits the administrator's authoritative file; this is separate from
41 passing official-rubric reports. Product classification/role eligibility, legal/applicant review,
production deployment key custody and the administrator/approver/CA decisions remain external. No
formal conformance or assurance is claimed. No application, email, assessment upload, purchase, npm
release or deployment has been performed.
# Narrative Lens integration work

Active objective: use the supported Narrative Lens 0.2 API to its practical potential,
without maintaining competing implementations of its analysis algorithms.

Acceptance scope:

- A project-owned asynchronous manuscript context, bounded cache and lifecycle cleanup.
- Stable binder scene IDs, exact saved revisions and original-text evidence; author
  configuration, scene intentions/chronology, suppressions and explicit coverage.
- Persisted revision baselines and upstream report comparison, connected to the existing
  review/workflow interfaces without automatic manuscript mutation.
- Useful supported standalone analysis and author-confirmed narrative annotations;
  do not expose legacy stubs as functioning detectors or fabricate model availability.
- Replace overlapping local algorithms with upstream calls while retaining application
  contracts, provenance, persistence, scheduling and unique editorial behavior.
- Real native-library regression fixtures, public tool integration, isolation/lifecycle
  checks, representative local performance evidence, documentation and required gates.

Initial evidence: the installed/locked/latest npm release is 0.2.0. Upstream integration
and manuscript contracts were inspected. The default addon excludes ONNX: model loading
must remain explicit and capability-checked. `analyzeSubtext` is a documented legacy stub;
`analyzeSubtextAnnotations` is the supported author-evidence API. No paid development
calls, production manuscript edits, commits or publication are authorized by this work.

## Ownership and duplication boundary

| Responsibility | Owner / integration |
| --- | --- |
| Readability formulas, syllable/polysyllable counts | Narrative Lens `computeReadability`; advanced readability, metrics, word classification and enhancement adapters reuse it. Linsear Write remains local because no equivalent is exported. |
| Pacing, themes, cliché/passive/prose examples, vocabulary frequencies, dialogue extraction, opening cues | Narrative Lens standalone APIs; existing analyzers adapt their results. One prose-example result is shared by style, quality and suggestion generation. |
| Manuscript rules, evidence ranges, rule configuration, suppression, intentions, chronology, report comparison, incremental scene cache | Project-owned `ManuscriptContext`, `compareManuscriptReports` and native validation; no second rule engine. |
| Author causality, knowledge, epistemics, reader state, promises, subtext, thematic evidence, coreference, uncertainty, history | Supported native author-evidence APIs in an isolated child process with a deadline, with original saved source quotations. Legacy automatic subtext stub is not exposed. |
| Binder order/identity, saved revisions, persistence, workflow checkpoints, proposal preview/apply/undo | Scrivener MCP application services. Analysis itself never edits manuscript text. |
| Curated canon, cross-series membership, aliases, finding status, inferred fact candidates | Existing editorial services. Their eye/hair-color and birth-year candidate extraction supports canon curation; native conflict findings do not export equivalent complete fact candidates. Domain overlap is retained deliberately, not represented as identical detection. |
| Emotion, ending/cliffhanger and callback phrase cues, contextual word classification, repeated bigram ratio, sensory/telling summaries | Existing heuristics with distinct contracts; no verified equivalent upstream scalar outputs. Phrase cues are not verified setup/payoff detection. Native prose examples do not provide a complete contextual word-classification API. These remain heuristics, not calibrated quality measures. |

Removed the unused SIMD text processor after checking callers and history. Readability algorithms
are no longer maintained there or independently in the legacy metric adapters. Full-content cache
keys replace prefix hashes so later edits invalidate results. Opening quality is `unassessed`;
passive prevalence and style consistency are `null` where no supported measurement exists.
Standalone results explicitly declare raw policy and saved revisions. `analyze_craft_local` also
accepts `policy: "configured"`, returning the same configured document report used by guided
review. Manuscript analysis and guided review apply saved author controls. Every affected result
identifies its source revisions, effective configuration and engine version. Unavailable numeric
metrics are `null`; unavailable classifications are `"unavailable"`. Non-dialogue text is not
automatically classified as description.

## Using the integration

`analyze_manuscript_local` defaults to `action: "analyze"`. Start with `action: "capabilities"`
for native rules/templates, annotation argument names and cache statistics. `action: "configure"`
replaces project controls, for example:

```json
{
  "action": "configure",
  "controls": {
    "configuration": { "rules": ["NL-GRAMMAR-REPETITION", "NL-GRAMMAR-WHITESPACE"] },
    "scenes": { "BINDER-UUID": { "intentions": ["repetition"] } },
    "knownCharacters": ["Mira"]
  }
}
```

Use actual binder UUIDs; scene controls cannot replace source identity/text. Native validation
rejects unknown configuration and unsupported values before persistence. Deleted/unselected scene
IDs cause an explicit error; replace controls to remove them. `{"saveAs":"draft-1"}` retains a
baseline; `{"baseline":"draft-1"}` compares against it. `read_baseline` and `delete_baseline`
require `baseline`. Names are project-local, with at most 32 baselines of at most 16 MiB each.
Controls/cache/baselines persist or clear according to their ownership: controls/baselines survive
reopening; the bounded native scene cache lasts only for the open project. Concurrent analyses
serialize through a queue capped at eight accepted operations; excess requests fail explicitly.
Closing drains accepted operations before releasing the native context and database.

`analyze_narrative_annotations` accepts `kind` and `input`, using upstream argument fields:

| Kind | Required input fields |
| --- | --- |
| causality | `nodes`, `interventions` |
| knowledge / reader | `propositions`, `events` |
| epistemics | `propositions`, `events`, `queries` |
| promises | `events` |
| subtext | `annotations` |
| themes | `theses`, `annotations` |
| coreference | `links` |
| uncertainty | `observations` |
| history | `catalogue`, `usages`, `targetYear`, `toleranceYears` |

Arrays must be supplied even when empty (maximum 4,096 entries each). The native library owns
element validation. `AuthorSource` is `{sceneId, utf16Start, utf16End, quote}`; offsets refer to
the saved original text, not normalized text. For example, a causal node is
`{id:"door-open",mechanism:{kind:"fixed",value:true},evidence:SOURCE}` and an intervention is
`{nodeId:"door-open",value:false}`. A promise setup is
`{kind:"setup",id:"letter",description:"Deliver the letter",evidence:SOURCE}`;
its resolution is `{kind:"resolution",id:"delivery",setupId:"letter",outcome:"fulfilled",evidence:SOURCE}`.
Supply exact quotations and valid source ranges. All ten modes publish discriminated, nested input
schemas generated from the upstream v0.2.0 JSON contracts, including enums, nullable fields and
UTF-16 source shapes. Native validation owns semantic checks. Historical target years and catalogue
years use signed 32-bit integers; tolerances use unsigned 32-bit integers. BCE years such as -300
are accepted. `scripts/generate-narrative-annotation-schema.mjs` accepts the pinned upstream
`docs/standalone.schema.json`; format only its generated TypeScript file after regeneration.

Guided chapter review now records native manuscript findings. Safe whitespace proposals use only
native grammar findings with one exact replacement, filtered through configured manuscript rules;
free-text editorial advice is never interpreted as a replacement. Existing revision-bound review
approval and undo remain responsible for applying any proposal.

## Local validation evidence (2026-10-30)

`scripts/check-narrative-lens.mjs` exercises the actual native asynchronous context with 100
synthetic scenes (450,819 UTF-8 bytes), repetition rules, and a 16 MiB cache. On macOS arm64,
Node 24.22.2, this single diagnostic run measured 81.99 ms cold, 1.79 ms warm and 1.89 ms after
one scene changed. Native statistics reported 100 reused scenes warm and 99 reused/one recomputed
after the edit, with 747,951 bytes retained. A 1 ms timer fired 64 times during the cold analysis;
the warm runs were too short for a meaningful responsiveness measurement. These are scoped
integration observations, not accuracy, throughput or end-to-end Scrivener benchmarks. Raw evidence:
`logs/narrative-lens-benchmark.json`; rerun with the supported Node runtime.

The redundant `syllable` dependency and its exclusive transitive dependencies were removed using
`npm uninstall syllable --package-lock-only --ignore-scripts --offline`; no other dependency
versions changed. Local development and validation use no paid providers or model downloads.

Prior verification, before the quality review below:

- TypeScript 5.9.3 checked the complete project with its unchanged `tsconfig.json` and emitted
  successfully with zero diagnostics. Slow filesystem writes required a compiler host that skips
  byte-identical output files (17 written, 879 identical files skipped); type checking and emitted
  contents were unchanged. The standard build's native binding verification also passed.
  Evidence: `logs/narrative-lens-build-current.log`, `logs/narrative-lens-build.log`.
- Full-source lint identified six formatting/style errors in two new/changed files; these were
  corrected. The final affected-file lint rerun exited zero, including the final classifier,
  suggestion and public type changes. Full source Prettier check passed; subsequent touched
  files were formatted. `git diff --check` passed.
- Registry: 82 tools, zero duplicate names, 62 data tools with output schemas. Output conformance:
  36 passed, zero failures/skips, including the two new public tools and native revision comparison.
- Full Jest run: 120 suites passed and one lifecycle suite failed solely because its assertion
  accessed the deleted resource pool; 1,651 tests passed and nine optional live tests were skipped.
  Removed that obsolete assertion while preserving in-flight completion, memoized-state and timer
  cleanup checks. Its focused rerun passed all eight tests. Combined final coverage: 121 suites,
  1,652 unique passing tests, nine optional skips. No production changes followed the full run.
  Evidence: `logs/narrative-lens-full-tests.log`, `logs/narrative-lens-lifecycle-final.log`.
- Native regressions cover UTF-16 evidence, persisted report comparison, project isolation,
  author intentions, invalid controls/quotations, source revision races, complete-content cache
  invalidation, bounded queue/draining, baseline capacity/replacement, safe exact replacements,
  native prose suggestions, opening availability and classifier syllable handling.

These checks are local macOS arm64 evidence, not a fresh cross-platform release certification.
No commits, publication, paid calls or real manuscript mutations were performed.


## Quality review against the updated audit (2026-10-30)

The inspected working tree still contained defects after the earlier remediation: fabricated
fallback labels and scores; sibling failures discarding native findings; schema variants that
rejected valid knowledge/reader payloads; pagination rerunning analysis and undercounting text
serialization; unexposed review methods; and thread termination that could return before native
work stopped. The fixes below supersede earlier completion claims for these paths.

| Audit item | Current behavior and focused evidence |
| --- | --- |
| P0-1 | The actual `analyze_document` handler projects typed local metrics and suggestions, preserves native repetition findings and evidence, declares provider unavailability and rejects changed saved revisions. `document-analysis-fallback.test.ts` uses a failing provider stub and real local analysis; `generate-content.test.ts` also verifies the public fallback contract. |
| P0-2 | Empty/failed classifications are unavailable; unsupported percentages, emotion consistency and zero-denominator ratios are null. Independent failures preserve successful findings; failed cache writes preserve measurements. `analysis-availability.test.ts` covers 9/10/11-token boundaries, empty input, native errors and multiple sibling failures. |
| P1-1 | General, standalone, manuscript, author-evidence and wired chapter-review results identify source revisions and explicit policy. Configured craft and workflow reports honor intentions/suppressions; raw craft explicitly ignores them. `narrative-analysis.test.ts` tests both policy fixtures through all three entry points. |
| P1-2 | Pages refer to immutable, project-owned serialized results. The byte check includes the complete MCP result, text JSON escaping and structured content. Large metadata, comparisons and individual findings use lossless JSON fragments. `report-transport.test.ts` checks budget−1/budget/budget+1 and reconstructs Unicode reports exactly after the original object changes. |
| P1-3 | `narrative-annotation-schema.ts` is generated from pinned upstream contracts, with shared definitions and a kind discriminator. Conditional branches validate only the selected mode, keeping its nested field errors visible in bounded MCP error messages. Optional native fields remain optional. All ten modes pass meaningful inputs and reject malformed nested fields through the public dispatcher in `narrative-analysis.test.ts`. |
| P1-4 | All ten native dispatch paths have populated fixtures, including epistemic answers, reader changes and historical candidates. Invalid quotations/ranges are rejected wherever the API accepts source ranges; uncertainty rejects missing scenes. Tests cover 7/8 admitted operations, rejection of the ninth, schema array bounds 4095/4096/4097, cancellation recovery and draining on close. |
| P1-5 | Public accept/dismiss/recheck actions use saved baselines and finding IDs. Decisions preserve disposition and provenance across restart; stale revisions and replaced original baselines fail explicitly. Rechecks delegate resolution and coverage gaps to native comparison. A two-scene Unicode-edit fixture exercises the public workflow, and disabled coverage yields `recheck_required`. |
| P1-6 | Signed-year acceptance is checked at −300, −1/0/+1 and both signed 32-bit endpoints; adjacent overflow and fractions fail. Tolerance tests separately cover 0, 1, unsigned maximum and adjacent failures. Native binding source and direct local probes corroborate these ranges. |
| P2-1 | The duplicated `crystal clear` catalogue entry now delegates to native prose evidence. The remaining business-word classifier, phrase-cue extraction and singleton canon extraction have demonstrated native gaps, described below. Unused parity declaration objects and the nonexistent `NL-STYLE-CLICHE` claim were removed. |

### Transport and finding-review contract

Small results retain their normal fields under `result`, with an added `reportId`. Large results
return `result.encoding: "json-fragment"`, a string `data`, and pagination metadata. Continue with
`analyze_manuscript_local` using `action: "read_report"`, the same `reportId`, and the returned
`pageCursor`. Concatenate the fragment strings in cursor order and JSON-parse once. This preserves
all native report fields, including comparisons and coverage; it does not rerun analysis between
pages. Cursors are UTF-16 offsets into serialized JSON and never split a surrogate pair. The
configurable 16 KiB–4 MiB limit applies to the serialized MCP result, excluding the outer JSON-RPC
frame. The default is 1 MiB. At most 32 reports and 32 MiB of serialized data are retained per open
project, with a 16 MiB individual report limit. Evicted/closed report IDs fail explicitly; persisted
baselines can be read again. Native findings budgets remain visible through native report coverage
and omitted-findings counters.

Save a baseline with `saveAs`, then use a returned `findingIds` entry with `accept_finding` or
`dismiss_finding`, `baseline`, and optional `note`. After an external edit, analyze into a different
baseline and call `recheck_finding` with that current baseline and the original finding ID. Keep the
original reviewed baseline: replacing or deleting it removes the evidence needed for comparison
and causes an explicit error. A disposition never applies a prose edit; revision-bound proposal
approval remains the separate mutation path.

### Detector ownership evidence

`detector-ownership.test.ts` supplies a shared corpus and checks native output and adapter behavior:

- Native prose examples detect `crystal clear`; token classification now consumes that evidence.
  The duplicated local phrase was removed. Native prose examples do not flag `think outside box`;
  the existing business-phrase classifier still does. Single-word business classifications also
  have no equivalent native token-classification API. These are lexical heuristics, not calibrated
  scores or a substitute for native prose analysis.
- A passage with explicit `Little did...` and `remembered...` cues yields local source excerpts,
  while native setup/payoff analysis on the same single-scene fixture returns no pairs. These cue
  excerpts remain separate behavior, rather than being advertised as confirmed setup/payoff links.
- A singleton eye-color assertion and birth-year assertion yield canon candidates with exact UTF-16
  quotations and saved revisions. The native attribute-conflict rule returns no conflict for that
  fixture and exposes no complete singleton fact catalogue. Existing canon, alias, confidence and
  cross-series lifecycle behavior is retained.

### Resource boundary and verification limits

Author annotation and baseline-comparison operations now run in a child process. A 30-second deadline or AbortSignal sends
SIGKILL, and completion waits for process exit. Inputs are bounded at 64 MiB and output at 16 MiB;
the child has a 128 MiB V8 old-generation setting and one native/UV thread-pool slot. These are not
native RSS or total-memory limits. At this checkpoint, the manuscript context still used its
16 MiB native cache and asynchronous in-process API; the persistent-context isolation checkpoint
below supersedes that boundary.
MCP request cancellation is passed through the dispatcher and annotation handler to this process
using request-local options. A concurrent-request regression confirms that cancelling one request
does not cancel another request on the same project; cancelled queued work does not launch a child.

`narrative-worker.test.ts` checks ordinary and 1 MB Unicode results, parent event-loop progress,
a deliberately blocked child, hard cancellation, native validation failure, abrupt exit and
subsequent reuse. PID liveness checks confirm timed-out/cancelled children have exited before the
promise rejects. This supports the tested process-lifecycle contract, not an OS-independent RSS
bound. See [Node child-process semantics](https://nodejs.org/api/child_process.html) and
[worker resource-limit semantics](https://nodejs.org/api/worker_threads.html).

Current review validation uses Node 24.22.2 on macOS arm64, local fixtures and mocked provider
failures. Logs are in `logs/quality-review-20261030/`. Each Jest invocation uses `--runInBand
--runTestsByPath` with one test file; no project-wide build or parallel test runner was used.
The earlier global build/test evidence above is historical and is not certification of this final
working tree. Native RSS containment, representative full-manuscript p50/p95 performance, cross-platform execution
and comparative editorial accuracy remain unverified investigations. No paid API calls, commits,
pushes, publication or real-manuscript mutations were performed.

First review verification: 156 passing tests across 16 individually invoked suites (availability,
native analyzers, suggestions, classifier entities, detector ownership, advanced readability,
document fallback, content generation, standalone handlers, manuscript analysis, worker lifecycle,
report transport, editorial workflows, predictive-cache lifecycle, tool registry and stdio protocol).
No tests were skipped in these runs. The manuscript suite includes all ten mode fixtures and the
request-cancellation regression. Affected-source lint, touched-file formatting and `git diff --check`
pass; detailed per-suite output and lint logs are retained in the review log directory above.

### Follow-up: legacy readability and saved-source transport (2026-10-30)

The legacy advanced-readability entry point also now distinguishes unavailable analysis from
measurement. Empty or wordless text has null scores and reading level, with actual native counts
retained. Native failures report `availability: "unavailable"`, `reason: "analysis_failed"`, and
null unmeasured counts. Comparisons and contextual scores do not rank unavailable results; batch
analysis preserves each input position when a native calculation fails. Invalid input types and
malformed batches fail explicitly. The public declaration re-exports the implementation's types
so nullability and availability cannot diverge between the two interfaces.

SMOG is null when the native engine reports it unavailable, with regressions at 29, 30 and 31
complete sentences. The legacy `linsearWriteFormula` field remains present but is null: the native
engine supplies no such measure, and the former local approximation has been removed rather than
advertised as a validated formula. Trend segmentation returns only actual nonempty segments,
preserves sentence punctuation, validates integer counts from 1 through 1000 and reports an
unavailable trend when fewer than three segments are measured or any segment failed. Existing
consumers must handle these intentional nullable values instead of treating sentinel zeroes as
measurements.

`narrative-saved-source.test.ts` exercises saved synthetic `.scriv` fixtures through `ProjectLoader`,
`DocumentTree`, `MutationCoordinator`, `ProjectSource`, SQLite baselines, native analysis/comparison
and the public manuscript handler, including every continuation page and its serialization. The
matrix covers 8/32/96 scenes and 1/8 repetition findings per scene, with five cold/warm/one-edit
samples per combination: 90 measured operations. Cold means fresh source/native context caches;
project opening and OS disk-cache state are outside the measurement. Every operation verifies
two saved reads per scene, exact finding counts, unique finding IDs, revision identity, native
cache reuse and the resolution of one finding after an external Unicode-containing RTF edit.

Predeclared local diagnostic budgets were 5000 ms per complete operation, 100 ms observed event-loop
lag and 128 MiB sampled RSS growth. These are evaluation targets, not production memory limits.
The initial measurement exceeded the lag target during immediate continuation draining: the largest
comparison required 145 pages and observed 192.26 ms lag. Continuation handlers now yield to the
event loop with request cancellation, and the transport avoids constructing a complete duplicated
response when its minimum possible size already exceeds the page budget. The repeated matrix
observed a maximum 34.95 ms lag, 220.60 ms complete-operation latency and 10.05 MiB sampled RSS growth,
with zero diagnostic budget violations. Every page remained within 32768 serialized MCP bytes.
These observations cover the combined changes on one host, not a universal performance guarantee.

For the largest fixture, 96 scenes with 8 findings per scene:

| Phase | Sample p50 (ms) | Sample p95 (ms) | Maximum observed lag (ms) | Maximum pages |
| --- | ---: | ---: | ---: | ---: |
| Cold, including baseline save | 109.07 | 110.31 | 12.55 | 54 |
| Warm, including comparison | 218.99 | 219.39 | 34.51 | 145 |
| One scene edited, including comparison | 219.54 | 220.60 | 34.95 | 145 |

Percentiles use nearest rank; with five samples, p95 is the maximum. RSS is sampled every 5 ms
and after completion, so short-lived peaks can be missed. Raw before/after measurements and the
summaries are retained in `logs/quality-review-followup-20261030/saved-source-before-yield.json`
and `saved-source.json`. The fixtures are short synthetic scenes using one native rule; this does
not certify full-novel workloads, other rule families, model inference, MCP client/network overhead
or cross-platform latency.

The worker also passes serialized-output tests at 16 MiB−1, exactly 16 MiB and 16 MiB+1. The first
two return complete results; the last rejects explicitly. All three child PIDs have exited before
the returned promise settles. `worker-resources.json` records child high-water RSS of 110.72–126.72
MiB for these serialization fixtures, distinct from the 128 MiB V8 old-generation setting. This
adds observed process-resource evidence; it does not establish a native-addon RSS containment bound.
Existing deadline and hard-cancellation regressions still pass.

Follow-up validation: 102 passing tests across seven separately invoked suites (advanced readability,
analysis availability, document fallback, narrative analysis, report transport, native worker and
saved-source analysis); no skips. Affected-source lint, touched-code formatting and `git diff --check`
pass. No global build, project-wide typecheck, parallel test runner, paid service, commit or push
was used. Logs and source hashes are under `logs/quality-review-followup-20261030/`.

Reproduce the saved-source measurements with a repository-supported Node runtime and the single
suite below; use the same environment and `tests/unit/services/narrative-worker.test.ts` with
`SCRIVENER_WORKER_RESOURCE_REPORT` to record worker resource observations:

```sh
SCRIVENER_RUN_LIVE_AI_TESTS=0 SCRIVENER_DISABLE_KEY_DISCOVERY=1 \
UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 OMP_NUM_THREADS=1 \
SCRIVENER_RESOURCE_REPORT=logs/quality-review-followup-20261030/saved-source.json \
node node_modules/jest/bin/jest.js --runInBand \
  --runTestsByPath tests/unit/services/narrative-saved-source.test.ts
```

Native RSS enforcement, representative full-novel and cross-platform validation, and independently
judged comparative editorial accuracy remain open investigations; no release-wide or zero-defect
certification follows from these focused checks.

### Production-readiness continuation (2026-10-31)

The broader production-readiness goal remains active. The existing release, platform and conformance
results above are historical; they do not certify this changing working tree. Current work retains
the single-file, single-threaded validation restriction and uses local fixtures without paid services.
Evidence for this continuation is retained in `logs/production-readiness-20261031/`.

The shared response formatter now minifies standard JSON without deleting null metrics, empty
objects, array positions or dates. Its 28 focused tests pass, including exact reconstruction through
the result spool. Real stdio checks verify document-info text/structured parity and the complete
default queue workflow through admission, status, result retrieval and supplied-text revision checks.

Inspection also found that default queued document analysis could complete without analyzing text,
requested entity/sentiment sections were missing, and embedded jobs retained caller-mutable input.
Corrections now snapshot JSON at admission, always perform base analysis, include readability by
default, honor optional native NER and local lexicon sentiment requests, and preserve independent
results when a section is unavailable. The installed native engine's NER call was directly observed
to reject with `onnx_feature_disabled`; no model was downloaded. Result envelopes distinguish hashes
of supplied UTF-8 text from saved RTF revisions and do not claim saved-source checks for supplied text.
Project jobs now validate document identities and sizes, preserve input order, honor bounded batch
options, and omit the former unmeasured two-seconds-per-document estimate. Admission checks cover
the 255-character identifier, 5,000,000 UTF-16-code-unit text, 5000-document and five-concurrent-document
boundaries. The overall serialized queue payload remains capped at 64 MiB. Malformed analysis jobs
are rejected before admission and revalidated by external workers as unrecoverable failures.

The lexicon sentiment path had also treated sentence punctuation as part of a lookup word and
misread the parser's POS output. It now uses the installed parser's normalized terms and actual
tags, computes those terms once per sentence, and retains clause boundaries for negation and
intensifiers. Regressions cover case, quotes, positive/negative words, punctuation and the 2/3/4-token
negation boundary. These are documented heuristic signals, without invented model probabilities.

Embedded queue admission now commits durable state before scheduling work. Terminal state writes
are separate from execution errors; failed writes retain the actual outcome for persistence retry
through status/statistics/shutdown without rerunning the job. Persistent storage is authoritative,
without a duplicate full-result memory cache that could resurrect deleted records. Fault-injection
tests verify admission failure, repeated terminal write failure, recovery and exact restart retention.
If storage remains unavailable through shutdown, shutdown reports failure and closes other resources;
the abandoned job becomes interrupted when reread after storage recovery, including a new service
in the same process, with no automatic replay. External resource-close failures also permit cleanup
of the remaining resources and a later cleanup retry.

Unimplemented legacy export/batch job types no longer accept new submissions or start workers;
their existing queue histories remain readable. The supported `export_project` and
`queue_project_analysis` tools remain available. Cancellation descriptions now distinguish skipping
unstarted embedded work, discarding an active embedded result and Redis active-job removal failure.
Completed large results use the existing lossless `_ref`/`read_result` transport while preserving
the original stored result and its provenance.

Final focused validation for this continuation: 205 tests pass across 16 separately invoked suites,
with no skips. This includes real SQLite/native queue execution and failure recovery, mocked external
queue admission/concurrency/cleanup, public stdio dispatch, all ten annotation modes and baseline
compatibility, bounded report and job-result transport, availability/fallback, cache/service lifecycle,
word classification and compilation. Targeted lint, touched-code formatting and `git diff --check`
pass. The SDK test-type and ES2021-library compatibility errors encountered during development were
corrected; the sentiment behavior failure led to the parser correction above. No global build,
project-wide typecheck, parallel suite runner, paid call, commit or push was used.

Remaining review coverage includes durable queue failure/recovery, mutation and RTF preservation,
retrieval/canon/series integrity, compilation/export, provider/privacy boundaries, setup/client
contracts, content credentials and packaging/runtime compatibility. Current evidence must be recorded
per component before raising its rating. Native memory enforcement, representative full-manuscript
and cross-platform workloads, external conformance assessment and independent comparative editorial
judgments remain distinct open gates; no numerical high-quality or best-in-class score is asserted.

### Passage-index ownership follow-up (2026-10-31)

The preceding 205-test checkpoint and its source manifest remain in
`logs/production-readiness-20261031/verification-summary.json`; subsequent changes are not covered
by that checkpoint. Follow-up evidence is recorded in `logs/production-readiness-index-20261031/verification-summary.json`.

Inspection found that queued indexing and foreground retrieval used separate writing-service
instances, the async indexing wrapper dropped `rebuild`, and clearing an index before validating its
replacement could lose the usable prior index. The queue now owns one shared writing service,
including local indexing without a chat provider, and shutdown owns its cleanup after draining work.
Rebuilds stage a replacement before swapping it in; failed cleanup retains ownership for retry.
Input text/revision snapshots are captured before deferred indexing. Root document titles, paths
and revision metadata now survive queued indexing. A malformed style-provider response also now
fails explicitly instead of returning invented tone, voice, complexity and 0.5 confidence.

Validation passed 111 tests across eight individually invoked suites on Node 24.22.2, with two
opt-in live-provider tests explicitly skipped. The new integration cases exercise the actual local
queue/index path, 4095/4096/4097-document admission, saved metadata, failed replacement preservation,
caller mutation isolation and retry after both creation and cleanup fail. Targeted lint, formatting
and `git diff --check` pass. All provider calls were mocked or disabled; no build or parallel runner ran.

Further confirmed review work remains: `suggest_improvements` currently ignores its saved document
identity when grounding context, and its async route ignores `useContext` and differs from synchronous
generation. The older, currently unrouted AI plot-consistency method also maps malformed provider
output to an empty finding list and defaults unknown severities to medium. These findings remain
open; they are not closed by the passage-index changes or the earlier Narrative Lens checks.

### Suggestion provenance follow-up (2026-10-31)

`suggest_improvements` now shares one implementation between synchronous and queued execution.
Context requests resolve the selected saved document, bind its RTF revision at admission, and recheck
before and after the provider call. Coverage identifies the exact UTF-16 prefix and any truncation;
context-free requests read no manuscript text. Requests are bounded, saved text is fenced as untrusted
input, output carries the shared envelope, and large results use the existing opaque spool contract.
Queued suggestions use one generation call and one queue attempt instead of four unrelated calls
with automatic retry. Provider failures and empty replies fail explicitly.

Caller/history inspection confirmed that commit `4e1257a` moved public plot consistency to canonical
continuity analysis; the old provider method had only obsolete test callers. That method and its
tests were removed, leaving the actual continuity workflow intact. Evidence is recorded in
`logs/production-readiness-suggestions-20261031/verification-summary.json`: 114 tests passed across
nine individually invoked suites, with one opt-in live-provider test disabled. The new 22-case suite
exercises saved RTF, shared sync/queue contracts, source changes before/during generation, Unicode
and 15999/16000/16001-character boundaries, malformed requests, provider failures and spooled output.
SDK schema validation, actual continuity queue behavior and actual source stdio protocol checks pass.
Targeted lint, touched-code formatting and `git diff --check` pass; no paid calls or global builds ran.
Broader style-provider schema/availability and lifecycle cleanup paths still require review, along
with the previously recorded release gates.

### Failed-shutdown ownership follow-up (2026-10-31)

Inspection found that the async-service wrapper discarded its queue reference before shutdown
succeeded and swallowed initialization errors; queued workers could also lose their dependencies
when worker shutdown failed. The wrapper now retains failed cleanup ownership, blocks operations
after a failed transition, and propagates initialization/cleanup failures. Replacement waits for
successful cleanup. Queue shutdown retains processor dependencies until workers drain and retains
the shared connection while queue/event cleanup remains incomplete. Evidence is recorded in
`logs/production-readiness-lifecycle-20261031/verification-summary.json`: 119 tests passed across
eight individually invoked suites, including failed initialization with successful/failed cleanup,
failed replacement, refusal of new work during failure and successful retry on the retained owner.
Existing embedded durability, local retrieval, saved-source suggestions, continuity and actual stdio
paths pass. Targeted lint, formatting and diff checks pass; no paid calls or global build ran.

### Provider style contract follow-up (2026-10-31)

Style-provider output previously accepted arbitrary JSON objects, omitted unavailable fields and
carried neither sample revisions nor truncation coverage. It now returns the seven advertised
fields with explicit unavailable/partial status, preserves valid strings from partially malformed
finding lists, and identifies the exact UTF-16 sample ranges included in the bounded prompt. Input
sample count/length and Unicode boundaries are checked. The public tool exposes nested input/output
schemas, supplied-text revision envelopes and the shared opaque result-reference schema. Evidence
is recorded in `logs/production-readiness-style-20261031/verification-summary.json`: 131 tests passed
across nine individually invoked suites, with one opt-in live-provider test disabled. The new
26-case suite covers partial/unavailable provider output, sample mutation isolation, 63/64/65-sample
admission, 63999/64000/64001-character inputs, 7999/8000/8001-character coverage, Unicode boundaries,
omitted samples and lossless spooling. Existing queue/index/lifecycle/suggestion contracts, shared
envelopes and actual stdio checks pass. Targeted lint, touched-code formatting and diff checks pass.
All development provider responses were mocked; no paid calls, global builds or parallel runners ran.

Further inspected defects remain in AI compilation and semantic extraction. Compilation fabricates
0.7/0.5 quality scores on missing/provider-failed assessments, and prose enhancement replaces full
output with a provider rewrite of only its first 12000 characters. The semantic extractor similarly
defaults unknown entity types/mention counts and relationship strength, and treats malformed JSON
as an empty successful result. These paths and their callers require correction before any broad
production-readiness claim; they are not covered by the preceding provider-style remediation.

### Provider completion boundary (2026-10-31)

Before changing compilation, inspection confirmed that the shared AI client discarded provider
stop reasons and accepted truncated/refused/empty completions as ordinary text. Installed Anthropic,
OpenAI and MCP SDK declarations were checked. The client now rejects incomplete or empty text
responses without replaying them on another provider; MCP sampling's optional absent stop reason
remains supported. Provider-unavailability classification also rejects malformed HTTP statuses and
null errors instead of triggering fallback or masking the original failure. Evidence is recorded in
`logs/production-readiness-provider-20261031/verification-summary.json`: 156 tests passed across six
individually invoked suites, with one opt-in live-provider test disabled. Actual installed-SDK request
fixtures, no-replay completion failures, safe public generation errors, local findings fallback and
style/suggestion contracts pass. The old handler-only empty-prose guard is now owned by the client;
its error regression was updated to the shared failure path and supplemented with public truncated,
filtered and tool-call completion cases. Targeted lint, formatting and diff checks pass. All responses
were mocked; no paid call or global build ran. Compilation and semantic-extraction defects remain open.

### Compilation integrity follow-up (2026-10-31)

AI compilation now exposes null/unavailable quality fields, retains valid findings from partial
responses, and preserves complete output when a rewrite fails or exceeds its 12000-character source
bound. Provider transformations use plain text before the existing renderer produces the requested
format; later enhancement cannot violate the selected target's word limit. Quality opinions identify
their exact 4000-character coverage and full plain-text hash. Public results retain warnings, quality,
and saved-RTF revision envelopes, rechecking both source revisions and selected binder metadata/order.
Formatted content and its revision are captured from one raw snapshot. Marketing generation reads
saved Draft text or explicit document IDs, rejects oversized scopes before provider access, rechecks
revisions/scope, returns explicit errors, and spools large output. Template token budgets now match
the requested generation length within validated limits instead of fixing all output to 2000 tokens.

Evidence is recorded in `logs/production-readiness-compilation-20261031/verification-summary.json`:
187 tests passed across eight individually invoked suites, with three opt-in live-provider cases
disabled. The 29 new public integration cases exercise actual RTF/SQLite source reads, source and
binder changes during generation, 11999/12000/12001-character boundaries, complete Unicode retrieval,
provider failure, nested output-schema validation, and rendered text/Markdown/HTML. Document review,
compilation, atomic formatted snapshots, and actual stdio dispatch pass. Targeted lint, touched-code
formatting and `git diff --check` pass. All development provider calls were mocked; no global build
or parallel runner ran. Semantic-extraction ownership and availability remain under review.

### Semantic ownership cleanup (2026-10-31)

Caller and history inspection established that `a29584d` replaced the legacy semantic database layer
in both public search routes. No current source, registration, export, or test caller used that class.
Its abandoned provider extraction, fabricated counts/strengths, partial graph synchronization and
SQL fallback were removed together with its sole context formatter and obsolete tests. Compilation
now calls the shared `AIClient` directly; the otherwise unused semantic extractor and ignored task
hints were removed. Author preferences still affect prose only, and marketing output budgets remain
bounded by validated requested lengths. Active local passage search, canon provenance, continuity,
and explicit relationship storage retain their existing owners.

Evidence is recorded in `logs/production-readiness-ownership-20261031/verification-summary.json` and
`ownership-history.patch`: 92 tests passed across six individually invoked suites, with one live-provider
case disabled. Coverage includes direct-client compilation and author preferences, saved-source public
generation, actual local passage ranking/reindexing, project/series canon evidence, queued continuity,
and stdio dispatch. No references to the removed modules remain in source or tests. Targeted lint,
formatting and diff checks pass; no paid calls or global build ran. This closes the previously identified
semantic-extractor defaults by removing their obsolete, unrouted implementation, not by claiming new
provider extraction accuracy. Current shared-client sampling timeouts and embedding result integrity
remain under inspection, alongside the release gates above.

### Shared-client integrity follow-up (2026-10-31)

MCP sampling now receives the configured per-request timeout and total deadline, with progress
resets disabled. Embedding batches are ordered by their explicit input indices and reject missing,
duplicate, out-of-range, inconsistent, empty or nonfinite vectors without fallback/replay. Inputs are
snapshotted before any request and bounded to 2048 texts, 32768 UTF-16 characters per text and 1 Mi
characters total; decoded vectors are bounded to 16384 dimensions. These are application admission
and result-validation limits, not a claim to constrain SDK decoding allocations or process RSS.
Provider fallback diagnostics retain HTTP status without logging provider response bodies.

Evidence is recorded in `logs/production-readiness-client-integrity-20261031/verification-summary.json`:
146 tests passed across four individually invoked suites, with one live-provider case disabled.
The 68-case installed-SDK suite uses offline HTTP fixtures and actual in-memory MCP transports,
covering limit-1/limit/limit+1 inputs, reordered/invalid vectors, caller mutation during fallback,
sampling timeout/cancellation messages, late replies, and no replay. Public generation and preservation
of native fallback findings pass. Targeted lint, formatting and diff checks pass; no paid calls or build ran.

The real SDK fixture also reproduces an upstream limitation in installed MCP SDK 1.32.1:
`Protocol._oncancel` uses a falsy check and ignores numeric request ID 0. Our sampling request still
times out, sends a correctly identified cancellation notification, rejects late output and does not
fall back; the peer cannot be assumed to stop that first request. Nonzero-ID cancellation reaches the
peer's abort signal. This remains a dependency/client cancellation gate; it is distinct from the
verified hard termination of the local Narrative Lens child process. No node_modules patch or private
SDK-state mutation was introduced. Unrouted legacy database analytics ownership is being reviewed next.

### Legacy database analytics ownership (2026-10-31)

The remaining database writing/story analytics classes had no consumers beyond their own unused
`DatabaseService` wrappers. History traced those wrappers to `6016d8c`; current registry, source,
tests and documentation searches found no public route using them. Their constructors only retained
borrowed database references. Both classes and their wrappers were removed, eliminating fabricated
voice consistency (85), revision-derived quality, default daily output and unverified timeline/scene
heuristics. Actual session/goal storage, graph operations, canonical narrative/continuity analysis,
and project/series evidence services remain in their existing implementations.

Evidence is recorded in `logs/production-readiness-analytics-ownership-20261031/verification-summary.json`:
67 tests passed across five individually invoked suites, with no skips. Real SQLite transaction and
lifecycle behavior, database synchronization, writing goals, canon evidence and stdio dispatch pass.
No references to the removed classes remain. Targeted lint, formatting and diff checks pass; no paid
calls or global build ran. This removal does not certify unrelated graph accuracy or external stores.

### Multi-perspective critique and provider JSON integrity (2026-10-31)

`multi_agent_analysis` now describes its single-provider behavior and uses the five advertised
perspectives consistently. Collaborative, workshop and review modes send distinct instructions.
Results preserve valid feedback, including multiple findings for one role, and identify missing
roles, incomplete collections and unavailable synthesis/consensus explicitly. No fabricated quality
scores or prose fill missing fields. Malformed/provider-failed responses return MCP tool errors
without exposing provider error bodies or automatically retrying.

The handler reads saved RTF through ProjectSource, checks its revision after provider completion,
and returns the common provider envelope. Coverage identifies the complete decoded-text hash and
exact UTF-16 range supplied, with a 12000-character context limit and 5000000-character source
admission limit. Unicode pairs are preserved at the boundary. Full nested input/output schemas,
runtime argument checks, explicit tool hints and lossless `read_result` spooling cover the handler
contract. Shared model JSON parsing no longer removes literal code fences from feedback strings;
outer fenced JSON still parses normally. Semantic-search descriptions now match returned passages.

Evidence is recorded in `logs/production-readiness-collaboration-20261031/verification-summary.json`:
129 tests passed across seven individually invoked suites; two paid live tests remained skipped.
The direct-handler fixture uses real saved RTF, SQLite and ProjectSource with mocked provider calls, including
source races, mode/role identity, context and admission boundaries, mixed valid/invalid findings,
Unicode spooling and installed-SDK schema validation. Writing-style, compilation, passage-search
and real stdio regressions pass. Targeted lint, formatting and diff checks pass; no global build or
paid calls ran. These checks establish transport and provenance, not editorial accuracy.

Registry inspection subsequently confirmed that `multi_agent_analysis`, `store_chapter_order` and
`sync_to_neo4j` are intentionally hidden by `dd77ef9`. The critique checks exercise its internal
handler, not public MCP dispatch; its visibility remains unchanged. An initially added README tool
listing was removed. The associated manifest records that earlier documentation snapshot; source and
test evidence is unaffected. The four relationship read/write/discovery tools are public.

### Project-owned relationship graph (2026-10-31)

The four public relationship tools previously requested a database engine whose `setHMS` initializer
had no call sites. They now use the existing project editorial store through `getEditorialServices`,
with borrowed resource ownership and deterministic SHA-256 identities for typed endpoints and labels.
Writes commit synchronously and atomically, retain existing metadata on idempotent calls, and fail
without an acknowledged or retained edge when storage fails. The 10000-edge limit rejects overflow
without eviction. Read admission checks row counts and UTF-8 bytes within a transaction before JSON
materialization, with a 32 MiB graph budget. Exact incoming/outgoing queries page at the same graph
revision and reject stale continuation; large pages/networks use lossless result spooling. Names such
as `__proto__` remain valid data, and delimiter-like names no longer collide.

Discovery now uses saved Draft text and the existing whole-word reference matcher instead of treating
HMS memory IDs as entity names. It excludes recorded pairs, computes actual document co-occurrence
ratios, preserves supporting document IDs and discloses its entity/source/work scope. Both saved RTF
and graph revisions are checked after analysis. The common envelope has an explicit application-local
mode, without claiming native-engine or provider execution. Unicode word boundaries cover accented
and non-Latin names. Shared legacy HMS data remains intact without unverified project attribution.
Internal sequence and Neo4j-copy handlers stay hidden; no live graph service was contacted.

`logs/production-readiness-relationships-20261031/verification-summary.json` records 125 passing tests
across nine individually invoked suites, with no skips. Real SQLite fixtures exercise rollback,
reopening, project separation, a second owner at capacity, query continuation, Unicode transport and
source/graph races. Real stdio dispatch confirms public writes, incoming queries and persistence after
closing/reopening the project; hidden handlers remain undispatchable. Existing source, database,
envelope and store checks pass. Targeted lint, formatting and diff checks pass; no global build or paid
calls ran. One earlier stdio attempt timed out during initialization at the unchanged 30-second
deadline; its log is retained. The isolated rerun passed with expanded stderr diagnostics, but the
initial timeout's cause is unestablished and remains a reliability observation.

### Saved-text reference integrity (2026-10-31)

The public reference handlers now read saved RTF through ProjectSource instead of interpreting
document metadata as empty text. A document query reads only its selected active document; entity,
orphan and connection queries include all active text, including Research and Draft items excluded
from Compile. Both source/binder identity and the SQLite registry are rechecked before returning a
common application-local analysis envelope. Missing registries are explicitly unavailable or partial;
broken connections and unexpected acquisition failures propagate. Registry snapshots use synchronous
transactions, with count and byte admission before materialization. Exact IDs take precedence over
names, ambiguous name queries require an ID, and association counts distinguish registry identities
even when their display names coincide.

Matching retains every UTF-16 offset within the declared limits, replacing the previous silent
100-position cap. Shared admission bounds cover 256 entities, 1000 documents, 2 Mi UTF-16 source
characters, source characters multiplied by entities at most 134217728, 1000000 match positions,
and 16 MiB of serialized mention records. Overflow fails explicitly without a partial successful
index. Relationship discovery uses the same source/work limits and a presence-only matcher, avoiding
position allocation when it only needs document co-occurrence. These literal matches do not establish
that a same-name character and place can be semantically disambiguated.

General list spooling now uses the existing bounded payload formatter rather than copying potentially
large initial entries into its preview. The shared retention contract includes one hour, process
restart, and capacity eviction at 64 MiB or 256 results. `read_result.limit` bounds UTF-8 chunk text;
JSON/MCP framing adds bytes. The stricter complete-response byte cap for native report pages remains
a separate verified contract.

`logs/production-readiness-references-20261031/verification-summary.json` records 198 passing tests
across nine individually invoked suites, with no skips. Real saved RTF and SQLite fixtures cover source
and registry races, missing/failed registries, ID/name ambiguity, registry/name boundary admission,
Unicode reconstruction, complete offsets, and explicit evidence overflow. Source, relationship,
compilation, story-evidence and stdio regressions pass. No global build or paid calls ran. This local
evidence does not close the previously recorded dependency, resource, platform or editorial-accuracy
gates.

### Complete saved-document enhancement (2026-10-31)

`enhance_content` previously read metadata as document text, clipped provider input to 12000
characters without declaring partial coverage, and replaced its returned rewrite with a boolean.
The public handler now reads complete saved RTF through ProjectSource, rejects longer input before
provider use, retains the exact proposed text, and checks the saved revision afterward. Unchanged
text remains a structured result. Provider failure, malformed output and incomplete completions
are explicitly unavailable with MCP error status; provider error bodies are not exposed and no
local rewrite is substituted. Source and preference-storage errors propagate independently.

The six public enhancement goals and nested editing options are validated and sent to the provider.
Options are snapshotted before asynchronous reads; preferences and options contribute to the common
request identity. Background context is fenced as data. Exact decoded-text coverage and saved-byte
revisions are distinct. Outputs beyond 64000 UTF-16 characters fail explicitly, while admitted large
Unicode rewrites spool losslessly. Native word counts and Flesch reading-ease differences replace
invented readability deltas; a failed measurement leaves successful sibling measurements and the
complete rewrite intact. Uncomputed edit lists, applied-change counts and quality scores are null.

The obsolete local rewrite engine had no remaining consumers after correcting the provider-only
route. History traced its introduction to `6016d8c`; source, tests, scripts and documentation checks
found only startup/test-context construction and the conformance script. Those references, its six
helper classes, unused template/filter-word catalogs and their private type module were removed.
The prior uncommitted readability adaptation is retained in the checkpoint's removal evidence rather
than silently discarded. The native analyzers and revision-bound editorial proposal service remain
separate active capabilities.

`logs/production-readiness-enhancement-20261031/verification-summary.json` records 121 passing tests
across eleven individually invoked suites; one paid live test stayed skipped. Real RTF/SQLite fixtures
cover source/output/context/word-target boundaries, all six goals, option identity, failure isolation,
native metric absence and source races. Real stdio dispatch verifies the provider-unavailable envelope
in local-only mode. Project lifecycle, binder guards, integrity, registry, general fallback and content
generation regressions pass. No global build or paid provider call ran; this establishes the tested
transport and preservation behavior, not independently judged rewrite quality.

### Text-count and empty-metric integrity (2026-10-31)

A local probe reproduced `getAccurateWordCount('U.S.A.') === -1`: the adapter deducted acronym
punctuation after Compromise had already counted the acronym as one token. Word counts now use the
tokenizer's measured count directly, retaining existing normalization and segmentation. Acronym-only
paragraphs are no longer discarded. Whitespace-only text has zero sentences and paragraphs; absent
denominators yield null averages in both the utility and public local-analysis metrics. Streaming
averages use aggregate word/unit counts and reading time rather than averaging differently sized
chunks or adding rounded per-chunk minutes. Combined clamped native readability scores remain null
until final whole-source analysis measures them.

`logs/production-readiness-text-metrics-20261031/verification-summary.json` records 136 passing tests
across eight individually invoked suites, with one paid live test skipped. Before/after local probes,
saved RTF snapshot counts/deltas, 249/250/251-acronym query-letter limits, blank-source analysis,
streaming metrics, compilation statistics and public fallback/generation checks pass. The compiler
rejects an over-limit acronym rewrite and preserves the source. This corrects the adapter's counting
and availability contracts; it does not claim parity between Compromise tokenization and Narrative
Lens segmentation or independent linguistic accuracy. No global build or paid calls ran.

### Provider fallback input stability (2026-10-31)

AIClient snapshots chat options and the configured model for each provider before its first await.
Caller mutation or a later environment-model change cannot alter the admitted instructions, token
budget or model during fallback. Prompt whitespace is preserved. Invalid prompt types and non-object
options fail before provider dispatch. Existing explicit-unavailability fallback, completion checks,
deadlines and disabled SDK replay remain intact.

`logs/production-readiness-chat-input-20261031/verification-summary.json` records 132 passing tests
across two individually invoked suites; one paid live test stayed skipped. The asynchronous mutation
fixture and installed SDK transport/completion/cancellation regressions pass with mocked/local
transports. No global build or paid calls ran. The previously recorded SDK request-ID-zero remote
cancellation limitation remains open.

### Generated-content context integrity (2026-10-31)

`generate_content` now supplies actual saved RTF excerpts and selected character profiles instead of
only their identifiers. Its explicit nested schemas and common envelope expose excerpt coverage,
profile hashes, source revisions and request identity. Inputs and profile snapshots are bounded;
options are copied before awaits. Project selection, saved text and profile revisions are checked
before returning prose. Context-free generation performs no manuscript reads and uses a null project
identity. Provider errors remain errors; unavailable word counting leaves the generated text intact
with a null metric. Large admitted Unicode outputs spool and reconstruct without loss.

Prompt and style validation count Unicode characters consistently with JSON Schema. Saved excerpts
and complete output limits use explicitly declared UTF-16 units, and excerpts never split surrogate
pairs. Profile JSON is capped at 16 KiB and 32 records. The reused HMS metadata validator now checks
aggregate string/key bytes before serialization, preventing oversized profile fields from requiring
an oversized JSON allocation; its final exact 64 KiB metadata budget is unchanged.

`logs/production-readiness-generation-20261031/verification-summary.json` records 198 passing tests
across nine individually invoked suites, with no skips. Saved RTF/profile fixtures cover input,
output, profile-count and serialized-context boundaries, source/selection races, option mutation,
privacy and explicit metric absence. Shared envelope, native author modes, public registrations,
enhancement and real stdio dispatch regressions pass. No global build or paid calls ran; these are
contract checks, not an independent assessment of generated prose quality.

### Complete general-analysis scope and independent fallback (2026-10-31)

`analyze_document` now validates, snapshots and canonically orders `analysisTypes`, and actually sends
that focus to the provider. Omitted focus and `all` produce the same request identity. Readability
and pacing remain baseline assessments; requested topics steer provider issues. Local fallback
explicitly declares its broad raw scope and preserves every available finding. The README's stale
`aspects` parameter name is corrected to `analysisTypes`.

The provider adapter accepts complete nonblank sources up to 12000 UTF-16 characters; it never
silently clips them. Empty or longer sources use local analysis with explicit provider reasons.
Missing assessments, malformed issues and oversized replies are rejected rather than filled with
`unknown` or silently filtered. The shared JSON parser preserves literal code fences inside quoted
strings. Response and nested assessment/issue/count limits are enforced before results are returned.
Grammar runs independently if the entire local analyzer fails; grammar failure likewise preserves
local prose findings. Availability identifies each failed operation without exposing provider errors.
Saved revisions, source coverage and project selection are checked, and large results spool without
dropping native evidence. Small results keep the existing readable summary.

`logs/production-readiness-document-analysis-20261031/verification-summary.json` records 107 passing
tests across eight individually invoked suites, with one paid live test skipped. Real RTF fixtures
cover source/response/nested-field boundaries, simultaneous and independent failures, source and
selection races, option mutation, semantic request identity and Unicode retrieval. The real stdio
client exercises public `analyze_document` and reconstructs its result through `read_result`; native
availability and registration checks also pass. No global build or paid calls ran. Provider focus
describes instructions sent, not an independently judged guarantee of critique quality.

### Durable project memory and canonical import (2026-10-31)

The public `remember`/`recall` pair now uses explicit nested input schemas, deterministic creation
IDs, validated existing update IDs and canonical snapshot revisions. Accepted writes stage immutable
inputs and serialize up to 32 pending operations. Success follows the primary JSON commit; failed
writes do not publish uncommitted facts. Unicode recall payloads spool and reconstruct completely.
Missing profile, style and progress facts remain absent. Requests are bounded at 64 KiB/depth 32;
whole memory is bounded at 16 MiB, with shared bounded JSON cloning and no fabricated circular tags.

Primary files use bounded descriptor reads, reject symlinks and malformed UTF-8, and preserve literal
JSON tags, repeated references and prototype-shaped custom keys. Invalid initialization never saves
empty defaults during cleanup. A missing primary with surviving backups requires verified restoration.
Daily backup retention touches only date-named JSON backups. Optional legacy SQLite imports use actual
schema columns and bounded reads; malformed JSON fails explicitly. Mirrors use one transaction,
preserve dependent rows, and retain a complete snapshot for recovery when no primary or backup exists.
Primary JSON is authoritative; secondary mirror failure is logged without discarding committed memory.

Short synchronous SQLite ownership transactions exclude competing live owners. Dead local owners are
recoverable; ambiguous ownership remains protected. External revision changes reject both updates and
idempotent retries, while unchanged shutdown permits reopening the edited file. This protects
cooperating servers and detects observed external changes; it is not an atomic filesystem
compare-and-swap against uncooperative edits between verification and rename.

Series import stages and validates one memory snapshot, rechecks its revision, and commits candidates
atomically. Canonical world records and both former custom location shapes remain usable. Equivalent
locations deduplicate; conflicting legacy identities fail. The existing 200/2000 UTF-16 subject/value
limits and 1000-entry legacy-location budget are explicit; oversized descriptions are not truncated.

`logs/production-readiness-memory-20261031/verification-summary.json` records 227 passing tests
across 13 individually invoked suites, with 0 skips. Real SQLite, process-death recovery, primary
and mirror failures, shutdown retry, Unicode retrieval, generation, canon import and public stdio
contracts pass. Targeted lint, formatting and whitespace checks pass. Existing
native RSS containment, representative full-novel/cross-platform evidence, independent editorial
accuracy and SDK request-ID-zero cancellation limitations remain separate release gates. No global
build, global test runner or paid development calls have run.

### Full-novel workloads and comparison responsiveness (2026-10-31; resource gate open)

Three publisher-identified US public-domain texts are pinned by URL and SHA-256 in
`tests/fixtures/narrative-novels.json`: Gutenberg 84 (Frankenstein), 1342 (Pride and Prejudice) and
2701 (Moby Dick). Downloads are retained under `logs/production-readiness-novels-20261031/corpus/`.
The opt-in individual suite `tests/integration/narrative-novels.test.ts` uses complete text between
Gutenberg markers, including front matter, normalized to LF and split into paragraph-preferred
16000-UTF-16 chunks. It verifies RTF round trips, source revisions, native warm-result identity and
lossless reconstruction through 32768-byte MCP pages. The collector is shared with the existing
saved-source and real stdio suites in `tests/helpers/narrative-report.ts`. The final source, transport,
registry, native worker and actual stdio regressions all pass.

`novels-before.json` and `novels-before.log` record five cold/warm/edited samples per novel: 45 measured
operations, with two passing novel cases and one failing performance case. Frankenstein returns 1346
findings; Pride and Prejudice returns 1914; Moby Dick detects 7359 and explicitly reports 2359 omitted
by the declared 5000-finding native budget. Pagination preserves all returned native findings and
metadata. Prose coverage is unavailable without a configured lexicon, and model-dependent NLI is
unavailable; these runs do not certify either. The corpus is varied workload evidence, not editorial
accuracy, modern-manuscript representativeness or cross-platform certification.

The predeclared diagnostic targets remain 5000 ms complete-operation latency, 100 ms event-loop lag
and 128 MiB sampled RSS growth. Moby Dick comparisons exceed the lag target, and some samples exceed
the RSS-growth target. `moby-profile.json` isolates about 167–174 ms of synchronous native comparison,
67–69 ms of baseline validation and 36–40 ms for initial report transport.

Comparisons now use the existing bounded child process, including cancellation, hard deadlines and
confirmed process exit. Source revisions and cancellation are rechecked after comparison, before any
baseline or review-state commit. Complete-result size is checked before saving a baseline. Comparison
results include `comparisonBaseline.name` and its original `envelope`; replacing that saved name later
does not erase the old source-revision identity. The current result envelope identifies the new side.
Focused tests cover interrupted comparisons, changed sources, queue recovery and 16 MiB −1/0/+1.

Pagination counts JSON escape costs without repeatedly serializing candidate fragments. The
`moby-transport.json` probe reduces approximately 955 continuation pages from about 860 ms to 80 ms.
Reports now retain UTF-8 buffers with sparse UTF-16 checkpoints, and decode only a bounded page.
Cursor semantics, immutable report IDs, full native fields and byte caps are unchanged. Boundary tests
include all JSON escape classes, lone surrogates, multibyte characters, 4 MiB pages and checkpoint
adjacency. The reusable page-cost workspace is bounded at 8 MiB plus four bytes and released on clear; the 32 MiB
report-data budget excludes this workspace, sparse offsets and object overhead.

The default Jest/typechecking process starts near 1.2 GiB RSS. The dedicated
`jest.narrative-performance.config.js` uses transpilation per module so the TypeScript program is
excluded from runtime measurements; correctness suites retain the normal configuration. RSS still
includes the shared Jest/server/client process and reconstruction. Comparison child high-water RSS
is recorded separately. Intermediate artifacts mislabeled the sum of sampled parent and child peaks
as `processTreePeakUpperBoundBytes`; sampling can miss parent peaks, so that is not a verified upper
bound. Final records use `sumObservedProcessPeaksBytes` and also record the parent lifetime high-water
RSS. Neither the sampled sum nor the lifetime measurement identifies the simultaneous per-operation peak.
The child V8 heap setting does not contain native RSS. No memory target was raised or check disabled.

`novels-after.json` records 45 operations after comparison isolation and allocation-aware pagination,
before compact report caching: all latency and lag targets pass, and all semantic/page assertions
pass; one Moby Dick warm sample reaches 135528448 bytes RSS growth, exceeding 128 MiB. Its individual
suite therefore fails (two book cases pass). Five samples per phase support descriptive nearest-rank
p50/p95 only, not tail guarantees; corpus order and allocator reuse affect RSS growth.

The isolated `moby-compact-cache.json` probe passes semantic/page checks but still fails resource
targets: warm RSS growth is 173309952 bytes, and warm/edited lag reaches 108–112 ms. This change is
not certified as solving the resource gate. These intermediate results are superseded by the corrected
instrumentation and final measurements below.
Native 0.2.0 comparison validates both reports itself (`v0.2.0`, commit
`14b272f0e7f83ead97f37d8eeae9af7754c0abda`, `src/manuscript/comparison.rs`). The redundant parent-side
parse/validation was removed for comparisons; public baseline reads still validate normally.
Malformed shape, summary counts and project identity all reject before a comparison baseline is
saved. A timer yield now separates complete-result validation from initial page serialization.
No global build, parallel runner, model download or paid call was used.

The initial benchmark used Jest spies that retained returned reports and, during profiling, all page
responses. The final harness uses ordinary method wrappers that retain only the current expected
report and aggregate timing counters. `novels-final.json` happened to pass before this correction;
it is not the accepted final resource evidence. The corrected `novels-runtime-final.json` records 45
operations and passes every source, semantic, pagination, latency and event-loop assertion, but its
suite fails one memory diagnostic: a Moby Dick warm sample grows by 135708672 bytes (129.42 MiB).
The independent fresh-process `moby-instrumentation.json` probe reaches 172720128 bytes (164.72 MiB)
in its warm phase. Neither failure is hidden by averaging or a relaxed target.

The table shows nearest-rank p50/p95 from five samples per phase on Node 24.22.2/macOS arm64. Parent
RSS includes Jest, server and client reconstruction; it does not isolate production-server memory.
Comparison-child high-water RSS reaches 332201984 bytes across the corrected runs. Full native RSS
containment and isolated server measurements remain open, as do cross-platform and independently
judged editorial quality. No high-quality numerical score or production certification is inferred.

| Gutenberg ID / phase | Latency p50 / p95 (ms) | Lag p95 (ms) | Parent RSS growth p95 (MiB) |
| --- | --- | --- | --- |
| 84 / cold | 171.1 / 176.4 | 15.9 | 15.56 |
| 84 / warm | 210.3 / 213.3 | 13.9 | 48.89 |
| 84 / one-scene edit | 210.1 / 233.1 | 14.4 | 28.52 |
| 1342 / cold | 284.8 / 293.3 | 22.4 | 25.42 |
| 1342 / warm | 281.0 / 287.8 | 19.8 | 37.66 |
| 1342 / one-scene edit | 284.7 / 292.4 | 19.9 | 45.75 |
| 2701 / cold | 591.6 / 595.1 | 62.9 | 36.38 |
| 2701 / warm | 670.6 / 675.6 | 57.3 | 129.42 |
| 2701 / one-scene edit | 683.0 / 687.8 | 57.6 | 75.94 |

`logs/production-readiness-novels-20261031/verification-summary.json` records 100 passing regression
tests across six individually invoked suites, separate from the failed resource diagnostics. The
benchmark also compiles under the ordinary typechecking Jest configuration with its three opt-in
workloads skipped. Scoped lint, formatting and whitespace checks pass. Raw measurements, corpus
hashes, aggregate methods and source hashes are retained beside the summary.

To reproduce the measured workload with a supported Node version and the pinned corpus directory:

```sh
SCRIVENER_RUN_LIVE_AI_TESTS=0 SCRIVENER_DISABLE_KEY_DISCOVERY=1 \
UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 OMP_NUM_THREADS=1 \
SCRIVENER_NOVEL_CORPUS="$PWD/logs/production-readiness-novels-20261031/corpus" \
SCRIVENER_NOVEL_SAMPLES=5 SCRIVENER_NOVEL_REPORT="$PWD/logs/novel-recheck.json" \
node node_modules/jest/bin/jest.js --config jest.narrative-performance.config.js \
  --runInBand --runTestsByPath tests/integration/narrative-novels.test.ts
```

### Worker owner-death boundary (2026-10-31)

An additional process-death regression reproduced a structural gap: killing the owner while the
native child is blocked removes the owner's deadline timer, leaving the child alive past its
configured limit. `logs/production-readiness-worker-owner-20261031/owner-before.log` records the
expected failing test, followed by explicit cleanup of the orphan. The test transpiles only the
individual worker source into its temporary fixture, never rebuilding the project.

The child now starts a separate watchdog isolate and waits for its timer to be armed before entering
native work. It then unreferences the watchdog so ordinary completion can exit promptly. The idle
watchdog can kill its own process even while the main child thread is blocked or the owner has died.
Parent cancellation and deadline enforcement remain in place. An initial implementation unreferenced
the watchdog before startup completed, causing premature child exit; that ordering was corrected.
Focused lifecycle and native integration checks pass. The added isolate changes resource usage;
the preceding novel measurements predate it and remain historical evidence. This is
not a native RSS or combined-isolate heap containment mechanism.

The nine worker lifecycle tests now pass, including owner SIGKILL, ordinary completion, output limits,
hard cancellation and listener cleanup. All 43 native service tests also pass. That service run was
slow before test execution; a one-second local stack sample is retained as
`stalled-jest.sample.txt`, without assigning an unproven application cause. A second individual Jest
process briefly overlapped it and was interrupted (exit 130); its incomplete stdio run is excluded
from evidence. Its subsequent run after the first process exited passes the real stdio comparison
workflow. No parallel suite runner was used.

`logs/production-readiness-worker-owner-20261031/verification-summary.json` records 53 passing tests
across three individual suites, plus scoped lint, formatting and whitespace checks. The additional
one-sample Moby Dick probe (`moby-watchdog.json`) passes all three phases: 581–708 ms latency,
55–58 ms lag and 87–102 MiB parent RSS growth. This limited passing sample does not erase earlier
RSS failures or establish containment. The next resource investigation should measure the real
server in a separate process so client reconstruction and Jest allocations cannot be mistaken for
server memory; changing thresholds or repeating the same shared-process probe is not sufficient.

### Separate server workload measurement (2026-10-31)

`tests/integration/narrative-novels-stdio.test.ts` now launches the actual source server through tsx,
uses public MCP tools over stdio, and samples server RSS/lag through a private Node IPC channel.
The SDK's public stream-based framing transport is reused; no private SDK fields or production
diagnostic endpoint are introduced. `tests/helpers/server-resource-probe.mjs` imports the real
entry point and adds only the sampler. The server's memory measurements exclude the Jest client and
the native comparison subprocess; those exclusions are explicit in the resulting report.

Pinned corpus, RTF round-trip validation and binder construction moved into the shared
`tests/helpers/narrative-novel-project.ts` fixture helper. Both local and stdio workload suites use
it. Server workloads use the normal single-file typechecking Jest configuration. The extracted
local path also passes its three Frankenstein phases, and the local workload file compiles under
the normal configuration with its three opt-in cases skipped. Process cleanup was checked after
the server runs.

The initial separate-server probe completes all source, semantic and page assertions, cleans up its
server process, and fails only the warm RSS-growth diagnostic: 175882240 bytes (167.73 MiB) in
`logs/production-readiness-novel-server-20261031/moby-server.json`. This reproduces the resource gap
outside Jest/client allocations. The child-process adapter is now being checked with binary output
collection (one final UTF-8 decode) and explicit release of the admitted input string after writing;
the intended reduction in retained serialization copies does not change the native result contract.
All nine worker lifecycle tests pass with binary collection. The first Moby Dick probe passes, but
the subsequent 45-operation separate-server run still fails one warm RSS-growth sample at
143753216 bytes. Both results are retained; the first passing sample is not sufficient evidence.

Optional test-only stage measurements (`moby-server-stages.json`) locate about 36 MiB of additional
RSS growth in the first-page construction after complete-result validation. That path serialized the
same large result twice. The service now exposes the already validated JSON to the public handler;
ordinary in-process callers retain the original object-returning API. Transport caches that JSON
without another full serialization. Source checks and the 16 MiB preflight still precede baseline
persistence, and result/page limits are unchanged. The 43 native service tests and 22 transport tests
pass, including lossless reconstruction through both object and serialized entry points.

The final separate-server workload (`novels-server-final.json`) passes all 45 operations, five
samples of cold, warm and one-scene-edit analysis for each of the three novels. Every native result
is reconstructed through bounded public MCP pages, with baseline/source assertions preserved.
The local harness now compares the SHA-256 of the service's serialized native result with the
reconstructed result, retaining only the expected digest. No report objects or page responses are
retained by profiling spies. The optional server stage instrumentation stores only numeric samples.

The following nearest-rank p50/p95 values describe this Node 24.22.2/macOS arm64 run. Limits remain
5000 ms latency, 100 ms event-loop lag and 128 MiB sampled server RSS growth for each operation.
The maximum growth, 127.45 MiB, leaves little margin; passing these workloads is not a guarantee for
every manuscript or runtime. Server lifetime high-water RSS reaches 680460288 bytes. Comparison-child
RSS is excluded from this server sampler, so native RSS containment remains open. Earlier failed
probes remain in the evidence directory, without changed thresholds or forced garbage collection.

| Gutenberg ID / phase | Latency p50 / p95 (ms) | Lag p95 (ms) | Server RSS growth p95 (MiB) |
| --- | --- | --- | --- |
| 84 / cold | 173.4 / 186.8 | 12.5 | 13.34 |
| 84 / warm | 244.3 / 291.7 | 12.5 | 30.27 |
| 84 / one-scene edit | 252.3 / 259.3 | 10.0 | 24.59 |
| 1342 / cold | 277.8 / 288.0 | 16.3 | 18.67 |
| 1342 / warm | 332.4 / 341.1 | 19.6 | 50.13 |
| 1342 / one-scene edit | 335.1 / 340.8 | 15.9 | 29.64 |
| 2701 / cold | 606.0 / 616.8 | 43.2 | 53.44 |
| 2701 / warm | 770.8 / 801.6 | 46.4 | 127.45 |
| 2701 / one-scene edit | 792.4 / 818.8 | 46.6 | 42.63 |

The evidence manifest is `logs/production-readiness-novel-server-20261031/verification-summary.json`.
This remains local workload evidence, without cross-platform or independent editorial certification.

### Narrative request admission and deadline diagnostics (2026-10-31)

Three focused race regressions reproduced additional P1-1 drift: caller mutation could change queued
controls, persist controls changed after native validation, or make an annotation request digest
describe different input from the worker's arguments. Controls and annotation input now receive
private snapshots before asynchronous work, within the existing 1 MiB control and 64 MiB worker-input
budgets. The native engine continues to own semantic validation; structured cloning preserves values
for that validation. Annotation cancellation retains the admitted signal and is rechecked after the
final source read.

All 49 native service tests pass, including the new mutation/cancellation regressions. A small-budget
unit fixture covers UTF-8 admission at limit−1/limit/limit+1 without allocating three 64 MiB inputs;
the production limit is unchanged, and the worker still checks the complete request with manuscript
overhead. `logs/production-readiness-narrative-admission-20261031/reproduced.log` preserves the three
original functional failures; `before.log` is an initial test typing failure, not behavioral evidence.

A separate 1 ms deadline regression reproduced an input-write error masking a successful timeout
kill. The input error handler now preserves an existing parent kill instead of replacing its reason
with an input failure. The complete 11-test worker lifecycle suite passes, including both 1/2 ms
deadline regressions, owner death, hard cancellation and output boundaries. The real stdio workflow
also passes. The checkpoint in
`logs/production-readiness-narrative-admission-20261031/verification-summary.json` records 61 passing
tests across three sequential individual suites, scoped lint, formatting and whitespace checks.
No global build, parallel suite runner or paid call was used. The preceding workload measurements
remain historical evidence at their recorded hashes; admission copying and error precedence do not
establish native RSS containment.

### Persisted narrative-control integrity (2026-10-31)

Four corruption fixtures showed that saved null, array, string and unknown-field control records
silently produced native default analysis. The control reader now distinguishes an absent record
from invalid stored state. The existing structural and 1 MiB validation is shared by reads and
writes, with plain JSON objects required at the adapter's control/scene boundaries. Native semantic
validation remains upstream. Caller snapshots and validation-before-persistence are preserved.

`logs/production-readiness-narrative-controls-20261031/before.log` records the four reproduced
failures; the final native service suite passes all 53 tests. Scoped lint, formatting and whitespace
checks pass. The corresponding verification manifest records current source hashes; previous
workload measurements remain historical, with their stated resource and platform limitations.

### Full worker input boundary (2026-10-31)

The worker's actual 64 MiB JSON input limit now has regressions at limit−1/limit/limit+1 for both
ASCII and sparse astral Unicode. Inputs at and below the limit return the expected child result;
the oversized request rejects before dispatch. These are real child-process serialization checks,
not reduced-limit fixtures or evidence of native-addon RSS containment. The child releases its
consumed read-buffer array before invoking the native operation.

All 13 worker tests pass, as do two focused native service cases covering exact Unicode baseline
comparison and author-evidence validation. The 51 unrelated cases in that service file were filtered
out for this check; its preceding complete run passed 53 tests. Scoped lint, formatting and whitespace
checks pass. `logs/production-readiness-worker-input-20261031/verification-summary.json` records the
15-test checkpoint and current hashes. No throughput or RSS improvement is inferred from releasing
the buffers, and the existing performance limits are unchanged.

### Persistent native context isolation (2026-10-31)

`NarrativeContext` now owns a persistent child for manuscript analysis, configured document analysis,
control validation, finding decisions and rechecks. Successful calls retain the real native cache;
terminating the child invalidates it. Parent cancellation/deadline handling waits for process exit,
and a child watchdog bounds blocked native execution after owner death. Cache statistics come from
the child and reject invalid values. The 64 MiB input, 16 MiB output and 16 MiB cache budgets remain
unchanged. Service close intentionally drains admitted operations before disposing the context;
this is not a complete-workflow or source-I/O deadline. Raw helper APIs still run in the server.

The 21 context tests pass, including owner death, blocked execution, cancellation/close, recovery,
listener cleanup, invalid statistics, actual input/output byte boundaries and a 1 ms deadline.
ASCII and sparse astral input are tested at 64 MiB−1/limit/+1; oversized input never enters native
execution and leaves an existing healthy context reusable. All 59 native service tests pass.
An additional cancellation defect was found during inspection: the service yielded after baseline
persistence. It now yields before its final source/cancellation checks, with no asynchronous gap
between those checks and the synchronous commit. The regression schedules cancellation on native
completion and verifies that no baseline is saved and subsequent analysis recovers.

The actual stdio workload passes all 45 operations: five cold/warm/one-scene-edit samples for each
of the three pinned novels, with lossless MCP reconstruction and revision/cache assertions.
Limits remain 5000 ms latency, 100 ms event-loop lag and 128 MiB sampled server RSS growth.
Observed maxima are 845.58 ms, 84.84 ms and 96.84 MiB respectively. Native context and comparison
child lifetime high-water RSS reach 195231744 and 344719360 bytes. The largest sum of observed
server/child peaks is 1168195584 bytes; it is not a simultaneous peak or a containment bound.
Moving work out of the server does not establish a reduction in total memory. Moby Dick retains
its declared native budget of 5000 returned findings and 2359 explicitly omitted native findings;
pagination loses or duplicates none of the returned report.

The test-only bootstrap injects an instrumentation preload into native child launches through
Node's public process APIs and [builtin ESM export synchronization](https://nodejs.org/api/module.html#modulesyncbuiltinesmexports).
It records both post-native and post-serialization high-water values and avoids loading the addon
into watchdog isolates. Initial instrumentation failures and startup timeouts are retained in the
logs; they are excluded from passing workload evidence. The one-sample local Frankenstein harness
also passes under the normal typechecking Jest configuration. Its shared-process RSS deliberately
excludes the persistent context child, as stated in its report.

### Offline annotation schema reproducibility (2026-10-31)

The generator now uses 13 unmodified upstream contracts in `assets/narrative-lens`, with the
original license, pinned source/subset hashes and version provenance. The published package includes
that bundle. `--check` verifies deterministic formatted output without writing, works outside the
repository working directory and rejects source, version and generated-output drift. Six regression
tests pass; the generated handler schema itself is unchanged. CI runs this check after the registry
gate. No second native semantic validator or network download is introduced.

The checkpoint manifest is
`logs/production-readiness-context-isolation-20261031/verification-summary.json`: 91 passing tests
across six individually invoked suites, including the three stdio workload cases and one selected
local workload case. Two other local novels were filtered out; the separate stdio workload covers
all three. `novels-server-aggregate.json` records nearest-rank p50/p95 values and resource maxima;
raw measurements and source hashes are retained beside it. Scoped lint, formatting and whitespace
checks pass. No global rebuild/typecheck, parallel test runner, paid call, model download, commit
or publication was used. Native RSS containment, exact-candidate cross-platform execution,
independent editorial assessment and the existing external conformance/custody gates remain open.

### Container build input boundary (2026-10-31)

Source inspection found that the Docker dependency layer omitted `vendor/deepmerge`, despite the
locked local link, and a later unrestricted `COPY . .` could overwrite Linux packages with host
`node_modules` and include local credentials. The Dockerfile now copies the local dependency before
installation, selects explicit build inputs, prunes development packages and copies only prepared
runtime directories into a separate stage. `.dockerignore` admits the required inputs and excludes
host dependencies, credentials, repository metadata and native build output. Installation scripts
remain disabled; the installed native packages ship binaries. The image build now checks native
module loading and SQLite after pruning. Its non-root runtime identity is preserved.

The pinned Narrative Lens 0.2.0 package supplies Linux x64 GNU, not Linux ARM64. Docker instructions
now specify `linux/amd64`, and unsupported image architectures fail before installation. The build
base digest is unchanged. No Docker runtime is available on this host; no image, application
dependency rebuild or project-wide compilation was run.

`tests/unit/scripts/container-context.test.ts` passes three focused checks: local-link availability
before installation, exclusion of host root files from explicit COPY inputs, and real C2PA
source/artifact verification from only the staged inputs. The last check validates existing hashes
and WebAssembly without compiling. These tests model only the Dockerfile's literal COPY subset.
A separate single-test probe uses the upstream
[Moby v0.6.0 ignore matcher](https://github.com/moby/patternmatcher/tree/v0.6.0): all 35 required
paths remain included and all 26 representative private/host paths are excluded. It runs with
`GOMAXPROCS=1`, `go test -p=1 -parallel=1`, and a pinned free module download; its source, module
checksums and command are retained in the evidence directory without adding a project dependency.
Neither check executes Docker. Actual Linux image build/startup and container memory containment
remain unverified. The evidence checkpoint is
`logs/production-readiness-container-20261031/verification-summary.json`.

### Execution deadlines, cancellation and startup follow-up (2026-10-31)

Three additional context regressions first reproduced deadline gaps: decoding reset the child
budget, output flushing ran after watchdog disarm, and a short timeout was unknown while decoding
was blocked. The persistent child now receives a validated five-digit timeout prefix before its
JSON body and enforces one monotonic expiry from complete-frame admission through output flush.
The JSON body retains its 64 MiB limit; framing adds five bytes plus the newline. Input resumes only
after the watchdog acknowledges disarm. All 25 context tests pass, including owner death during
blocked decoding/output, rapid sequential cache reuse and unchanged byte-boundary checks. These
are execution deadlines, not a source-I/O, admission-queue or whole-workflow SLA; native RSS remains
outside the V8 heap limit.

Actual stdio EOF and SIGTERM tests reproduced shutdown waiting on a blocked native analysis.
Shutdown now closes MCP before draining project resources, aborting active request signals and
stopping new transport input. All four real-server lifecycle tests pass: EOF, SIGTERM, cancellation
of wire request ID zero, and cancellation of an empty-string ID. They verify native process death
before cleanup escalation, continued server use after request cancellation, and natural server
exit with code zero. SIGTERM is explicitly skipped on Windows; EOF and request cancellation remain
cross-platform test cases, not claims of a Windows run.

The currently installed and locked MCP SDK is 1.32.2. Its published archive was independently
integrity-checked and still contains the falsy-ID cancellation bug documented in
[upstream issue 2283](https://github.com/modelcontextprotocol/typescript-sdk/issues/2283).
`CancellationSafeTransport` uses only the public transport interface: reversible escaping of zero,
empty-string and reserved-prefix IDs, exact response-ID restoration, and preserved routing and
message metadata. It introduces no request map, SDK patch or private-state mutation. Eleven focused
tests pass against the installed SDK, including first-request sampling cancellation, response/error
matching, alias collisions, malformed responses and close failures. This addresses the previously
recorded zero-ID gate for this server; remote clients still control whether their own work obeys an
abort signal.

Real ESM startup also exposed an obsolete CommonJS entry guard in `auto-setup.ts`. Removing that
unused bootstrap preserves the dedicated CLI callers and restores first-run initialization. The
isolated real-ESM skip-setup regression passes without provisioning or creating setup markers.
The stdio protocol regression now checks that startup does not swallow a first-run import failure.
README native platform requirements reflect the intersection of shipped native binaries:
macOS x64/ARM64, Windows x64 and Linux x64 glibc, using the Node runtime architecture.

The final follow-up checkpoint contains 170 passing tests across eight sequential, single-file
Jest invocations: context 25, transport 11, server lifecycle 4, first-run import 1, offline SDK
compatibility 68, narrative service 59, public stdio protocol 1, and the selected Moby Dick workload
1. The two other novel cases were filtered; the earlier 45-operation three-novel checkpoint remains
historical evidence at its recorded hashes. The new Moby Dick run covers cold/warm/one-edit
operations with lossless 32768-byte pages. Maxima are 867.93 ms elapsed, 87.91 ms sampled server
event-loop lag and 97665024 bytes sampled server RSS growth, within the unchanged 5000 ms/100 ms/
128 MiB budgets. Context/comparison child lifetime high-water RSS reaches 226721792/304873472 bytes;
the largest sum of observed process peaks is 1085145088 bytes, not simultaneous RSS or containment.
All three observed native processes exited. One sample per phase does not establish new p95 or
throughput claims.

Evidence, source hashes, exact invocations and excluded preliminary failures are recorded in
`logs/production-readiness-context-deadline-20261031/verification-summary.json`. Scoped source lint,
touched-code formatting and whitespace checks pass. Tests use Node 24.22.2 on macOS ARM64, one file
and `--runInBand` per process, with paid providers disabled. No global build/typecheck, parallel
test runner, paid call, model download, commit or publication was performed. Native RSS containment,
actual Linux image execution, exact-candidate cross-platform validation, independent editorial
assessment and the existing external conformance/custody requirements remain open release gates.

### Diagnostic credential redaction (2026-10-31)

The logger's exact-key filter missed opaque values under provider-specific API key names and
compound token/password/secret fields. It now shares the existing diagnostic-key predicate while
retaining its manuscript-field filtering and useful Error/cause/AggregateError context. Seven
regressions first reproduced the leaks; all 12 logger tests and three redaction tests now pass.
Scoped lint, formatting and whitespace checks pass. A pre-output Jest stall was stopped and is
excluded from validation; its cause was not established. Evidence is retained under
`logs/production-readiness-release-gates-20261031/`.

### Conditional Linux memory containment (2026-10-31)

Current context/worker adapters and the pinned Linux x64 GNU native package were exercised in an
isolated one-vCPU Ubuntu 26.04 guest, using Node 24.22.2 x64 through Rosetta on an ARM64 host/guest.
The workload cgroup included the calling process and its descendants, with `memory.max=512 MiB`,
zero swap and group OOM killing. An independent supervisor survived outside that workload leaf.
This is evidence for this Linux cgroup configuration, not a product-enforced per-child native RSS
limit, a native-amd64 platform run, or the application Docker image.

All five sequential cases pass: normal cached context, normal BCE worker, blocked context,
blocked worker and a large native-context workload. The two 1500 ms deadline requests completed
with their child dead in 1532.46 and 1571.81 ms, within the declared 2500 ms fixture completion
budget. The large case reached the native dispatch marker after decoding, then hit a 536870912-byte
cgroup peak and exited 137 with `oom=1`, `oom_kill=3` and `oom_group_kill=1`. Every workload leaf
became naturally empty before cleanup escalation; the supervisor exited zero. The marker is just
before the native call and does not identify the precise allocation instruction that caused OOM.

The first run's kernel and lifecycle evidence is preserved, but its shell timing column used
incorrect units and is excluded. The corrected rerun uses validated `/proc/uptime` centiseconds
for whole-case timing and `performance.now()` for request timing. Its five-case service consumed
4.858 seconds of CPU. Logs, input hashes, commands and both runs are retained in
`logs/production-readiness-release-gates-20261031/lima-staging/`; the final instance record confirms
the owned VM is stopped. No unrelated VM was started or modified. Application Docker build/startup,
exact-candidate platform validation and independent editorial assessment remain open.

### Explicit C2PA 2.4 assessment export (2026-10-31)

The official full crJSON schema was located in the published 2.4 schema ZIP, despite the broken
HTML include. Its exact 75699 bytes, source pin, SHA-256, attribution and license are retained in
`assets/c2pa-crjson-2.4/`. Rechecking the 41 historical native reports against it produces 182
additional-property errors: both native manifest flags appear on all 91 manifests. The SDK 0.91.7
serializer emits those fields; the official 2.4 schema forbids them, and 2.5 requires them. The
schema itself validates and compiles; the corrected vocabulary inventory has no unknown keywords.
The original packet and initial findings are preserved. Earlier rubric success never established
full-schema validity, and no historical report is silently rewritten.

The administrator CLI now supports `--crjson-version 2.4` with required `--out` and `--native-out`.
Only the two incompatible flags are removed from the assessment projection; its JSON generator
identifies the product performing that export. The unchanged official schema validates the result.
A mandatory native sidecar preserves the complete inspection, source revision, SDK identity,
assessment time and original flags, and binds the exact exported bytes with SHA-256 and length.
Cryptographic failure/trust status is never replaced by schema success. Default CLI and MCP native
reports are unchanged. Unknown versions/manifest fields, incompatible schema shapes, non-JSON data,
invalid identity and excess size fail explicitly. Limits include the complete UTF-8 output and LF:
8 MiB assessment, 16 MiB + 256 KiB native evidence. Destination checks reject existing files and
aliases before validation; exclusive writes publish native evidence first and preserve it with an
explicit recovery error if the assessment write fails. No competing file is deleted or replaced.

The assessment helper passes 40 tests, including v1/v2 and unsigned reports, nested formats,
immutable native failures, exact byte/depth/label boundaries and non-JSON rejection. Eight file
tests cover aliases, overwrite races and partial-pair recovery; seven real-ESM CLI tests cover
discovery, argument rejection and preflight. Initial test/source typing failures ran no tests and
are excluded. A selected-root production-options typecheck covers four roots and their 16-file
implementation closure with zero diagnostics; no project-wide typecheck/build ran.

A separate source-bound native probe transpiles only the 20-module credential runtime closure,
uses the existing pinned WASM, and executes the default and explicit CLI paths sequentially.
A real compressed manifest and a pinned upstream update-manifest JPEG each expose one true flag.
Both exported reports pass the unchanged schema; sidecar native JSON exactly matches default CLI
output, and assessment output differs only in the two omitted flags and generator identity. The
compressed fixture is valid/trusted under the disposable root; the update fixture retains valid
integrity and untrusted status. Original SDK codes remain intact. The probe records all selected
source/generated hashes and removes disposable signing keys; its privately retained upstream media
has no inferred redistribution permission.

Direct runtime AJV 8.18.0 and ajv-formats 3.0.1 dependencies are pinned. Installation was offline
with scripts disabled; the recorded lockfile delta is limited to validator dependencies: root AJV
6→8, deduplication of existing AJV 8 copies, and ESLint's separate AJV 6.15.0 dependency. The output-conformance script now explicitly installs
format validators after the AJV upgrade; the global output-conformance gate was not rerun under the
CPU constraint. Source lint, touched-code formatting and whitespace checks pass. The readiness/GPSA
documents now distinguish the failed original baseline, the historical passing rubric packet,
the report-version mismatch and current scoped evidence.

The checkpoint is `logs/production-readiness-release-gates-20261031/verification-summary.json`:
70 passing tests in five sequential single-file suites, two native assessment cases and five Linux
cgroup cases, plus scoped static checks. These establish the stated contracts on the recorded
fixtures, not whole-repository release certification, an editorial accuracy ranking or formal C2PA
conformance. Final-candidate platform/image execution, deployment-specific custody and independent
assessment remain open. No paid calls, parallel suite runner, global rebuild, commit, push or
publication was performed.

### Repeated workload after deadline corrections (2026-10-31)

The existing real-stdio novel suite was rerun once against current source because the preceding
45-operation checkpoint predates the deadline corrections; the later Moby Dick check had only one
sample per phase. All three tests pass, covering five cold/warm/one-scene-edit samples for each of
the three pinned novels, 45 operations total. Reports reconstruct losslessly from 32768-byte pages;
source revisions, baseline identity, finding uniqueness and native cache behavior remain valid.
Moby Dick's native budget still returns 5000 findings and explicitly reports 2359 omitted findings;
transport does not silently truncate that returned report.

| Corpus | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | One-edit p50 / p95 (ms) |
| --- | --- | --- | --- |
| Frankenstein | 256.79 / 262.93 | 287.12 / 289.94 | 286.21 / 366.97 |
| Pride and Prejudice | 379.98 / 394.01 | 386.88 / 415.99 | 373.95 / 391.43 |
| Moby Dick | 707.36 / 724.29 | 864.47 / 887.21 | 844.31 / 922.87 |

Percentiles use nearest rank; with five observations, each per-phase p95 is its maximum, not a
tail guarantee. Across these 45 operations, maxima are 922.87 ms elapsed, 85.77 ms sampled server
event-loop lag and 87523328 bytes sampled server RSS growth, within the unchanged 5000 ms,
100 ms and 128 MiB budgets. Server lifetime high-water RSS is 651460608 bytes; context/comparison
child lifetime highs are 225067008/344670208 bytes. The largest sum of observed process peaks is
1180418048 bytes, not simultaneous RSS or memory containment. Setup/project opening and cold OS
disk cache are excluded; timings include instrumentation and result reconstruction.

All 45 observed native PIDs were absent in a separate post-suite check. That observation does not
prove natural shutdown or rule out PID reuse; the dedicated lifecycle regressions provide the
separate shutdown/cancellation evidence. Raw measurements, the aggregation method, exact invocation,
selected source/dependency hashes and terminal results are retained in
`logs/production-readiness-current-workload-20261031/verification-summary.json`. This is one
sequential single-file suite on macOS ARM64 / Node 24.22.2, with local fixtures and paid providers
disabled. No global build, parallel runner or additional platform certification is inferred.

The final provenance inventory compares all 93 changed production-source paths: 76 existing
modified/untracked files have exact hashes in retained passing checkpoints; 17 deletions are
recorded separately. Checkpoint membership does not establish coverage of every feature or input.
One direct workflow-suite/source-hash linkage was incomplete, so its individual suite was run once:
all 13 tests pass, now bound to the current workflow implementation and dependencies in
`logs/production-readiness-current-workload-20261031/workflow-verification.json`. The combined new
checks comprise 86 passing tests across seven sequential individual suites, alongside the two
native assessment cases and five Linux cgroup cases. No remaining current test failure was found;
external release/platform and independent-assessment gates retain their stated limits.

### Linux source lifecycle and offline installation (2026-10-31)

The unchanged stdio lifecycle suite now also passes all four cases in Linux x64 userland:
EOF, SIGTERM and cancellation with request IDs `0` and `""`. The tests verify blocked native
process death before their cleanup, continued server usability after cancellation and natural
server exit zero within the existing two-second shutdown bound. One sequential, single-file
Jest invocation completed in 18.249 seconds. This uses Node 24.22.2 and Ubuntu 26.04 x64 through
Rosetta in the owned ARM64 Lima guest, not native-amd64 CI or a Docker image.

A fresh isolated dependency tree contains 657 packages from the pinned lockfile. Installation
was offline, targeted Linux/x64/glibc and disabled lifecycle scripts; missing cache archives had
first been fetched from the free npm registry and integrity-checked. The SQLite 13.0.3 package
already supplies its Linux prebuild. An unprivileged UID/GID 65534 preflight loads the actual
SQLite, Narrative Lens, Bluepencil and HMS Linux binaries, executes an in-memory SQLite query
and checks esbuild's runtime binary. HMS model behavior is not assessed; the server suite uses
its explicit fallback. No paid provider or model download was used.

All 247 staged source/fixture files still match the worktree and guest after execution; the
generated guest-only Jest configuration also retains its recorded hash. It uses per-file
transpilation with `isolatedModules`, not a project build or typecheck. The one-CPU, 2 GiB VM ran
the suite under a separately verified 1536 MiB service limit, zero swap and 128-task cap.
Systemd reports a 726978560-byte service memory peak and 18.939398 seconds of CPU, including
preflight. These are fixture measurements and external containment, not application-enforced
RSS limits. Systemd pruned the finished cgroup before independent terminal sampling; its absence
is not treated as proof of natural shutdown. The test assertions supply that lifecycle evidence.

The initial harness attempt failed before preflight/tests because `chroot` was at `/usr/bin`
rather than `/usr/sbin`; its logs are preserved. The corrected runner resolves the executable
and exits zero. Both attempts, source/binary hashes, exact commands and scoped assertions are
recorded in `logs/production-readiness-linux-lifecycle-20261031/verification-summary.json`.
Owned chroot mounts were released and the VM is confirmed stopped. Actual image execution,
the remaining supported-platform matrix and independent editorial assessment remain open.

### Container release gate definition (2026-10-31)

The compatibility matrix previously had no image build/startup step, so rerunning it alone could
not close the container gate. Its required Ubuntu/Node 24 row now builds `linux/amd64`, retains
the exact image ID and build log, and invokes `scripts/check-container-smoke.mjs` against that ID.
The existing aggregate release gate requires this matrix row. Container evidence is uploaded even
when its step fails; no image is published.

The smoke check uses the image's default entrypoint and actual SDK initialize/tool-discovery
exchange, verifies the process and PID 1 run without root, and requires natural exit zero within
five seconds of EOF. It then checks container exit/OOM status and configured CPU, memory, swap,
task and network limits. Runtime flags request one CPU, 1536 MiB, zero swap, 128 tasks and no
network. Local-only operation, disabled key discovery, HMS fallback and isolated Docker
configuration prevent dependence on host provider/proxy settings. No host directories are mounted.
These configured limits are not independent measurements of kernel enforcement.

Each run owns a randomly named, labelled container and an exclusive evidence file. Failure cleanup
reaps the Docker client before inspecting ownership, recovers by name when creation preceded its
ID file, and rechecks delayed creation twice. A mismatched label/name prevents removal; continued
absence is recorded as unobserved, not proof that creation never occurred. CLI/request deadlines,
bounded protocol buffers and stream-error handling keep failures explicit.

Twelve regressions pass in one single-threaded suite using subprocesses and real MCP framing with
a fake Docker command. They cover natural EOF, hung/nonzero exits, OOM metadata, root PID 1,
ownership mismatch, partial/delayed creation, existing evidence and immutable image-ID boundaries.
This validates the harness, not Docker or the built application image. The exact source hashes,
command, terminal result and scoped checks are retained in
`logs/production-readiness-container-gate-20261031/verification-summary.json`. Actual image and
final-candidate matrix execution remain open; no global rebuild or remote workflow was run.

### Authorized remote candidate and registry corrections (2026-10-31)

The user authorized an isolated public candidate branch and full remote CI, including global
builds/tests and Docker. Candidate `d331cf957c2178a89e68c9b3a6b03b0ca86e6a2f` is on
`audit/production-readiness-20261031-befef94e`; the original main checkout, index and dirty work
were preserved. [CI run 41240955045](https://github.com/writerslogic/scrivener-mcp/actions/runs/41240955045)
completed: all eight platform rows passed typecheck, formatting, lint and build, then failed the
tool-registry gate. The independent C2PA native/runtime security job passed. Later matrix steps,
including tests and the image smoke, were skipped; the aggregate release gate correctly failed.

The registry reported 267 metadata problems, including missing provenance descriptions, redundant
empty union-root property maps and six structured tools still classified as text-only. The gate
also omitted union alternatives and definition maps from its nested checks. It now visits those
schemas, rejects blank descriptions and supports a source-only invocation without rebuilding.
Handler schemas document source identities, availability, bounds, UTF-16 offsets and UTF-8 payload
budgets against their actual producers. Inputs retain explicit root properties; output types permit
fully specified union alternatives without redundant empty maps. The annotation schema generator
owns its new mode description, preserving deterministic regeneration and upstream integrity checks.

Current source passes the expanded gate: 82 tools, zero duplicate names, 68 structured data tools
and no metadata failures. Comparing both runtime registries after removing descriptions and empty
property maps found only the explicit `remember` root fields; their constraints are already implied
by every unchanged variant. Handler execution paths and schema validation bounds are preserved.
Three sequential individual suites pass, 53 tests total: registry regression checks (4), generated
schema consistency (6), and the memory contract (43). Scoped lint and formatting also pass. Evidence
is retained in `logs/production-readiness-remote-ci-20261031/`; no local global build/typecheck,
parallel test runner or paid provider call was used. Full CI on the corrected commit remains pending.

### Full-matrix failures and native parsing capacity correction (2026-10-31)

Registry-corrected commit `725bb64619f672b9527b7e7ce90cdd19e25e2cf0` ran in
[CI 41241888058](https://github.com/writerslogic/scrivener-mcp/actions/runs/41241888058).
All eight platform rows passed build/type/static gates, registry/output conformance and native
C2PA compatibility. The separate security job passed its configured high/critical policy; its
downloaded artifact digest, five inventory/scanner-output pairs and 26 source hashes were checked.
Full tests exposed additional failures, so installed-package and container gates were not reached.

The setup unit suite auto-mocked a dependency by loading its real queue/envelope imports while
blanket filesystem mocks returned undefined package metadata. Explicit dependency factories now
isolate setup, and 22 real status/health/setup/persistence/CLI assertions replace method-existence
and self-mocked checks. Readability fixtures now require finite available scores before comparing
them; short text is accepted with measured zero dialogue and unavailable description coverage.
The Windows memory-owner fixture now passes its resolved tsx loader as a file URL; live-process
exclusion and hard-termination recovery assertions remain unchanged.

The native input-boundary failures were a production capacity mismatch. On local Node 22.23.4,
the admitted sparse-Unicode input reproduced a child `SIGABRT` classified from V8's fatal heap
diagnostic as out-of-memory. ASCII and Unicode inputs can retain the JSON source and decoded
values simultaneously; a 64 MiB serialized request can exceed the former 128 MiB old-space cap
before native dispatch. Both child adapters now share a 384 MiB V8 old-generation limit and
release received buffers, decoded source and request references as soon as their stage finishes.
The 64 MiB input cap, 16 MiB output cap, deadlines, cancellation and native cache budget are
unchanged. This heap setting remains distinct from native RSS and external deployment containment.

Both complete process suites pass on Node 22.23.4: worker 13/13 and persistent context 25/25,
including byte-limit-minus-one/limit/limit-plus-one inputs, Unicode, output limits, deadlines,
hard cancellation and owner death. Setup, readability and memory ownership pass 31 further tests
in three sequential individual suites on Node 24.22.2. Scoped lint/format checks pass. Safe shared
test diagnostics retain only exit code, signal and a recognized heap-failure classification;
raw child stderr is not emitted. Logs and hashes are under
`logs/production-readiness-remote-ci-20261031/`. The corrected full matrix remains pending.

### Lifecycle instrumentation and asynchronous fixture corrections (2026-10-31)

Commit `4fc8895b86601fe2bea4fd770867699335ab0979` ran in
[CI 41243134078](https://github.com/writerslogic/scrivener-mcp/actions/runs/41243134078). All eight
rows passed static/build, registry/schema and native compatibility gates; the native 64 MiB boundary
suites also passed. The security policy job passed. Full tests failed because the server lifecycle
probe still selected the former 128 MiB child argument, so its blocking preload never ran. Three
Linux rows additionally exposed polling helpers that exhausted fixed `setImmediate` counts before
asynchronous suggestions settled. No later release gate passed.

The probe now uses the worker's shared heap constant. Suggestion and indexing helpers use a
monotonic five-second deadline with a ten-millisecond delay; terminal-state, error, revision and
index assertions are unchanged. Three sequential individual suites pass locally on Node 24.22.2:
server shutdown/cancellation 4/4, writing suggestions 22/22 and asynchronous indexing 9/9.

A current-source novel workload rerun passed all 15 Pride and Prejudice operations within the
existing budgets, but Frankenstein and Moby Dick timed out during the 30-second initialization step,
before analysis. Those failures remain explicit; neither initialization nor analysis budgets were
loosened. An unchanged rerun initialized both novels and completed their 30 operations; Frankenstein
passed, but three Moby Dick observations exceeded the 100 ms event-loop budget (maximum 552.62 ms).
All operation durations and RSS-growth observations remained within budget. One bounded startup
sample showed synchronous module/file reads, without establishing the cause of the earlier timeouts.
The latency investigation and corrected full remote matrix remain open. Exact logs, the process
sample and measurements from both invocations are retained under
`logs/production-readiness-remote-ci-20261031/`.

### Requested session checkpoint (2026-10-31)

The user requested a safe stopping point and a fresh-session continuation prompt. Candidate
`9b1647c908c80f72ead4c31e8eaa19fe88c0d344` is published on the isolated audit branch;
[CI 41244515251](https://github.com/writerslogic/scrivener-mcp/actions/runs/41244515251)
is running, with no observed failures at the checkpoint. Its terminal result and release artifacts
remain unverified. The candidate worktree is clean; the original main checkout and index remain
preserved. This checkpoint section is a local, unpublished ledger update.

The additional five-sample Moby profiling attempt exited 1 after an initialization timeout,
before collecting measurements. Its test process and server child have exited; no local suite
remains running. This does not resolve the earlier latency failures. No performance thresholds
were changed and no further production edits were made. Continue from the detailed state and
artifact checklist in `logs/production-readiness-remote-ci-20261031/continuation-state.md`;
the audit specification is also retained there as `quality-audit-updated.md`.

### Installed-consumer dependency correction and bounded profiling (2026-10-31)

[Run 41244515251, attempt 1](https://github.com/writerslogic/scrivener-mcp/actions/runs/41244515251)
completed unsuccessfully at exact commit `9b1647c908c80f72ead4c31e8eaa19fe88c0d344`.
All eight rows passed the build/static/native gates and complete default test run: Linux/macOS
155 suites and 2,554 tests passed (12 skips); Windows 154 suites and 2,530 tests passed (40 skips).
All eight then failed the installed-consumer dependency audit. Docker, Redis, dashboard and
EPUBCheck did not execute. The separate native/runtime security policy passed; release verification
correctly failed. Complete per-row logs and exact run metadata are retained in
`logs/production-readiness-remote-ci-20261031/`.

A fresh consumer dependency resolution reproduced five moderate findings originating in minimatch
through EPUB's EJS/Jake build-tool dependencies. The repository audit additionally identified the
glob cancellation advisory in development tooling. The correction pins EJS 7.0.2 for EPUB, removing
Jake/filelist from production, and pins patched minimatch 11.0.3 and glob 14.0.3 for development.
EPUB's dependency tree is bundled into the application tarball so consumers receive the tested EJS
resolution: npm ignores overrides declared by installed dependencies. No audit threshold changed.
See [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249),
[glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), and
[npm bundle/override semantics](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).

The final local npm audit reports zero vulnerabilities. The locked dependency graph installed
successfully with scripts disabled; no local global build/typecheck ran. Two sequential individual
suites pass 16 tests: EPUB/DOCX/PDF export (including Unicode and template-injection input) and
actual Jest dependency security (prototype poisoning, cancelled filesystem traversal, adversarial
globstar preprocessing). Full installed-package/platform verification remains pending.

Profile-only instrumentation now records bounded stage spans, process CPU deltas for the worst lag
window, up to 64 GC events and the eight longest page operations, without manuscript content.
The new Moby Dick run completed all 15 operations within unchanged budgets: maximum event-loop
lag 87.55 ms. The largest observed windows overlapped final report serialization and first-page
creation; recorded GC pauses were below 5 ms. These measurements do not establish the cause of the
previous 552.62 ms stall or initialization failures, which remain preserved. The profile overlapped
part of an npm resolution diagnostic, so it is not an idle-host performance claim. No speculative
production performance change was made. Complete three-novel validation remains pending.

### Complete novel measurement and EJS applicability reassessment (2026-10-31)

Candidate `3ba6846f5f8e627e6105567f21bc1e5b9198629c` completed all three pinned novels through the
real stdio server, five cold/warm/one-edit samples each: 45 operations, zero budget violations.
Maximum server event-loop lag was 83.673 ms (budget 100 ms), elapsed time 870.953 ms (5,000 ms),
and sampled server RSS growth 120,209,408 bytes (134,217,728 bytes). Initialization stayed within
30 seconds and every tool within ten seconds. The run used Node 24.22.2 on macOS arm64, bounded
profiling, the exact installed candidate dependency graph and no concurrent local installation,
build or other suite. Results, per-phase p50/p95 and corpus hashes are in
`novels-candidate-3ba6846-{profile,summary}.json` under the remote-CI evidence directory.
With five samples, nearest-rank p95 is the observed maximum; these are fixture measurements,
not a universal latency or native RSS guarantee. All earlier failed observations remain retained;
the old intermittent startup/stall causes were not reproduced and remain unattributed.

The corrected candidate's separate security job reported one critical CPE match for
`CVE-2023-29827` against EJS 7.0.2. The existing exact-version VEX assessment covered EJS 3.1.10
and correctly did not suppress the changed version. Reinspection established that project export
and toEpub use explicit option allowlists, the EPUB generator uses packaged templates, and EJS
7.0.2's render function takes compilation options only from its third argument, separate from data.
An added real-export regression injects template bodies and engine-option properties and verifies
normal EPUB metadata; all nine exporter tests pass. The VEX document now records this reassessment
for exactly EJS 7.0.2 and that CVE, with source paths and regression evidence. The high/critical
policy and every other disposition are unchanged. The failed scanner artifact, its SHA-256,
source hashes and reassessment are retained; a new successful scan is still required.

The same run exposed a macOS 22 cancellation-fixture race: the test aborted after a fixed 400 ms,
then assumed the child had already written its PID. Cancellation could validly stop startup first.
The fixture now waits for explicit native entry before cancellation, checks that PID is alive,
then checks it has exited before the rejection settles. A deliberate 500 ms entry delay protects
against the old race. Deadline tests retain their 400 ms execution deadline and 2,500 ms completion
bound, but now assert exit of the actual spawned process; a missing PID file can no longer satisfy
an assertion accidentally. All 13 worker tests pass on Node 22.23.4, including input/output byte
boundaries, owner death, delayed-entry cancellation and recovery. Production lifecycle code and
resource budgets are unchanged. Windows rows were still running when this correction was prepared.

[Run 41246536667, attempt 1](https://github.com/writerslogic/scrivener-mcp/actions/runs/41246536667)
then completed: seven platform rows passed, including installed-consumer audit/smoke everywhere
except the macOS 22 row stopped by the fixture race. Ubuntu 24 also passed the immutable-image
Docker smoke, real Redis checks, Chromium dashboard interactions and four EPUBCheck cases
(Unicode/empty, unsigned/signed). The separate security assessment failed solely on the newly
versioned EJS match above. The aggregate release gate failed as intended. These successes are
partial evidence at 3ba6846, not a passing release matrix; both corrections require a new run.

### Verified audit closure (2026-10-31)

Candidate `2eb6b9e2c4246767fee53eebeeb058e3ab217a6d` passed [CI 41247863036, attempt 1](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036):
all eight platform rows, native/runtime security and aggregate release verification. Every installed
smoke ran; Ubuntu 24 also passed Docker, real Redis, the browser dashboard and four EPUBCheck cases.
All ten artifact hashes, native fixture/index identities, container lifecycle and security
source/SBOM/scanner/VEX provenance were verified against that exact candidate.

All nine P0/P1/P2 criteria and the tested hard-cancellation contract now have passing implementation
and functional evidence. The complete 45-operation novel workload passed unchanged budgets on
3ba6846 with production source/dependencies/harness identical to the CI candidate. Historical lag
and startup failures remain unattributed; sampled server RSS does not establish native containment.
Security retains four medium findings and seven reviewed VEX exclusions. Comparative editorial
accuracy, optional model paths, all MCP hosts and external certification remain unverified.

The [final audit report](repository-audit-20261031.md) records exact platform totals, acceptance
fixtures, workload p50/p95, artifact digests and evidence limits. This closing entry and report are
documentation published after the tested SHA; they do not claim another CI execution. The original
dirty main checkout and index remain preserved. No merge or package publication was performed.

### GitHub security and quality follow-up (2026-10-31)

PR #214 at dc1754e passed every PR workflow, including extension packaging, CodeQL, dependency
review and the complete compatibility matrix. Initial GitHub triage found no Dependabot alerts,
no PR security alerts or review threads, and no other open PRs. The separate code-quality API
reported finding #568: an unused readFile import left after descriptor-safe file reads replaced it;
that import is removed. Raw snapshots are in logs/github-security-followup-20261031/.

ESLint's Ajv6 dependency used uri-js 4.4.1, whose UTF-8 decoder has no patched release. Its scoped
npm alias now reuses the existing patched fast-uri 3.1.9 implementation; three regressions cover
malformed encoded metacharacters, Unicode line-separator termination and actual Ajv6 relative
references/validation boundaries. The complete dependency-security suite passes 11/11. No production
dependency version or benchmark threshold changed.

The RSA timing advisory was reassessed against the native callback boundary: Rust receives message
and signature bytes, while Node/OpenSSL retains private keys and performs RSA-PSS. All 13 credential
SDK tests pass, including independently verified RSA-PSS, ECDSA and Ed25519 signatures. Two V8
CPE matches refer to 2011 engine behavior; pinned Node 24.22.2 source and the original CNA/Chrome
records substantiate exact-version VEX dispositions. The removed uri-js dependency no longer needs
its previous VEX exception. Fresh scanner execution remains pending.

Scorecard alert #76 accurately identifies the bundled WASM. CI now requires a clean rebuild with
Rust 1.96.0 / wasm-pack 0.14.0 and comparison of every generated artifact against the committed files;
its first execution is pending. Alert #22 includes unmaintained bincode 2.0.1 (HMS SBOMs),
paste 1.0.15 (Narrative Lens tokenizers) and proc-macro-error 1.0.4 (C2PA build dependency). Their
current upstream releases offer no patched replacements; supplied SBOMs/lockfiles and alerts remain
intact. These maintenance warnings are distinct from the RSA execution-path assessment, and this
follow-up does not merge changes or dismiss genuine dependency/binary-presence findings.

All 24 supply-chain policy regressions pass, including vulnerable unpatched high/critical findings,
scanner failures, stale databases and evidence bounds. The high/critical rejection policy remains
unchanged. Full remote checks and rebuilt-engine/scanner artifacts will bind the follow-up to its
published candidate.

Follow-up run 41263291711 at c66c4d2 passed the native/runtime scanner with zero applicable
findings across all five inventories and nine explicit VEX exclusions. Its new clean rebuild
compiled successfully with the pinned tools, but four generated assets differed from the committed
files; all six source hashes matched. The WASM grew by 239 bytes. The gate correctly failed, and
the manifest/archive evidence is retained. Build-host or Cargo metadata differences are hypotheses,
not an established cause. The next run retains complete rebuilt files, toolchain metadata and a
second clean-build comparison to diagnose the discrepancy without weakening byte equality.

Diagnostic run 41263877217 at b4cf414 reproduced the same Linux output as the first run, then
produced byte-identical files after `cargo clean`. All six source inputs match the candidate. The
retained producer sections establish one concrete provenance difference: the former engine records
wasm-bindgen `0.2.129`; Linux records `0.2.129 (165586f85)`. Generated JS/declarations differ only
in two compiler-generated closure names; WASM code/data sections also differ, so semantic
equivalence is not inferred from those names. The exact compiler contribution to those differences
remains unproven. The reference build is now explicitly Ubuntu 24.04 x64, and its repeatedly
reproduced assets replace the previous host-unspecified generation. Source, dependency graph, 1 GiB
memory cap and byte-equality gate are unchanged. Functional and clean-checkout verification of these
regenerated assets is required before this follow-up is complete.

### Verified GitHub security and quality closure (2026-10-31)

Candidate `ac8e3d4d156abd3ead29021dd870a71a2d446560` passed
[CI 41264607021, attempt 1](https://github.com/writerslogic/scrivener-mcp/actions/runs/41264607021):
all eight platform rows, native/runtime security, the new byte-identical C2PA rebuild and aggregate
release verification. All seventeen PR checks passed, including CodeQL, dependency review and
extension packaging. Full tests passed with 2,560 tests per Linux/macOS row and 2,536 per Windows
row; existing skips remain explicit. Installed-package smoke, Docker, Redis, dashboard and all
four EPUBCheck cases passed. All eleven artifact archives and 26 security source identities were
verified against the exact candidate/attempt; five regenerated files and their manifest match Git.

Fresh scans have zero applicable findings across five inventories with nine reviewed VEX exclusions.
CodeQL reported zero results across 103 rules without errors/warnings; its synthetic PR checkout
has the candidate's exact tree. Dependabot and PR security queries are clear. Code Quality #568 is
fixed on the branch; its repository finding still refers to unmodified main. Scorecard's accurate
binary-presence finding and three upstream maintenance advisories remain documented and undismissed.
No merge, publication or paid development calls occurred. The original dirty main checkout/index
and unpublished ledger checkpoint remain preserved.

The [security follow-up report](github-security-followup-20261031.md) records the corrections,
failed rebuild observations, reference environment, exact artifact digests and remaining limits.
Durable proof is under `logs/github-security-followup-20261031/`. This ledger entry and report are
documentation added after the tested SHA; they do not relabel earlier failed runs as successes.
