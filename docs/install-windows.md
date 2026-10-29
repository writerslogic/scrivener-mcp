# Install on Windows

The public server and setup CLI provide all editorial features. Use stable Node.js satisfying
`^22.23.4 || ^24.22.1 || >=26.12.1`, with Node-API 10 or newer. Node 24.22.1 or a newer Node 24 patch
is recommended; install the official Windows distribution from
[nodejs.org](https://nodejs.org/en/download), including npm. The pinned CAI native SDK requires these
patched TLS floors in addition to SQLite 13's Node-API requirement. Node 23/25 and lower patches on
22/24/26 are excluded. Scrivener 3 projects use a `.scriv` directory containing a `.scrivx` file.

In PowerShell:

```powershell
node --version
npm.cmd install --global scrivener-mcp
scrivener-setup.cmd --client claude-desktop
scrivener-setup.cmd --check --json
```

Setup backs up an existing client file before changing it. Restart the selected client after setup.
Use `--client cursor`, `--client vscode` or another identifier printed by
`scrivener-setup.cmd --help` to select a different client. Claude Code uses `--client claude-code`.

For a manual entry without changing configuration:

```powershell
scrivener-setup.cmd --print
```

The Windows entry runs npm's `npx-cli.js` through the absolute `node.exe` path, avoiding a
shell-dependent `.cmd` launch inside the MCP client. Keep the Node installation in place after
setup. [Client setup](CLIENT_SETUP.md) documents supported configuration formats and locations.

Run a real first session in an isolated, newly created sample directory:

```powershell
scrivener-setup.cmd --demo
```

The command starts the server, opens an original CC0 sample copy, runs local analysis and previews a
persisted edit. It verifies the sample manuscript is unchanged. It changes no client configuration
and uses no provider key or client sampling.
`--demo-dir C:\Users\YourName\Documents\NewSampleSession` keeps the sample at an explicitly selected
**new** directory; existing directories are refused.

For this unreleased local checkout, build and exercise the candidate directly:

```powershell
npm.cmd ci
npm.cmd run build
node dist/cli/setup.js --demo --node (Get-Command node).Source --script (Join-Path $PWD 'dist/index.js')
```

The [compatibility matrix](SCRIVENER_COMPATIBILITY.md) distinguishes Windows-shaped fixtures tested
on macOS from native Windows execution. Native Windows CI is configured, but the patched-floor and
new C2PA native-matrix results remain pending until the respective checks complete. A local macOS
session cannot verify Windows process launching or a live Scrivener installation. See
[Content Credentials](content-credentials.md) for native SDK availability, format/mode evidence and
offline signing/validation limits.
