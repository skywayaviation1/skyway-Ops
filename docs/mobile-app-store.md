# Skyway Ops mobile release guide

Skyway Ops now has bundled Capacitor projects for iOS and Android. The mobile
apps use the existing React UI and Firestore data model while providing native
Microsoft authentication, Firebase push messaging, app lifecycle handling,
network state, status-bar behavior, and native-safe screen insets.

## Requirements

- Node.js 22+
- iOS: macOS, Xcode 26+, an Apple Developer account, and an App Store Connect
  app whose bundle ID is `com.flyskyway.ops`
- Android: Android Studio 2025.2.1+, JDK 21+, and a Play Console app whose
  application ID is `com.flyskyway.ops`
- Access to the `skyway-ops-app` Firebase project
- A deployed production API. Mobile builds default to
  `https://skyway-ops.vercel.app`; set `VITE_API_BASE_URL` at build time if the
  canonical production URL changes.

Capacitor 8 targets iOS 15+ and Android 7+ (API 24) and compiles Android against
API 36.

## What the repository already configures

The Xcode project is committed pre-wired, so the usual manual capability setup
is unnecessary:

- Bundle identifier `com.flyskyway.ops`, iOS 15 deployment target, iPhone and
  iPad device families
- Push Notifications capability and `App.entitlements` with `aps-environment`
- `Background Modes > Remote notifications` and camera, location, and photo
  usage strings in `Info.plist`
- A `GoogleService-Info.plist` reference in the App target, so the file only has
  to be saved to the expected path
- A build phase that reads `REVERSED_CLIENT_ID` from `GoogleService-Info.plist`
  and injects the Microsoft OAuth callback URL scheme automatically
- `FirebaseApp.configure()` and the Firebase OAuth/push delegate callbacks in
  `AppDelegate.swift`

What still requires a human: Apple/Google account registration, downloading the
Firebase platform files, and selecting a signing team.

## One-time Firebase setup

1. In Firebase Console, add an Android app with package
   `com.flyskyway.ops`. Download `google-services.json` to
   `android/app/google-services.json`.
2. Add an iOS app with bundle ID `com.flyskyway.ops`. Download
   `GoogleService-Info.plist` to `ios/App/App/GoogleService-Info.plist`. Do not
   drag it into Xcode; the project already references that path.
3. Keep Microsoft enabled in Firebase Authentication. In the Entra app
   registration, keep Firebase's documented Web redirect URI configured.
4. Create or select an APNs auth key in Apple Developer and upload it in
   Firebase Console under **Project Settings > Cloud Messaging**.

The Firebase platform files and signing keys are intentionally ignored by Git.

## Build and run

### iOS (macOS only)

```bash
./scripts/setup-ios.sh
```

The script verifies macOS, Xcode, and Node, installs dependencies, builds the
web bundle, syncs the native project, reports any missing Firebase file, and
opens Xcode. Then, in Xcode, select the Skyway team under **Signing &
Capabilities**, choose a physical iPhone, and run the `App` scheme.

To rebuild after web code changes:

```bash
npm run mobile:ios
```

Microsoft login and push notifications must be verified on physical devices;
neither works on the Simulator.

### Android

```bash
npm run mobile:android
```

Select a device or emulator in Android Studio and run the `app` configuration.

## Release builds

### iOS

1. Set the marketing version and build number in Xcode.
2. Confirm the App target uses `com.flyskyway.ops` and the production signing
   team. Automatic signing promotes `aps-environment` to `production` on export,
   so the committed development value does not need editing.
3. Use **Product > Archive**, validate the archive, then upload to App Store
   Connect.
4. Distribute through TestFlight first. For this employee operations app,
   evaluate **Unlisted App** or **Custom App via Apple Business Manager**
   distribution before choosing a public listing.

### Android

1. Create a Play upload key and store it outside the repository.
2. Configure `android/keystore.properties` and Gradle release signing locally
   or in the protected CI environment.
3. In Android Studio, use **Build > Generate Signed App Bundle** and produce an
   Android App Bundle (`.aab`).
4. Upload to Play Console's internal testing track before production.

## Store submission material

Both stores require:

- App name, subtitle/short description, full description, support URL, and
  privacy-policy URL
- Phone and tablet screenshots from the submitted build
- A 1024x1024 iOS icon and 512x512 Play icon without transparency where the
  store disallows it
- App Review credentials for an approved, non-production-sensitive reviewer
  account, plus instructions explaining the role-gated workflow
- Privacy disclosures covering account identity, location, photos/documents,
  operational data, diagnostics, and push tokens
- Data retention and account-deletion instructions

Do not submit until the native app icon and launch assets replace Capacitor's
generated placeholders.

## Pre-submission device checklist

- Fresh install, Microsoft sign-in, sign-out, and session restoration
- Pending, disabled, and approved account states
- Foreground/background push and notification-tap navigation
- Camera scanning, photo/document upload, geolocation, PDF generation, sharing,
  and external links
- Offline launch and recovery after connectivity returns
- Phone and tablet layouts, rotation, keyboard behavior, safe areas, dark/light
  themes, and Dynamic Type/accessibility review
- API behavior against the production URL and all role-specific workflows
- No test bypass, preview environment, placeholder icon, or development signing
  in the uploaded artifacts

Apple Guideline 4.2 rejects apps that are only repackaged websites. The native
authentication, notifications, camera/location workflows, lifecycle handling,
and operational utility should be demonstrated clearly in review notes, but
acceptance is ultimately Apple's decision.
