# XML and plain-text save regression

The previous loader used `mergeAttrs: true` and passed that flattened object to
the default xml2js builder. A load/save converted `UUID="..."` into a `<UUID>`
child element. The result could be well-formed XML while losing the native
Scrivener representation. The same conversion affected project identity,
timestamps, section types, and unknown metadata attributes.

The loader now preserves xml2js's `$` maps. Non-enumerable accessors retain the
direct field access used by document services and update the underlying
attribute values. Serialization retains attributes on loaded nodes and encodes
the known attributes of newly created binder items. JSON export/import retains
the maps and restores accessors on import. An attribute and child with the same
name remain separate. This preserves the parsed XML structure; byte-identical
formatting, comments, and processing instructions are not promised.

A separate RTF writer bug discarded `plainText` when a content object had an
empty `formattedText` array, the representation used by DocumentManager. The
writer now uses `plainText` in that case and retains formatted segments when
present.

## Verification

Before the fixes, all five new regression tests failed, including an unchanged
load/save and a Korean body that read back as empty. After the fixes, the five
new tests plus ten neighboring tests passed. They cover repeated saves, unknown
metadata, same-name attributes/children, title updates, new binder items,
JSON import/export, Unicode, formatting, and empty content.

Run the focused checks:

```sh
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/unit/services/project-loader-roundtrip.test.ts tests/unit/services/parsers/rtf-handler-plaintext.test.ts tests/unit/services/project-loader-paths.test.ts tests/unit/services/parsers/rtf-handler-unicode.test.ts tests/unit/services/document-manager-recursion.test.ts
```

For an actual stdio MCP write/read check, build first and run:

```sh
npm run build
node scripts/check-save-roundtrip.mjs
```

The script copies the sample project into a fresh temporary directory. An
optional `.scriv` directory argument selects a different source to copy. It
checks an unchanged save, creates a Korean document through MCP, waits for the
existing body-write queue, reloads and reads it, and compares all pre-existing
XML nodes. It leaves the copy and a `verification.json` report for inspection in
Scrivener. It does not modify the source project. `save_project` is not an
exposed MCP tool; unchanged saves are checked through ProjectLoader, and the
MCP `create_document` call exercises the public save path.

## Windows verification limits

On Node 24.18.0, type checking, lint, formatting, build, and the 57-tool registry
check passed. The full Jest run passed 609 tests, skipped 10, and failed 12.
The exact same 12 path-separator assertions failed on the unmodified base
commit `2b5e678`. Two integration suites also failed during cleanup because
SQLite files remained locked, on both the base and the patched code. Jest
required `--forceExit` after results because of remaining open handles.

The output-conformance harness passed its exercised tool responses but could
not complete its Windows temporary-directory cleanup; it also skipped a
writing-goals check whose sample document had no RTF file. These checks are not
reported as a fully green suite. Folder insertion behavior, queued-write
latency, and database shutdown are outside this focused serialization fix.
