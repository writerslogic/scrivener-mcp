# Marginalia for Scrivener (Mac app)

A small native app that connects AI apps (Claude Desktop, BoltAI, Raycast, LM Studio, Cursor, VS Code, Claude Code) to Scrivener projects without Terminal, Node.js, or editing JSON.

It bundles a pinned Node.js runtime and the server, so it works on a Mac with nothing else installed. It does not run the server itself; each AI app launches the bundled server on demand. The app only writes the connection settings, repairs them, and tests that the server starts.

## How it works

The app runs the bundled `scrivener-setup` helper (`dist/cli/setup.js`) with `--json` and shows the result. All config logic lives in one place, the TypeScript helper, which is covered by its own tests. The Swift side decodes the helper's `schemaVersion 1` report and never edits another app's files itself.

| Piece | Where |
|---|---|
| Report types, state mapping, process runner, locator, update check | `Sources/Core` (tested) |
| SwiftUI window, menu bar item, preview renderer | `Sources/App` |
| Build, sign, notarize, DMG | `scripts/build-app.sh` |

## Develop

```bash
cd apps/mac
swift test                                   # unit tests
swift build
# Run against a built checkout instead of the bundled server:
SCRIVENER_MCP_DEV_ROOT=/path/to/scrivener-mcp .build/debug/ScrivenerMCP
# Render every screen to PNG (light and dark) for review:
.build/debug/ScrivenerMCP --render-previews /tmp/previews
```

## Build a DMG

Apple silicon only; the app needs macOS 14 or later.

```bash
# Unsigned, for local testing
SKIP_SIGN=1 apps/mac/scripts/build-app.sh

# Signed with a Developer ID certificate
SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" apps/mac/scripts/build-app.sh

# Signed and notarized
xcrun notarytool store-credentials scrivener-notary   # once
SIGN_IDENTITY="..." NOTARY_PROFILE=scrivener-notary apps/mac/scripts/build-app.sh
```

The script downloads the Node.js release for the pinned line and verifies its SHA-256, installs production dependencies, fetches the SQLite binary that matches the bundled Node, starts the staged server as a smoke test, builds the app, generates the icon, signs every Mach-O file with the hardened runtime, builds the DMG, and optionally notarizes and staples it. The result is `apps/mac/build/Marginalia-<version>-arm64.dmg` plus a checksum.

The bundled Node needs two entitlements for V8 (`entitlements-node.plist`). Everything else runs with the plain hardened runtime.

## Before the first public release

- Notarize with a real credential profile and confirm `spctl --assess` accepts the DMG on a clean Mac.
- Decide the publisher identity. A certificate in a person's name shows that name in Gatekeeper dialogs.
- Review the Scrivener trademark guidance before choosing the final app name.
- Add an Intel build if wanted: bundle an x64 Node and the x64 native modules, then merge them with `lipo`.
- Add automatic updates (Sparkle) once release signing keys exist. Today the app only shows a banner when a newer GitHub release exists.
