# Scrivener MCP v0.3.0 Feature Demo

This guide demonstrates the powerful new AI features in Scrivener MCP v0.3.0.

## Prerequisites

1. Install Scrivener MCP:
```bash
npm install -g scrivener-mcp
```

2. Restart Claude Desktop (the package auto-configures itself)

3. Open a Scrivener project in Claude

## Demo Workflow

### 1. Open Your Project

Ask Claude:
> "Open my Scrivener project at /path/to/MyNovel.scriv"

### 2. Analyze Your Writing

Get deep analysis of a chapter:
> "Analyze chapter 1 for writing quality"

Claude will provide:
- Readability scores (Flesch-Kincaid, etc.)
- Sentence variety analysis
- Pacing assessment
- Quality indicators (clichés, filter words)
- Emotional arc tracking
- Specific improvement suggestions

### 3. Set Up Project Memory

Create character profiles:
> "Save a character profile for my protagonist Sarah: intelligent detective, observant and methodical, struggles with trust issues, her arc involves learning to rely on others"

Track plot threads:
> "Create a plot thread for 'Murder Mystery' that spans chapters 1-5, currently in development phase"

Define your style:
> "Set my style guide: noir tone, first-person POV, past tense, hardboiled voice"

### 4. Enhance Your Content

Eliminate weak words:
> "Remove filter words from chapter 2"

Strengthen prose:
> "Strengthen the verbs in the opening scene"

Improve variety:
> "Vary the sentence structure in the dialogue scene"

Add immersion:
> "Add sensory details to the crime scene description"

Show don't tell:
> "Convert telling to showing in the character introduction"

### 5. Get Comprehensive Critiques

Focus on specific areas:
> "Critique chapter 3 focusing on pacing and dialogue"

Get overall feedback:
> "Give me a full critique of the climax scene"

### 6. Track Your Progress

View statistics:
> "Show my writing statistics"

Export everything:
> "Export my complete project memory"

## Advanced Features

### Batch Processing

Analyze multiple documents:
> "Analyze all chapters in Part 1 and identify consistency issues"

### Style Matching

Maintain consistency:
> "Enhance chapter 5 to match the style of chapter 1"

### Content Goals

Meet word counts:
> "Expand this scene to 2000 words while maintaining pacing"

Or trim excess:
> "Condense this chapter by 30% without losing key plot points"

### Memory Persistence

All character profiles, plot threads, style guides, and analysis results are automatically saved in your Scrivener project. They persist between sessions and travel with your project file.

## Tips

1. **Build Character Depth**: Save detailed profiles early and update them as characters develop
2. **Track Subplots**: Use plot threads to manage multiple storylines
3. **Iterate Enhancements**: Apply improvements incrementally and review changes
4. **Regular Analysis**: Analyze chapters periodically to track improvement
5. **Style Consistency**: Set your style guide early to maintain voice throughout

## Example Commands

```
// Complex character with relationships
"Save character: Detective Mills, protagonist, cynical veteran cop, traits: alcoholic, divorced, protective, arc: redemption through solving case, relationship with Sarah: mentor"

// Multi-layered enhancement
"Enhance the interrogation scene: strengthen dialogue, fix pacing to be more tense, eliminate filter words"

// Targeted analysis
"Analyze the romantic subplot across all chapters and suggest improvements"

// Style application
"Make all narrative sections match the noir style: darker tone, shorter sentences, more atmospheric descriptions"
```

## Troubleshooting

If features aren't working:
1. Ensure you have v0.3.0+ installed: `npm list -g scrivener-mcp`
2. Check that a project is open: "What project is currently open?"
3. Memory is stored in `.ai-memory` within your .scriv folder
4. Restart Claude Desktop after installation/updates

## Next Steps

- Experiment with different enhancement types on sample text
- Build comprehensive character profiles for your entire cast
- Set up plot threads for all storylines
- Use analysis to identify your writing patterns
- Apply targeted improvements based on suggestions

The AI features learn from your project context, so the more you use them, the better they become at understanding your unique style and story!