# Installing Skyway Ops on iPhone

Skyway Ops is a Progressive Web App. Apple does not provide a normal App Store
download dialog for this type of application; installation is built into
Safari.

## Pilot / employee steps

1. Open the stable Skyway production URL in **Safari**.
2. Tap **Install on iPhone** on the sign-in screen for the visual guide.
3. Tap Safari's **Share** button.
4. Choose **Add to Home Screen**.
5. Tap **Add**.
6. Launch Skyway from its Home Screen icon.
7. Sign in using the company Microsoft account ending in
   `@flyskyway.com`.
8. Open notification settings and enable lock-screen alerts.

Chrome, Firefox, and in-app browsers on iPhone cannot add a web app to the Home
Screen. The install guide offers a Copy Link action so the same URL can be
opened in Safari.

## Deployment checklist

Installation itself works on any HTTPS production host, but Microsoft login in
the installed app needs a stable callback:

1. Choose one canonical production host (currently
   `skyway-ops.vercel.app` is the primary).
2. Set `VITE_FIREBASE_AUTH_DOMAIN` to that bare hostname in Vercel Production.
3. Add `https://<host>/__/auth/handler` as a Web redirect URI in Microsoft
   Entra.
4. Add the bare hostname to Firebase Authentication → Authorized domains.
5. Set `VITE_MICROSOFT_TENANT_ID` to the Skyway Entra tenant.
6. Redeploy and test login by launching from the Home Screen icon.

See `docs/microsoft-sso-setup.md` for complete identity and claims setup.

## PWA behavior

- The manifest uses standalone display, dedicated 180px/167px Apple icons,
  maskable Android art, and mobile/desktop install screenshots.
- Device-specific iPhone launch images avoid a white startup flash.
- Safe-area CSS accounts for the Dynamic Island, notch, and Home indicator.
- The service worker handles push notifications and navigation requests.
- App code is always network-first and is never stored in the offline cache,
  avoiding stale JavaScript after a deploy.
- When offline, Skyway shows a static safety message rather than cached
  operational data. Flight, duty, maintenance, and message data must not be
  treated as current without a connection.

## Updating an installed app

Vercel's `index.html` is no-cache and hashed JavaScript is immutable. Every
launch checks the network for the current version. The global stale-chunk
recovery performs one guarded reload if an app was left open across a deploy.
The service worker caches only the offline explanation and removes its prior
version on activation.

## Push notifications

iOS web push requires:

- iOS/iPadOS 16.4 or newer;
- Skyway installed on the Home Screen;
- notification permission requested from the installed app;
- `VITE_FIREBASE_VAPID_KEY` configured for the Firebase project.

Users can configure quiet hours, hide message previews, and mute individual
conversations from the app.

