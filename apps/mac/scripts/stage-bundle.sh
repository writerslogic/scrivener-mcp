#!/bin/bash
# Stages the pieces both the Mac app and the Claude Desktop extension ship:
#   $BUILD/bundle/runtime/bin/node   a checksum-verified Node.js (Apple silicon)
#   $BUILD/bundle/server             the built server with production dependencies
# and proves the staged server starts under that Node.
#
# Environment: NODE_LINE (default v22), BUILD (default apps/mac/build).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
BUILD="${BUILD:-$ROOT/apps/mac/build}"
NODE_LINE="${NODE_LINE:-v22}"
BUNDLE="$BUILD/bundle"
WORK="$BUILD/stage"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || die "Build on an Apple silicon Mac."

mkdir -p "${BUILD:?}/cache"
rm -rf "${BUILD:?}/bundle" "${BUILD:?}/stage"
mkdir -p "$BUNDLE/runtime/bin" "$WORK"

say "Building the TypeScript server"
(cd "$ROOT" && npm run build >/dev/null)

say "Fetching Node.js $NODE_LINE (checksum verified)"
BASE="https://nodejs.org/dist/latest-${NODE_LINE}.x"
curl -fsSL --proto '=https' --tlsv1.2 "$BASE/SHASUMS256.txt" -o "$BUILD/cache/SHASUMS256.txt"
LINE="$(grep "  node-v[0-9.]*-darwin-arm64\.tar\.gz\$" "$BUILD/cache/SHASUMS256.txt")"
EXPECTED="${LINE%% *}"
FILE="${LINE##* }"
if [ ! -f "$BUILD/cache/$FILE" ]; then
	curl -fsSL --proto '=https' --tlsv1.2 "$BASE/$FILE" -o "$BUILD/cache/$FILE"
fi
ACTUAL="$(shasum -a 256 "$BUILD/cache/$FILE" | cut -d ' ' -f 1)"
[ "$ACTUAL" = "$EXPECTED" ] || die "Checksum mismatch for $FILE"
mkdir -p "$WORK/node-full"
tar -xzf "$BUILD/cache/$FILE" -C "$WORK/node-full" --strip-components 1
FULL_NODE="$WORK/node-full/bin/node"

say "Staging the server with production dependencies"
SERVER="$WORK/server"
mkdir -p "$SERVER"
cp -R "$ROOT/dist" "$SERVER/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$SERVER/"
(cd "$SERVER" && PATH="$WORK/node-full/bin:$PATH" npm ci --omit=dev --ignore-scripts --os=darwin --cpu=arm64 --no-audit --no-fund >/dev/null)

say "Installing the SQLite binary that matches the bundled Node"
(cd "$SERVER/node_modules/better-sqlite3" && "$FULL_NODE" ../prebuild-install/bin.js --runtime node --target "$("$FULL_NODE" -p process.versions.node)" >/dev/null)

say "Pruning files the server never loads"
find "${SERVER:?}/node_modules" \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -type f -delete
rm -rf "${SERVER:?}/node_modules/narrative-lens/artifacts" "${SERVER:?}/node_modules/narrative-lens/npm"
find "${SERVER:?}/node_modules" -name '*.node' \( -path '*linux*' -o -path '*win32*' -o -path '*darwin-x64*' \) -type f -delete

cp "$FULL_NODE" "$BUNDLE/runtime/bin/node"
cp -R "$SERVER" "$BUNDLE/server"
cp "$ROOT/LICENSE" "$BUNDLE/LICENSE"

say "Smoke test: the staged server must start under the bundled Node"
SMOKE_HOME="$(mktemp -d)"
# The helper exits 1 when a client is not configured, which is expected in an empty home.
(HOME="$SMOKE_HOME" "$BUNDLE/runtime/bin/node" "$BUNDLE/server/dist/cli/setup.js" --json --check \
	--node "$BUNDLE/runtime/bin/node" --script "$BUNDLE/server/dist/index.js" --client claude-code || true) \
	| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.startup||!j.startup.ok){console.error("Smoke test failed:",JSON.stringify(j.startup||j));process.exit(1)}console.log("server started, "+j.startup.toolCount+" tools")})'
