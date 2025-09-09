<p align="center">
  <img src="https://raw.githubusercontent.com/dcondrey/scrivener-mcp/main/assets/logo.svg" alt="Scrivener MCP Logo" width="200"/>
</p>

<h1 align="center">Scrivener MCP Server</h1>

<p align="center">
  <strong>A Model Context Protocol (MCP) server for seamless Scrivener integration with Claude AI</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/scrivener-mcp">
    <img src="https://img.shields.io/npm/v/scrivener-mcp.svg" alt="npm version"/>
  </a>
  <img src="https://img.shields.io/npm/dt/scrivener-mcp.svg" alt="npm total downloads"/>
  <img src="https://img.shields.io/npm/dm/scrivener-mcp.svg" alt="npm monthly downloads"/>
  <a href="https://github.com/dcondrey/scrivener-mcp/actions">
    <img src="https://github.com/dcondrey/scrivener-mcp/actions/workflows/ci.yml/badge.svg" alt="build status"/>
  </a>
  <a href="https://coveralls.io/github/dcondrey/scrivener-mcp">
    <img src="https://coveralls.io/repos/github/dcondrey/scrivener-mcp/badge.svg" alt="coverage"/>
  </a>
  <img src="https://img.shields.io/github/license/dcondrey/scrivener-mcp" alt="license"/>
  <img src="https://img.shields.io/node/v/scrivener-mcp" alt="node version"/>
  <img src="https://img.shields.io/badge/TypeScript-5.3-blue" alt="typescript"/>
</p>

<p align="center">
  <a href="https://github.com/dcondrey/scrivener-mcp/stargazers">
    <img src="https://img.shields.io/github/stars/dcondrey/scrivener-mcp?style=social" alt="GitHub stars"/>
  </a>
  <a href="https://github.com/dcondrey/scrivener-mcp/network/members">
    <img src="https://img.shields.io/github/forks/dcondrey/scrivener-mcp?style=social" alt="GitHub forks"/>
  </a>
  <a href="https://buymeacoffee.com/davidcondrey">
    <img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee" alt="Buy Me A Coffee"/>
  </a>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#api-reference">API</a> •
  <a href="#contributing">Contributing</a>
</p>

---

A powerful Model Context Protocol (MCP) server that enables Claude AI to seamlessly interact with Scrivener projects. This server provides comprehensive document management, AI-powered content analysis, and advanced writing assistance capabilities - all without requiring external services like Redis.

## 🚀 Quick Start

### Installation

```bash
npm install -g scrivener-mcp
```

✨ **Features:**
- **Automatic Claude Desktop configuration** - Just restart Claude Desktop after installation
- **No Redis or external services required** - Built-in embedded queue system
- **Zero configuration** - Works out of the box
- **AI providers optional** - Core features work without API keys

### Manual Configuration (Optional)

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

## ✨ Features

### 📚 Core Scrivener Operations
- **Project Management**: Open and manage Scrivener `.scriv` projects
- **Document CRUD**: Read, write, create, delete, and move documents and folders
- **Metadata Management**: Update document titles, keywords, and custom metadata
- **Project Structure**: Navigate and manipulate the hierarchical binder structure

### 📝 Advanced RTF Support
- **Full RTF Parsing**: Complete support for Scrivener's RTF document format
- **Formatted Content**: Preserve and manipulate bold, italic, underline, and other formatting
- **Scrivener Annotations**: Extract and preserve Scrivener-specific annotations and comments
- **Unicode Support**: Handle international characters and special symbols

### 🤖 AI-Powered Content Analysis
- **Deep Writing Analysis**: Comprehensive metrics including Flesch scores, readability, pacing
- **Style Assessment**: Sentence variety, vocabulary complexity, adverb usage analysis
- **Quality Indicators**: Detection of clichés, filter words, repetitiveness
- **Emotional Analysis**: Track emotional arcs and tension levels
- **Smart Suggestions**: Actionable recommendations for improvement
- **Legacy Analysis**: Basic readability metrics and passive voice detection

### 🧠 Intelligent Memory Management
- **Project Memory**: Persistent storage within each Scrivener project
- **Character Profiles**: Track character details, relationships, and arcs
- **Plot Threads**: Manage multiple storylines and their progression
- **Style Guide**: Maintain consistent tone, voice, POV, and tense
- **Writing Statistics**: Track progress, word counts, and productivity
- **Auto-save**: Automatic backups with version history

### ✍️ Smart Content Enhancement
- **Smart Editing**: 12+ enhancement types for improving prose
- **Filter Word Elimination**: Remove unnecessary qualifiers
- **Verb Strengthening**: Replace weak verbs with powerful alternatives
- **Sentence Variation**: Improve rhythm and flow
- **Sensory Enhancement**: Add vivid sensory details
- **Show Don't Tell**: Convert telling to showing
- **Pacing Control**: Adjust story tempo
- **Content Expansion/Condensing**: Meet word count targets

### 📖 Document Compilation & Export
- **Multi-document Compilation**: Combine multiple documents into single output
- **Format Preservation**: Option to maintain or strip RTF formatting
- **Custom Separators**: Configure how documents are joined

## 🛠️ Available Tools

The MCP server provides 60+ powerful tools for comprehensive Scrivener integration:

### 📁 Project Operations
- `open_project(path)` - Open a Scrivener project
- `get_structure(options?)` - Get the project's hierarchical structure
  - Options: `maxDepth` (limit tree depth), `folderId` (get specific folder), `includeTrash` (include trash), `summaryOnly` (return counts only)
- `get_document_info(documentId)` - Get document metadata with full parent hierarchy and location
- `get_project_metadata()` - Get project-level metadata

### 📄 Document Operations
- `read_document(documentId)` - Read plain text content
- `read_document_formatted(documentId)` - Read with RTF formatting preserved
- `write_document(documentId, content)` - Write content to document
- `get_document_annotations(documentId)` - Get Scrivener annotations

### 🗂️ File Management
- `create_document(parentId?, title, type?)` - Create new document or folder
- `delete_document(documentId)` - Delete document or folder
- `move_document(documentId, newParentId?)` - Move document to new location

### 🔍 Metadata & Search
- `update_metadata(documentId, metadata)` - Update document metadata
- `search_content(query, options?)` - Search across all documents (excludes trash)
- `get_word_count(documentId?)` - Get word/character counts

### 🗑️ Trash Management
- `list_trash()` - List all documents in the trash folder
- `search_trash(query, options?)` - Search only within trashed documents
- `recover_document(documentId, targetParentId?)` - Recover document from trash

### 📊 Analysis & Compilation
- `analyze_document(documentId)` - Deep AI-powered content analysis
- `deep_analyze_content(documentId)` - Comprehensive writing metrics and suggestions
- `critique_document(documentId, focusAreas?)` - Get constructive feedback
- `compile_documents(documentIds, separator?, preserveFormatting?)` - Compile multiple documents

### ✨ Content Enhancement
- `enhance_content(documentId, enhancementType, options?)` - Apply AI improvements
  - Enhancement types: `eliminate-filter-words`, `strengthen-verbs`, `vary-sentences`, `add-sensory-details`, `show-dont-tell`, `improve-flow`, `enhance-descriptions`, `strengthen-dialogue`, `fix-pacing`, `expand`, `condense`, `rewrite`

### 💾 Memory Management
- `save_character_profile(name, role, description?, traits?, arc?)` - Store character data
- `get_character_profiles()` - Retrieve all character profiles
- `update_style_guide(tone?, voice?, pov?, tense?)` - Set writing preferences
- `get_style_guide()` - Get current style guide
- `save_plot_thread(name, description, status?, documents?)` - Track plot lines
- `get_plot_threads()` - View all plot threads
- `get_writing_stats()` - Get project statistics
- `export_project_memory()` - Export complete memory data

### 🔧 Additional Tools
- `get_all_documents(includeTrash?)` - Get flat list of all documents
- `save_project()` - Save any pending changes to the project
- `is_project_modified()` - Check if project has unsaved changes
- `read_document_rtf(documentId)` - Read document with RTF formatting preserved
- `update_document_context(documentId, summary?, themes?, pacing?)` - Update document memory context
- `add_custom_context(key, value)` - Add custom context to project memory
- `get_custom_context(key?)` - Get custom context from project memory
- `update_writing_session(wordsWritten, duration?)` - Update writing session statistics
- `extract_research_data(html, keywords?)` - Extract research data from web content
- `import_memory(memoryData)` - Import project memory from exported data
- `update_document_synopsis_notes(documentId, synopsis?, notes?)` - Update synopsis and/or notes for a document
- `batch_update_synopsis_notes(updates)` - Update synopsis and/or notes for multiple documents at once

### 🗄️ Database Tools (Advanced)
- `get_database_status()` - Get status of SQLite and Neo4j databases
- `query_database(query, params?)` - Execute SELECT queries on SQLite database
- `get_writing_statistics(days?)` - Get writing statistics for specified period
- `record_writing_session(wordsWritten, durationMinutes?, documentsWorkedOn?, notes?)` - Record a writing session
- `analyze_story_structure()` - Analyze document flow, character arcs, and themes using Neo4j
- `find_character_relationships(characterId)` - Find all relationships for a character
- `create_relationship(fromId, fromType, toId, toType, relationshipType, properties?)` - Create relationships between entities
- `get_content_analysis_history(documentId, analysisType?)` - Get historical analysis data
- `backup_databases(backupPath?)` - Create backup of project databases

## 📄 RTF Format Support

This MCP server includes comprehensive RTF (Rich Text Format) support specifically designed for Scrivener's document format:

- **RTF Parsing**: Converts RTF to structured content with formatting preserved
- **RTF Generation**: Creates valid RTF from plain or formatted text
- **Scrivener Extensions**: Handles Scrivener-specific RTF extensions and annotations
- **Character Encoding**: Properly handles Unicode and special characters
- **Metadata Extraction**: Extracts document metadata from RTF info groups

## 🏗️ Architecture

### Core Components
- `ScrivenerProject` - Main class for project operations
- `RTFHandler` - Comprehensive RTF parsing and generation
- `DatabaseService` - Manages SQLite and Neo4j database operations
- `MemoryManager` - Persistent project memory and context storage
- `ContentAnalyzer` - Deep writing analysis and metrics
- `ContentEnhancer` - AI-powered content improvement engine
- MCP Server - Tool definitions and request handling

### Data Storage
- **SQLite Database** - Stored in `.scrivener-databases/scrivener.db` within each project
  - Documents, characters, plot threads, themes, writing sessions
  - Content analysis history and relationships
- **Neo4j Graph Database** - Optional graph database for relationship analysis
  - Document flow, character networks, theme progression
  - Falls back gracefully if not available
- **Memory Files** - Stored in `.ai-memory` folders for quick access
- Automatic backups maintain history and data integrity
- All data persists between sessions and travels with the project

## 💻 Usage Examples

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

### Synopsis and Notes Management
```javascript
// Update synopsis for a single document
update_document_synopsis_notes("UUID-OF-CHAPTER", {
  synopsis: "Elizabeth meets Mr. Darcy at the assembly ball and takes an instant dislike to him.",
  notes: "Important first impression scene - sets up central conflict"
})

// Batch update multiple documents
batch_update_synopsis_notes([
  {
    documentId: "UUID-OF-CHAPTER-1",
    synopsis: "Introduction to Elizabeth and her family",
    notes: "Character establishment chapter"
  },
  {
    documentId: "UUID-OF-CHAPTER-2", 
    synopsis: "The Netherfield ball",
    notes: "Major social event - introduces Bingley and Darcy"
  }
])
```

### Database Operations
```javascript
// Check database status
get_database_status()

// Query documents with custom SQL
query_database("SELECT title, word_count FROM documents WHERE word_count > 1000")

// Record a writing session
record_writing_session({
  wordsWritten: 1250,
  durationMinutes: 45,
  documentsWorkedOn: ["UUID-1", "UUID-2"],
  notes: "Productive morning session"
})

// Get writing statistics
get_writing_statistics(30) // Last 30 days

// Analyze story structure (requires Neo4j)
analyze_story_structure()

// Find character relationships in graph
find_character_relationships("CHARACTER-UUID")

// Create document relationship
create_relationship(
  "CHAPTER-1-UUID", "document",
  "CHAPTER-2-UUID", "document", 
  "FOLLOWS"
)
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

## 🛡️ Error Handling

The server includes robust error handling for:
- Invalid project paths
- Missing documents
- RTF parsing failures
- File system errors
- Malformed project structures
- Memory corruption recovery

## 👨‍💻 Development

```bash
npm run dev       # Development mode with hot reload
npm run build     # Build TypeScript
npm run lint      # ESLint
npm run typecheck # TypeScript checking
```

## 📋 Requirements

- Node.js 18+
- TypeScript 5.0+
- Valid Scrivener 3 project files

## 📜 License

MIT © [David Condrey](https://github.com/dcondrey)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 💖 Support

If you find this project helpful, consider:
- ⭐ Starring the repository
- 🐛 Reporting bugs or requesting features
- ☕ [Buying me a coffee](https://buymeacoffee.com/davidcondrey)
- 📣 Sharing with other Scrivener users

## 🔗 Links

- [GitHub Repository](https://github.com/dcondrey/scrivener-mcp)
- [NPM Package](https://www.npmjs.com/package/scrivener-mcp)
- [Issue Tracker](https://github.com/dcondrey/scrivener-mcp/issues)
- [Changelog](https://github.com/dcondrey/scrivener-mcp/releases)