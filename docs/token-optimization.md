# Token Optimization

Scrivener projects can be massive -- hundreds of documents, deeply nested binders, and chapters exceeding 10,000 words. Without optimization, a single tool call could consume the entire context window. The scrivener-mcp server uses several strategies to keep token usage minimal while preserving full access to project data.

## Progressive Skill Loading

At startup, only 6 tools are registered: the `project` skill group (`open_project`, `get_structure`, `refresh_project`, `close_project`) plus two meta-tools (`list_skills`, `use_skill`). This consumes roughly 300 tokens of tool definitions instead of the 5,000+ tokens that all 60+ tools would require.

Skills activate on demand:

| Trigger | Skills activated |
|---------|-----------------|
| `open_project` (automatic) | `documents`, `search` |
| `use_skill("analysis")` | Analysis tools (document analysis, consistency checks) |
| `use_skill("compilation")` | Compilation tools (manuscript export, format conversion) |
| `use_skill("memory")` | Project memory (character profiles, plot threads, style guide) |
| `use_skill("advanced")` | Advanced tools (semantic search, graph analysis) |
| `list_skills` | Lists all available groups and their activation status |

This means the AI client only pays the token cost for tool definitions it actually uses in the current conversation.

## Compact Responses

Every tool response is optimized to minimize token consumption:

- **Minified JSON:** Responses strip null fields and omit empty arrays/objects. No pretty-printing.
- **Search snippets:** `search_project` returns 100-character context snippets around each match, not full document text. Follow up with `read_document` for the complete content.
- **Analysis summaries:** `analyze_document` returns a summary with the top 3 issues rather than a full metrics blob. This keeps analysis results actionable without overwhelming the context.
- **Large payload spill:** Compiled manuscripts and other results exceeding 4,000 characters are written to a temp directory on disk. The tool returns a tracker ID and a short preview instead of the full payload. The AI client can read the file if needed.

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

## Paginated Listings

`get_all_documents` returns 50 items per page with `offset`/`limit` pagination:

```
First page:    offset=0,  limit=50
Second page:   offset=50, limit=50
Third page:    offset=100, limit=50
```

For most conversations, the first page is sufficient -- the AI client can search or filter rather than paginating through the entire binder.

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
| 5,000 tokens for tool definitions | 300 tokens at startup |
| 8,000 tokens for project structure | 2,000 tokens (flat format) |
| 50,000 tokens to read a long chapter | 1,000 tokens per window |
| 4,000 tokens for analysis results | 800 tokens (top 3 summary) |

This means more of the context window is available for the actual conversation, and the AI client can work with larger projects without hitting token limits.
