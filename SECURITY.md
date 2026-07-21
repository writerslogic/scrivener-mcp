# Security Policy

## Supported Versions

Security fixes are applied to `main`; there is no long-term support branch yet.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Open a private advisory via
[GitHub Security Advisories](https://github.com/writerslogic/scrivener-mcp/security/advisories/new),
or email **admin@writerslogic.com**.

Please include a description of the vulnerability and its impact, steps to reproduce (without real
secrets or credentials), and the affected version/commit. You can expect an initial response within a
few days; coordinated disclosure is appreciated — please give a reasonable window to ship a fix before
publishing details.

## Supply-chain security

- All GitHub Actions are pinned to full commit SHAs.
- **OpenSSF Scorecard**, **Dependency Review**, and **Dependabot** run in CI.
- Releases are published with build provenance where the package registry supports it (see the badges
  and the release workflow).
