# Publishing Guide

This guide covers how to publish `@mcp/scrivener` to various package management platforms.

## Prerequisites

1. **npm account**: Create at https://www.npmjs.com/signup
2. **Authentication**: Run `npm login` and enter your credentials
3. **Build the project**: `npm run build`
4. **Run tests**: `npm test`

## Publishing to npm

### First-time Setup

1. Verify package name availability:
   ```bash
   npm view @mcp/scrivener
   ```
   If the package doesn't exist, you're good to go.

2. Check your npm configuration:
   ```bash
   npm whoami
   npm config get registry
   ```

### Publishing Steps

1. **Update version** (following semantic versioning):
   ```bash
   npm version patch  # for bug fixes (0.1.0 → 0.1.1)
   npm version minor  # for new features (0.1.0 → 0.2.0)
   npm version major  # for breaking changes (0.1.0 → 1.0.0)
   ```

2. **Build and test**:
   ```bash
   npm run clean
   npm run build
   npm test
   ```

3. **Publish to npm**:
   ```bash
   npm publish --access public
   ```
   Note: The `--access public` flag is required for scoped packages.

4. **Create a git tag**:
   ```bash
   git push origin main --tags
   ```

## GitHub Releases

The project includes automated GitHub releases via `.github/workflows/release.yml`.

### Manual Release

1. **Create a new release** on GitHub:
   ```bash
   gh release create v0.1.0 \
     --title "Release v0.1.0" \
     --notes "Initial release of Scrivener MCP server" \
     --draft
   ```

2. **Attach build artifacts** (optional):
   ```bash
   npm pack
   gh release upload v0.1.0 mcp-scrivener-0.1.0.tgz
   ```

3. **Publish the release**:
   ```bash
   gh release edit v0.1.0 --draft=false
   ```

### Automated Release (via GitHub Actions)

Push a tag starting with `v`:
```bash
git tag v0.1.0
git push origin v0.1.0
```

This triggers the release workflow which:
- Builds the project
- Runs tests
- Creates a GitHub release
- Publishes to npm (if NPM_TOKEN secret is configured)

## Setting up Automated Publishing

### Configure npm Token for GitHub Actions

1. Generate an npm token:
   ```bash
   npm token create --read-only=false
   ```

2. Add to GitHub repository secrets:
   - Go to Settings → Secrets and variables → Actions
   - Add new secret: `NPM_TOKEN`
   - Paste your npm token

### Configure GitHub Token

The default `GITHUB_TOKEN` is automatically available in workflows.

## Package Registry Options

### 1. npm Registry (Recommended)
- **Pros**: Largest JavaScript package registry, best discoverability
- **Cons**: Public packages only (for free tier)
- **URL**: https://www.npmjs.com/package/@mcp/scrivener

### 2. GitHub Packages
- **Pros**: Integrated with GitHub, supports private packages
- **Cons**: Requires authentication to install
- **Setup**: Add to package.json:
  ```json
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
  ```

### 3. JSR (JavaScript Registry)
- **Pros**: Modern, TypeScript-first registry
- **Cons**: Newer, smaller ecosystem
- **Publish**: `npx jsr publish`

## Pre-publish Checklist

- [ ] Version updated in package.json
- [ ] CHANGELOG.md updated with release notes
- [ ] All tests passing (`npm test`)
- [ ] No ESLint warnings (`npm run lint`)
- [ ] Build successful (`npm run build`)
- [ ] README.md is up-to-date
- [ ] LICENSE file present
- [ ] No sensitive data in code or test files
- [ ] Dependencies up-to-date (`npm outdated`)

## Troubleshooting

### "402 Payment Required"
You're trying to publish a private package. Either:
- Use `npm publish --access public` for public packages
- Upgrade to npm paid plan for private packages

### "403 Forbidden"
- Not logged in: Run `npm login`
- Package name taken: Choose a different name
- No publish permissions: Check npm account

### "E404 Not Found"
For scoped packages, ensure the scope exists or use `--access public`

## Version Management

Follow semantic versioning (semver):
- **MAJOR** (1.0.0): Breaking API changes
- **MINOR** (0.1.0): New features, backward compatible
- **PATCH** (0.0.1): Bug fixes, backward compatible

Example version progression:
```
0.1.0 → 0.1.1 (bug fix)
0.1.1 → 0.2.0 (new feature)
0.2.0 → 1.0.0 (breaking change or stable release)
```

## Post-publish

After publishing:

1. **Verify installation works**:
   ```bash
   npm install -g @mcp/scrivener
   scrivener-mcp --version
   ```

2. **Update documentation**:
   - Add installation instructions to README
   - Update any version-specific documentation
   - Tweet/announce the release

3. **Monitor for issues**:
   - Check GitHub issues
   - Monitor npm download statistics
   - Respond to user feedback

## Unpublishing

If you need to unpublish (use sparingly):
```bash
npm unpublish @mcp/scrivener@0.1.0  # specific version
npm unpublish @mcp/scrivener --force  # entire package
```

Note: Unpublishing is discouraged after 72 hours and may be restricted.