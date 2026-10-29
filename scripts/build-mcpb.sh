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
BUILD="${BUILD:-$ROOT/build}"
OUT="${MCPB_OUT:-$ROOT/dist-mcpb}"
SRC="$BUILD/mcpb-src"
MCPB_CLI_VERSION="${MCPB_CLI_VERSION:-2.1.2}"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
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
    "search by meaning, get feedback on a chapter, and revise a scene. Close Scrivener before " +
    "applying edits. Proposed changes have previews, native snapshots, and guarded undo. " +
    "The server runs on your Mac. Text Claude reads from your project is sent to Claude under your " +
    "Claude account terms.",
  author: { name: "WritersLogic, Inc.", url: "https://github.com/writerslogic" },
  repository: { type: "git", url: "https://github.com/writerslogic/scrivener-mcp" },
  homepage: "https://writerslogic.com/scrivener-mcp",
  documentation: "https://github.com/writerslogic/scrivener-mcp/blob/main/docs/install-mac.md",
  support: "https://github.com/writerslogic/scrivener-mcp/issues",
  license: "AGPL-3.0-only",
  keywords: ["scrivener", "writing", "manuscript", "novel", "editing"],
  icon: "icon.png",
  screenshots: ["server/assets/infographics/capability-map.png"],
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
trap 'rm -rf "$CHECK"' EXIT
unzip -q "$ARCHIVE" -d "$CHECK"
[ -x "$CHECK/runtime/bin/node" ] || die "The bundled node lost its executable bit in the archive."
(cd "$CHECK" && CHECK="$CHECK" SCRIVENER_SOURCE_ROOT="$ROOT" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { handshake } = await import(pathToFileURL(process.env.SCRIVENER_SOURCE_ROOT + "/dist/setup/doctor.js").href);
const dir = process.env.CHECK;
const m = JSON.parse(readFileSync(dir + "/manifest.json", "utf8")).server.mcp_config;
const sub = (s) => s.replaceAll("${__dirname}", dir);
const result = await handshake({
  command: sub(m.command), args: m.args.map(sub),
  env: { ...m.env, HOME: dir, SCRIVENER_DATA_DIR: dir + "/state" }
}, 90000);
if (!result.ok) throw new Error(result.error);
console.log("extension started, " + result.toolCount + " tools");
')

shasum -a 256 "$ARCHIVE" | tee "$ARCHIVE.sha256"
say "Built $ARCHIVE"
