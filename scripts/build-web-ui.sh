#!/usr/bin/env bash
set -euo pipefail

# Build the React UI from the desktop repo and copy into mobile assets.
# Usage: ./scripts/build-web-ui.sh /path/to/destinclaude

DESKTOP_REPO="${1:?Usage: $0 /path/to/destinclaude}"
ASSETS_DIR="app/src/main/assets/web"

echo "Building React UI from $DESKTOP_REPO/desktop..."
cd "$DESKTOP_REPO/desktop"
npm ci
npm run build

echo "Copying build output to $ASSETS_DIR..."
cd -
rm -rf "$ASSETS_DIR"
mkdir -p "$ASSETS_DIR"
cp -r "$DESKTOP_REPO/desktop/dist/renderer/"* "$ASSETS_DIR/"

echo "Done. React UI bundled at $ASSETS_DIR/"
ls -lah "$ASSETS_DIR/"
