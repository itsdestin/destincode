#!/usr/bin/env bash
# Verify that every packaged macOS app under desktop/release/ is signed and sealed.
#
# WHY this exists: electron-builder SILENTLY skips macOS signing when it cannot sign,
# and a Dependabot bump did exactly that on 2026-07-23 (26.8.1 -> 26.15.3 dropped the
# ad-hoc fallback). Every Mac build from then to 2026-09-03 shipped without a seal,
# which macOS treats as a BROKEN app — no "Open Anyway" button, no way in — and not
# one check anywhere went red. Postmortem:
#   youcoded-dev/docs/active/investigations/2026-09-03-macos-beta72-unopenable-postmortem.md
#
# Both mac-producing workflows (desktop-release.yml, desktop-test-build.yml) call this
# ONE script so betas and releases are held to the same standard. Run from desktop/.
#
# What it asserts, per bundle:
#   1. `codesign --verify --deep --strict` passes. This is the verdict Gatekeeper
#      depends on and the exact check @electron/osx-sign runs after signing. It fails
#      both the beta.72 case ("code object is not signed at all") AND the subtler one
#      where a seal exists but no longer matches the bundle's contents — which a
#      "does _CodeSignature exist" test would wave through.
#   2. The signing identifier equals the bundle's own CFBundleIdentifier. An unsigned
#      build keeps the stock prebuilt Electron binary's identifier ("Electron"), so this
#      catches "the wrong thing got signed". Both values are read off the bundle, not
#      hard-coded, so a productName or appId change cannot desync them.
#
# CODESIGN / PLISTBUDDY overrides exist ONLY so the script can be exercised on Linux
# with stand-ins (tests/verify-mac-signature.test.ts). CI never sets them.
set -euo pipefail

CODESIGN="${CODESIGN:-codesign}"
PLISTBUDDY="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"
RELEASE_DIR="${1:-release}"

found=0
while IFS= read -r app; do
  found=$((found + 1))
  echo "checking $app"

  # 1. Ask macOS whether the seal is valid. Capture the output FIRST, then test the
  #    exit code — under `set -e` a failing command inside $(...) would abort the
  #    script before any ::error:: line ran, swallowing codesign's own explanation.
  if ! verify_out=$("$CODESIGN" --verify --deep --strict --verbose=2 "$app" 2>&1); then
    echo "::error::$app failed codesign --verify: ${verify_out:-<no output>}"
    exit 1
  fi

  # 2. Signing identifier must match what the bundle says it is.
  if ! details=$("$CODESIGN" -d --verbose=2 "$app" 2>&1); then
    echo "::error::codesign -d failed on $app: ${details:-<no output>}"
    exit 1
  fi
  ident=$(printf '%s\n' "$details" | sed -n 's/^Identifier=//p' | head -n1)
  if ! expected=$("$PLISTBUDDY" -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>&1); then
    echo "::error::could not read CFBundleIdentifier from $app/Contents/Info.plist: $expected"
    exit 1
  fi
  if [ -z "$ident" ] || [ "$ident" != "$expected" ]; then
    echo "::error::$app signing identifier is '${ident:-<none>}', expected '$expected' (Info.plist)"
    exit 1
  fi
  echo "  ok: $ident, $(printf '%s\n' "$details" | sed -n 's/^Signature=//p' | head -n1 | sed 's/^$/certificate/') signature"
done < <(find "$RELEASE_DIR" -maxdepth 2 -name '*.app' -type d)

if [ "$found" -eq 0 ]; then
  echo "::error::no .app bundle found under $RELEASE_DIR/ - did the mac build run?"
  exit 1
fi
echo "$found macOS bundle(s) signed and sealed"
