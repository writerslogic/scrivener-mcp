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
- **Coverage threshold**: 5% globally (branches, functions, lines, statements), as configured in
  `jest.config.js`

## Coverage Areas

### Unit Tests (`tests/unit/`)

- Cache service
- Compilation handlers
- Database migrations and Neo4j manager
- Handler argument extraction and validation
- AI clients, collaboration, and content enhancement
- Native binder XML and RTF round trips
- Buffered write identity, revision conflicts, and draining in-flight writes and snapshots at
  shutdown
- Serialized memory persistence, corrupt-file refusal, and sorted-set restart round trips
- Fresh, case-sensitive, regex, metadata, and Trash content search
- Fallback semantic retrieval with consistent corpus vectors
- Predictive cache capacity, timer ownership, and disposal during in-flight work
- Scrivener project operations
- Project utilities

### Integration Tests (`tests/integration/`)

- End-to-end project workflows
- Utility adoption workflows
- SQLite sync isolation, metadata preservation, and durable queue partial successes
- Native SQLite transaction scopes, lifecycle ordering, busy retries, and completed backups
