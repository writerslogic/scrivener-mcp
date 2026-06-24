# Security Policy

## Reporting a Vulnerability

scrivener-mcp is an MCP server that reads and writes a user's manuscript project, so
issues that could corrupt project data, escape the project directory, or expose
content are in scope. Please do not open a public issue for security problems.

Report vulnerabilities by:
- Opening a [draft security advisory](https://github.com/writerslogic/scrivener-mcp/security/advisories/new) on GitHub
- Contacting security@writerslogic.com

We will acknowledge your report within 48 hours.

## Of particular interest
- **Path traversal / project escape.** Any way for a tool call to read or write files
  outside the intended Scrivener project.
- **Content exposure.** Any path that sends manuscript content somewhere the user did
  not intend.
