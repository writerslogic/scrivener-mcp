#!/bin/bash
# Stages the pieces both the Mac app and the Claude Desktop extension ship:
#   $BUILD/bundle/runtime/bin/node   a checksum-verified Node.js (Apple silicon)
#   $BUILD/bundle/server             the built server with production dependencies
# and proves the staged server starts under that Node.
#
# Environment: NODE_LINE (default v24), BUILD (default build).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD="${BUILD:-$ROOT/build}"
NODE_LINE="${NODE_LINE:-v24}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || die "Build on an Apple silicon Mac."
[[ "$NODE_LINE" =~ ^v[1-9][0-9]*$ ]] || die "NODE_LINE must be a stable major line such as v24."

mkdir -p "${BUILD:?}/cache"
BUILD="$(cd "$BUILD" && pwd)"
BUNDLE="$BUILD/bundle"
WORK="$BUILD/stage"
DOWNLOAD=""
SMOKE_HOME=""
cleanup() {
	[ -z "$DOWNLOAD" ] || rm -f "$DOWNLOAD"
	[ -z "$SMOKE_HOME" ] || rm -rf "$SMOKE_HOME"
}
trap cleanup EXIT
rm -rf "${BUILD:?}/bundle" "${BUILD:?}/stage"
mkdir -p "$BUNDLE/runtime/bin" "$WORK"

say "Building the TypeScript server"
(cd "$ROOT" && npm run build >/dev/null)

say "Fetching Node.js $NODE_LINE (checksum verified)"
BASE="https://nodejs.org/dist/latest-${NODE_LINE}.x"
curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 --proto '=https' --proto-redir '=https' --tlsv1.2 "$BASE/SHASUMS256.txt" -o "$BUILD/cache/SHASUMS256.txt"
LINE="$(grep "  node-v[0-9.]*-darwin-arm64\.tar\.gz\$" "$BUILD/cache/SHASUMS256.txt")"
EXPECTED="${LINE%% *}"
FILE="${LINE##* }"
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ && "$FILE" =~ ^node-v[0-9]+\.[0-9]+\.[0-9]+-darwin-arm64\.tar\.gz$ ]] || die "Unexpected Node.js checksum manifest."
NODE_VERSION="${FILE#node-}"
NODE_VERSION="${NODE_VERSION%-darwin-arm64.tar.gz}"
if [ -f "$BUILD/cache/$FILE" ]; then
	ACTUAL="$(shasum -a 256 "$BUILD/cache/$FILE" | cut -d ' ' -f 1)"
	[ "$ACTUAL" = "$EXPECTED" ] || rm -f "$BUILD/cache/$FILE"
fi
if [ ! -f "$BUILD/cache/$FILE" ]; then
	DOWNLOAD="$(mktemp "$BUILD/cache/.node-download.XXXXXX")"
	curl -fsSL --connect-timeout 15 --max-time 180 --retry 2 --proto '=https' --proto-redir '=https' --tlsv1.2 "https://nodejs.org/dist/$NODE_VERSION/$FILE" -o "$DOWNLOAD"
	ACTUAL="$(shasum -a 256 "$DOWNLOAD" | cut -d ' ' -f 1)"
	[ "$ACTUAL" = "$EXPECTED" ] || die "Checksum mismatch for $FILE"
	mv "$DOWNLOAD" "$BUILD/cache/$FILE"
	DOWNLOAD=""
fi
ACTUAL="$(shasum -a 256 "$BUILD/cache/$FILE" | cut -d ' ' -f 1)"
[ "$ACTUAL" = "$EXPECTED" ] || die "Checksum mismatch for $FILE"
mkdir -p "$WORK/node-full"
tar -xzf "$BUILD/cache/$FILE" -C "$WORK/node-full" --strip-components 1
FULL_NODE="$WORK/node-full/bin/node"

say "Staging the server with production dependencies"
SERVER="$WORK/server"
mkdir -p "$SERVER"
(cd "$ROOT" && npm pack --ignore-scripts --json --pack-destination "$WORK" > "$WORK/package-pack.json")
ARCHIVE="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0].filename)' "$WORK/package-pack.json")"
[[ "$ARCHIVE" =~ ^scrivener-mcp-[0-9A-Za-z.+-]+\.tgz$ ]] || die "Unexpected server package filename."
tar -xzf "$WORK/$ARCHIVE" -C "$SERVER" --strip-components 1
cp "$ROOT/package-lock.json" "$SERVER/package-lock.json"
(cd "$SERVER" && PATH="$WORK/node-full/bin:$PATH" npm ci --omit=dev --ignore-scripts --os=darwin --cpu=arm64 --no-audit --no-fund >/dev/null)

say "Verifying the bundled C2PA engine"
(cd "$SERVER" && "$FULL_NODE" scripts/check-c2pa-binding.mjs --packaged)

say "Verifying the shipped SQLite binary with the bundled Node"
(cd "$SERVER" && "$FULL_NODE" -e '
const Database = require("better-sqlite3");
const database = new Database(":memory:");
try {
	if (database.prepare("SELECT 1 AS ready").get().ready !== 1) {
		throw new Error("The bundled SQLite binary failed its query check");
	}
} finally {
	database.close();
}
')

say "Pruning files the server never loads"
find "${SERVER:?}/node_modules" -type f \( -name '*.map' -o \( \( -name '*.md' -o -name '*.markdown' \) ! -iname 'license*' ! -iname 'licence*' ! -iname 'copying*' ! -iname 'notice*' \) \) -delete
rm -rf "${SERVER:?}/node_modules/narrative-lens/artifacts" "${SERVER:?}/node_modules/narrative-lens/npm"
find "${SERVER:?}/node_modules" -name '*.node' \( -path '*linux*' -o -path '*win32*' -o -path '*darwin-x64*' \) -type f -delete

cp "$FULL_NODE" "$BUNDLE/runtime/bin/node"
cp "$WORK/node-full/LICENSE" "$BUNDLE/runtime/LICENSE"
cp -R "$SERVER" "$BUNDLE/server"
cp "$ROOT/LICENSE" "$BUNDLE/LICENSE"

say "Smoke test: the staged server must start under the bundled Node"
SMOKE_HOME="$(mktemp -d)"
if (cd "$SMOKE_HOME" && HOME="$SMOKE_HOME" SCRIVENER_DATA_DIR="$SMOKE_HOME/state" \
	SCRIVENER_DISABLE_KEY_DISCOVERY=1 SCRIVENER_LOCAL_ONLY=true \
	"$BUNDLE/runtime/bin/node" "$BUNDLE/server/dist/cli/setup.js" --json --check \
	--node "$BUNDLE/runtime/bin/node" --script "$BUNDLE/server/dist/index.js" --client claude-code > "$WORK/startup-report.json"); then
	SMOKE_STATUS=0
else
	SMOKE_STATUS=$?
fi
[ "$SMOKE_STATUS" -le 1 ] || die "Bundled setup helper exited with status $SMOKE_STATUS."
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(j.schemaVersion!==1||j.mode!=="check"||j.startup?.ok!==true||!Number.isSafeInteger(j.startup.toolCount)||j.startup.toolCount<1)process.exit(1);console.log("server started, "+j.startup.toolCount+" tools")' "$WORK/startup-report.json"

say "Verifying the staged package through real MCP sessions"
"$FULL_NODE" "$ROOT/scripts/check-release-smoke.mjs" --installed-server "$BUNDLE/server" \
	--npm-cli "$WORK/node-full/lib/node_modules/npm/bin/npm-cli.js"
