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
digest and format/mode results.

The minimum Windows job uses `windows-2022` for Visual Studio 2022 compatibility; the Node 24 job
uses `windows-latest`. Every matrix job runs the release checks, including installed-package MCP
sessions, SQLite and native/fallback HMS. Linux Node 24 also exercises the dashboard in Chromium and
validates exports with EPUBCheck. Docker and Redis have separate integration checks.

These checks verify saved-project fixtures and simulated MCP hosts. They do not certify live
Scrivener GUI interactions, unsaved buffers, or every commercial client's Apps integration.
[Content Credentials](content-credentials.md) describes per-format coverage and offline trust
limits. A passing result on one platform does not establish a pass on another.

The SQLite driver upgrade retains the application schema. Original CC0 fixtures in
`tests/fixtures/sqlite12` were produced with driver 12.11.1 / SQLite 3.53.2, including a committed
WAL left by a terminated writer. Tests copy those files before opening them with the current driver,
verify Unicode and WAL recovery, and exercise rollback, reopen and competing-process claims.

## Format and fidelity coverage

Warm 0.6.4 is a declared dependency. The release gate exercises its installed native binding and the
forced JavaScript fallback on every CI job. Local checks also verified native cross-process
ownership and restart recovery, exact Unicode passage byte ranges, metadata/version retention and
vector-store scope isolation. Published native packages cover eight OS/architecture tuples;
publishing a tuple does not establish live verification on that hardware. Scrivener's saved source
revisions remain authoritative. HMS `flush()` does not release its native store lock, and the
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
| PDF                                        | Existing standard-font exporter                                                                                                                       | Unsupported characters fail preflight explicitly; prefer DOCX/EPUB for Unicode fidelity                                                                                  |

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
with concurrent external replacements remaining best effort. The native `docs.checksum` sidecar must
be a regular UTF-8 file of at most 4 MiB, including entries added by the requested mutation. Its
input and projected output are checked before manuscript publication. Missing checksum files remain
absent; updates preserve unrelated entries and line endings. RTF text matching has a 60000-token
bound and a one-million-candidate work budget. A changed document that exceeds either budget
requires the same explicit formatting-loss acknowledgement as other unsplicable RTF; an unchanged
document retains its original bytes.

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
