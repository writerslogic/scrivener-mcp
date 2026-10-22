#!/bin/bash
# Builds the one-click Claude Desktop extension (.mcpb) for Apple silicon Macs.
#
# The extension bundles its own Node.js. Claude Desktop runs ordinary Node extensions on its
# built-in Electron runtime, whose native-module ABI changes between releases, and this server
# uses native SQLite. Shipping our own Node (a "binary" server) keeps it independent of that.
#
# Output: dist-mcpb/scrivener-mcp-<version>-macos-arm64.mcpb and a .sha256 file.
# Environment: MCPB_CLI_VERSION to pin the packer (default below).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD="$ROOT/build"
OUT="$ROOT/dist-mcpb"
SRC="$BUILD/mcpb-src"
MCPB_CLI_VERSION="${MCPB_CLI_VERSION:-2.1.2}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCHIVE="$OUT/scrivener-mcp-$VERSION-macos-arm64.mcpb"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

BUILD="$BUILD" "$HERE/stage-bundle.sh"

say "Assembling the extension"
rm -rf "${SRC:?}"
mkdir -p "$SRC" "$OUT"
cp -R "$BUILD/bundle/runtime" "$SRC/runtime"
cp -R "$BUILD/bundle/server" "$SRC/server"
cp "$BUILD/bundle/LICENSE" "$SRC/LICENSE"

cp "$ROOT/assets/draftbridge/icon.png" "$SRC/icon.png"

say "Writing the manifest"
VERSION="$VERSION" SRC="$SRC" node -e '
const fs = require("fs");
const manifest = {
  manifest_version: "0.3",
  name: "scrivener-mcp",
  display_name: "Draftbridge for Scrivener",
  version: process.env.VERSION,
  description: "Let Claude read, search, and safely edit your Scrivener 3 projects.",
  long_description:
    "Draftbridge connects Claude to the Scrivener 3 projects on your Mac. Ask for word counts, " +
    "search by meaning, get feedback on a chapter, and revise a scene. It refuses to write while " +
    "Scrivener has the project open, and takes a Scrivener snapshot before risky edits. It runs " +
    "entirely on your Mac. Text Claude reads from your project is sent to Claude under your " +
    "Claude account terms.",
  author: { name: "WritersLogic, Inc.", url: "https://github.com/writerslogic" },
  repository: { type: "git", url: "https://github.com/writerslogic/scrivener-mcp" },
  homepage: "https://writerslogic.com/scrivener-mcp",
  documentation: "https://github.com/writerslogic/scrivener-mcp/blob/main/docs/install-mac.md",
  support: "https://github.com/writerslogic/scrivener-mcp/issues",
  license: "AGPL-3.0-only",
  keywords: ["scrivener", "writing", "manuscript", "novel", "editing"],
  icon: "icon.png",
  server: {
    type: "binary",
    entry_point: "runtime/bin/node",
    mcp_config: {
      command: "${__dirname}/runtime/bin/node",
      args: ["${__dirname}/server/dist/index.js"],
      env: { LOG_LEVEL: "ERROR" },
    },
  },
  tools_generated: true,
  compatibility: { platforms: ["darwin"] },
};
fs.writeFileSync(process.env.SRC + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
'

say "Validating and packing with @anthropic-ai/mcpb $MCPB_CLI_VERSION"
npx -y "@anthropic-ai/mcpb@$MCPB_CLI_VERSION" validate "$SRC/manifest.json"
rm -f "${ARCHIVE:?}"
npx -y "@anthropic-ai/mcpb@$MCPB_CLI_VERSION" pack "$SRC" "$ARCHIVE"

say "Verifying the packed extension launches the way Claude Desktop will launch it"
CHECK="$(mktemp -d)"
unzip -q "$ARCHIVE" -d "$CHECK"
[ -x "$CHECK/runtime/bin/node" ] || die "The bundled node lost its executable bit in the archive."
# Run the manifest's exact command, with ${__dirname} resolved, through an MCP handshake.
CHECK="$CHECK" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const dir = process.env.CHECK;
const m = JSON.parse(readFileSync(dir + "/manifest.json", "utf8")).server.mcp_config;
const sub = (s) => s.replaceAll("${__dirname}", dir);
const child = spawn(sub(m.command), m.args.map(sub), { env: { ...process.env, ...m.env }, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const timer = setTimeout(() => { console.error("handshake timed out"); child.kill(); process.exit(1); }, 90000);
child.stdout.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
      } else if (msg.id === 2) {
        console.log("extension started, " + msg.result.tools.length + " tools");
        clearTimeout(timer); child.kill(); process.exit(0);
      }
    } catch {}
  }
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb-check", version: "1" } } }) + "\n");
'

shasum -a 256 "$ARCHIVE" | tee "$ARCHIVE.sha256"
say "Built $ARCHIVE"
