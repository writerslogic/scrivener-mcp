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

Primary contracts:
[0.6.4 release](https://github.com/writerslogic/holographic-memory/releases/tag/v0.6.4),
[Node declarations](https://github.com/writerslogic/holographic-memory/blob/v0.6.4/index.d.ts) and
[native store ownership](https://github.com/writerslogic/holographic-memory/blob/v0.6.4/src/core/store_lock.rs).
