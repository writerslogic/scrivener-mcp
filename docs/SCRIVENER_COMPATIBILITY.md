# Verified compatibility

The public server targets Scrivener 3's saved `.scriv` directory/package: a `.scrivx` binder and
UUID-addressed `Files/Data/<UUID>/content.rtf`. A project can be opened by directory or manifest
path, including case-varied or renamed manifests when discovery is unambiguous. Native unsaved
buffers and undocumented native compile-layout rules are outside this interface.

## Runtime and platform evidence

| Target                                                 | Evidence in this candidate                                                                                                                                                                 | Limit                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64, Node 26.8.1 / npm 11.19.0                 | Local manager validation, generated Mac/Windows-layout fixtures, installed-package MCP sessions and Chromium Apps interactions                                                             | Exact final command results are recorded in [the ledger](implementation-status.md)                                                                   |
| Windows, Node 22.13.0 and 24                           | Native Windows CI matrix; Windows setup entries run npm JavaScript through absolute `node.exe`; original synthetic case-varied/renamed Windows projects are exercised by integration tests | Windows CI is configured, not executed by the local macOS session; live Windows Scrivener behavior is unverified here                                |
| Linux, Node 22.13.0 and 24                             | CI matrix, portable XML/RTF/SQLite/export paths                                                                                                                                            | No native Scrivener process integration; native-app detection is ambiguous and writes need explicit acknowledgment                                   |
| macOS, Node 22.13.0 and 24                             | CI matrix and private-runtime installer path                                                                                                                                               | These CI executions are not claimed as local measurements                                                                                            |
| Node below 22.13.0                                     | Rejected by package/setup requirements                                                                                                                                                     | The supported runtime policy starts at 22.13, above the dependency minimums; Node 18/20 are outside the current test matrix                          |
| MCP core SDK 1.32.1 / 1.32.2, Apps protocol 2026-01-26 | Installed-package sessions negotiate Apps and resource metadata; a plain client receives useful text/structured data                                                                       | Individual commercial hosts may implement different extension versions; their visual integration is not certified by the simulated-host browser test |

The repository's full final gate includes formatting, lint, type checking, build,
registry/output/HMS checks, all Jest suites and npm audit. Additional release checks install a local
tarball into an isolated consumer, exercise real MCP calls, drive the dashboard in Chromium, and
validate generated ebooks with W3C EPUBCheck. No external publication, deployment or real client
reconfiguration is part of these checks.

## Format and fidelity coverage

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
