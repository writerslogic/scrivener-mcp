# Architecture

## Overview

Scrivener MCP is a stdio-based MCP server written in TypeScript. It reads and writes Scrivener 3 project files directly (XML binder structure + RTF document files) and exposes 60+ tools over the Model Context Protocol via progressive skill-based registration.

```
Claude Desktop / Claude Code
        |
        | JSON-RPC over stdio
        |
   MCP Server (src/index.ts)
        |
   Handler Layer (src/handlers/)
        |
   +----+----+----+----+
   |    |    |    |    |
Project Memory  DB  Analysis  HMS
```

## Key Modules

### MCP Server (`src/index.ts`)

Entry point. Creates the MCP `Server` instance, initializes the skill registry, and routes incoming `CallToolRequest` messages to the appropriate handler.

### Skill Registry (`src/handlers/skill-registry.ts`)

Tools are organized into skills that load progressively to minimize token overhead:

| Skill | Tools | When Loaded |
|-------|-------|-------------|
| `project` | open_project, get_structure, refresh, close | Startup (always) |
| `documents` | read, write, create, delete, move, rename, metadata, word count | After open_project |
| `search` | search, trash, annotations, mentions, find_document | After open_project |
| `analysis` | analyze, enhance, generate, consistency, multi-agent | On demand via use_skill |
| `compilation` | compile, export, statistics | On demand via use_skill |
| `memory` | semantic search, analogies, dream | On demand via use_skill |
| `advanced` | fractal memory, async queue, batch ops | On demand via use_skill |

Two meta-tools (`list_skills`, `use_skill`) are always available. When a skill is activated, `sendToolListChanged` notifies the client to re-fetch the tool list.

### Handlers (`src/handlers/`)

Each handler file defines a set of MCP tools as `ToolDefinition` objects with:
- `name` -- tool name exposed to the client
- `description` -- concise (<40 char) description
- `inputSchema` -- JSON Schema with shared definitions from `shared-schemas.ts`
- `handler` -- async function that executes the tool

Arguments are validated using typed extractors (`getStringArg`, `getOptionalNumberArg`, etc.) from `src/handlers/types.ts`.

### Response Formatting (`src/core/response-formatter.ts`)

All tool outputs are optimized for token efficiency:
- `compact()` -- JSON serialization with null stripping, no indentation
- `formatPayload()` -- large results (>4K chars) spill to disk, return tracker ID + preview
- `formatError()` -- masks stack traces and internal paths into short actionable messages

### Scrivener Project (`src/scrivener-project.ts`)

Core class that manages an open Scrivener project. Handles:
- Loading and parsing the `.scrivx` XML file
- Reading/writing RTF document files from `Files/Data/`
- Binder item traversal (finding documents by UUID)
- Metadata updates (synopsis, notes, labels, status, custom metadata)
- Project saves (writing modified XML back to disk)

### Project Loader (`src/services/project-loader.ts`)

Handles file-level operations: finding the `.scrivx` file within a `.scriv` package, parsing XML, managing file locks, and saving.

### RTF Handler

Parses Scrivener's RTF format to extract plain text and formatting. Handles Scrivener-specific extensions (annotations, comments) and Unicode.

### Memory Manager (`src/memory-manager.ts`)

Persistent key-value storage for project memory (character profiles, plot threads, style guide, writing stats). Stored as JSON in `.ai-memory/` within the project.

### Content Analyzer (`src/analysis/`)

Writing quality analysis: readability scores (Flesch-Kincaid), sentence variety, vocabulary complexity, pacing, emotional arc, quality indicators (cliches, filter words).

### Content Enhancer (`src/services/enhancements/`)

Applies targeted improvements to text (12+ enhancement types). Uses the style guide when available.

### Holographic Memory System (`src/services/memory/hhm/`)

TypeScript wrapper around the `@hms/native` Rust binary. The Rust engine (`/Volumes/A/HMS`) implements Binary Spatter Code (BSC) in a 10,000-dimensional vector space for:
- Semantic encoding of text via character trigrams
- Approximate nearest neighbor search
- Analogical reasoning via vector arithmetic
- Concept synthesis via clustering

The wrapper adds metadata tracking, result mapping, and typed interfaces.

### Database Service (`src/handlers/database/`)

SQLite for structured data (writing sessions, content analysis history, entity relationships). Optional Neo4j for graph queries (character relationships, story structure, theme progression).

## Data Flow

### Reading a Document

```
read_document(id)
  -> document-handlers.ts validates args
  -> ScrivenerProject.readDocument(id)
  -> ProjectLoader finds the binder item by UUID
  -> Reads RTF from Files/Data/{UUID}/content.rtf
  -> RTFHandler extracts plain text
  -> Returns text in MCP response
```

### Writing a Document

```
write_document(id, content)
  -> document-handlers.ts validates args
  -> ScrivenerProject.writeDocument(id, content)
  -> Writes content to Files/Data/{UUID}/content.rtf
  -> HMS memorizes content (zero-copy for large docs)
  -> Returns success
```

### Semantic Search

```
semantic_search(query)
  -> memory-handlers.ts generates traceId
  -> HolographicMemorySystem.queryText(query, k, traceId)
  -> native.query(text, k, traceId) [Rust via napi-rs]
  -> HmsCore encodes query as EntangledHVec
  -> Approximate nearest neighbor search
  -> Returns ranked results with similarity scores
```

## Logging

All logging goes to stderr (never stdout, which is reserved for JSON-RPC). The logger in `src/core/logger.ts` writes to `process.stderr`.

## Error Handling

Errors use the `AppError` class with typed `ErrorCode` values. Handlers catch errors and return them as MCP error responses. HMS failures are non-fatal; the server continues operating without semantic features.

## Generated Types

The HMS Rust crate auto-generates TypeScript types via `ts-rs` and JSON schemas via `schemars`. Generated files live in `src/types/generated/`. A type stub at `src/types/hms-native.d.ts` allows compilation when the native binary is unavailable.
