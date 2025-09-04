# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2024-01-03

### Added
- Initial release of Scrivener MCP Server
- Complete MCP interface for Scrivener project manipulation
- Full RTF parsing and generation with Scrivener-specific features
- 14 MCP tools for comprehensive Scrivener integration:
  - `open_project` - Open Scrivener projects
  - `get_structure` - Navigate project hierarchy
  - `read_document` - Read document content
  - `read_document_formatted` - Read with RTF formatting
  - `write_document` - Write content to documents
  - `create_document` - Create new documents/folders
  - `delete_document` - Delete documents/folders
  - `move_document` - Move documents in hierarchy
  - `update_metadata` - Manage document metadata
  - `search_content` - Full-text search with regex support
  - `compile_documents` - Compile multiple documents
  - `get_word_count` - Word and character counting
  - `analyze_document` - Writing quality metrics
  - `critique_document` - Constructive writing feedback
  - `get_project_metadata` - Project-level metadata
  - `get_document_annotations` - Extract Scrivener annotations
- RTF format support with:
  - Unicode and special character handling
  - Format preservation (bold, italic, underline)
  - Scrivener annotation extraction
- Writing analysis features:
  - Readability metrics (Flesch Reading Ease)
  - Sentence structure analysis
  - Passive voice detection
  - Word frequency analysis
- Document critique with focus areas:
  - Structure and flow
  - Clarity and style
  - Dialogue and pacing
  - Character development
- Comprehensive error handling and recovery
- Full TypeScript support with type definitions
- Extensive test coverage
- Publishing configuration for npm

### Technical Details
- Built with TypeScript and ES modules
- Uses MCP SDK for protocol implementation
- Supports Node.js 18+
- Includes RTF parser with fallback mechanisms
- XML-based Scrivener project manipulation

[0.1.0]: https://github.com/dcondrey/scrivener-mcp/releases/tag/v0.1.0