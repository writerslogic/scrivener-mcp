# Contributing

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/scrivener-mcp.git
   cd scrivener-mcp
   ```
3. Install dependencies:
   ```bash
   npm install --legacy-peer-deps
   ```
4. Run the type checker:
   ```bash
   npm run typecheck
   ```
5. Run tests:
   ```bash
   npm test
   ```

## Development Workflow

```bash
npm run dev        # Start with hot reload
npm run build      # Build TypeScript to dist/
npm run typecheck  # Type check without emitting
npm run lint       # Run ESLint
npm test           # Run Jest tests
npm run test:unit  # Unit tests only
```

## Project Structure

```
src/
  index.ts                    # MCP server entry point
  scrivener-project.ts        # Core project class
  memory-manager.ts           # Project memory storage
  handlers/                   # MCP tool definitions
    types.ts                  # Shared types and argument extractors
    project-handlers.ts       # Project operations
    document-handlers.ts      # Document CRUD
    search-handlers.ts        # Search tools
    analysis-handlers.ts      # AI analysis tools
    compilation-handlers.ts   # Compilation tools
    memory-handlers.ts        # HMS semantic tools
    fractal-memory-handlers.ts# Fractal memory tools
    database/                 # Database-related handlers
  services/                   # Business logic
    memory/                   # Memory systems (HMS, fractal)
    ai/                       # AI service integrations
    enhancements/             # Content enhancement engine
  analysis/                   # Writing analysis modules
  core/                       # Logger, config, resilience
  utils/                      # Shared utilities
  types/                      # TypeScript types and generated types
tests/
  setup.ts                    # Jest setup
  unit/                       # Unit tests
  integration/                # Integration tests
  sample-project.scriv/       # Test fixture
```

## Code Conventions

- **TypeScript strict mode** -- no `any` on our own typed data
- **ESM modules** -- use `import`/`export`, never `require()` in production code
- **Async I/O** -- use `fs/promises`, never `readFileSync` in async methods
- **Logging** -- use `getLogger()` from `src/core/logger.ts`, never `console.log` (stdout corrupts MCP protocol)
- **Argument validation** -- use typed extractors from `src/handlers/types.ts` (`getStringArg`, `getOptionalNumberArg`, etc.)
- **IDs** -- use `crypto.randomUUID()`, never `Date.now() + Math.random()`
- **MCP responses** -- serialize data into the `text` field, never use a `data` property on content blocks

## Adding a New Tool

1. Define the tool in the appropriate handler file:
   ```typescript
   export const myToolHandler: ToolDefinition = {
     name: 'my_tool',
     description: 'What it does',
     inputSchema: {
       type: 'object',
       properties: {
         arg1: { type: 'string', description: '...' },
       },
       required: ['arg1'],
     },
     handler: async (args, context): Promise<HandlerResult> => {
       const arg1 = getStringArg(args, 'arg1');
       // ... implementation
       return {
         content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
       };
     },
   };
   ```

2. Add it to the tool array in the same file (e.g., `export const myTools = [myToolHandler, ...]`)

3. The tool array is picked up automatically by `src/handlers/index.ts`

4. Add a test in `tests/unit/handlers/`

## Writing Tests

Tests use Jest with ts-jest ESM. Follow existing patterns:

```typescript
import { myToolHandler } from '../../../src/handlers/my-handlers.js';

describe('myTool', () => {
  it('should validate required arguments', async () => {
    await expect(
      myToolHandler.handler({}, mockContext)
    ).rejects.toThrow();
  });

  it('should return results', async () => {
    const result = await myToolHandler.handler(
      { arg1: 'value' },
      mockContext
    );
    expect(result.content[0].text).toContain('expected');
  });
});
```

## Submitting a PR

1. Create a feature branch: `git checkout -b my-feature`
2. Make your changes
3. Ensure `npm run typecheck` passes with zero errors
4. Run `npm test` and verify no new failures
5. Commit with a descriptive message: `feat: add snapshot browsing tools`
6. Push and open a PR against `main`

Commit message prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

## HMS Native Module

The Holographic Memory System is a separate Rust crate at `/Volumes/A/HMS`. It's an optional dependency -- the server works without it. If you're working on HMS features:

```bash
cd /path/to/HMS
cargo test          # Run Rust tests
cargo build --features node-api  # Build napi bindings
```

Type declarations for `@hms/native` are stubbed in `src/types/hms-native.d.ts` so TypeScript compiles without the binary.

## Good First Issues

Check the [issue tracker](https://github.com/writerslogic/scrivener-mcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) for issues tagged "good first issue".
