# Install on Windows

The public server and setup CLI provide all editorial features. Node.js 22.13.0 or newer is
required; use the official Windows installer from [nodejs.org](https://nodejs.org/en/download),
including npm. Node 22 and 24 are the CI targets. Scrivener 3 projects use a `.scriv` directory
containing a `.scrivx` file.

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

The compatibility matrix distinguishes Windows-shaped fixtures tested on macOS from native Windows
execution. Native Windows CI is configured; a local macOS session cannot verify Windows process
launching or a live Scrivener installation.
