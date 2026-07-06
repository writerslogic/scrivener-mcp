# Scrivener Compatibility Matrix

What scrivener-mcp reads and writes, and which Scrivener versions and platforms
it supports. This reflects the actual parser behaviour in `src/services/project-loader.ts`,
`src/services/document-manager.ts`, and `src/utils/scrivener-utils.ts` — not an
aspiration. If you hit a project that doesn't load, please open an issue with the
(redacted) `.scrivx` structure.

## Supported format

scrivener-mcp targets the **Scrivener 3** project format:

- A `.scriv` package (a folder) containing a single `<name>.scrivx` XML manifest.
- A `<ScrivenerProject>` root with a `<Binder>` of `<BinderItem>` nodes, each
  identified by a **UUID** (`UUID` attribute; validated with `isValidUUID`).
- Document text stored as RTF at `Files/Data/<UUID>/content.rtf`.

You can open a project by passing either the `.scriv` folder or the `.scrivx`
file to `open_project`; the `.scrivx` is auto-discovered inside a `.scriv` folder.

## Version matrix

| Scrivener version | Project layout | Status | Notes |
|-------------------|----------------|--------|-------|
| **Scrivener 3** (macOS / Windows / iOS-authored) | `.scrivx` + UUID `Files/Data/<uuid>/content.rtf` | **Supported** | Primary target; binder, metadata, synopsis, notes, keywords, labels/status (as text), and RTF content are read/written. |
| **Scrivener 2** | `.scrivx` + numeric doc IDs under `Files/Docs/<n>.rtf` | **Not supported** | The numeric-ID/`Files/Docs` layout is not parsed. Loading a Scrivener 2 project will fail or find no documents. Tracked as a contribution opportunity (see below). |
| **Scrivener 1 / iOS-only formats** | — | **Not supported** | No parser. |

To migrate a Scrivener 2 project, open and re-save it in Scrivener 3 first
(Scrivener performs the format upgrade), then point scrivener-mcp at the upgraded
`.scriv`.

## Platform matrix (Scrivener 3)

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Supported | Primary development/test platform. |
| Windows | Supported | Full path handling and `.scrivx` discovery; less heavily tested than macOS. |
| Linux | Supported | The format is identical; there's no native Scrivener on Linux, but `.scriv` packages authored elsewhere load fine. |

## Feature coverage (Scrivener 3)

| Area | Read | Write | Notes |
|------|------|-------|-------|
| Binder structure (folders/documents, order, nesting) | ✅ | ✅ | |
| Document RTF content | ✅ | ✅ | via the RTF handler |
| Synopsis, notes, keywords | ✅ | ✅ | |
| Label / status | ✅ | ✅ | Colors surfaced (raw + hex) via `get_compile_settings`. |
| Collections | ✅ | ➖ | Read-only via `get_compile_settings` (id, title, type, color). |
| Compile format settings | ✅ | ➖ | Read-only via `get_compile_settings` (formats, section-layout counts, front matter, options). Not applied during compile. |
| Section types | ✅ | ➖ | Read-only via `get_compile_settings`. |
| Snapshots | ➖ | ➖ | Not yet exposed. |
| Project/manuscript export (Markdown, HTML, JSON) | — | ✅ | Inline. |
| Project/manuscript export (DOCX, EPUB, PDF) | — | ✅ | Written to disk via `export_project` — see issue #37. |

For the on-disk format itself — element and file layout, what we read vs. infer,
the RTF dialect, and safe-modification guidance — see
[`scrivener-format.md`](./scrivener-format.md).

## No stability guarantee

The `.scriv` format is reverse-engineered from real projects; Literature & Latte
publish no formal specification. scrivener-mcp always operates on the on-disk
package and creates a timestamped backup of the `.scrivx` before writing. Treat
it as best-effort across Scrivener point releases, and keep your own backups.

## Helping with Scrivener 2

Scrivener 2 support would mean detecting the legacy layout (numeric document IDs,
`Files/Docs/<n>.rtf`, the older `.scrivx` schema) and mapping it onto the same
binder/document model. If you have Scrivener 2 projects to test against, this is
a welcome contribution — see issues #39 and #40.
