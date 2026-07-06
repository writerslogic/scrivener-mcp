# The Scrivener `.scriv` format, as scrivener-mcp understands it

Literature & Latte publish no formal specification for the Scrivener 3 project
format. Everything here is **reverse-engineered** from real projects and reflects
what this codebase actually parses (`src/services/project-loader.ts`,
`src/services/document-manager.ts`, `src/services/parsers/rtf-handler.ts`,
`src/services/compile-settings.ts`, `src/utils/scrivener-utils.ts`). It is a
working reference and a statement of risk, not an authority. Where we infer
rather than know, it says so.

This document exists to support
[issue #40](https://github.com/writerslogic/scrivener-mcp/issues/40) — an open
request for an official format spec and stability guarantees. We would gladly
align this with any published guidance.

## Package layout

A `.scriv` "project" is a **directory** (a macOS package; an ordinary folder
elsewhere). Observed top-level contents of a Scrivener 3 project:

```
<name>.scriv/
├── <name>.scrivx        # XML manifest: binder tree + project settings
├── Files/
│   ├── Data/
│   │   └── <UUID>/
│   │       ├── content.rtf   # the document's text (RTF)
│   │       ├── synopsis.txt  # index-card synopsis (optional)
│   │       └── notes.rtf     # document notes (optional)
│   ├── binder.autosave  # Scrivener's autosave copy of the binder
│   ├── search.indexes   # Scrivener's full-text index
│   ├── styles.xml       # paragraph/character styles
│   └── version.txt      # format/app version marker
├── Settings/
│   ├── compile.xml      # compile-format definitions (see below)
│   ├── ui-common.xml, ui.plist, recents.txt, favorites.xml, ...
├── QuickLook/           # macOS preview thumbnail
```

Some projects (notably iOS-synced ones) additionally carry a `docs.checksum`
file used to detect external tampering. **We neither read nor maintain it** —
see *Risks* below.

> `scrivener.db/` appearing inside a project directory is **created by
> scrivener-mcp**, not by Scrivener. It is this server's SQLite cache and is not
> part of the Scrivener format.

## The `.scrivx` manifest

Parsed with `xml2js` (`explicitArray: false, mergeAttrs: true`), so XML
attributes and child elements land as sibling keys and element text lands on `_`.

The root carries project identity as attributes:

```xml
<ScrivenerProject Identifier="…" Version="2.0" Creator="SCRMAC-3.4-16639"
                  Device="…" Author="…" Modified="…" ModID="…">
```

`Version="2.0"` denotes the **Scrivener 3** on-disk format (not app version 2 —
see the version note below). Elements we read:

| Path | Meaning | We |
|------|---------|-----|
| `Binder` → `BinderItem` (recursive via `Children`) | The folder/document tree | read + write |
| `BinderItem[@UUID]` | Stable document id; names `Files/Data/<UUID>/` | read + write |
| `BinderItem[@Type]` | `DraftFolder`, `Text`, `Folder`, `TrashFolder`, … | read |
| `BinderItem` → `Title` | Display title | read + write |
| `BinderItem` → `MetaData` → `IncludeInCompile`, `Label`, `Status`, `Synopsis`, `Notes`, `Keywords`, `Created`, `Modified`, `CustomMetaData` | Per-item metadata | read + write |
| `ProjectSettings` → `ProjectTitle`, `FullName`/`Author` | Project identity | read |
| `ProjectTargets` → `DraftTarget`, `SessionTarget`, `Deadline` | Word-count goals | read |
| `LabelSettings` → `Labels` → `Label[@ID,@Color]` | Label definitions + colors | read (`get_compile_settings`) |
| `StatusSettings` → `StatusItems` → `Status[@ID]` | Status definitions (no color) | read |
| `Collections` → `Collection[@Type,@ID,@Color]` → `Title` | Saved collections/searches | read |
| `SectionTypes` → `TypeDefinitions` → `Type[@ID]` | User-defined section types | read |

**Colors** are stored as normalized-RGB triples, space-separated, each channel in
`0..1` (e.g. `0.993495 0.701207 0.732587`). `get_compile_settings` returns both
the raw string and a `#RRGGBB` conversion (`scrivColorToHex`).

Fields present in real `.scrivx` files that we **do not** currently interpret:
snapshots, per-item `TextSettings`, revision markers, and the trash's internal
ordering beyond identifying the `TrashFolder`/`SearchResults` container.

## Document content: `Files/Data/<UUID>/content.rtf`

Each `BinderItem` of type `Text` maps to `Files/Data/<UUID>/content.rtf`
(`getDocumentPath`). This is the **Scrivener 3 layout**; Scrivener 2 used numeric
ids under `Files/Docs/<n>.rtf` and is not parsed (see the compatibility matrix).

### RTF dialect

Scrivener writes a specific RTF subset. What our handler
(`src/services/parsers/rtf-handler.ts`) knows about it:

- **Unicode fallback count.** Genuine Scrivener files use `\uc0` (no fallback
  characters after a `\u…` escape). We read the header's `\uc<n>` and honor it;
  assuming the RTF default of `\uc1` would silently drop the character following
  each Unicode escape. This is the single most fragile RTF detail.
- **Typographic entities.** `\ldblquote`/`\rdblquote` → `“`/`”`, `\endash` → `–`,
  `\emdash` → `—`, and back again on write.
- **Annotations.** Scrivener inline annotations/comments are detected and
  preserved (`preserveScrivenerAnnotations`), across more than one annotation
  encoding.
- **Generation.** We emit `{\rtf1\ansi\deff0\uc1 …}` with a
  `{\*\generator …}` marker. Our output is **not** guaranteed byte-identical to
  Scrivener's own writer — it aims to be semantically equivalent and to round-trip
  the text and the metadata we track, not to reproduce every control word.

## `Settings/compile.xml`

Root `<CompileSettings>`. `get_compile_settings` exposes a read-only summary
(`src/services/compile-settings.ts`); it does **not** re-implement compilation.

| Path | Exposed as |
|------|-----------|
| `CurrentFileType` | `currentFileType` (e.g. `pdf`) |
| `ProjectSettings` → `Options` → `RemoveComments`, `RemoveAnnotations` | `options.*` (booleans) |
| `FormatSettings` → `Format[@ID]` | one `compileFormats[]` entry per format |
| `Format` → `Font` | `compileFormats[].font` |
| `Format` → `SectionLayouts` → `Type[]` | `compileFormats[].sectionLayoutCount` |
| `Format` → `FrontAndBackMatter` | `compileFormats[].hasFrontMatter` |

Everything below `Options` (PDF/Ebook/Scriptwriting sub-trees) and the exact
section-layout → format mapping is present in the file but **not surfaced** — it
is deeply undocumented and version-specific.

## Version and platform notes

- **Format version.** The `.scrivx` root `Version="2.0"` is the format revision
  used by Scrivener **3** on macOS, Windows, and iOS. `Creator` (e.g.
  `SCRMAC-3.4-…`) records the authoring app build.
- **Scrivener 2 and earlier.** Numeric-id `Files/Docs/<n>.rtf` layouts, and the
  older Mac `.scrivproj` binary-plist manifest (`bplist00` signature), are **not
  parsed**. Upgrade in Scrivener 3 first.
- **Cross-platform.** The on-disk format is identical across platforms; only path
  handling differs.

## Risks and stability posture

The reason this document is also a risk statement:

1. **No spec, so no guarantees.** Any Scrivener point release can add, rename, or
   restructure elements. We read defensively (missing/renamed/array-vs-single all
   degrade to empty rather than throwing), but new *required* structure could
   still break assumptions.
2. **Inferred fields.** Compile section-layout semantics, snapshots, and revision
   metadata are guessed from context or ignored. We do not write them.
3. **Write safety.** Before modifying a `.scrivx` we create a timestamped backup.
   We do **not** update `docs.checksum`, so on projects that carry one, Scrivener
   may flag externally-modified content. Prefer letting Scrivener re-open and
   re-save after external edits.
4. **RTF fidelity.** Our RTF writer round-trips text, basic styling, and tracked
   metadata — not every Scrivener control word. Inline images, tables, footnotes,
   and revision marks are not guaranteed to survive a write cycle byte-for-byte.

### Safe-modification guidance (what third-party tools should assume)

- Treat `UUID`s as immutable identity; never renumber or reuse them.
- Never write a document whose `BinderItem` you cannot find in the binder.
- Back up the whole `.scriv` package (not just `.scrivx`) before batch edits.
- After external modification, expect the user to re-open in Scrivener so it can
  rebuild `search.indexes`, `binder.autosave`, and any checksum.
- Do not depend on undocumented sub-trees (compile layout internals, UI settings)
  surviving a Scrivener upgrade.

## What would make this unnecessary

A published `.scrivx` schema, a description of the `Files/Data` naming and the
`Settings/` contents, guidance on which fields third-party tools may safely
change, and a few edge-case test projects (annotations, footnotes, inline
images, revisions) would let this and every other integration drop the
guesswork. We're happy to collaborate on such a spec.
