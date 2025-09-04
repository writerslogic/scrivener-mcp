# Scrivener MCP Server

A Model Context Protocol (MCP) server for Scrivener integration that allows Claude to manipulate Scrivener projects, including file and folder operations, metadata management, and content analysis.

## Installation

```bash
npm install -g scrivener-mcp
```

The installation will **automatically configure Claude Desktop** for you! Just restart Claude Desktop after installation.

### Manual Configuration (if needed)

If automatic setup didn't work, you can manually configure:

```bash
# Run the setup script
npx scrivener-mcp setup

# Or manually add to claude_desktop_config.json:
```

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "npx",
      "args": ["scrivener-mcp"]
    }
  }
}
```

### Uninstalling

```bash
# Remove the package and configuration
npm uninstall -g scrivener-mcp
```

## Features

### Core Scrivener Operations
- **Project Management**: Open and manage Scrivener `.scriv` projects
- **Document CRUD**: Read, write, create, delete, and move documents and folders
- **Metadata Management**: Update document titles, keywords, and custom metadata
- **Project Structure**: Navigate and manipulate the hierarchical binder structure

### RTF Support
- **Full RTF Parsing**: Complete support for Scrivener's RTF document format
- **Formatted Content**: Preserve and manipulate bold, italic, underline, and other formatting
- **Scrivener Annotations**: Extract and preserve Scrivener-specific annotations and comments
- **Unicode Support**: Handle international characters and special symbols

### AI-Powered Content Analysis (v0.3.0+)
- **Deep Writing Analysis**: Comprehensive metrics including Flesch scores, readability, pacing
- **Style Assessment**: Sentence variety, vocabulary complexity, adverb usage analysis
- **Quality Indicators**: Detection of clichés, filter words, repetitiveness
- **Emotional Analysis**: Track emotional arcs and tension levels
- **Smart Suggestions**: Actionable recommendations for improvement
- **Legacy Analysis**: Basic readability metrics and passive voice detection

### Memory Management (v0.3.0+)
- **Project Memory**: Persistent storage within each Scrivener project
- **Character Profiles**: Track character details, relationships, and arcs
- **Plot Threads**: Manage multiple storylines and their progression
- **Style Guide**: Maintain consistent tone, voice, POV, and tense
- **Writing Statistics**: Track progress, word counts, and productivity
- **Auto-save**: Automatic backups with version history

### Content Enhancement (v0.3.0+)
- **Smart Editing**: 12+ enhancement types for improving prose
- **Filter Word Elimination**: Remove unnecessary qualifiers
- **Verb Strengthening**: Replace weak verbs with powerful alternatives
- **Sentence Variation**: Improve rhythm and flow
- **Sensory Enhancement**: Add vivid sensory details
- **Show Don't Tell**: Convert telling to showing
- **Pacing Control**: Adjust story tempo
- **Content Expansion/Condensing**: Meet word count targets

### Document Compilation
- **Multi-document Compilation**: Combine multiple documents into single output
- **Format Preservation**: Option to maintain or strip RTF formatting
- **Custom Separators**: Configure how documents are joined

## Installation

```bash
npm install
npm run build
```

## Usage

The MCP server provides the following tools:

### Project Operations
- `open_project(path)` - Open a Scrivener project
- `get_structure()` - Get the project's hierarchical structure
- `get_project_metadata()` - Get project-level metadata

### Document Operations
- `read_document(documentId)` - Read plain text content
- `read_document_formatted(documentId)` - Read with RTF formatting preserved
- `write_document(documentId, content)` - Write content to document
- `get_document_annotations(documentId)` - Get Scrivener annotations

### File Management
- `create_document(parentId?, title, type?)` - Create new document or folder
- `delete_document(documentId)` - Delete document or folder
- `move_document(documentId, newParentId?)` - Move document to new location

### Metadata & Search
- `update_metadata(documentId, metadata)` - Update document metadata
- `search_content(query, options?)` - Search across all documents
- `get_word_count(documentId?)` - Get word/character counts

### Analysis & Compilation
- `analyze_document(documentId)` - Deep AI-powered content analysis
- `deep_analyze_content(documentId)` - Comprehensive writing metrics and suggestions
- `critique_document(documentId, focusAreas?)` - Get constructive feedback
- `compile_documents(documentIds, separator?, preserveFormatting?)` - Compile multiple documents

### Content Enhancement (v0.3.0+)
- `enhance_content(documentId, enhancementType, options?)` - Apply AI improvements
  - Enhancement types: `eliminate-filter-words`, `strengthen-verbs`, `vary-sentences`, `add-sensory-details`, `show-dont-tell`, `improve-flow`, `enhance-descriptions`, `strengthen-dialogue`, `fix-pacing`, `expand`, `condense`, `rewrite`

### Memory Management (v0.3.0+)
- `save_character_profile(name, role, description?, traits?, arc?)` - Store character data
- `get_character_profiles()` - Retrieve all character profiles
- `update_style_guide(tone?, voice?, pov?, tense?)` - Set writing preferences
- `get_style_guide()` - Get current style guide
- `save_plot_thread(name, description, status?, documents?)` - Track plot lines
- `get_plot_threads()` - View all plot threads
- `get_writing_stats()` - Get project statistics
- `export_project_memory()` - Export complete memory data

## RTF Format Support

This MCP server includes comprehensive RTF (Rich Text Format) support specifically designed for Scrivener's document format:

- **RTF Parsing**: Converts RTF to structured content with formatting preserved
- **RTF Generation**: Creates valid RTF from plain or formatted text
- **Scrivener Extensions**: Handles Scrivener-specific RTF extensions and annotations
- **Character Encoding**: Properly handles Unicode and special characters
- **Metadata Extraction**: Extracts document metadata from RTF info groups

## Architecture

### Core Components
- `ScrivenerProject` - Main class for project operations
- `RTFHandler` - Comprehensive RTF parsing and generation
- `MemoryManager` - Persistent project memory and context storage
- `ContentAnalyzer` - Deep writing analysis and metrics
- `ContentEnhancer` - AI-powered content improvement engine
- MCP Server - Tool definitions and request handling

### Data Storage
- Project memories are stored in `.ai-memory` folders within each Scrivener project
- Automatic backups maintain the last 7 days of memory history
- All data persists between sessions and travels with the project

## Usage Examples

### Basic Workflow
```javascript
// Open a project
open_project("/path/to/MyNovel.scriv")

// Get project structure
get_structure()

// Read a document
read_document("UUID-OF-DOCUMENT")

// Analyze content
deep_analyze_content("UUID-OF-DOCUMENT")

// Apply enhancements
enhance_content("UUID-OF-DOCUMENT", "strengthen-verbs")
```

### Character Management
```javascript
// Save a character profile
save_character_profile({
  name: "Elizabeth Bennet",
  role: "protagonist",
  description: "Intelligent and witty young woman",
  traits: ["independent", "prejudiced", "romantic"],
  arc: "Overcomes initial prejudice to find true love"
})

// Retrieve all characters
get_character_profiles()
```

### Style Consistency
```javascript
// Set style guide
update_style_guide({
  tone: ["witty", "romantic", "formal"],
  voice: "Jane Austen-esque",
  pov: "third-limited",
  tense: "past"
})

// Apply style-aware enhancements
enhance_content("UUID", "match-style")
```

### Writing Analysis
```javascript
// Get comprehensive analysis
const analysis = deep_analyze_content("UUID")
// Returns metrics, suggestions, quality indicators, pacing analysis

// Get focused critique
critique_document("UUID", ["pacing", "dialogue"])
```

## Error Handling

The server includes robust error handling for:
- Invalid project paths
- Missing documents
- RTF parsing failures
- File system errors
- Malformed project structures
- Memory corruption recovery

## Development

```bash
npm run dev       # Development mode with hot reload
npm run build     # Build TypeScript
npm run lint      # ESLint
npm run typecheck # TypeScript checking
```

## Requirements

- Node.js 18+
- TypeScript 5.0+
- Valid Scrivener 3 project files

## License

MIT