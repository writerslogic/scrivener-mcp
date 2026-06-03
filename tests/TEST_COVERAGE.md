# Test Coverage

## Structure

```
tests/
  setup.ts                 # Jest setup (mocks, globals)
  sample-project.scriv/    # Fixture Scrivener project
  unit/                    # Unit tests (*.test.ts)
  integration/             # Integration tests (*.test.ts)
  manual/                  # Manual test scripts
```

## Running Tests

```bash
npm test                   # Run all tests
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:coverage      # With coverage report
npm run test:watch         # Watch mode
```

## Test Configuration

- **Runner**: Jest with ts-jest ESM preset
- **Config**: `jest.config.js` in project root
- **Timeout**: 30s per test
- **Coverage threshold**: 80% (branches, functions, lines, statements)

## Coverage Areas

### Unit Tests (`tests/unit/`)
- Cache service
- Compilation handlers
- Database migrations and Neo4j manager
- Handler argument extraction and validation
- LangChain multi-agent orchestration
- Content enhancement (LangChain enhancer)
- Scrivener project operations
- Project utilities

### Integration Tests (`tests/integration/`)
- End-to-end project workflows
- Utility adoption workflows
