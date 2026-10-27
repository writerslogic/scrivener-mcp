#!/bin/sh
# Scrivener MCP bootstrap for macOS and Linux.
#
# Makes sure a usable Node.js (version 22.13 or newer, with npx) exists, then runs scrivener-setup.
# If Node is missing it installs the official build into ~/.scrivener-mcp/node. That needs no
# administrator password and touches nothing else on the system.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/scripts/bootstrap-mac.sh | sh
#   Pass options to scrivener-setup after "sh -s --", for example: ... | sh -s -- --check
#   Set SCRIVENER_ASSUME_YES=1 to skip the question before downloading Node.
#   Set SCRIVENER_IGNORE_SYSTEM_NODE=1 to always use the private runtime.
#   Set SCRIVENER_SETUP_PACKAGE to install a different package spec (for testing).

set -eu

MIN_MAJOR=22
NODE_LINE="v22"
PRIVATE_DIR="$HOME/.scrivener-mcp/node"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

node_ok() {
	# $1 = path to a node binary
	[ -x "$1" ] || return 1
	ver=$("$1" -v 2>/dev/null) || return 1
	major=${ver#v}
	major=${major%%.*}
	case "$major" in ''|*[!0-9]*) return 1 ;; esac
	[ "$major" -ge "$MIN_MAJOR" ] || return 1
	[ -x "$(dirname "$1")/npx" ] || return 1
	return 0
}

find_node() {
	if [ -x "$PRIVATE_DIR/bin/node" ] && node_ok "$PRIVATE_DIR/bin/node"; then
		printf '%s' "$PRIVATE_DIR/bin/node"
		return 0
	fi
	# Set SCRIVENER_IGNORE_SYSTEM_NODE=1 to use only the private runtime.
	[ "${SCRIVENER_IGNORE_SYSTEM_NODE:-}" = "1" ] && return 1
	for candidate in \
		"$(command -v node 2>/dev/null || true)" \
		/opt/homebrew/bin/node \
		/usr/local/bin/node \
		"$HOME/.volta/bin/node"; do
		[ -n "$candidate" ] && node_ok "$candidate" && { printf '%s' "$candidate"; return 0; }
	done
	for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
		[ -e "$candidate" ] && node_ok "$candidate" && { printf '%s' "$candidate"; return 0; }
	done
	return 1
}

install_private_node() {
	os=$(uname -s)
	arch=$(uname -m)
	case "$os" in
		Darwin) platform="darwin" ;;
		Linux) platform="linux" ;;
		*) die "Unsupported system: $os" ;;
	esac
	case "$arch" in
		arm64|aarch64) cpu="arm64" ;;
		x86_64) cpu="x64" ;;
		*) die "Unsupported processor: $arch" ;;
	esac

	say "Node.js $MIN_MAJOR or newer was not found on this Mac."
	say "This will download the official Node.js ${NODE_LINE} build from nodejs.org into:"
	say "  $PRIVATE_DIR"
	say "It needs no administrator password and changes nothing else."
	if [ "${SCRIVENER_ASSUME_YES:-}" != "1" ]; then
		if [ -r /dev/tty ]; then
			printf 'Continue? (Y/n) '
			read -r answer < /dev/tty || answer=""
			case "$answer" in ''|y|Y|yes|Yes) ;; *) die "Cancelled. Nothing was installed." ;; esac
		else
			die "Cannot ask for confirmation here. Re-run with SCRIVENER_ASSUME_YES=1 to allow the download."
		fi
	fi

	base="https://nodejs.org/dist/latest-${NODE_LINE}.x"
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT

	say "Looking up the latest Node.js ${NODE_LINE} release..."
	curl -fsSL --proto '=https' --tlsv1.2 "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
		|| die "Could not reach nodejs.org. Check your internet connection and try again."

	line=$(grep "  node-v[0-9.]*-${platform}-${cpu}\.tar\.gz\$" "$tmp/SHASUMS256.txt" || true)
	[ -n "$line" ] || die "No matching Node.js build for ${platform}-${cpu}."
	expected=${line%% *}
	file=${line##* }

	say "Downloading $file..."
	curl -fL --progress-bar --proto '=https' --tlsv1.2 "$base/$file" -o "$tmp/$file" \
		|| die "Download failed."

	actual=$(shasum -a 256 "$tmp/$file" | cut -d ' ' -f 1)
	[ "$actual" = "$expected" ] || die "Checksum mismatch for $file. Nothing was installed."

	rm -rf "$PRIVATE_DIR.new"
	mkdir -p "$PRIVATE_DIR.new"
	tar -xzf "$tmp/$file" -C "$PRIVATE_DIR.new" --strip-components 1
	rm -rf "$PRIVATE_DIR"
	mv "$PRIVATE_DIR.new" "$PRIVATE_DIR"
	say "Installed Node.js $("$PRIVATE_DIR/bin/node" -v)."
}

NODE_BIN=$(find_node || true)
if [ -z "$NODE_BIN" ]; then
	install_private_node
	NODE_BIN="$PRIVATE_DIR/bin/node"
fi

BIN_DIR=$(dirname "$NODE_BIN")
say "Using Node.js $("$NODE_BIN" -v) at $NODE_BIN"

PATH="$BIN_DIR:$PATH"
export PATH
exec "$BIN_DIR/npx" -y -p "${SCRIVENER_SETUP_PACKAGE:-scrivener-mcp}" scrivener-setup "$@"
