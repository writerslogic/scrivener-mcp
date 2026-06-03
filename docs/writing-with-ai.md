# Writing with AI

This guide covers the AI-powered writing features: analysis, enhancement, memory, and semantic search.

## Writing Analysis

### Quick Analysis

> "Analyze chapter 3"

Returns readability scores, sentence variety, quality indicators, and improvement suggestions.

### Deep Analysis

> "Give me a deep analysis of the opening scene"

Returns everything from quick analysis plus:
- Pacing assessment (fast/slow detection)
- Emotional arc tracking
- Vocabulary complexity metrics
- Structure analysis (scene breaks, hooks)

### Focused Critique

> "Critique this chapter, focusing on pacing and dialogue"

Available focus areas: `structure`, `clarity`, `dialogue`, `pacing`, `character-development`, `style`

## Content Enhancement

Ask Claude to apply specific improvements:

| Enhancement | What it does | Example prompt |
|-------------|-------------|----------------|
| `eliminate-filter-words` | Removes "just", "really", "very", etc. | "Remove filter words from chapter 2" |
| `strengthen-verbs` | Replaces weak verbs with vivid ones | "Strengthen the verbs in this scene" |
| `vary-sentences` | Fixes repetitive sentence structure | "Vary the sentence structure here" |
| `add-sensory-details` | Adds sight, sound, smell, touch, taste | "Add sensory details to the setting" |
| `show-dont-tell` | Converts telling to showing | "Convert the character intro to showing" |
| `improve-flow` | Smooths transitions between sentences | "Improve the flow of this paragraph" |
| `enhance-descriptions` | Enriches descriptive passages | "Enhance the descriptions in this scene" |
| `strengthen-dialogue` | Makes dialogue more natural/punchy | "Strengthen the dialogue" |
| `fix-pacing` | Adjusts tempo (faster or slower) | "Fix the pacing in the climax" |
| `expand` | Lengthens content to meet word count | "Expand this to 2000 words" |
| `condense` | Shortens while preserving meaning | "Condense this by 30%" |
| `rewrite` | Full rewrite with style preservation | "Rewrite this scene" |

### Tips for Enhancement

- Apply enhancements incrementally. Review each change before applying the next.
- Set a style guide first (`update_style_guide`) so enhancements match your voice.
- Use `condense` after `expand` to tighten prose that was lengthened.

## Project Memory

Memory is stored within your `.scriv` package and persists across sessions.

### Character Profiles

> "Save a character profile for Detective Sarah Chen: protagonist, LAPD homicide, observant and methodical, struggles with trust issues, arc is learning to rely on her new partner"

Profiles track name, role, description, traits, relationships, and character arc. Claude can reference these when analyzing scenes or suggesting improvements.

### Plot Threads

> "Create a plot thread called 'Missing Witness' -- a key witness disappears in chapter 3, investigated through chapters 4-8, resolved in chapter 12. Status: in-progress."

Track multiple storylines with status, chapter ranges, and descriptions.

### Style Guide

> "Set the style guide: noir tone, first-person POV, past tense, short punchy sentences, hardboiled voice"

Once set, enhancement tools will match your defined style. Analysis tools will flag deviations.

### Writing Statistics

> "Show my writing statistics"

Track word counts, session durations, and productivity over time.

> "Record a writing session: 1200 words in 45 minutes, worked on chapters 3 and 4"

## Semantic Search (HMS)

The Holographic Memory System stores documents in a 10,000-dimensional vector space for meaning-based retrieval.

### Search by Meaning

> "Find documents about betrayal and broken trust"

Unlike keyword search, this finds documents that are semantically related even if they don't contain the exact words.

### Analogical Reasoning

> "Find analogies: protagonist is to hero as antagonist is to ?"

Uses vector arithmetic to discover relationships between concepts in your project.

### Dream Mode

> "Enter dream mode"

Generates novel concept associations by recombining patterns found across your documents. Useful for brainstorming and finding unexpected connections.

## Workflow Recipes

### Revision Pass

1. `deep_analyze_content` on each chapter
2. Review suggestions, note patterns
3. `enhance_content` with targeted improvements
4. `critique_document` on revised chapters
5. Compare before/after metrics

### Character Consistency Check

1. Save character profiles for your cast
2. `search_content` for each character name
3. Review appearances across chapters
4. Use `critique_document` focusing on `character-development`

### Style Normalization

1. `update_style_guide` with your target style
2. `analyze_document` on your best chapter (the style benchmark)
3. `enhance_content` with `match-style` on other chapters
4. `critique_document` to verify consistency

### Synopsis Generation

1. Open your project
2. `get_structure` to see all documents
3. For each chapter, `read_document` then ask Claude to write a synopsis
4. `batch_update_synopsis_notes` to save them all at once
