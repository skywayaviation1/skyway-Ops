#!/bin/sh
# Injects the Firebase REVERSED_CLIENT_ID into the built app's Info.plist as a
# custom URL scheme. Firebase's OAuth provider flow (Microsoft sign-in) returns
# to the app through that scheme, so a missing entry produces a sign-in that
# opens the browser and never comes back.
#
# The value lives in GoogleService-Info.plist, which is per-Firebase-app and is
# deliberately not committed. Deriving it at build time keeps the checked-in
# project free of environment-specific identifiers.

set -e

PLIST_BUDDY=/usr/libexec/PlistBuddy
GOOGLE_PLIST="${SRCROOT}/App/GoogleService-Info.plist"
BUILT_PLIST="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"

if [ ! -f "${GOOGLE_PLIST}" ]; then
  echo "warning: GoogleService-Info.plist not found. Microsoft sign-in and push notifications will not work until it is added. See docs/mobile-app-store.md."
  exit 0
fi

REVERSED_CLIENT_ID=$("${PLIST_BUDDY}" -c "Print :REVERSED_CLIENT_ID" "${GOOGLE_PLIST}" 2>/dev/null || true)

if [ -z "${REVERSED_CLIENT_ID}" ]; then
  echo "warning: GoogleService-Info.plist has no REVERSED_CLIENT_ID. Enable an iOS OAuth client for this Firebase app, then re-download the file."
  exit 0
fi

# Rewrite rather than append so repeated builds cannot stack duplicate schemes.
"${PLIST_BUDDY}" -c "Delete :CFBundleURLTypes" "${BUILT_PLIST}" 2>/dev/null || true
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes array" "${BUILT_PLIST}"
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes:0 dict" "${BUILT_PLIST}"
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLName string ${PRODUCT_BUNDLE_IDENTIFIER}.firebaseauth" "${BUILT_PLIST}"
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "${BUILT_PLIST}"
"${PLIST_BUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${REVERSED_CLIENT_ID}" "${BUILT_PLIST}"

echo "Configured Firebase OAuth callback URL scheme."
