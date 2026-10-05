# Broker white-label tracking links

Ops can attach a logo to a broker so the public tracking page the broker
shares with their client shows that broker's brand.

## Where to upload

Two places, both limited to **ops** and **admin**:

1. **Brokers** in the Admin nav. Open a broker by email, upload a PNG, JPG, or
   SVG (1.5 MB max), and optionally set a public name, accent color, and the
   "Powered by" line.
2. **Share with broker** on a trip. The same editor sits under the broker
   email, so branding can be set while the link is created.

The public page switches to the broker logo only after a logo is saved. A
name or color on its own leaves the current operator branding in place.
Removing the logo returns the page to that branding. "Powered by" is off
unless someone turns it on, and it never includes the operator phone or email.

Passenger names still follow the existing per-leg privacy flag. The branding
payload is the logo URL, display name, accent, and the powered-by flag. It
does not include the broker email, storage path, or staff identity.

## What Jake needs to publish

No new environment variables. The API uses the existing
`FIREBASE_SERVICE_ACCOUNT_JSON`. The service account needs permission to
write Cloud Storage on `skyway-ops-app.firebasestorage.app` and to read and
write the named Firestore database `appusers`.

Logos are stored at:

```
broker-logos/{broker-email}/logo.png|jpg|svg
```

Metadata is the `brokers/{broker-email}` document in the `appusers` database
(`displayName`, `accentColor`, `showPoweredBy`, `logoPath`, `logoContentType`).

Client Firebase SDKs must not read or write those objects. The Admin SDK
(used by `/api/broker-brand` and `/api/broker-logo`) bypasses security rules,
so publishing the blocks below does not block ops uploads. Merge them into
the live rules. They are not a complete ruleset.

Firestore (`appusers`):

```
match /brokers/{brokerId} {
  allow read, write: if false;
}
```

Storage:

```
match /broker-logos/{brokerId}/{fileName} {
  allow read, write: if false;
}
```

The tracking page loads the logo from `/api/broker-logo?token=…` after the
trip token is checked. Ops preview the logo with the same route and their
sign-in token. Crawler previews (iMessage, Slack, and similar) receive the
broker title and logo from `/api/trip-track-preview`; everyone else still
gets the normal tracking page.

## Native app

Clients open a normal web link, so they do not need an app update. Ops who
use the website see the upload screen on the next deploy. Ops who upload
from the installed iOS or Android shell need a new store build, because that
shell packages the web app.
