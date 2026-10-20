#!/bin/bash
# Builds, signs, notarizes and packages Scrivener MCP.app as a DMG (Apple silicon).
#
# Required for a signed build:
#   SIGN_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"
# Optional:
#   NOTARY_PROFILE  keychain profile created with `xcrun notarytool store-credentials`
#                   (omit to skip notarization)
#   NODE_LINE       Node.js major line to bundle (default v22)
#   SKIP_SIGN=1     unsigned build for local testing
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
APP_DIR="$ROOT/apps/mac"
BUILD="$APP_DIR/build"
NODE_LINE="${NODE_LINE:-v22}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
BUILD_NUMBER="${BUILD_NUMBER:-$(git -C "$ROOT" rev-list --count HEAD)}"
APP="$BUILD/Scrivener MCP.app"
RES="$APP/Contents/Resources"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = "arm64" ] || die "Build on an Apple silicon Mac."
if [ "${SKIP_SIGN:-}" != "1" ]; then
	[ -n "${SIGN_IDENTITY:-}" ] || die "Set SIGN_IDENTITY, or SKIP_SIGN=1 for an unsigned build."
fi

mkdir -p "${BUILD:?}/cache"
rm -rf "${BUILD:?}/stage" "${BUILD:?}/Scrivener MCP.app"
mkdir -p "$BUILD/stage"

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
mkdir -p "$BUILD/stage/node-full"
tar -xzf "$BUILD/cache/$FILE" -C "$BUILD/stage/node-full" --strip-components 1
FULL_NODE="$BUILD/stage/node-full/bin/node"

say "Staging the server with production dependencies"
SERVER="$BUILD/stage/server"
mkdir -p "$SERVER"
cp -R "$ROOT/dist" "$SERVER/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$SERVER/"
(cd "$SERVER" && PATH="$BUILD/stage/node-full/bin:$PATH" npm ci --omit=dev --ignore-scripts --os=darwin --cpu=arm64 --no-audit --no-fund >/dev/null)

say "Installing the SQLite binary that matches the bundled Node"
(cd "$SERVER/node_modules/better-sqlite3" && "$FULL_NODE" ../prebuild-install/bin.js --runtime node --target "$("$FULL_NODE" -p process.versions.node)" >/dev/null)

say "Pruning files the server never loads"
find "$SERVER/node_modules" \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -type f -delete
rm -rf "$SERVER/node_modules/narrative-lens/artifacts" "$SERVER/node_modules/narrative-lens/npm"
find "$SERVER/node_modules" -name '*.node' \( -path '*linux*' -o -path '*win32*' -o -path '*darwin-x64*' \) -type f -delete

say "Assembling the app bundle"
mkdir -p "$RES/runtime/bin" "$APP/Contents/MacOS"
cp "$FULL_NODE" "$RES/runtime/bin/node"
cp -R "$SERVER" "$RES/server"
cp "$ROOT/LICENSE" "$RES/LICENSE"

say "Smoke test: the staged server must start under the bundled Node"
SMOKE_HOME="$(mktemp -d)"
# The helper exits 1 when a client is not configured, which is expected in an empty home.
(HOME="$SMOKE_HOME" "$RES/runtime/bin/node" "$RES/server/dist/cli/setup.js" --json --check \
	--node "$RES/runtime/bin/node" --script "$RES/server/dist/index.js" --client claude-code || true) \
	| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.startup||!j.startup.ok){console.error("Smoke test failed:",JSON.stringify(j.startup||j));process.exit(1)}console.log("server started, "+j.startup.toolCount+" tools")})'

say "Compiling the app"
(cd "$APP_DIR" && swift build -c release --arch arm64 >/dev/null)
BIN_PATH="$(cd "$APP_DIR" && swift build -c release --arch arm64 --show-bin-path)"
cp "$BIN_PATH/ScrivenerMCP" "$APP/Contents/MacOS/ScrivenerMCP"

say "Generating the app icon"
ICONSET="$BUILD/stage/AppIcon.iconset"
mkdir -p "$ICONSET"
"$APP/Contents/MacOS/ScrivenerMCP" --render-icon "$ICONSET"
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUMBER/" "$HERE/Info.plist.template" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

if [ "${SKIP_SIGN:-}" != "1" ]; then
	say "Signing (hardened runtime)"
	# Innermost first: every Mach-O file under Resources, then the app itself.
	while IFS= read -r -d '' f; do
		if file "$f" | grep -q "Mach-O"; then
			case "$f" in
				*/runtime/bin/node) ent=(--entitlements "$HERE/entitlements-node.plist") ;;
				*) ent=() ;;
			esac
			codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" ${ent[@]+"${ent[@]}"} "$f"
		fi
	done < <(find "$RES" -type f -print0)
	codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
	codesign --verify --deep --strict --verbose=1 "$APP"
fi

say "Creating the disk image"
DMG="$BUILD/ScrivenerMCP-$VERSION-arm64.dmg"
rm -f "$DMG"
DMG_STAGE="$BUILD/stage/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -volname "Scrivener MCP" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG" >/dev/null
if [ "${SKIP_SIGN:-}" != "1" ]; then
	codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
fi

if [ "${SKIP_SIGN:-}" != "1" ] && [ -n "${NOTARY_PROFILE:-}" ]; then
	say "Notarizing (this can take several minutes)"
	xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
	xcrun stapler staple "$DMG"
	xcrun stapler validate "$DMG"
	spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
else
	say "Skipping notarization (set NOTARY_PROFILE to enable)"
fi

shasum -a 256 "$DMG" | tee "$DMG.sha256"
say "Built $DMG"
