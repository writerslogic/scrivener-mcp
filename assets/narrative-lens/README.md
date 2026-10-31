# Narrative Lens annotation contract input

`annotations.schema.json` contains the 13 unmodified top-level contracts needed by the ten MCP
annotation modes. They are extracted from Narrative Lens `v0.2.0`, commit
`14b272f0e7f83ead97f37d8eeae9af7754c0abda`,
[`docs/standalone.schema.json`](https://github.com/writerslogic/narrative-lens/blob/14b272f0e7f83ead97f37d8eeae9af7754c0abda/docs/standalone.schema.json).
The original Apache-2.0 license is retained in `LICENSE`.

`provenance.json` records both hashes: `fullSha256` identifies the original upstream file;
`subsetSha256` identifies this subset. The generated TypeScript header continues to identify the
full upstream source. To reproduce the subset, parse the pinned full file, select the top-level keys
in `provenance.json`'s `contracts` order, and serialize that object with
`JSON.stringify(selected, null, 2) + '\n'`. Nested values and definitions remain unchanged.

The installed npm package omits the source schema. Vendoring the selected contracts makes both
commands independent of a sibling checkout, network access and the caller's working directory:

```sh
node scripts/generate-narrative-annotation-schema.mjs --check
node scripts/generate-narrative-annotation-schema.mjs
```

This bundle lives under `assets/narrative-lens` so its source, provenance and license are retained
in the published Scrivener MCP package.

The generator verifies the installed engine version and the source digest. An optional positional
source path accepts only the pinned original full file or this pinned subset. `--output FILE`
selects a destination; `--check` compares the project-formatted output without rewriting it. A
native version or contract update requires an explicit review of these pins and the generated
result.
