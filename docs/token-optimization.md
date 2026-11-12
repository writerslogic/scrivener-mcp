# Token Optimization

Scrivener projects can be massive -- hundreds of documents, deeply nested binders, and chapters exceeding 10,000 words. Without optimization, a single tool call could consume the entire context window. The server supports bounded reads and compact responses while preserving access to the full source. Actual token cost depends on the tokenizer, protocol, client and requested detail.

## Skill-Based Registration

Tools are grouped into skills (`project`, `documents`, `search`, `analysis`, `compilation`, `memory`, `relationships`, `credentials`, `advanced`). MCP 2026-07-28 connections list every tool at once. On earlier protocol versions the server uses **progressive disclosure** by default: only the `project` group and the `list_skills`/`use_skill`/`read_result` meta-tools register at startup, and the rest activate on demand:

| Trigger | Skills activated |
|---------|-----------------|
| `open_project` (automatic) | `documents`, `search`, `memory` |
| `use_skill("analysis")` | Document analysis, consistency checks, writing goals and preferences |
| `use_skill("compilation")` | Manuscript compile and export |
| `use_skill("memory")` | Project memory (`remember`, `recall`) |
| `use_skill("relationships")` | Character network and entity relationships |
| `list_skills` | Lists all groups and their activation status |

Legacy activation limits the initial catalog; clients may include every discovered definition on subsequent turns. Modern discovery returns the complete stable catalog. Client caching and prompt construction determine the actual model overhead. Set `SCRIVENER_MCP_EAGER_TOOLS=1` to instead register the full set at startup — useful for registries, inspectors, and clients that do not honor `notifications/tools/list_changed` (the Docker image sets this by default).

## Compact Responses

Response policies include:

- **Minified JSON:** Responses omit indentation while preserving nulls, empty arrays/objects and array positions. Explicit unavailable values retain their meaning.
- **Search snippets:** `search` returns short context snippets around each match, not full document text. Follow up with `read_document` for the complete content.
- **Analysis summaries:** `analyze_document` returns a summary with the top 3 issues rather than a full metrics blob. This keeps analysis results actionable without overwhelming the context.
- **Large payload spill:** Compiled manuscripts, completed background-job results and other payloads exceeding 4,000 characters are written to a private temporary directory. Use `read_result` with the returned `_ref`, then follow `nextOffset` until null to reconstruct the original JSON; filesystem access is not required. Results expire after one hour, a server restart, or eviction from the 64 MiB/256-result cache. The read limit applies to UTF-8 chunk text; MCP serialization adds overhead.

## Sliding Window Reads

`read_document` supports word-based windowing via `offset` and `limit` parameters:

```
read first 1000 words:    offset=0,    limit=1000
continue reading:         offset=1000, limit=1000
skip to the end:          offset=9000, limit=1000
```

Offsets must be nonnegative safe integers; limits are 1–10000 words, and zero is rejected. Plain pages retain exact source whitespace and include `pagination.nextOffset`, UTF-16 source ranges and the saved revision. Follow `nextOffset` and require the same revision to combine pages. Formatted reads reject paging.

When no offset/limit is specified, the full document is returned. For typical scenes and chapters (under 5,000 words), this is fine. For long documents, explicitly request a bounded page. The server does not infer the client’s context budget.

## Flattened Structure

`get_structure` returns a compact flat array by default. Each entry is a tuple:

```json
[id, title, type, depth, wordCount, hasChildren]
```

For example:

```json
["ABC-123", "Chapter 1", "Text", 1, 3420, true]
```

Tuples avoid repeating field names; their token cost and readability tradeoffs depend on the actual binder and client. No fixed reduction is guaranteed.

To get the full nested tree (useful for programmatic traversal), pass `flat=false`:

```
get_structure(flat=false)
```

## Scaling to Large Binders

`get_structure` is tuned for large projects rather than paginating:

```
summaryOnly=true   counts only (documents, words) -- cheapest
maxDepth=1         top-level items only, then drill in
flat=true          compact [id, title, type, depth, wordCount, hasChildren] tuples (default)
```

Start with `summaryOnly` or a shallow `maxDepth`, then read specific documents by id. To locate a document without listing the whole binder, use `search` (with `field: "title"`) or `find_mentions` instead of walking the tree.

## Design Principles

These optimizations follow a few core principles:

1. **Choose the needed scope.** Request relevant documents and fields; modern discovery still advertises the complete stable catalog.
2. **Summaries first, details on demand.** Return compact overviews by default. The AI client can drill into specifics with follow-up calls.
3. **Spill large data to disk.** When a result would dominate the context window, write it to a file and return a reference. The data is still accessible but doesn't consume tokens unless explicitly read.
4. **Choose the needed structure.** Flat tuples reduce repeated keys; request nested objects when their explicit relationships are useful.

## Measurement

Run the local original-fixture workflow through real modern stdio, including discovery,
open, structure, paged read, propose, preview, apply, undo and close:

```sh
node scripts/measure-token-workflow.mjs --repo "$PWD" --output logs/token-workflow.json --scope-mode argument
uv run --with tiktoken==0.12.0 scripts/count-workflow-tokens.py logs/token-workflow.json logs/token-counts.json
```

The collector checks exact undo and records the source digest, fixture hash, client,
runtime and every request/response payload. Use `--scope-mode argument` for an ordinary
project handle on versions supporting it. Compare the same fixture and protocol against
an isolated baseline. The counter uses named `cl100k_base` and `o200k_base` encodings;
counts include complete JSON payloads and duplicated text/structured content, not actual
provider billing or a commercial host's prompt. Volatile IDs and durations can vary.
No token savings are claimed from the historical byte estimates or unmeasured examples.

The November 2026 local measurement used Node 26.12.1, MCP 2026-07-28, the SDK 2.4.0
stdio transport and tiktoken 0.12.0. Both workflows made ten calls and discovered 84 tools.
The baseline is the recorded pre-mission working tree, including its existing unpublished
features; it is not the clean audit commit. The candidate uses ordinary `projectHandle`
arguments instead of custom scope metadata. Exact undo passed in both runs.

| Complete serialized payloads | `cl100k_base` | `o200k_base` |
| --- | ---: | ---: |
| Baseline workflow | 76,685 | 77,611 |
| Candidate workflow | 78,677 | 79,610 |
| Baseline `tools/list` request and response | 71,720 | 72,602 |
| Candidate `tools/list` request and response | 73,617 | 74,492 |

Total measured tokens increased about 2.6%; these changes do not establish overall token
savings. Discovery accounts for about 94% of this tiny workflow. Factoring one repeated
analysis envelope into local schema references saved 749/763 catalog tokens relative to
the otherwise equivalent candidate schema; schema expansion and independent validation
check the same accepted outputs. Other scope and safety additions remain visible.

The [baseline payloads](benchmarks/token-workflow-baseline.json),
[candidate payloads](benchmarks/token-workflow-0.14.json) and corresponding
[baseline counts](benchmarks/token-workflow-baseline-counts.json) /
[candidate counts](benchmarks/token-workflow-0.14-counts.json) retain the exact data for
recounting with the command above. Source manifests identify the uncommitted states.
This is one original, small fixture with volatile IDs, paths and timings; it does not
measure model selection, client caching, novel-sized workflows or billed tokens.

Narrative report transport defaults to a 1 MiB serialized response budget, with an
explicit smaller-page option. Very small pages increase calls and can hit the documented
invocation rate budget; wait for the stated retry interval and keep the same revision-bound
report cursor. Do not discard pages to avoid the limit. The full report remains available
within its documented retention period.
