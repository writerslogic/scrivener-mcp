# Contributing to scrivener-mcp

Thanks for your interest in improving scrivener-mcp. This document describes how to report issues,
set up a development environment, and submit changes.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you are
expected to uphold it.

## How to Contribute

### Reporting Issues

- Use the [issue templates](.github/ISSUE_TEMPLATE) for bugs and feature requests.
- **Do not** report security vulnerabilities in public issues — see [SECURITY.md](SECURITY.md) if
  present, or contact security@writerslogic.com.

### Development Setup

Requires **Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`** and Node-API 10, matching `package.json`; a
current Node 24 patch is recommended.

Builds and type checks use TypeScript 7 through the `@typescript/native` npm alias. Jest and ESLint
use the TypeScript 6 compatibility API installed as `typescript`, following the
[ts-jest migration guide](https://kulshekhar.github.io/ts-jest/docs/next/guides/typescript-7). Keep
both aliases when updating the compiler; replacing the API package with TypeScript 7 breaks these
tools.

```sh
git clone https://github.com/writerslogic/scrivener-mcp
cd scrivener-mcp
npm install
npm run build
npm test
```

### Making Changes

1. Create a topic branch off `main`.
2. Make focused, minimal changes; keep commits as single logical units.
3. Before opening a PR, the quality gate must be green:

    ```sh
    npm run format:check   # formatting
    npm run lint           # lints
    npm run typecheck      # types
    npm test               # tests
    ```

4. Add a regression test for every fix or new behavior where feasible.

For changes to fallback semantic indexing, run the deterministic benchmark:

```sh
node --import tsx scripts/benchmark-hms-fallback.ts 1000 3
```

It reports batch ingestion, first query (including deferred vector construction), and warm query
times for 1,000 documents at 512 dimensions over three repetitions. Compare batch plus first-query
time on the same runtime and hardware; batch time alone excludes deferred work.

### Tools and tests

Register new tools through `src/handlers/index.ts`, validate arguments with the existing typed
extractors, and return MCP text plus schema-validated structured content. Use `getLogger()` rather
than writing to stdout, which carries the MCP protocol.

Tests use Jest and ts-jest. During iteration, run the relevant suite:

```sh
npm test -- --runInBand --runTestsByPath tests/unit/path/to/change.test.ts
```

Keep regression tests for behavior, security, data integrity and concurrency. Prefer exercising a
real boundary over assertions on constants or mocks. Copy fixtures before modifying them, use
synthetic content, and keep credentials, local reports and workflow notes outside the public tree.

Run `npm run test:coverage -- --runInBand` to check the coverage floors in `jest.config.js`. Linux
Node 24 CI enforces them and retains the reports: 60% branches and 65% functions, lines and
statements globally, plus 80% branches and 85% other measures for six persistence and response
boundary files. Jest evaluates those files separately and subtracts them from the global group.
Coverage measures exercised code; it does not establish correctness. The existing collection scope
excludes the entrypoint, declarations, tests and `.cts` files.

### Code Style

- Match the surrounding idiom and naming. Keep comments only for non-obvious constraints.
- `npm run format` (Prettier) is the source of truth for formatting.
- Conventional commit subjects: `<type>: <description>` where
  `type ∈ fix | feat | refactor | test | docs | perf | security | chore`.

## Pull Request Process

- Fill out the [pull request template](.github/pull_request_template.md).
- Keep PRs scoped to one concern; link related issues.
- All CI checks must pass and at least one maintainer must approve.

## License and Contributor Agreement

scrivener-mcp is licensed under [AGPL-3.0](LICENSE). By contributing, you agree that your
contributions are licensed under the same terms.

For questions about the contributor agreement, contact: admin@writerslogic.com
