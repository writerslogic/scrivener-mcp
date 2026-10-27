# Editorial workflows

Open a project with `open_project`. Use `list_skills` and `use_skill` to discover tools; the server also activates a tool group when called directly. Close the project in Scrivener before applying manuscript edits. The server reads saved files, not unsaved Scrivener buffers, and cannot guarantee safe simultaneous writing with the native app.

## Preview and approve changes

`manuscript_dashboard` shows binder navigation, scene context, character appearances, pacing measurements and unresolved findings. Clients supporting MCP Apps display an interactive view; other clients receive text and structured results. Its review controls call the same `review_changes` operations as tools.

Use a source revision and UTF-16 offsets from the selected saved manuscript context when proposing replacements. Replace the example identifiers with values returned by your session:

```js
review_changes({
  action: "propose",
  documentId: "<document UUID>",
  expectedRevision: "<saved revision>",
  edits: [{ start: 0, end: 3, text: "The" }],
  idempotencyKey: "chapter-one-opening-v1"
})
review_changes({ action: "preview", proposalId: "<proposal UUID>" })
```

Proposals persist without changing manuscript text. Preview returns before/after text and formatting risks. Supply `editIds` to preview, apply or reject selected edits; omitting them selects pending edits. Applying uses native snapshots and the existing formatting-preserving editor. If preview reports loss, inspect it before explicitly setting `allowFormattingLoss: true`.

```js
review_changes({ action: "apply", proposalId: "<proposal UUID>", editIds: ["<edit UUID>"] })
review_changes({ action: "reject", proposalId: "<proposal UUID>", editIds: ["<edit UUID>"] })
review_changes({ action: "undo", operationId: "<application UUID>" })
```

Use `batch` with `proposalIds` for multiple applications, `list` to inspect durable review state, and `recover` to inspect/recover interrupted applications. Retain operation identifiers when retrying. Batch progress is recoverable; it is not one atomic filesystem transaction. Changed saved revisions stop stale applications and undo instead of overwriting newer work. `force` only overrides native-app detection; it does not override revisions or another server's mutation reservation. Ambiguous native detection requires an explicit decision.

## Find passages locally

```js
search_passages({ query: "betrayal", mode: "semantic", limit: 5 })
search_passages({ query: "Mara", mode: "keyword", contextChars: 400 })
```

`search_passages` needs no provider key. Hybrid mode combines BM25 keyword ranking, a bounded encoder covering 30 English story concepts and existing HMS text vectors. Semantic mode compares those concept vectors and can retrieve supported paraphrases with no shared query words. This is not a general multilingual embedding model: use keyword mode for names, specialist terms and unsupported concepts. Each response discloses its method and limitations.

Results contain exact quotations, surrounding context, document identity, binder path, line, UTF-16 offsets and the saved RTF revision. Changed documents update incrementally. Optional provider-backed interpretation or prose explanations are separate capabilities; they are unnecessary for this local search. Manuscript passages returned to an AI client are subject to that client's privacy and billing policies.

## Audit continuity with evidence

```js
check_consistency({ documentIds: ["<scene UUID>"] })
continuity_findings({ action: "list" })
continuity_findings({ action: "dismiss", findingId: "<finding id>", note: "Intentional unreliable narrator" })
continuity_findings({ action: "recheck", findingId: "<finding id>" })
```

Findings quote their supporting passages and retain document identities, source revisions, binder order and review state. Local automatic extraction covers explicit eye color, hair color and birth-year statements; other comparisons use curated facts. Narrative candidates remain inferred. Keyword counts, absent character mentions and mixed time words do not establish contradictions. Binder order is not assumed to be story chronology. Explicit story-time metadata, flashbacks and intentional variations affect comparisons; read the report's coverage statement.

`confirm` records that the author accepts a finding as a concern; it does not promote its underlying candidates to canon. `dismiss` preserves an intentional exception, `resolve` records a completed decision, and `recheck` reruns analysis and checks saved source revisions. Changed evidence remains identifiable as stale; obsolete concerns are resolved without erasing their history.

## Curate a project or series bible

Use `manage_series` with `action: "create"` and a name to create a series containing the open project. Open another intended project and explicitly `join` the returned `seriesId`. `list` shows memberships; `leave` removes the current project. Unjoined projects do not contribute facts automatically.

Every `story_bible` request supplies `scope: { kind: "project", id: "<project id>" }` or `scope: { kind: "series", id: "<series id>" }`. `curate` stores characters, aliases, locations, world rules or chronology. Confirmed facts require verified source passages: copy identity, revision, location and quote fields from actual source results. For aliases, use the canonical name as `subject`, `predicate: "alias"` and the alternate name as `value`.

Use `correct` with `factId` and a `patch` to retain the previous fact and provenance. `list` can include superseded facts; `recheck` reports current, stale or unavailable sources. `import_memory` extends the existing character, world and plot memory into current-project candidates; source-free imported entries remain inferred. To include shared canon in an audit, pass its explicit `seriesId` to `check_consistency`.

## Run a guided workflow

```js
editorial_workflow({ action: "start", kind: "review-chapter", rootFolderId: "<chapter UUID>", idempotencyKey: "chapter-one-review-v1" })
editorial_workflow({ action: "start", kind: "audit-continuity" })
editorial_workflow({ action: "start", kind: "beta-reader-draft" })
editorial_workflow({ action: "get", workflowId: "<workflow id>" })
editorial_workflow({ action: "cancel", workflowId: "<workflow id>" })
editorial_workflow({ action: "resume", workflowId: "<workflow id>" })
```

Chapter review requires explicit document or folder scope. It combines local prose analysis with proposed mechanical spacing edits; suggestions do not silently rewrite the chapter. Continuity audits reuse evidence services. Beta-reader preparation analyzes the selected manuscript and exports a draft. Use `export_manuscript` for export preflight and explicit warning acknowledgment when unsupported constructs need attention.

Status includes scope, saved revisions, completed step results, progress and usage. These workflows make no provider requests: their server-side provider estimate and charge are zero; client chat costs are outside that estimate. Cancellation stops remaining work after the active step finishes and does not undo completed proposals or exports. Restart/resume retains completed checkpoints, uses stable operation identifiers for retried proposals/exports, and rejects changed source revisions. An active or ambiguous owner blocks another instance from resuming the same workflow. Inspect failed steps before resuming; do not blindly create a replacement run with a new request key.
