# Validation for 0.14

This release hardens saved-manuscript review, editing and export. Its supported scope is
described in [Scrivener format handling](scrivener-format.md),
[editorial workflows](editorial-workflows.md) and [client setup](CLIENT_SETUP.md).
The observations below are local candidate evidence, not standards certification or a
claim that every client, manuscript or RTF construct has been tested. The protected
release workflow additionally requires successful CI for the exact released main commit.
The protected merge check now propagates each prerequisite failure; a shell regression
test covers failed, cancelled, skipped and missing job results. The separate publication
verifier continues to require overall exact-commit CI success.

## Manuscript integrity

One decoder now supplies the text, styles and source offsets used for reading and
preserving edits. Independent Cocoa checks cover straight punctuation, Windows-1252,
Unicode, nested styles, metadata and boundary whitespace, including create, notes,
regeneration, reviewed changes and exact-byte undo. Unsupported encodings, inconsistent
formatted spans, unpaired surrogates and unsupported supplied formatting or metadata fail
explicitly. Close Scrivener before editing; the final revision check cannot atomically
coordinate with arbitrary native or external writers.

The read-only bundled Scrivener 3.5.2 tutorial corpus contains 78 RTF files. The initial
candidate matched Cocoa text extraction in 16; generated list labels, table boundaries
and soft/page breaks exposed additional differences. The corrected decoder matched all
78. The [corpus receipt](benchmarks/native-rtf-0.14.json) retains hashes and lengths without
redistributing the tutorial text.
This is text extraction evidence, not a native GUI save/reopen qualification.

EPUB/DOCX tests retain supported styles and terminal paragraphs and validate publication
and resource languages. EPUBCheck 5.4.0 passed 12 signed/unsigned fixtures. Independent
Cocoa DOCX import preserved exact text and bold, italic, underline and strikethrough
attributes. Chromium rendered four original EPUB chapters with exact paragraph text,
computed styles and French/Japanese language tags. It exposed collapsed empty paragraphs;
the corrected stylesheet gives each at least one em of height without adding text.
The [before](benchmarks/export-rendering-before.json) and
[after](benchmarks/export-rendering-0.14.json) receipts retain that result. Cocoa did not
expose DOCX language attributes; Word, Pages and complete EPUB reading systems remain
outside this renderer check.

## Contracts and recovery

Each connection has explicit pending-call, retained-parameter and attempt-rate budgets.
Queued cancellation releases admission; running work holds its capacity until it settles.
Modern clients can pass an ordinary `projectHandle`, and legacy scope behavior remains
available. A real Chromium reference host drove the modern stdio server through
open, dashboard, read, proposal, preview, apply and exact-byte undo. Commercial client
qualification is separate.

Continuity publication rechecks saved source, scope and canon identities. Plain and paged
reads no longer populate the legacy global manuscript memory. Setup uses one recoverable
publication path with exact backups, corruption refusal and optimistic conflict checks.
Mutation receipts have explicit admission budgets with reserved inverse-undo capacity;
existing history is not silently purged. Those budgets do not bound all snapshots, WAL
files, native memory or total project disk usage.

Snapshot creation accepts the same explicit `force` acknowledgment of uncertain native
application state as other guarded writes. It still refuses by default when native state
is open or unknown, and `force` never overrides a read-only project. Headless CI exposed
the previously missing option plumbing; disposable snapshot and queue fixtures now also
check the saved result, not only its response schema.

The [direct-handler conformance receipt](benchmarks/conformance-0.14.json) records 144 cases: 125 schema-valid successes,
17 expected refusals and two lifecycle acknowledgments. All 70 schema-bearing tools have
an observed success or provider-unavailable refusal. The [generated ledger](benchmarks/coverage-ledger-0.14.json) distinguishes
these observations from complete action, boundary, wire and host coverage. Controlled
native-detection absence does not validate positive GUI detection. No paid provider
success was exercised.

## Local checks and reproduction

The local full coverage gate on Node 26.12.1 / macOS arm64 passed 180 suites and 3,318 tests;
12 tests were skipped: six opt-in novel cases and six paid-provider cases. Coverage was
72.12% statements, 67.50% branches, 73.25% functions and 72.86% lines, above the existing
thresholds. A later EPUB stylesheet correction passed the 44 focused export tests,
EPUBCheck and the independent renderer. The expanded conformance harness has its own
focused tests and runtime receipt. Final CI reruns the repository gates after integration.

Type checking, formatting, lint, runtime/registry/schema checks, fallback HMS, native C2PA,
isolated Redis, dashboard and 24 installed-package smoke checks passed. The local desktop
extension built and launched with a checksum-verified Node 24.22.3 runtime. These local
package checks preceded the final narrow export/harness changes; the release workflow
rebuilds and verifies the exact publishable artifacts. The six Python comparison tests
also passed. Earlier failed attempts are retained locally rather than described as clean
first-pass results.

Useful commands, from a supported runtime and a disposable environment:

```sh
npm run build
npm run test:coverage -- --runInBand
node scripts/check-output-conformance.mjs --receipt logs/conformance.json
node --import tsx scripts/coverage-ledger.mjs --repository "$PWD" --receipt logs/conformance.json --output logs/coverage-ledger.json
node scripts/check-epub-export.mjs
node scripts/check-export-rendering.mjs --output logs/export-rendering.json
node scripts/check-release-smoke.mjs
uv run --no-project python -B -m unittest discover -s scripts/tests
```

The independent renderer requires macOS, its command-line developer tools and Chromium;
CI runs it on macOS with Node 24. Real RTF corpus checks use
`scripts/check-native-rtf.mjs --project PATH --corpus-version LABEL --output NEW_FILE.json`
against an explicitly selected disposable or read-only corpus. Never use a working
manuscript for mutation tests.

## Scale evidence

The [performance report](performance-0.14.md) retains 120 completed passage phases across
1,000/10,000/50,000 passages, an actual 10,000-edit quota/replay/inverse test and 45 completed
explicitly paced novel phases. Citation and recovery checks passed. Existing latency,
event-loop and memory objectives did not all pass; two initial server startup timeouts
remain undiagnosed. Earlier failed unpaced and observer runs are preserved. These are
measured limits, not performance or general containment guarantees.

The subsequent snapshot/release-check corrections passed 70 focused tests, static checks,
the registry gate and a fresh 144-case conformance receipt with its matching ledger.

## Token and editorial evidence

[Token measurements](token-optimization.md#measurement) retain complete payloads and named
tokenizer counts. A repeated schema envelope became local references with equivalent
validation, saving 749/763 catalog tokens relative to the uncompacted candidate.
The complete ten-call workflow increased about 2.6% from its recorded working-tree
baseline; no overall token or billing savings are claimed.

The offline 90-case literary-development and 36-case synthetic continuity regressions
passed with exact evidence checks. These are agent-authored development labels. The
former 12-case holdout was used in later tuning; it is no longer unseen. Independent human
labels, reviewer agreement, a fresh holdout, at least 100 representative retrieval queries
and stratified ranking metrics remain required before editorial accuracy, retrieval
superiority or broad temporal-knowledge claims. No extra extraction rules were added to
substitute for that missing evaluation.
