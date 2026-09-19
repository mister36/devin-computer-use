#!/usr/bin/env bash
# Build Devin Computer Use.app from helper/ and install it to ~/Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_DIR="$ROOT/helper"
APP_NAME="Devin Computer Use"
BUNDLE_ID="ai.devin.computer-use.helper"
IDENTITY="${CODESIGN_IDENTITY:--}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-app: macOS is required to build the helper app." >&2
  exit 1
fi
if ! command -v swift >/dev/null 2>&1; then
  echo "build-app: swift not found. Install the Xcode Command Line Tools." >&2
  exit 1
fi

echo "==> swift build -c release"
(cd "$HELPER_DIR" && swift build -c release)

BINARY="$HELPER_DIR/.build/release/DevinComputerUseHelper"
if [[ ! -x "$BINARY" ]]; then
  echo "build-app: expected binary at $BINARY" >&2
  exit 1
fi

APP="$ROOT/dist/$APP_NAME.app"
echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BINARY" "$APP/Contents/MacOS/DevinComputerUseHelper"
cp "$HELPER_DIR/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> codesign (identity: $IDENTITY)"
codesign --force --deep -s "$IDENTITY" --identifier "$BUNDLE_ID" "$APP"

DEST="$HOME/Applications"
mkdir -p "$DEST"
if [[ -d "$DEST/$APP_NAME.app" ]]; then
  # Quit any running copy so the new binary is what gets launched next.
  pkill -x DevinComputerUseHelper 2>/dev/null || true
fi
rm -rf "$DEST/$APP_NAME.app"
cp -R "$APP" "$DEST/"

# Ad-hoc signatures are identified by TCC via the binary's cdhash, so every
# rebuild invalidates previous Accessibility / Screen Recording grants while
# System Settings keeps showing the stale toggle as "on". Clear the stale
# entries so the helper prompts again cleanly.
if [[ "$IDENTITY" == "-" ]]; then
  tccutil reset Accessibility "$BUNDLE_ID" >/dev/null 2>&1 || true
  tccutil reset ScreenCapture "$BUNDLE_ID" >/dev/null 2>&1 || true
fi

# Register with LaunchServices so `open -a "$APP_NAME"` resolves immediately.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$DEST/$APP_NAME.app" >/dev/null 2>&1 || true
fi

cat <<EOF

Installed $APP_NAME.app to $DEST

Next steps:
  1. devin-computer-use open-app
  2. Grant Accessibility and Screen Recording to "$APP_NAME" when prompted
     (System Settings > Privacy & Security).
  3. devin-computer-use install && devin-computer-use doctor
EOF
