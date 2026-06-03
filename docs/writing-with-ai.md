# Writing with AI

This guide covers the AI-powered features that help you analyze, improve, and manage your writing. These features work best when you've set up project memory (character profiles, style guide) as described in [Getting Started](./getting-started.md).

## Analyzing Your Writing

The server offers three levels of analysis, each progressively deeper.

### Quick Analysis

> "Analyze chapter 3"

Gives you a snapshot: readability score, word count, sentence count, average sentence length, and a handful of quick observations about style.

### Deep Analysis

> "Give me a deep analysis of the opening scene"

Goes further with:

- **Readability metrics** -- Flesch-Kincaid grade level, Flesch Reading Ease, Gunning Fog index
- **Style analysis** -- sentence length variety, vocabulary complexity, adverb density, passive voice percentage
- **Quality indicators** -- cliche count, filter words ("just", "very", "really"), repetitive word patterns
- **Pacing assessment** -- detects fast-paced action sequences vs. slow reflective passages based on sentence length, dialogue ratio, and paragraph density
- **Emotional arc** -- tracks tension and emotional intensity through the passage
- **Structure** -- scene breaks, chapter hooks, transition quality

The output includes specific numbers so you can track improvement across revision passes.

### Focused Critique

> "Critique this chapter, focusing on pacing and dialogue"

Returns targeted feedback on the areas you specify. Available focus areas:

- **structure** -- chapter organization, scene breaks, narrative flow
- **clarity** -- confusing passages, ambiguous references, logical gaps
- **dialogue** -- naturalness, character voice distinction, said-bookism, talking head syndrome
- **pacing** -- scenes that drag or rush, tension management, page-turner quality
- **character-development** -- consistency, arc progression, motivation clarity
- **style** -- voice consistency, prose quality, word choice

You can combine multiple focus areas in one request.

### Comparing Before and After

A useful pattern: analyze a chapter before and after revision to see what improved.

> "Analyze chapter 5 and remember the scores."
> [make revisions]
> "Analyze chapter 5 again. How do the scores compare to before?"

Claude will call the analysis tool again and compare the metrics for you.

## Enhancing Your Prose

The enhancement system applies targeted transformations to your text. Each type addresses a specific writing weakness.

### Sentence-Level Improvements

**Eliminate filter words** -- Removes qualifiers that weaken prose: "just", "really", "very", "quite", "somewhat", "actually", "basically", "practically".

> "Remove filter words from the interrogation scene"

Before: "She was really just quite angry about what had actually happened."
After: "She was angry about what had happened."

**Strengthen verbs** -- Replaces weak or generic verbs with specific, vivid ones.

> "Strengthen the verbs in paragraphs 2 through 5"

Before: "He went across the room and got the letter."
After: "He strode across the room and snatched the letter."

**Show don't tell** -- Converts emotional telling into sensory showing.

> "Convert the character introduction to showing instead of telling"

Before: "Sarah was nervous about the interview."
After: "Sarah's fingers twisted the strap of her bag. She checked her reflection in the elevator doors, smoothed a wrinkle that wasn't there, and checked again."

### Paragraph-Level Improvements

**Vary sentence structure** -- Breaks up monotonous sentence patterns by mixing lengths, starting words, and structures.

> "Vary the sentence structure in the opening page"

This is particularly useful after writing a first draft quickly, where many sentences tend to follow the same subject-verb-object pattern.

**Improve flow** -- Smooths transitions between sentences and paragraphs. Adds connective tissue without changing meaning.

> "Improve the flow between the flashback and the present-day scene"

**Add sensory details** -- Enriches passages with sight, sound, smell, touch, and taste.

> "Add sensory details to the marketplace scene"

Works best on setting descriptions and action sequences where the reader needs to feel present.

### Scene-Level Improvements

**Enhance descriptions** -- Enriches descriptive passages with more specific imagery and detail.

> "Enhance the descriptions in the storm scene"

**Strengthen dialogue** -- Makes conversation feel more natural, gives characters distinct voices, cuts unnecessary dialogue tags.

> "Strengthen the dialogue in the argument between Marcus and Elena"

**Fix pacing** -- Adjusts the tempo of a scene. Can speed up slow passages (shorter sentences, more action, less internal monologue) or slow down rushed ones (more beats, sensory grounding, emotional processing).

> "The climax feels rushed -- slow down the pacing"
> "The dinner party scene drags -- tighten the pacing"

### Length Adjustments

**Expand** -- Lengthens content to meet a word count target while maintaining quality.

> "Expand the confrontation scene to about 2000 words"

**Condense** -- Shortens content while preserving key information and emotional beats.

> "Condense this chapter by about 30%"

**Rewrite** -- Full rewrite that preserves plot points and character beats but reimagines the prose.

> "Rewrite the opening paragraph in a more literary style"

### Getting the Best Results

**Set your style guide first.** Enhancements match your defined voice when a style guide exists. Without one, they default to general literary fiction conventions.

> "Set the style guide: hardboiled noir, first-person, present tense, short declarative sentences, minimal adjectives"

**Apply incrementally.** Don't run five enhancements at once. Apply one, read the result, then decide what's next. Sometimes one enhancement is enough.

**Combine with analysis.** Run `deep_analyze_content` before and after to see measurable improvement. If filter word count drops from 47 to 3, you know it worked.

**Use condense after expand.** Content that gets expanded to meet a word count often benefits from a condensing pass to tighten the added material.

## Project Memory in Depth

Memory is your AI writing assistant's long-term context. It persists across conversations and travels with your Scrivener project.

### Character Profiles

> "Save a character profile for Detective Sarah Chen"

Tell Claude everything relevant: role, physical description, personality traits, background, relationships, character arc, speech patterns, quirks.

> "Sarah Chen: protagonist, LAPD homicide detective, 38, second-generation Chinese-American. Methodical and observant but struggles to trust her new partner after her previous partner's betrayal. Arc: learns to rely on others without losing her independence. Speech: clipped, precise, avoids small talk. Quirk: always carries a specific pen her father gave her."

The more detail you provide, the better Claude can:
- Check character consistency across chapters
- Flag out-of-character dialogue
- Suggest character-appropriate reactions in new scenes
- Track arc progression

You can update profiles as characters develop:

> "Update Sarah's profile: as of chapter 8, she's started confiding in her partner about personal matters"

### Plot Threads

> "Create a plot thread for the missing witness subplot"

Track storylines with descriptions, chapter ranges, and status:

> "Plot thread: 'The Missing Witness' -- key witness Maria Vasquez disappears after chapter 3. Investigation runs chapters 4-8. She's found in chapter 9 but refuses to testify. Resolution in chapter 12 when she changes her mind. Status: first draft complete."

Useful for:
- Keeping track of multiple subplots
- Checking that all threads get resolved
- Planning revision passes focused on specific storylines

### Style Guide

The style guide shapes how all AI features behave.

> "Style guide: literary thriller, third-person close POV (rotating between Sarah and the antagonist), past tense, atmospheric prose, longer sentences for tension-building, short punchy sentences for action. Avoid: adverbs, exclamation marks, the word 'suddenly'."

Once set, the enhancement tools respect your preferences. The analysis tools flag violations. The critique tools evaluate against your stated style rather than generic rules.

### Custom Context

Store any project-specific information that doesn't fit the other categories:

> "Save custom context: the story is set in 2019 Los Angeles. The LAPD precinct is fictional -- 'Pacific Division West'. The McGuffin is a USB drive containing surveillance footage."

Claude can reference this to catch anachronisms, maintain setting consistency, and avoid contradictions.

### Writing Statistics

Track your productivity:

> "Record a writing session: 1,500 words in 60 minutes, worked on chapters 7 and 8. Notes: breakthrough on the subplot resolution."

> "Show my writing statistics for the last two weeks"

The server stores sessions in SQLite and can report trends, averages, and streaks.

## Semantic Search

When the Holographic Memory System is available, documents are stored in a high-dimensional vector space that enables meaning-based retrieval.

### Finding Related Content

> "Find passages about loss and grief"

Unlike keyword search, semantic search finds documents that express a concept even when they don't use those specific words. A passage about a character staring at an empty chair could match "loss and grief" even though neither word appears.

> "Find scenes similar in mood to the funeral chapter"

You can search by referencing existing content, and the system finds passages with similar emotional or thematic signatures.

### Analogical Reasoning

> "protagonist is to hero as antagonist is to ?"

The system uses vector arithmetic to discover conceptual relationships. This works best with concrete relationships established in your text:

> "If Marcus is to the police department as Elena is to what?"
> "Find patterns like: chapter 1 opening is to chapter 1 closing as chapter 5 opening is to ?"

### Creative Exploration

> "Enter dream mode"

Dream mode recombines patterns found across your documents to surface unexpected connections. It might reveal that two seemingly unrelated characters share thematic parallels, or that a motif you planted early pays off in a way you hadn't consciously planned.

This is a brainstorming tool, not an analysis tool. Not every connection will be useful, but the surprising ones can spark new ideas.

## Workflow Recipes

### Full Revision Pass

1. **Set up memory** -- character profiles, style guide, plot threads
2. **Analyze each chapter** -- note recurring issues (e.g., high filter word count, low sentence variety)
3. **Apply targeted enhancements** -- address the most common issues first
4. **Critique revised chapters** -- get feedback on the improvements
5. **Compare metrics** -- verify that scores improved
6. **Update synopses** -- batch-update all synopses to reflect final content

### Character Consistency Audit

1. **Save profiles** for every named character
2. **Search for each character** across the manuscript
3. **Read their scenes chronologically** and check for:
   - Trait consistency (does the shy character suddenly become bold without justification?)
   - Arc progression (does the change happen gradually?)
   - Voice distinction (does each character sound different in dialogue?)
4. **Critique** chapters with character focus

### Pre-Submission Polish

1. **Eliminate filter words** across the entire manuscript
2. **Strengthen verbs** in action scenes and dialogue tags
3. **Fix pacing** in any scenes flagged as too slow or too fast
4. **Deep analyze** each chapter and note any readability outliers
5. **Generate synopses** for every chapter (useful for query letters)
6. **Export statistics** for your records

### Outlining a New Project

1. **Open the project** (even if it's mostly empty)
2. **Create character profiles** for your planned cast
3. **Set up plot threads** with rough chapter ranges
4. **Set the style guide** with your target voice
5. **Add custom context** for worldbuilding details, timeline, rules
6. Claude now has enough context to help you outline, draft, and revise coherently from the start

### Daily Writing Session

1. **Open your project**
2. **Ask "What was I working on?"** -- Claude checks recent writing stats and open plot threads
3. **Read the last scene you wrote** for continuity
4. **Write your new content** -- Claude can draft, extend, or help with blocks
5. **Quick analysis** of what you wrote today
6. **Record your session** -- "Log 800 words in 30 minutes on chapter 4"
