#!/bin/sh
# Injects the Firebase OAuth callback URL scheme into the built app's
# Info.plist. Firebase's OAuth provider flow (Microsoft sign-in) returns to the
# app through that scheme, so a missing entry produces a sign-in that opens the
# browser and never comes back.
#
# Prefer REVERSED_CLIENT_ID from GoogleService-Info.plist. Firebase iOS apps
# with no Google OAuth client omit that key and fall back to the Encoded App
# ID: "app-" plus GOOGLE_APP_ID, with ":" replaced by "-". The plist is
# per-Firebase-app and is deliberately not committed. Deriving the scheme at
# build time keeps the checked-in project free of environment-specific
# identifiers.

set -e

PLIST_BUDDY=/usr/libexec/PlistBuddy
GOOGLE_PLIST="${SRCROOT}/App/GoogleService-Info.plist"
BUILT_PLIST="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"

if [ ! -f "${GOOGLE_PLIST}" ]; then
  echo "warning: GoogleService-Info.plist not found. Microsoft sign-in and push notifications will not work until it is added. See docs/mobile-app-store.md."
  exit 0
fi

REVERSED_CLIENT_ID=$("${PLIST_BUDDY}" -c "Print :REVERSED_CLIENT_ID" "${GOOGLE_PLIST}" 2>/dev/null || true)

if [ -n "${REVERSED_CLIENT_ID}" ]; then
  URL_SCHEME="${REVERSED_CLIENT_ID}"
else
  GOOGLE_APP_ID=$("${PLIST_BUDDY}" -c "Print :GOOGLE_APP_ID" "${GOOGLE_PLIST}" 2>/dev/null || true)
  if [ -z "${GOOGLE_APP_ID}" ]; then
    echo "error: GoogleService-Info.plist has neither REVERSED_CLIENT_ID nor GOOGLE_APP_ID. Microsoft sign-in cannot register a callback URL scheme."
    exit 1
  fi
  # Firebase Encoded App ID, e.g. app-1-12464871520-ios-6e86ce57c35c7b97d2cb05
  URL_SCHEME="app-$(printf '%s' "${GOOGLE_APP_ID}" | tr ':' '-')"
fi

# Rewrite rather than append so repeated builds cannot stack duplicate schemes.
"${PLIST_BUDDY}" -c "Delete :CFBundleURLTypes" "${BUILT_PLIST}" 2>/dev/null || true
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes array" "${BUILT_PLIST}"
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes:0 dict" "${BUILT_PLIST}"
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLName string ${PRODUCT_BUNDLE_IDENTIFIER}.firebaseauth" "${BUILT_PLIST}"
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "${BUILT_PLIST}"
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${URL_SCHEME}" "${BUILT_PLIST}"

echo "Configured Firebase OAuth callback URL scheme."
