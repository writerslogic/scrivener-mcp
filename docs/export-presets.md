# Manuscript export presets

`export_manuscript` extends the existing exporters. It defaults to a read-only preflight. Exports
follow the Draft/Manuscript binder order and `IncludeInCompile`, rather than exporting research and
trash. Explicit `documentIds` narrow the text scope; `frontMatterIds` prepend selected active text
documents in the supplied order.

| Preset                  | Output | Applied layout                                                                                                                                    |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submission-manuscript` | DOCX   | US Letter, one-inch margins, 12pt Times New Roman, double-spaced body, half-inch first-line indent, title/author, running header and page numbers |
| `beta-reader`           | DOCX   | US Letter, one-inch margins, 12pt Calibri, 1.5-spaced body, readable paragraph spacing, title/author, header and page numbers                     |
| `ebook`                 | EPUB 3 | Reflowable serif body, navigation, Unicode text, hierarchical headings and restrained paragraph styling                                           |

```js
export_manuscript({ preset: 'submission-manuscript' });
export_manuscript({ action: 'export', preset: 'submission-manuscript' });
export_manuscript({ preset: 'beta-reader', includeAnnotations: true });
export_manuscript({ action: 'export', preset: 'ebook', outputPath: '/path/to/book.epub' });
```

Chapter/part/scene section types and binder hierarchy determine headings, chapter page breaks and
scene separators. Bold, italic, underline and strikethrough are mapped when the existing RTF
parser's formatting runs align exactly with the source text. Otherwise preflight reports a
body-style fallback. Front matter is explicit; the server does not discover hidden native
compile-format rules.

Supported `Scrv_fn`, `Scrv_annot`, `Scrv_comm` and `Scrv_inl` marker ranges are removed from the
prose body. Footnote text is retained as labeled scene-end notes. Editorial annotations/comments are
included there only with `includeAnnotations: true`. This moves anchors and produces a preflight
warning. Native RTF `footnote` anchors, images, objects, tables and fields are reported as
unsupported or reduced constructs. Acknowledging a warning with `allowWarnings: true` is required
before export; review its actual effect first. The source manuscript is never changed.

Default files are placed in `.scrivener-mcp/exports`. Explicit destinations must match the output
extension and cannot write into protected Scrivener project data, including through a directory
symlink. Export failures propagate instead of silently omitting unreadable scenes.

Generated DOCX files are checked for ZIP integrity, OOXML document/content-type/style syntax. EPUB
checks cover ZIP CRC, the first stored mimetype entry, container/package XML, metadata, manifest
resources, spine references and XHTML syntax. These are structural checks, not a complete EPUB
accessibility or reading-system certification. Release verification additionally runs
[W3C EPUBCheck](https://www.w3.org/publishing/epubcheck/); exact results belong in
[the implementation ledger](implementation-status.md).

These presets do not promise equivalence to Scrivener's undocumented native compile engine. Use
native compile when precise custom layouts, image placement or anchored notes are essential. The
existing PDF exporter remains available through `export_project`; its standard fonts normalize or
omit characters outside WinAnsi, so use DOCX/EPUB when Unicode fidelity matters.
