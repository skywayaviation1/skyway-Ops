#!/bin/bash
# One-command iOS bootstrap for the Skyway Ops app. Run this on a Mac from the
# repository root:
#
#   ./scripts/setup-ios.sh
#
# It installs dependencies, builds the web bundle, syncs the native project,
# reports anything that still needs a human, and opens Xcode.

set -euo pipefail

FAIL=0

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$1"; }
warn() { printf '    \033[33maction needed\033[0m %s\n' "$1"; }
fail() { printf '    \033[31mblocked\033[0m %s\n' "$1"; FAIL=1; }

step "Checking the machine"

if [ "$(uname -s)" != "Darwin" ]; then
  fail "iOS builds require macOS. Xcode does not run on $(uname -s)."
  exit 1
fi
ok "macOS $(sw_vers -productVersion)"

if ! xcode-select -p >/dev/null 2>&1; then
  fail "Xcode command line tools are missing. Install Xcode from the App Store, open it once to accept the license, then run: xcode-select --install"
  exit 1
fi

if [ -d "$(xcode-select -p)/Platforms/iPhoneOS.platform" ]; then
  ok "Xcode $(xcodebuild -version 2>/dev/null | head -n1 | awk '{print $2}')"
else
  fail "xcode-select points at the command line tools only. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Capacitor 8 needs Node 20 or newer. Found $(node -v 2>/dev/null || echo 'no node')."
  exit 1
fi
ok "Node $(node -v)"

step "Installing dependencies"
npm install --no-audit --no-fund
ok "dependencies installed"

step "Building the web bundle"
npm run build >/dev/null
ok "dist/ built"

step "Syncing the native iOS project"
npx cap sync ios
ok "ios/ synced"

step "Checking Firebase and signing prerequisites"

if [ -f "ios/App/App/GoogleService-Info.plist" ]; then
  ok "GoogleService-Info.plist present"
else
  warn "GoogleService-Info.plist is missing. In Firebase Console (project skyway-ops-app) add an iOS app with bundle ID com.flyskyway.ops, download the file, and save it to ios/App/App/GoogleService-Info.plist. The Xcode project already references it, so no dragging is required."
fi

step "Opening Xcode"
npx cap open ios

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '\033[31mSetup stopped early. Resolve the blocked items above.\033[0m\n'
  exit 1
fi

cat <<'NEXT'
Remaining steps inside Xcode (one time):

  1. Select the App target > Signing & Capabilities.
  2. Choose the Skyway development team. Automatic signing will create the
     provisioning profile for com.flyskyway.ops.
  3. Push Notifications is already enabled in the project. Confirm it appears,
     and add Background Modes > Remote notifications if it is not listed.
  4. Pick a physical iPhone as the run destination and press Run. Microsoft
     sign-in and push notifications cannot be verified on the Simulator.

See docs/mobile-app-store.md for App Store submission steps.
NEXT
