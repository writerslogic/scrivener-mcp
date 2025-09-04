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

### Content Analysis
- **Search Functionality**: Full-text search across documents with regex support
- **Word Counting**: Per-document or project-wide word and character counts
- **Writing Analysis**: Readability metrics, sentence structure analysis, passive voice detection
- **Document Critique**: Constructive feedback on structure, flow, clarity, and style

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
- `analyze_document(documentId)` - Analyze writing quality metrics
- `critique_document(documentId, focusAreas?)` - Get constructive feedback
- `compile_documents(documentIds, separator?, preserveFormatting?)` - Compile multiple documents

## RTF Format Support

This MCP server includes comprehensive RTF (Rich Text Format) support specifically designed for Scrivener's document format:

- **RTF Parsing**: Converts RTF to structured content with formatting preserved
- **RTF Generation**: Creates valid RTF from plain or formatted text
- **Scrivener Extensions**: Handles Scrivener-specific RTF extensions and annotations
- **Character Encoding**: Properly handles Unicode and special characters
- **Metadata Extraction**: Extracts document metadata from RTF info groups

## Architecture

- `ScrivenerProject` - Main class for project operations
- `RTFHandler` - Comprehensive RTF parsing and generation
- MCP Server - Tool definitions and request handling

## Error Handling

The server includes robust error handling for:
- Invalid project paths
- Missing documents
- RTF parsing failures
- File system errors
- Malformed project structures

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