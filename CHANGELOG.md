# Changelog

## [0.3.0] - 2024-01-04

### Added
- **Memory Management System**
  - Persistent project memory stored in `.ai-memory` folder within each project
  - Character profiles with relationships and arc tracking
  - Plot thread management with status tracking
  - Style guide for maintaining consistent voice and tone
  - Writing statistics and progress tracking
  - Automatic backups with 7-day history

- **Advanced Content Analysis**
  - Deep writing metrics (Flesch scores, readability grades)
  - Style analysis (sentence variety, vocabulary complexity)
  - Structure analysis (scene breaks, chapters, pacing)
  - Quality indicators (clichés, filter words, repetitiveness)
  - Emotional analysis and tension tracking
  - Actionable writing suggestions

- **Content Enhancement Engine**
  - 12+ enhancement types for prose improvement
  - Filter word elimination
  - Verb strengthening
  - Sentence variation
  - Sensory detail enhancement
  - Show don't tell conversions
  - Pacing adjustments
  - Content expansion/condensing

- **New MCP Tools**
  - `deep_analyze_content` - Comprehensive content analysis
  - `enhance_content` - Apply writing improvements
  - `save_character_profile` - Store character data
  - `get_character_profiles` - Retrieve characters
  - `update_style_guide` - Set writing preferences
  - `get_style_guide` - Get style settings
  - `save_plot_thread` - Track plot lines
  - `get_plot_threads` - View plot threads
  - `get_writing_stats` - Project statistics
  - `export_project_memory` - Export all memory

### Changed
- `analyze_document` now uses the new ContentAnalyzer for deeper insights
- `critique_document` provides more detailed, actionable feedback

### Technical
- Added TypeScript modules: `memory-manager.ts`, `content-analyzer.ts`, `content-enhancer.ts`
- Memory data persists within Scrivener projects for portability
- Automatic 5-minute save intervals for memory updates

## [0.2.0] - 2024-01-04

### Added
- Automated Claude Desktop setup on installation
- Postinstall script for automatic configuration
- Setup and uninstall scripts for easy management

## [0.1.x] - 2024-01-03

### Initial Release
- Core Scrivener project operations
- RTF parsing and generation
- Basic content analysis
- Document CRUD operations
- Project structure navigation

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