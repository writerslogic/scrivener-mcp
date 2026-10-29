# Verified compatibility

The public server targets Scrivener 3's saved `.scriv` directory/package: a `.scrivx` binder and
UUID-addressed `Files/Data/<UUID>/content.rtf`. A project can be opened by directory or manifest
path, including case-varied or renamed manifests when discovery is unambiguous. Native unsaved
buffers and undocumented native compile-layout rules are outside this interface.

## Runtime and platform evidence

The current supported stable Node range is `^22.23.4 || ^24.22.1 || >=26.12.1`, with Node-API 10 or
newer. Node 24.22.1 or a newer Node 24 patch is recommended. The pinned CAI native SDK requires the
patched TLS floors in addition to SQLite 13's Node-API requirement. Node 23/25 and lower patches on
22/24/26 are excluded. See the
[runtime policy](forward-compatibility.md#runtime-and-dependency-changes).

CI is configured for the exact 22.23.4 minimum and Node 24 across all three operating systems, plus
latest Node 22 and Node 26 on Linux. The protected release gate requires every job to pass.
Configuration alone is not evidence: inspect the exact commit in the
[CI matrix](https://github.com/writerslogic/scrivener-mcp/actions/workflows/ci.yml) and its per-job
C2PA JSON artifact. Each report records the actual OS, architecture, Node/SDK version, fixture-index
digest and format/mode results. Current local evidence is recorded in
[the ledger](implementation-status.md).

The 0.14.0 candidate passed the complete local gate on macOS arm64 / Node 24.22.1: 48 native C2PA
fixtures, 1,138 tests and 17 fresh-package/MCP checks. The staged Mac bundle separately passed its
15 applicable installed-package checks under Node 24.22.2, including the actual arm64 C2PA binary.
[The retained native snapshot](compatibility/c2pa-0.14.0-macos-arm64.json) is local evidence;
Windows/Linux results are supplied by the matching CI jobs, not inferred from the Mac result.

The Node 22.13 and 26.8.1 observations below are historical. They do not establish current runtime
support or verify the new CAI native SDK. The Node 22.13 results used SQLite driver 12.

The minimum Windows job remains on `windows-2022`, with Visual Studio 2022; the Node 24 job uses
`windows-latest`. An earlier Node 22.14 reproduction used npm 10.9.2 and node-gyp 11, which could
not recognize Visual Studio 2026 on the newer runner. In that reproduction, frozen installs invoked
node-gyp because the lockfile omitted SQLite's `gypfile: false` setting despite its bundled native
binary; a fresh registry install with npm 10.9.2 used that binary without rebuilding. These
historical toolchain versions explain the runner choice; they are not asserted as the versions
bundled with Node 22.23.4. Record the current minimum's npm/node-gyp versions and Windows results
from its actual CI run. Both Windows jobs retain every applicable release check.

| Target                                                 | Historical verification                                                                                                                                                   | Limit                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64, Node 26.8.1 / npm 11.19.0                 | Local manager validation, generated Mac/Windows-layout fixtures, installed-package MCP sessions and Chromium Apps interactions                                            | Exact final command results are recorded in [the ledger](implementation-status.md)                                                                   |
| Windows, Node 22.13.0 and 24                           | Native CI passed the release gate and installed-package MCP sessions; setup uses absolute `node.exe`; synthetic case-varied/renamed projects exercise saved-file behavior | Live Windows Scrivener GUI behavior is unverified; POSIX FIFO/no-follow tests are inapplicable                                                       |
| Linux, Node 22.13.0 and 24                             | Native CI passed the release gate and installed-package MCP sessions; Node 24 also passed Chromium and EPUBCheck                                                          | No native Scrivener process integration; native-app detection is ambiguous and writes need explicit acknowledgment                                   |
| macOS, Node 22.13.0 and 24                             | Native CI passed the release gate and installed-package MCP sessions, including private-runtime setup                                                                     | These remote CI observations are separate from the local Node 26 measurements                                                                        |
| Linux, latest Node 22 and Node 26                      | Expanded native CI passed the same release gate and installed-package sessions                                                                                            | This supplements the minimum-version and Node 24 jobs; native Scrivener GUI behavior remains outside Linux coverage                                  |
| Node below 22.14, or 23.0 through 23.5                 | Rejected by current package/setup/bootstrap requirements                                                                                                                  | SQLite 13 requires Node-API 10; the previous 22.13 floor applied to driver 12. Node 18/20 are unsupported                                            |
| MCP core SDK 1.32.1 / 1.32.2, Apps protocol 2026-01-26 | Installed-package sessions negotiate Apps and resource metadata; a plain client receives useful text/structured data                                                      | Individual commercial hosts may implement different extension versions; their visual integration is not certified by the simulated-host browser test |

The repository's full final gate includes formatting, lint, type checking, build,
registry/output/HMS checks, all Jest suites and npm audit. Additional release checks install a local
tarball into an isolated consumer, exercise real MCP calls, drive the dashboard in Chromium, and
validate generated ebooks with W3C EPUBCheck. No external publication, deployment or real client
reconfiguration is part of these checks.

The earlier six-job OS/runtime matrix passed in
[CI run 40617784860](https://github.com/writerslogic/scrivener-mcp/actions/runs/40617784860) at
`eecbe98`. This verifies the public server against redistributable saved-project fixtures, not every
native Scrivener release or GUI interaction.

The earlier expanded eight-job matrix passed on main at `72ade1c` in
[CI run 40707022045](https://github.com/writerslogic/scrivener-mcp/actions/runs/40707022045).
`Release verification` now requires every matrix job to succeed before main integration.

Those runs predate the current patched-floor/C2PA candidate. Native Content Credentials coverage has
a separate per-format, per-mode and per-platform matrix; the format catalog alone is not
verification. See [Content Credentials](content-credentials.md) for its pending evidence, offline
trust limits and export integration. No new Windows C2PA pass is inferred from historical runs.

The SQLite driver upgrade retains the application schema. Original CC0 fixtures in
`tests/fixtures/sqlite12` were produced with driver 12.11.1 / SQLite 3.53.2, including a committed
WAL left by a terminated writer. Tests copy those files before opening them with the current driver,
verify Unicode and WAL recovery, and exercise rollback, reopen and competing-process claims.

## Format and fidelity coverage

Holographic Memory 0.6.4 is a declared dependency. The release gate exercises its installed native
binding and the forced JavaScript fallback on every CI job. Local checks also verified native
cross-process ownership and restart recovery, exact Unicode passage byte ranges, metadata/version
retention and vector-store scope isolation. Published native packages cover eight OS/architecture
tuples; publishing a tuple does not establish live verification on that hardware. Scrivener's saved
source revisions remain authoritative. HMS `flush()` does not release its native store lock, and the
upstream Node API has no deterministic close method; compatible owners reuse the store, while
another server selects a volatile local fallback rehydrated from SQLite. No embedding model is
downloaded.

| Construct                                  | Verified behavior                                                                                                                                     | Boundary                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mac package and Windows-shaped directories | XML attributes, binder hierarchy/order, renamed/case-varied manifest discovery                                                                        | Scrivener 2 numeric IDs under `Files/Docs` and Scrivener 1/iOS-only formats are unsupported; migrate through Scrivener 3                                                 |
| Unicode                                    | Accented Latin, Japanese, combining marks, non-BMP surrogate pairs, RTF Unicode fallback scoping, quotation/tab/dash controls                         | Saved RTF must be valid UTF-8/ASCII with supported RTF escapes; unsupported byte encodings fail explicitly                                                               |
| RTF formatting and embedded groups         | Bold/italic and unchanged stylesheet, annotation, footnote, image and opaque groups survive eligible splices byte-for-byte                            | An exact parser round trip gates every splice; regeneration requires acknowledged preview loss, rather than a silent formatting promise                                  |
| Snapshots                                  | Native RTF/index layout, collision-safe identifiers and title mapping; interrupted writes reconcile from persistent plans                             | The native app can still save independently; these protections coordinate server instances on a local filesystem                                                         |
| Metadata                                   | Binder attributes, section types, custom metadata, keywords, unknown XML elements and extension attributes round-trip through representative fixtures | Native preferences and undocumented custom compile layouts are preserved where untouched, not interpreted as a complete native engine                                    |
| Review and undo                            | Persistent selective proposals, batches, snapshots, expected revisions, exact raw undo and restart recovery                                           | Later saved revisions stop stale writes/undo; ambiguous owners require inspection instead of unsafe lock removal                                                         |
| Search and continuity                      | Exact quoted passages, UUID/revision/offset provenance; local concept relevance fixture; author-curated canon/finding lifecycle                       | Concept search covers a bounded English vocabulary; continuity extraction covers explicit eye/hair colors and birth years, with other dimensions requiring curated facts |
| DOCX / EPUB presets                        | Scope/order, front matter, supported styles and scene-end notes, structural archive validation and EPUBCheck release fixtures                         | Images, native note anchors, tables, fields and native compile rules have documented preflight limits; see [export coverage](export-presets.md)                          |
| PDF                                        | Existing standard-font exporter                                                                                                                       | Characters outside WinAnsi may be normalized/omitted; prefer DOCX/EPUB for Unicode fidelity                                                                              |

`tests/fixtures/compatibility.ts` generates original, redistributable Mac/Windows-layout projects,
including a valid generated PNG, Unicode RTF, annotations, footnotes and unknown metadata. Its CC0
license is adjacent. The packaged first-session project under `assets/sample-project` is separately
CC0. These synthetic fixtures demonstrate documented file behavior; they are not a certification of
every native Scrivener point release.

## Persistence and recovery

Per-project `.scrivener-mcp/editorial.sqlite` stores schema-versioned proposals, review receipts,
mutation/snapshot recovery plans, source facts/findings, passage indexes and workflow checkpoints.
SQLite transactions are synchronous and short; durable operation reservations coordinate the
filesystem work without holding database transactions across I/O. Binder saves compare the exact
loaded XML revision, including same-size changes with preserved timestamps. Reads refresh saved
revisions and reject stale applications. Saved reads validate opened file descriptors and bounded
content. POSIX uses no-follow/nonblocking flags; Windows verifies path/file identity after opening,
with concurrent external replacements remaining best effort.

Back up the project together with its editorial state and native `Snapshots` directory. Do not
delete `.scrivener-mcp` as a cache. Existing version-zero editorial databases acquire the
version-one state table without dropping records; future schema versions are refused. Retried
operations reuse receipts. An interrupted operation whose saved bytes match neither the before nor
after revision is marked conflicting and does not overwrite those bytes.

The series registry defaults to `~/.scrivener-mcp/series.sqlite`, configurable with
`SCRIVENER_DATA_DIR`. Series membership and fact scope are explicit. Research text may support
curated provenance without being included in manuscript search/workflows/exports. Copied projects
retaining an already registered editorial identity are rejected while the original path exists,
preventing accidental cross-project identity reuse; preserve the original history separately before
intentionally starting an independent copy.

Close the project in Scrivener before applying edits. `force: true` acknowledges native
open/ambiguous detection only; it cannot override revision mismatches or server reservations.
Unsaved buffers, network-filesystem lock semantics, cloud-sync races and safe simultaneous native
writes are not guaranteed. The format remains reverse engineered; keep independent backups.
