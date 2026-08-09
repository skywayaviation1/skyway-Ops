# Skyway messaging platform

Skyway messaging uses Stream Chat for message storage, realtime delivery,
typing, presence, reactions, threads, read state and attachments. Firebase
Cloud Messaging (FCM) delivers lock-screen notifications through a signed
Stream webhook so Skyway can enforce quiet hours, per-conversation mute and
preview privacy.

## Required Vercel environment variables

Set these for Production and Preview:

```text
STREAM_API_KEY
STREAM_API_SECRET
FIREBASE_SERVICE_ACCOUNT_JSON
VITE_FIREBASE_VAPID_KEY
```

`STREAM_API_SECRET` and `FIREBASE_SERVICE_ACCOUNT_JSON` are server-only.
`VITE_FIREBASE_VAPID_KEY` is public by design.

## Configure the Stream webhook

In the Stream dashboard for the app identified by `STREAM_API_KEY`:

1. Open **Chat & Messaging → Webhooks**.
2. Add an event webhook:

   ```text
   https://YOUR_PRODUCTION_DOMAIN/api/stream-webhook
   ```

3. Subscribe it to `message.new`.
4. Save and send a test event.

Stream signs the raw body with `STREAM_API_SECRET`; invalid signatures receive
HTTP 401. The endpoint accepts no browser/user token and cannot be called as a
general push relay.

Do **not** also enable Stream's native Firebase push provider for this app.
Running native push and the webhook bridge together produces duplicate
notifications. The browser stores its FCM tokens under
`users/{uid}/push-tokens`; `api/stream-webhook.js` is the only Stream-message
sender.

## Firebase setup

In Firebase Console → Project Settings → Cloud Messaging:

1. Generate a Web Push certificate.
2. Put its public key in Vercel as `VITE_FIREBASE_VAPID_KEY`.
3. Redeploy. Vite injects this variable at build time.

The service account in `FIREBASE_SERVICE_ACCOUNT_JSON` must be able to:

- send FCM messages;
- read `appusers/users` and each user's `push-tokens`/`comms-mutes`;
- create `appusers/stream-push-events` deduplication records.

Configure Firestore TTL on the `expiresAt` field of
`stream-push-events` so deduplication records are removed after seven days.

## User behavior

- The Messages screen prompts each device to enable notifications.
- On iPhone, the site must first be installed with **Add to Home Screen** and
  opened from that icon.
- Quiet hours and lock-screen preview privacy live under the user's Push
  Notification settings.
- The bell in a conversation header mutes push for that thread only; messages
  and unread badges continue to arrive.
- Notification clicks open the exact DM/group or the trip's Comms tab.

## Delivery checks

1. Enable notifications on two separate approved accounts/devices.
2. Put the recipient PWA in the background.
3. Send a DM. Confirm one lock-screen notification appears and opens the DM.
4. Mute the DM and repeat; no notification should appear.
5. Enable quiet hours covering the current local hour and repeat.
6. Disable message previews and confirm the lock screen says only
   **New message**.
7. Send an image-only message and confirm the preview says **Sent a photo**.

Vercel function logs for `/api/stream-webhook` report recipient, sent and
suppressed counts without logging message bodies.

## Current security boundary

Stream's standard `messaging` channel permissions remain authoritative. Only
approved Firebase profiles receive Stream tokens. Tokens expire after 12 hours,
and reconnecting requires a fresh Firebase ID token.

This is managed company messaging, not Signal's end-to-end encryption model.
Stream encrypts data in transit and at rest, but workspace administrators and
the provider retain the operational access defined by the Stream account.
