# Community Post Drafts

## Literature & Latte Forums

**Best category:** Wish List (framing as features writers have wished for) or Scrivener for macOS/Windows (framing as workflow)

**Title:** Two free tools for Scrivener writers -- manuscript analysis and authorship proof

I write fiction in Scrivener and kept running into two problems no plugin could solve. So I built tools for both. Sharing in case they're useful to others here.

---

**1. Manuscript analysis and semantic search** ([scrivener-mcp](https://github.com/writerslogic/scrivener-mcp))

A companion tool that reads your .scriv project and gives you things Scrivener's built-in tools don't:

- **Search by meaning.** "Find scenes where the protagonist feels trapped" works even if that word never appears. Useful for tracking themes across 80+ chapters.
- **Character consistency checking.** Scans every document and flags contradictions. Found my protagonist "walking briskly" in Chapter 9 when I'd given him a limp in Chapter 2.
- **Pacing analysis.** Identifies long stretches without dialogue or action, chapters that are 3x the length of others, filter word clusters.
- **Readability per chapter.** Flesch-Kincaid, sentence variety, vocabulary complexity. Not prescriptive -- just data.
- **Structural overview.** Word distribution across chapters, scene counts, binder summary. Spots the 8,000-word chapter when everything else is 3,000.

It reads your .scriv files directly and doesn't modify anything unless you explicitly tell it to. Works with Claude Desktop, but the analytics and consistency checking run without any AI service.

---

**2. Prove you wrote it** ([WritersProof](https://writersproof.com))

This one's for a different problem. With AI-generated text everywhere, publishers, agents, and contest judges increasingly want proof that a human actually wrote the manuscript.

WritersProof captures cryptographic evidence of your writing process -- keystroke timing, editing patterns, revision history -- and timestamps it to a public transparency log. It doesn't read or store your text. It just proves that a human sat at a keyboard and wrote it, with a verifiable timestamp.

Useful for:
- Contest submissions that require proof of human authorship
- Copyright disputes where you need to prove when you wrote something
- Agents/publishers who ask about AI involvement
- Your own peace of mind

Free for individual writers. Works alongside Scrivener (doesn't require it).

---

Both tools are open source and built by a fellow Scrivener user. Not affiliated with Literature & Latte.

Would love to hear what problems you run into with long manuscripts that a companion tool might help with.

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
