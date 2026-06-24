# Contributing to scrivener-mcp

Thanks for your interest in improving scrivener-mcp. This document describes how to
report issues, set up a development environment, and submit changes.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you are expected to uphold it.

## How to Contribute

### Reporting Issues

- Use the [issue templates](.github/ISSUE_TEMPLATE) for bugs and feature requests.
- **Do not** report security vulnerabilities in public issues — see
  [SECURITY.md](SECURITY.md) if present, or contact security@writerslogic.com.

### Development Setup

Requires **Node.js 18+**.

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

### Code Style

- Match the surrounding code's idiom, naming, and comment density.
- `npm run format` (Prettier) is the source of truth for formatting.
- Conventional commit subjects: `<type>: <description>` where
  `type ∈ fix | feat | refactor | test | docs | perf | security | chore`.

## Pull Request Process

- Fill out the [pull request template](.github/pull_request_template.md).
- Keep PRs scoped to one concern; link related issues.
- All CI checks must pass and at least one maintainer must approve.

## License and Contributor Agreement

scrivener-mcp is licensed under [AGPL-3.0](LICENSE). By contributing, you agree that
your contributions are licensed under the same terms.

For questions about the contributor agreement, contact: admin@writerslogic.com
