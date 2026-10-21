#!/bin/bash
# Builds, signs, notarizes and packages Draftbridge.app as a DMG (Apple silicon).
#
# Required for a signed build:
#   SIGN_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"
# Optional:
#   NOTARY_PROFILE  keychain profile created with `xcrun notarytool store-credentials`
#                   (omit to skip notarization)
#   NODE_LINE       Node.js major line to bundle (default v22)
#   SKIP_SIGN=1     unsigned build for local testing
#
# Licensing. A signed build must either carry license settings or say it is deliberately free:
#   LICENSE_PUBLIC_KEYS   kid=base64 pairs, comma separated; the 32-byte Ed25519 public key(s)
#   LICENSE_BASE_URL      https URL of the license service (activation and revocation list)
#   LICENSE_CHECKOUT_URL  https URL of the purchase page
#   LICENSE_PRICE         label shown in the app, e.g. "$14.99"
#   LICENSE_REQUIRE_ACTIVATION  "false" to skip the per-Mac activation (default true)
#   LICENSE_DISABLED=1    build with no licensing, as community builds from source are
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
APP_DIR="$ROOT/apps/mac"
BUILD="$APP_DIR/build"
NODE_LINE="${NODE_LINE:-v22}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
BUILD_NUMBER="${BUILD_NUMBER:-$(git -C "$ROOT" rev-list --count HEAD)}"
APP="$BUILD/Draftbridge.app"
RES="$APP/Contents/Resources"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = "arm64" ] || die "Build on an Apple silicon Mac."
if [ "${SKIP_SIGN:-}" != "1" ]; then
	[ -n "${SIGN_IDENTITY:-}" ] || die "Set SIGN_IDENTITY, or SKIP_SIGN=1 for an unsigned build."
fi

if [ -z "${LICENSE_PUBLIC_KEYS:-}" ] && [ "${SKIP_SIGN:-}" != "1" ] && [ "${LICENSE_DISABLED:-}" != "1" ]; then
	die "A signed build needs license settings (LICENSE_PUBLIC_KEYS and friends), or LICENSE_DISABLED=1 to ship it free on purpose."
fi

rm -rf "${BUILD:?}/Draftbridge.app"
BUILD="$BUILD" NODE_LINE="$NODE_LINE" "$HERE/stage-bundle.sh"

say "Assembling the app bundle"
mkdir -p "$RES" "$APP/Contents/MacOS"
cp -R "$BUILD/bundle/runtime" "$RES/runtime"
cp -R "$BUILD/bundle/server" "$RES/server"
cp "$BUILD/bundle/LICENSE" "$RES/LICENSE"

say "Compiling the app"
(cd "$APP_DIR" && swift build -c release --arch arm64 >/dev/null)
BIN_PATH="$(cd "$APP_DIR" && swift build -c release --arch arm64 --show-bin-path)"
cp "$BIN_PATH/ScrivenerMCP" "$APP/Contents/MacOS/ScrivenerMCP"

say "Generating the app icon"
ICONSET="$BUILD/stage-app/AppIcon.iconset"
mkdir -p "$ICONSET"
"$APP/Contents/MacOS/ScrivenerMCP" --render-icon "$ICONSET"
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUMBER/" "$HERE/Info.plist.template" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

PLIST="$APP/Contents/Info.plist"
if [ -n "${LICENSE_PUBLIC_KEYS:-}" ]; then
	[ -n "${LICENSE_BASE_URL:-}" ] && [ -n "${LICENSE_CHECKOUT_URL:-}" ] && [ -n "${LICENSE_PRICE:-}" ] \
		|| die "LICENSE_PUBLIC_KEYS needs LICENSE_BASE_URL, LICENSE_CHECKOUT_URL and LICENSE_PRICE."
	case "$LICENSE_BASE_URL$LICENSE_CHECKOUT_URL" in *http://*) die "License URLs must be https." ;; esac
	/usr/libexec/PlistBuddy -c "Add :DBLicensePublicKeys dict" "$PLIST"
	IFS=',' read -r -a pairs <<< "$LICENSE_PUBLIC_KEYS"
	for pair in "${pairs[@]}"; do
		kid="${pair%%=*}"; key="${pair#*=}"
		[ -n "$kid" ] && [ "$kid" != "$pair" ] || die "LICENSE_PUBLIC_KEYS entries look like kid=base64."
		[ "$(printf '%s' "$key" | base64 -D 2>/dev/null | wc -c | tr -d ' ')" = "32" ] || die "Public key '$kid' is not a 32-byte Ed25519 key in base64."
		/usr/libexec/PlistBuddy -c "Add :DBLicensePublicKeys:$kid string $key" "$PLIST"
	done
	/usr/libexec/PlistBuddy -c "Add :DBLicenseBaseURL string $LICENSE_BASE_URL" "$PLIST"
	/usr/libexec/PlistBuddy -c "Add :DBLicenseCheckoutURL string $LICENSE_CHECKOUT_URL" "$PLIST"
	/usr/libexec/PlistBuddy -c "Add :DBLicensePrice string $LICENSE_PRICE" "$PLIST"
	/usr/libexec/PlistBuddy -c "Add :DBLicenseRequireActivation bool ${LICENSE_REQUIRE_ACTIVATION:-true}" "$PLIST"
	say "Licensing is ON for this build"
elif [ "${SKIP_SIGN:-}" != "1" ] && [ "${LICENSE_DISABLED:-}" != "1" ]; then
	die "A signed build needs license settings (LICENSE_PUBLIC_KEYS and friends), or LICENSE_DISABLED=1 to ship it free on purpose."
else
	say "Licensing is OFF for this build"
fi

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
DMG="$BUILD/Draftbridge-$VERSION-arm64.dmg"
rm -f "$DMG"
DMG_STAGE="$BUILD/stage-app/dmg"
rm -rf "${BUILD:?}/stage-app/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -volname "Draftbridge" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG" >/dev/null
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
