#!/usr/bin/env bash
set -euo pipefail

# Build the React UI + transcript-watcher CLI from the desktop app and copy
# both into Android assets.
# Usage: ./scripts/build-web-ui.sh [/path/to/desktop]
# Defaults to the desktop/ directory in this repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="${1:-$REPO_ROOT/desktop}"
ASSETS_ROOT="$REPO_ROOT/app/src/main/assets"
ASSETS_DIR="$ASSETS_ROOT/web"

echo "Building React UI + transcript-watcher CLI from $DESKTOP_DIR..."
cd "$DESKTOP_DIR"
npm ci
npm run build

if [ ! -d "$DESKTOP_DIR/dist/renderer" ]; then
  echo "ERROR: Build output not found at $DESKTOP_DIR/dist/renderer"
  echo "       The desktop build may have failed. Check npm run build output above."
  exit 1
fi

echo "Copying React UI build output to $ASSETS_DIR..."
rm -rf "$ASSETS_DIR"
mkdir -p "$ASSETS_DIR"
cp -r "$DESKTOP_DIR/dist/renderer/"* "$ASSETS_DIR/"

# Transcript watcher CLI: produced by the build:cli step inside `npm run
# build` above. Same TypeScript code parses transcripts on Electron (in-
# process) and on Android (subprocess under Termux Node) — single source of
# truth for the most CC-coupled, highest-drift parser in the app.
# Bootstrap.deployTranscriptWatcherCli() picks this up at session start.
CLI_BUNDLE="$DESKTOP_DIR/dist/cli/transcript-watcher-cli.js"
if [ ! -f "$CLI_BUNDLE" ]; then
  echo "ERROR: transcript-watcher CLI bundle missing at $CLI_BUNDLE"
  echo "       Expected npm run build to produce it via the build:cli step."
  exit 1
fi
echo "Copying transcript-watcher CLI bundle to $ASSETS_ROOT/transcript-watcher-cli.js..."
cp "$CLI_BUNDLE" "$ASSETS_ROOT/transcript-watcher-cli.js"

echo "Done. Bundles ready under $ASSETS_ROOT/"
ls -lah "$ASSETS_ROOT/" | head -20
echo "  (web/ contains the React UI, transcript-watcher-cli.js is the Node helper)"
