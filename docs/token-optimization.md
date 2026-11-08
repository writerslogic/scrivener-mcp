# Token Optimization

Scrivener projects can be massive -- hundreds of documents, deeply nested binders, and chapters exceeding 10,000 words. Without optimization, a single tool call could consume the entire context window. The scrivener-mcp server uses several strategies to keep token usage minimal while preserving full access to project data.

## Skill-Based Registration

Tools are grouped into skills (`project`, `documents`, `search`, `analysis`, `compilation`, `memory`, `relationships`, `credentials`, `advanced`). MCP 2026-07-28 connections list every tool at once. On earlier protocol versions the server uses **progressive disclosure** by default: only the `project` group and the `list_skills`/`use_skill`/`read_result` meta-tools register at startup (about 30 KB of serialized tool definitions instead of about 340 KB for all 82 tools), and the rest activate on demand:

| Trigger | Skills activated |
|---------|-----------------|
| `open_project` (automatic) | `documents`, `search` |
| `use_skill("analysis")` | Document analysis, consistency checks, writing goals and preferences |
| `use_skill("compilation")` | Manuscript compile and export |
| `use_skill("memory")` | Project memory (`remember`, `recall`) |
| `use_skill("relationships")` | Character network and entity relationships |
| `list_skills` | Lists all groups and their activation status |

The AI client only pays the token cost for tool definitions it actually uses in the current conversation. Set `SCRIVENER_MCP_EAGER_TOOLS=1` to instead register the full set at startup — useful for registries, inspectors, and clients that do not honor `notifications/tools/list_changed` (the Docker image sets this by default).

## Compact Responses

Every tool response is optimized to minimize token consumption:

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

This prevents loading a 50,000-word manuscript into context all at once. The AI client can read a document incrementally, processing each section before moving to the next.

When no offset/limit is specified, the full document is returned. For typical scenes and chapters (under 5,000 words), this is fine. For very long documents, the AI client will naturally use windowing to stay within context limits.

## Flattened Structure

`get_structure` returns a compact flat array by default. Each entry is a tuple:

```json
[id, title, type, depth, wordCount, hasChildren]
```

For example:

```json
["ABC-123", "Chapter 1", "text", 1, 3420, true]
```

This is dramatically smaller than a deeply nested JSON tree, especially for projects with hundreds of documents. A 200-document project might use 2,000 tokens in flat format versus 8,000+ in nested format.

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

1. **Pay only for what you use.** Don't register tools, load documents, or return data that isn't needed for the current task.
2. **Summaries first, details on demand.** Return compact overviews by default. The AI client can drill into specifics with follow-up calls.
3. **Spill large data to disk.** When a result would dominate the context window, write it to a file and return a reference. The data is still accessible but doesn't consume tokens unless explicitly read.
4. **Flat over nested.** Flat arrays are cheaper to tokenize than nested objects, and LLMs parse them just as effectively.

## Impact

For a typical writing session with a 100-document novel project:

| Without optimization | With optimization |
|---------------------|-------------------|
| ~340 KB of tool definitions (all 82 tools) | ~30 KB at startup (17 tools, pre-2026-07-28 protocol) |
| 8,000 tokens for project structure | 2,000 tokens (flat format) |
| 50,000 tokens to read a long chapter | 1,000 tokens per window |
| 4,000 tokens for analysis results | 800 tokens (top 3 summary) |

This means more of the context window is available for the actual conversation, and the AI client can work with larger projects without hitting token limits.
