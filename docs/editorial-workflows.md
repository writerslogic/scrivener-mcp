# Editorial workflows

Open a project with `open_project`. Use `list_skills` and `use_skill` to discover tools; the server
also activates a tool group when called directly. Close the project in Scrivener before applying
manuscript edits. The server reads saved files, not unsaved Scrivener buffers, and cannot guarantee
safe simultaneous writing with the native app.

## Preview and approve changes

`manuscript_dashboard` shows binder navigation, scene context, character appearances, pacing
measurements and unresolved findings. Clients supporting MCP Apps display an interactive view; other
clients receive text and structured results. Its review controls call the same `review_changes`
operations as tools.

Use a source revision and UTF-16 offsets from the selected saved manuscript context when proposing
replacements. Replace the example identifiers with values returned by your session:

```js
review_changes({
	action: 'propose',
	documentId: '<document UUID>',
	expectedRevision: '<saved revision>',
	edits: [{ start: 0, end: 3, text: 'The' }],
	idempotencyKey: 'chapter-one-opening-v1',
});
review_changes({ action: 'preview', proposalId: '<proposal UUID>' });
```

Proposals persist without changing manuscript text. Preview returns before/after text and formatting
risks. Supply `editIds` to preview, apply or reject selected edits; omitting them selects pending
edits. Applying uses native snapshots and the existing formatting-preserving editor. If preview
reports loss, inspect it before explicitly setting `allowFormattingLoss: true`.

```js
review_changes({ action: 'apply', proposalId: '<proposal UUID>', editIds: ['<edit UUID>'] });
review_changes({ action: 'reject', proposalId: '<proposal UUID>', editIds: ['<edit UUID>'] });
review_changes({ action: 'undo', operationId: '<application UUID>' });
```

Use `batch` with `proposalIds` for multiple applications, `list` to page through durable review summaries,
and `recover` to inspect/recover interrupted applications. Retain operation identifiers when
retrying. Batch progress is recoverable; it is not one atomic filesystem transaction. Changed saved
revisions stop stale applications and undo instead of overwriting newer work. `force` only overrides
native-app detection; it does not override revisions or another server's mutation reservation.
Ambiguous native detection requires an explicit decision. Proposals whose saved preimage no longer
matches the current text interpretation are rejected even if the raw revision is unchanged; recreate
them from refreshed context after a parser upgrade.

History pages default to 20 items and accept `limit` from 1–100. `review_changes` returns independent
`pagination.proposals`, `.applications` and `.batches` cursors; pass them as `proposalsAfter`,
`applicationsAfter` and `batchesAfter`. List summaries omit manuscript text and edits; use
`review_changes({action: 'get', proposalId: '<UUID>'})` for one full proposal. Workflow lists omit
scope/step payloads; use `get` for those. `editorial_workflow` and `continuity_findings` accept `after`
and return `nextCursor`. A null cursor ends that collection. Pages use stable ID order, rather than
claiming chronological ordering; newly inserted lower IDs appear after restarting pagination.
The dashboard pages histories separately from scenes and loads proposal details on demand.

## Find passages locally

```js
search_passages({ query: 'betrayal', mode: 'semantic', limit: 5 });
search_passages({ query: 'Mara', mode: 'keyword', contextChars: 400 });
```

`search_passages` needs no provider key. Hybrid mode combines BM25 keyword ranking, a bounded
encoder covering 30 English story concepts and existing HMS text vectors. Semantic mode compares
those concept vectors and can retrieve supported paraphrases with no shared query words. This is not
a general multilingual embedding model: use keyword mode for names, specialist terms and unsupported
concepts. Each response discloses its method and limitations.

Results contain exact quotations, surrounding context, document identity, binder path, line, UTF-16
offsets and the saved RTF revision. Changed documents update incrementally. Optional provider-backed
interpretation or prose explanations are separate capabilities; they are unnecessary for this local
search. `search` uses literal matching across the full active binder, including research and excluded
drafts; `search_passages` and `semantic_search` use the compilable manuscript. Manuscript passages returned to an AI client are subject to that client's privacy and
billing policies.

## Audit continuity with evidence

```js
check_consistency({ documentIds: ['<scene UUID>'] });
continuity_findings({ action: 'list' });
continuity_findings({
	action: 'dismiss',
	findingId: '<finding id>',
	note: 'Intentional unreliable narrator',
});
continuity_findings({ action: 'recheck', findingId: '<finding id>' });
```

Findings quote their supporting passages and retain document identities, source revisions, binder
order and review state. Local automatic extraction covers explicit eye color, hair color and
birth-year statements; other comparisons use curated facts. Narrative candidates remain inferred.
Keyword counts, absent character mentions and mixed time words do not establish contradictions.
`check_plot_consistency` uses this same service for synchronous and background requests. Supply
saved document IDs; optional supplied text must match the saved manuscript. Queued checks bind to
source revisions and fail if those revisions change before execution. Their results retain the same
quoted evidence and uncertainty as synchronous analysis.

Binder order is not assumed to be story chronology. Explicit story-time metadata, flashbacks and
intentional variations affect comparisons; read the report's coverage statement.

`confirm` records that the author accepts a finding as a concern; it does not promote its underlying
candidates to canon. `dismiss` preserves an intentional exception, `resolve` records a completed
decision, and `recheck` reruns analysis and checks saved source revisions. Changed evidence remains
identifiable as stale; obsolete concerns are resolved without erasing their history.

## Curate a project or series bible

Use `manage_series` with `action: "create"` and a name to create a series containing the open
project. Open another intended project and explicitly `join` the returned `seriesId`. `list` shows
memberships; `leave` removes the current project. Unjoined projects do not contribute facts
automatically.

Every `story_bible` request supplies `scope: { kind: "project", id: "<project id>" }` or
`scope: { kind: "series", id: "<series id>" }`. `curate` stores characters, aliases, locations,
world rules or chronology. Confirmed facts require verified source passages: copy identity,
revision, location and quote fields from actual source results. For aliases, use the canonical name
as `subject`, `predicate: "alias"` and the alternate name as `value`.

Use `correct` with `factId` and a `patch` to retain the previous fact and provenance. `list` can
include superseded facts; `recheck` reports current, stale or unavailable sources. `import_memory`
extends the existing character, world and plot memory into current-project candidates; source-free
imported entries remain inferred. To include shared canon in an audit, pass its explicit `seriesId`
to `check_consistency`.

## Run a guided workflow

```js
editorial_workflow({
	action: 'start',
	kind: 'review-chapter',
	rootFolderId: '<chapter UUID>',
	idempotencyKey: 'chapter-one-review-v1',
});
editorial_workflow({ action: 'start', kind: 'audit-continuity' });
editorial_workflow({ action: 'start', kind: 'beta-reader-draft' });
editorial_workflow({ action: 'get', workflowId: '<workflow id>' });
editorial_workflow({ action: 'cancel', workflowId: '<workflow id>' });
editorial_workflow({ action: 'resume', workflowId: '<workflow id>' });
```

Chapter review requires explicit document or folder scope. It combines local prose analysis with
proposed mechanical spacing edits; suggestions do not silently rewrite the chapter. Continuity
audits reuse evidence services. Beta-reader preparation analyzes the selected manuscript and exports
a draft. If its export step reports unsupported constructs, inspect the returned preflight findings
and resume the same workflow with `allowExportWarnings: true` to acknowledge them. Completed
analysis steps are retained. Omit that option on later resumes to retain the prior decision.
`export_manuscript` also provides standalone preflight and export controls.

Status includes scope, saved revisions, completed step results, progress and usage. These workflows
make no provider requests: their server-side provider estimate and charge are zero; client chat
costs are outside that estimate. Cancellation stops remaining work after the active step finishes
and does not undo completed proposals or exports. Restart/resume retains completed checkpoints, uses
stable operation identifiers for retried proposals/exports, and rejects changed source revisions. An
active or ambiguous owner blocks another instance from resuming the same workflow. Inspect failed
steps before resuming; do not blindly create a replacement run with a new request key.


## Retrieve large results and inspect queues

Large `compile_documents` responses include `resultId`. Call
`read_result({resultId: '<id>', offset: 0, limit: 16384})`, concatenate the returned `text`, and
continue with `nextOffset` until it is null. Offsets count UTF-8 bytes; follow returned offsets to
avoid splitting characters. The reconstructed value is JSON containing `compiledText`. No local
filesystem tool is required. Results are private to the server instance, expire after one hour or a
restart, and may be evicted when its 256-result/64 MiB spool budget is reached. Chunk limits are
4–65,536 bytes. A missing result requires repeating the original read operation.

`get_queue_stats` reports backend and scope. Redis/KeyDB queues and embedded history use the
canonical project path and durable project UUID; overlapping document IDs in unrelated projects do
not share jobs. Copied projects at different paths are isolated. Status/cancel requests reject
foreign job IDs, and processors reject legacy or foreign envelopes before analysis/database work.
Embedded jobs run immediately; nonzero priorities or delays require Redis/KeyDB and are rejected
rather than silently ignored.

Older unscoped queue keys and embedded records are retained but excluded from processing, status
and cancellation. Do not relabel them automatically: ownership cannot be inferred safely. Inspect
and retain the previous installation's records, verify the owning project, and deliberately
resubmit unfinished work under that project. Moving a project changes its queue scope too; old
history remains in its original scope. No automatic cross-project or move migration is performed.
