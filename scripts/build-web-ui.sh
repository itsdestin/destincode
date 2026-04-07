#!/usr/bin/env bash
set -euo pipefail

# Build the React UI from the desktop app and copy into mobile assets.
# Usage: ./scripts/build-web-ui.sh [/path/to/desktop]
# Defaults to the desktop/ directory in this repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="${1:-$REPO_ROOT/desktop}"
ASSETS_DIR="$REPO_ROOT/app/src/main/assets/web"

echo "Building React UI from $DESKTOP_DIR..."
cd "$DESKTOP_DIR"
npm ci
npm run build

echo "Copying build output to $ASSETS_DIR..."
rm -rf "$ASSETS_DIR"
mkdir -p "$ASSETS_DIR"
cp -r "$DESKTOP_DIR/dist/renderer/"* "$ASSETS_DIR/"

echo "Done. React UI bundled at $ASSETS_DIR/"
ls -lah "$ASSETS_DIR/"
