# Community Post Drafts

## Literature & Latte Forums (Third-Party Tools)

**Title:** Scrivener MCP -- Use Claude AI directly with your Scrivener projects

I've built an open-source tool that connects Scrivener 3 to Claude (and other AI assistants) via the Model Context Protocol.

What it does:
- Opens your .scriv projects and lets Claude read, edit, and organize documents
- Analyzes your writing: readability, pacing, style, emotional arc, filter words
- Enhances prose: 12 improvement types (show-don't-tell, verb strengthening, dialogue, etc.)
- Remembers your characters, plot threads, and style guide across sessions
- Semantic search: find passages by meaning, not just keywords

It doesn't change how Scrivener works. You keep writing in Scrivener. The AI reads and writes to the same .scriv files. Think of it as giving Claude a window into your project.

Install: `npm install -g scrivener-mcp`
More info: https://github.com/writerslogic/scrivener-mcp

Works with Claude Desktop, Claude Code, Cursor, and any MCP-compatible client. macOS, Windows, Linux.

Happy to hear what features writers would find most useful.

---

## r/scrivener

**Title:** I built an AI bridge for Scrivener -- Claude can now read and edit your .scriv projects directly

After months of work, I'm sharing an open-source tool that lets Claude AI work directly with Scrivener 3 projects.

Instead of copy-pasting chapters into ChatGPT, you just say "open my novel and analyze Chapter 12" and Claude reads it from your .scriv file, analyzes it, and can even apply improvements back.

Features:
- 60+ tools: read/write/create/delete/move documents, browse binder, search
- Writing analysis: readability scores, pacing, filter words, cliches, emotional arc
- 12 enhancement types: eliminate filter words, strengthen verbs, show-don't-tell, fix pacing
- Character memory: stores profiles, plot threads, and style guides inside your project
- Semantic search: "find scenes where the protagonist feels isolated" works even without exact keywords

It's free, open source, and installs in one command: `npm install -g scrivener-mcp`

Works with Claude Desktop, Claude Code, and Cursor. macOS, Windows, and Linux.

GitHub: https://github.com/writerslogic/scrivener-mcp

What would you want an AI assistant to do with your Scrivener project?

---

## r/ClaudeAI

**Title:** MCP server for Scrivener -- full manuscript management from Claude

Built an MCP server that gives Claude deep access to Scrivener 3 writing projects. 60+ tools, semantic search, writing analysis, content enhancement, and persistent character/plot memory.

Key differentiator from other writing MCP tools: it works with Scrivener's native .scriv format directly. No export/import. Your manuscript stays in Scrivener.

Token-optimized: progressive skill loading (6 tools at startup instead of 60), compact responses, sliding window reads for large chapters, search results capped to snippets.

`npm install -g scrivener-mcp` -- auto-configures Claude Desktop.

https://github.com/writerslogic/scrivener-mcp

---

## r/writing

**Title:** Free tool to connect your Scrivener projects to AI -- no copy-pasting, works with your actual manuscript files

If you use Scrivener and want AI help with your writing, I built an open-source bridge that lets Claude (or other AI assistants) work directly with your .scriv project files.

Instead of copying a chapter into ChatGPT and losing all your formatting and context, you say "open my novel" and the AI can see your entire project -- binder structure, chapters, character sheets, research notes, everything.

What it can do:
- Read any document in your project and give feedback
- Analyze readability, pacing, dialogue quality, filter word density
- Apply specific improvements (strengthen verbs, add sensory details, fix show-vs-tell)
- Remember your characters and plot threads across conversations
- Search your manuscript by meaning ("find scenes about betrayal")
- Check character consistency across the entire manuscript

Free, open source: https://github.com/writerslogic/scrivener-mcp
Install: `npm install -g scrivener-mcp` (requires Node.js)

I'm a writer too. Built this because I was tired of the copy-paste workflow. Happy to answer questions.
