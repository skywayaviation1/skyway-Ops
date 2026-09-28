# Multi-tenant architecture and migration plan

This document is a plan only. It does not change how www.skyway.app behaves. Skyway Aviation stays the only live tenant until each phase below is implemented and verified.

The product today is one Part 135 operation (Skyway Aviation) on one Firebase project. Jake’s target is a subscription product other operators can buy, with their own users, their own branding, and no path for one company to read or write another company’s data. That isolation has to be enforced in the database, not only in the React screens.

A parallel workstream (open pull request [#33](https://github.com/skywayaviation1/skyway-Ops/pull/33)) adds the pilot safety rating, Wyvern import, and broker pilot report. Those collections and routes are included here so they are tenant-scoped when they land. This plan does not edit that workstream.

## Recommendation in one paragraph

Replatform the system of record to Postgres with row-level security. Keep the Vite/React app, the Vercel project `skyway-ops`, and the Capacitor shells. Do not start by rewriting `src/App.jsx` (about 29,500 lines) into Next.js. New customer companies are born in Postgres and never written into the shared Firestore database. Skyway’s existing Firestore data stays where it is until each collection is moved, with www.skyway.app and 135ops.app pinned to Skyway so a routing mistake cannot show another company or take the live site down. Staying on Firestore as the long-term store cannot meet the isolation requirement: the Firebase Admin SDK, which almost every API route uses, ignores security rules, and those rules are not in this repository. Which modules a company has are a separate control: a catalog keyed to today’s screens, defaults from the Stripe tier, and a per-tenant override (force on, force off, or a trial that expires). The server blocks the API and the data, and the nav item is removed rather than shown as disabled.

## Current stack

| Layer | What production uses |
| --- | --- |
| UI | Vite 5, React 18, Tailwind. One client bundle. `src/App.jsx` is the operations console. |
| Hosting | Vercel project `skyway-ops`. `vercel.json` rewrites HTML to `index.html`, proxies `/__/auth/*` to `skyway-ops-app.firebaseapp.com`, and runs seven crons. |
| Domains | `www.skyway.app` is the documented origin (`docs/microsoft-sso-setup.md`). Apex `skyway.app` redirects there. `135ops.app` is a live alias and is not referenced in this repo. |
| API | About 90 Vercel serverless functions in `api/` (plus shared modules prefixed `_`). One Edge function: `api/ical.js`. |
| Database | Cloud Firestore, named database `appusers` (not the `(default)` database). Client in `src/firebase.js`, Admin SDK everywhere under `api/`. |
| Files | Firebase Storage bucket `skyway-ops-app.firebasestorage.app`. |
| Auth | Firebase Auth, Microsoft only, locked to `@flyskyway.com` and one Entra directory. |
| Mobile | Capacitor iOS and Android. Bundle id `com.flyskyway.ops`. The native app loads the same web build and calls `https://www.skyway.app`. |
| Chat | Stream Chat (`stream-chat` / `stream-chat-react`). One Stream app. Tokens minted in `api/stream-token.js`, which also upserts every Firestore user into that app. |
| Email | Resend. From address defaults to `Skyway Ops <noreply@send.flyskyway.com>`. |
| Schedule | JetInsight iCal, fetched by the unauthenticated proxy `api/ical.js` and parsed in the client. |

There is no Postgres, no Stripe, no `firestore.rules` file, and no `firestore.indexes.json`. Firebase client config (API key, project id `skyway-ops-app`, sender id) is hardcoded in `src/firebase.js`, `src/firebase-storage.js`, `src/firebase-expenses.js`, and `public/firebase-messaging-sw.js`. That key is public by design. The service account in `FIREBASE_SERVICE_ACCOUNT_JSON` is not.

### Auth today

Sign-in is implemented in `src/firebase-auth.js` and `api/auth-profile-bootstrap.js`.

- The browser uses the Microsoft OAuth provider with `tenant` set from `VITE_MICROSOFT_TENANT_ID`, falling back to the domain `flyskyway.com`. `docs/microsoft-sso-setup.md` records the live directory id and says the Entra app is single-tenant on purpose.
- After sign-in, the client rejects any verified email that is not `@flyskyway.com`, then reads `users/{uid}`.
- If no profile exists, `POST /api/auth-profile-bootstrap` creates one with role `crew` and `approved: false`. The same domain check is repeated on the server.
- An existing admin approves the profile with `approveUser()` in `src/firebase-auth.js`, which is a client `updateDoc` on `users/{uid}`.
- `updateUserProfile()` lets the client write `role`, `approved`, and `active`. The comment at the top of `firebase-auth.js` says the browser must not choose its own role. That is true for bootstrap, and false for this later update.
- Disabled (`active === false`) and unapproved users are blocked in the client after the profile is read.
- Native sign-in goes through `@capacitor-firebase/authentication`, then `POST /api/mobile-auth-token` exchanges the Microsoft token for a Firebase custom token with a `nativeMicrosoft` claim.
- Preview deployments can mint a development admin via `api/dev-auth-bypass.js`. Production refuses that path when `VERCEL_ENV=production`.

There is one user pool. A person is a document in `users`, not a member of an organization. There is no tenant id, no invite token, and no SSO configuration per company.

### Roles today

The canonical list is in `src/firebase-comms.js`:

`crew`, `sales`, `ops`, `maint`, `accounting`, `admin`

A few modules also mention `pilot`, `chief-pilot`, and `chief_pilot` (`src/duty-pairing.js`). Those are not in the comms role list. Role is a string on the user document. Screens hide buttons with checks like `currentUser.role === 'admin'`. Some API routes repeat the check after `verifyIdToken` (for example `api/admin-settings.js`, `api/_quickbooks.js`, `api/duty-admin-action.js`). Many routes only check that the token is valid, and the operational writes themselves happen from the browser with the client SDK.

What each role can do is scattered:

| Role | What the code actually gates |
| --- | --- |
| `crew` | Own duty, own expenses, own pilot docs, schedule, comms. New Microsoft users land here, unapproved. |
| `sales` | Charter inbox, broker share, some trip email. QuickBooks is excluded. |
| `ops` | Fleet board, trip state, service requests, currency edits, shift log. |
| `maint` | Maintenance, MEL, service requests, AML. |
| `accounting` | QuickBooks workspace and expense sync, together with `admin`. |
| `admin` | User approval, fleet settings, FlightAware, ForeFlight, email diagnostics, delete user, impersonation. |

Impersonation (`src/App.jsx`) is a client flag. The admin’s Firebase token does not change. Writes are blocked in the UI while impersonating. That pattern must stay UI-only, and it must never be a way to open another tenant.

Authorization is not a policy table. Adding a company admin who can manage users but cannot export passenger IDs requires new checks in both the UI and every API that currently treats `admin` as global.

### Branding today

`src/brand.js` already uses the word “tenant”, and it is not multi-tenant.

- Two brands are compiled into the bundle: `skyway` and `elite`.
- The active brand is `VITE_TENANT` at build time, or `window.__TENANT__` in tests. Default is `skyway`.
- Colors are CSS variables (`--sw-accent` and related) applied by `applyBrandAccent()`.
- Logos, legal name, phone, charter email, and tagline are constants.
- `index.html`, `public/manifest.json`, the iOS display name, and Capacitor `appName` are the literal string Skyway.
- Email HTML in `api/_email-signature.js` points at `https://www.skyway.app/skyway-logo.png` and “Skyway Aviation Services”.

Standing up Elite Jets, or any second operator, means a separate build or a code edit. Subdomains and custom domains are not resolved at request time. `vercel.json` has no host-based rewrite.

### Environment and third-party services

Server secrets live in the Vercel project environment. They are one value for the whole deployment, which means one QuickBooks company, one charter mailbox, one FlightAware key, and one Stream app.

| Variable | Used for |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Admin SDK. Full access to Auth, Firestore `appusers`, and Storage. |
| `FIREBASE_STORAGE_BUCKET` | Passenger-ID cleanup. Defaults to the Skyway bucket. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Same-origin auth helper. Production value `www.skyway.app`. |
| `VITE_MICROSOFT_TENANT_ID` | Skyway Entra directory. Compiled into the client. |
| `MICROSOFT_SSO_CLIENT_ID` / `MICROSOFT_SSO_CLIENT_SECRET` | Account linking and mobile sign-in. |
| `MICROSOFT_MAIL_*`, `CHARTER_MAILBOX_UPN` | Shared inbox. Default mailbox `charters@flyskyway.com`. |
| `MICROSOFT_USER_MAIL_*` | Per-user Outlook. Falls back to the Skyway SSO app. |
| `RESEND_API_KEY`, `OPS_FROM_EMAIL`, `OPS_REPLY_TO`, `DUTY_ALERT_FROM_EMAIL`, `RESEND_FROM_ADDRESS` | Transactional mail. |
| `OPS_ALERT_EMAILS` | Ops alert fan-out. Several routes also hardcode Jake, Jim, Zack, and `mx@flyskyway.com`. |
| `FLIGHTAWARE_API_KEY`, `FLIGHTAWARE_WEBHOOK_SECRET` | Tracking poll (every minute), webhooks, alerts. |
| `INTUIT_CLIENT_ID`, `INTUIT_CLIENT_SECRET`, `INTUIT_REDIRECT_URI`, `INTUIT_ENV` | One QuickBooks connection stored at `quickbooks/connection`. |
| `VERYON_CLIENT_ID`, `VERYON_CLIENT_SECRET`, `VERYON_REDIRECT_URI`, `VERYON_SCOPE` | One Veryon connection at `veryon/connection`. |
| `IFLIGHTPLANNER_CLIENT_ID`, `IFLIGHTPLANNER_CLIENT_SECRET` | FBO lookup. |
| `ANTHROPIC_API_KEY` | Receipt parse, ID parse, MEL ingest, wear vision, pilot-doc parse. |
| `STREAM_API_KEY`, `STREAM_API_SECRET` | Comms. |
| `GOOGLE_MAPS_API_KEY` | Browser map key, served by `api/google-maps-config.js`. |
| `APPLE_MAPKIT_*` | MapKit JWT. Origin-locked. |
| `FAA_NMS_CLIENT_ID`, `FAA_NMS_CLIENT_SECRET` | NOTAMs. |
| `KLIPY_API_KEY` or `TENOR_API_KEY` | GIF search. |
| `CRON_SECRET`, `INTERNAL_API_SECRET` | Cron auth and server-to-server calls. |
| `TRIP_LINK_SECRET`, `OPERATOR_LINK_SECRET`, `AOG_LINK_SECRET`, `AOG_OFFER_SECRET`, `SERVICE_LINK_SECRET` | HMAC tokens for public trip, operator, AOG, and service pages. |
| `NEXT_PUBLIC_APP_URL`, `PUBLIC_BASE_URL` | Callback and link base. Often `https://www.skyway.app`. |
| `DEV_AUTH_BYPASS`, `VITE_DEV_AUTH_BYPASS` | Preview sign-in. |
| `VITE_TENANT` | Build-time brand id. |
| `VITE_FIREBASE_VAPID_KEY` | Web push. |

OAuth redirect URIs are registered for `www.skyway.app` (QuickBooks, Microsoft, Veryon). A tenant on `acme.skyway.app` cannot complete those OAuth flows until the redirect URI and the stored tokens are per tenant.

### Scheduled jobs

From `vercel.json`:

| Cron | Path | What it touches |
| --- | --- | --- |
| Every minute | `/api/flightaware-cron-poll` | All of `trip-state`, `app-config/fleet`, `brokered-tail-tracking`, `flightaware/config`. Emails brokers as Skyway Aviation. |
| Every minute | `/api/email-queue-drain` | `email-queue`. |
| Every minute | `/api/aog-chat-nudge` | `aog-events`. Recipients include `Jake@flyskyway.com` and `MX@flyskyway.com`. |
| Sundays 06:00 | `/api/airport-coords-refresh` | `airport-cache-ourairports`. |
| Daily 14:00 | `/api/currency-alerts` | All of `pilot-currencies` and `users`. |
| Daily 07:30 | `/api/cleanup-pax-ids` | Passenger ID images in Storage older than five days. |

These jobs assume one company. A second tenant in the same collections would be processed with Skyway’s FlightAware key, Skyway’s from-address, and Skyway’s alert recipients.

### Public and semi-public surfaces

These pages are unauthenticated and must stay tenant-scoped. A token minted for a Skyway trip must not resolve a document that later belongs to another company, and the reverse.

- Broker tracking: `src/TripTrack.jsx`, `api/trip-public.js`, `api/trip-share.js`, HMAC in `api/_trip-token.js`.
- Brokered-operator portal: `src/OperatorFlightPortal.jsx`, `api/operator-flight.js`, `api/operator-link.js`.
- External AOG tech page: `ExternalTechPage` in `src/App.jsx`, `api/aog-public.js`, `api/aog-link.js`.
- External service tech page: `src/ServiceRequests.jsx`, `api/service-public.js`, `api/service-link.js`.
- `public/aog-response.html` and `api/aog-offer-respond.js`.
- `public/privacy.html` (App Store privacy page).
- `api/ical.js` proxies JetInsight, Google Calendar, and iCloud with `Access-Control-Allow-Origin: *` and no auth. The feed URL is the secret. Anyone who can ask the proxy fetches that calendar.

## Data inventory

Everything below lives in Firestore database `appusers` unless noted. Document ids are global. There is no `tenantId` field. Client modules subscribe with `onSnapshot` to whole collections. Server jobs call `.get()` on whole collections.

Singleton documents (one per deployment, not one per company):

| Document | Holds |
| --- | --- |
| `app-config/fleet` | Managed tails and aircraft metadata. Written by `api/admin-settings.js`. Fallback tails are hardcoded in `src/fleet-config.js` (`N20UF`, `N168ZZ`, `N286N`, `N444AM`, `N651TW`, `N551FP`, `N85AH`, `N525CR`). |
| `app-config/tab-order` | Nav layout. |
| `app-config/frat` | FRAT scoring switches. |
| `flightaware/config` | Tracking on/off, duty-alert emails. |
| `quickbooks/connection` | Realm id and OAuth tokens. `src/firebase-quickbooks.js` states the tokens are plaintext and that the client subscribes to this document. |
| `veryon/connection` | Veryon OAuth tokens. |
| `aogConfig/settings` | AOG offer settings. |
| `mxProjectionSettings` | Maintenance projection settings (collection used as a settings bag). |

`app-config/pilot-safety` is specified in pull request #33 and is not on `main` yet. It is the same kind of singleton: one standard for the whole database.

### Tenant-owned collections

These must become rows owned by exactly one tenant. “Client” means the browser SDK writes or listens. “Server” means an API route or cron uses the Admin SDK.

| Collection | What it is | Access today | Isolation note |
| --- | --- | --- | --- |
| `users` | Profile: email, name, callsign, role, `approved`, `active`, `jetinsightName`, certificate fields, signature. Subcollections `push-tokens`, `comms-mutes`. | Client listens to the entire collection (`subscribeToUsers`). Client updates role and approval. Server creates profiles. | The company directory. Cross-tenant read here is an employee-list leak. |
| `trip-state` | Per-leg operational state, passengers, broker email, statuses, OOOI times. Subcollection `ops-audit`. | Client listen-all. Crons scan all. Public token routes read one doc by id. | Passengers and broker contacts. |
| `manual-trips` | Trips created inside the app. | Client. | Schedule content. |
| `manifests` | Load manifests. | Client. | Passenger names. |
| `tripHotelBookings` | Hotels on a trip. | Client (`src/firebase-hotels.js`). | |
| `travel-bookings` | Crew travel. | Client. Lodging dashboard queries all, or by `userUid`. | |
| `expenses` | Receipts, amounts, QuickBooks sync ids. | Client listen-all. Storage `expenses/{uid}/`. | Financial. |
| `wallet-cards` | Card records used for expenses. | Client listen-all. | Treat as payment data. Do not replicate PANs into a new table. |
| `reports` | Submitted reports. | Client. | |
| `conversations` + `messages` + `typing` | DMs and groups. | Client. Policy in `src/firebase-comms.js` says DMs are visible only to the two participants, enforced in UI code. | Must stay participant-scoped inside the tenant. Admins do not get a backdoor. |
| `trips/{id}/messages` | Legacy trip chat. | Client. | |
| `stream-push-events` | Stream webhook dedupe. | Server. | Stream user ids must include the tenant, or two companies’ users collide in one Stream app. |
| `pilot-currencies` | Part 135 currency and checks. Keyed by uid. | Client. Cron reads all. | |
| `pilot-docs` | Certificate, medical, passport, license. Includes document numbers and date of birth. | Client. Storage `pilot-docs/{uid}/`. `src/firebase-pilotdocs.js` says rules are required and are not in the repo. | Highest-sensitivity PII. |
| `duty-periods-v2` | Part 135 duty periods. | Client, and server for pairing (`api/duty-start-pair.js`, `api/duty-end-pair.js`, `api/duty-admin-action.js`). | Comments in `src/firebase-duty-v2.js` describe rules that are not checked in. |
| `duty-outside-flying-v2` | Flying for other operators. | Client. | |
| `duty-state`, `dutyRecords` | Older duty data. | Client (`src/close-stuck-duty.js`, `src/DutyDataExport.jsx`). | Migrate or archive with the duty wave. Do not leave them world-readable. |
| `duty-alert-failures` | Failed duty emails. | Server. | |
| `duty-pair-backfill-previews`, `duty-pair-backfill-runs` | Admin backfill jobs. | Server. | |
| `maint-aircraft`, `maint-squawks`, `maint-mel`, `maint-timelog` | Maintenance records. | Client. Aircraft docs updated from admin settings. | |
| `mel-revisions` | MEL PDFs and extracted items. | Client and `api/mel-ingest.js`. Storage `mel-uploads/{tail}/`. | |
| `mx-projects`, `mxDueItems` | MX projects and due-list parse. | Client and `api/mx-due-list-parse.js`. | |
| `aml-entries`, `aml-deletions` | Aircraft maintenance log. `src/firebase-aml.js` says this is a parallel record, not an approved official log. | Client. | Still tenant maintenance data. |
| `aog-events`, `aogCoverage` | AOG events and coverage offers. | Client and several email/token routes. | |
| `service-requests`, `deleted-logbook-entries` | Service requests and deletion audit. | Client and public token routes. | |
| `wear-items`, `wear-inspections`, `wear-training`, `wear-check-sessions`, `wear-check-drafts`, `wear-replacements` | Wear program. | Client. Photos in Storage. | |
| `foreflight-events` | ForeFlight webhook deliveries. | Server. | ForeFlight credentials are per operator. |
| `flightaware-state`, `flightaware-airports`, `flight-events` | Live tracking derived from Skyway’s FlightAware account. | Client listen; cron writes. | A second tenant needs its own AeroAPI account or a contracted sub-account. Sharing Skyway’s key mixes telemetry and billing. |
| `flightaware-cache` | Weather, NOTAM, track, and position cache. | Server. | Cache keys are global (`wx_{icao}`). Safe to share only for public FAA data. Do not cache tenant positions here without a tenant prefix. |
| `brokered-tail-tracking` | Temporary tails to poll. | Server. | |
| `email-queue` | Outbound mail. | Server. | From-address and reply-to are Skyway’s. |
| `charter-mail-links`, `charter-mail-conversations` | Filing of the shared Outlook mailbox onto trips. | Server (`api/charter-mail.js`). | One mailbox for the deployment. |
| `user-mailboxes`, `user-mail-oauth-state` | Personal work mail OAuth. | Server. | Tokens must be encrypted and tenant-scoped. |
| `quickbooks-oauth-state` | OAuth CSRF state. | Server. | |
| `veryon-oauth-state` | OAuth CSRF state. | Server. | |
| `ops-shift-log` | Ops shift notes. | Server (`api/ops-control-action.js`). | |
| `airport-cache-ourairports` | Airport coordinate cache. | Server. | Reference data. Can stay global. |

Storage prefixes that must sit under a tenant prefix (`tenants/{tenantId}/...`) before a second company uploads anything:

`trip-sheets/`, `aog-references/`, `service-references/`, `trip-attachments/`, `comms-attachments/`, `mel-uploads/`, `pilot-docs/`, `expenses/`, wear photos, and passenger ID images cleaned by `api/cleanup-pax-ids.js`.

`src/firebase-storage.js` says trip-sheet rules are assumed, not present in git, and that an open bucket lets any signed-in user read every trip sheet.

### Pull request #33 collections (not on `main`)

When that branch merges, these are tenant data on day one. Do not add them to Firestore for a second company.

| Name | Contents | Who writes |
| --- | --- | --- |
| `pilot-logbooks/{uid}` | Hours, certificate grade, background yes/no, Wyvern import metadata. Certificate numbers are intentionally excluded. | Admin and ops, from Currency. |
| `pilot-flight-log/{entryId}` | One credited leg per pilot. Id shape `{uid}__leg_{PIC\|SIC}_{tripUid}`. | Sync when admin or ops opens Currency. Scripts `scripts/import-wyvern.mjs` and `scripts/rebuild-pilot-hours.mjs`. |
| `app-config/pilot-safety` | PIC/SIC minimums. Shipped defaults are the Wyvern Registered Standard. | Admin. |
| `POST /api/pilot-report-email` | Broker PDF. Specified for admin, ops, and sales. | Server, Resend, not `email-queue`. |
| `GET /api/trip-public` | Adds `trip.crewReports` only when the assigned crew meets the seat. | Public token. |

The rating also reads `pilot-currencies`, `pilot-docs` (grade and medical only), `duty-periods-v2`, and `trip-state`. A broker report for tenant A must be built from tenant A’s pilots only. Wyvern outbound (`src/wyvern-outbound.js` on that branch) has no credentials yet. When it does, the vendor account is per tenant, not a platform key.

The PR’s suggested security rules still allow any signed-in user to read `app-config/pilot-safety`, and they document that the Admin SDK bypasses them. Those rules are a single-company patch. They are not the multi-tenant control.

### Reference data that can stay global

Airport coordinates, winds, NOTAM text, and the GIF catalog are not a customer’s records. Cache them in a shared store with no tenant documents beside them. FlightAware positions of a tenant’s tails are not reference data.

### Hardcoded Skyway

A second company will show Skyway’s name until these are driven by the tenant record. This is the set to treat as brand and identity, not an exhaustive string search.

- `src/brand.js`: legal name, `charters@flyskyway.com`, phone `727-605-5000`, logo paths, cyan accent.
- `src/firebase-auth.js`: `COMPANY_DOMAIN = 'flyskyway.com'`.
- `api/auth-profile-bootstrap.js`: `ALLOWED_DOMAIN = 'flyskyway.com'`.
- `api/auth-link-microsoft.js`: same domain gate.
- `index.html` title and apple-mobile-web-app-title. `public/manifest.json` name.
- `capacitor.config.json`: `appId` `com.flyskyway.ops`, `appName` `Skyway Ops`.
- `src/fleet-config.js`: eight Skyway tails used when fleet config is missing.
- `api/_email-signature.js`, `api/_email-transport.js`, `api/flightaware-cron-poll.js`, `api/generate-report.js`, `api/send-aog-logbook-email.js`: Skyway wording, logo URL, and from-address.
- `api/generate-report.js` and `api/duty-admin-action.js`: recipient lists `jake@flyskyway.com`, `zack@flyskyway.com`, `jim@flyskyway.com`, `mx@flyskyway.com`, and `zack.taylor@flyskyway.com`.
- `api/aog-chat-nudge.js`: `Jake@flyskyway.com`, `MX@flyskyway.com`.
- `api/_charter-mail.js`: default mailbox `charters@flyskyway.com`.
- `docs/microsoft-sso-setup.md`: production Entra tenant id and client id (already public in the auth URL).
- Local storage key `skyway-theme` and session key `skyway_oauth_redirect_at`.

Elite Jets in `src/brand.js` is a second compiled skin (gold accent, `elitejets.com`, phone `239-330-4114`). It is not a second database. Whether Elite is a real future tenant is a decision for Jake, listed at the end.

## Why the current stack cannot isolate tenants

1. **The Admin SDK is the data path, and it bypasses rules.** Nearly every file in `api/` initializes `firebase-admin` with the service account and opens database `appusers`. Firestore security rules do not apply to that client. Isolation would be a convention inside ~90 handlers, crons, and scripts. One missed `.collection('trip-state').get()` returns every operator’s trips.

2. **Rules are not in the repository.** `src/firebase-duty-v2.js`, `src/firebase-pilotdocs.js`, `src/firebase-storage.js`, and `src/firebase-expenses.js` all say the real protection is rules that someone must configure in the console. Pull request #33 repeats that. There is no way, from this repo, to review or test the boundary Jake is asking for.

3. **The browser writes the business data.** Role changes, trip state, expenses, duty, maintenance, passenger manifests, and pilot documents are `setDoc` / `updateDoc` / `onSnapshot` from `src/`. UI checks are not a server check. `updateUserProfile()` can set `role: 'admin'` if the rules allow the signed-in user to update that document.

4. **Listeners are collection-wide.** `users`, `trip-state`, `expenses`, `wallet-cards`, `aog-events`, `maint-squawks`, and others are subscribed without a filter. Firestore rules can reject a query that is not constrained, which would break these screens, or allow the query, which returns every tenant. Either way the current access pattern does not survive a shared database.

5. **Identity is one directory.** `@flyskyway.com` is hardcoded on the client and the server. The Entra app is single-tenant. Another operator cannot sign in. Firebase Auth in this project has one user pool, so two companies that both have a `jane@...` collision, and a user who consults for two operators, have no membership model.

6. **Integrations are singletons.** QuickBooks tokens sit in one document the browser subscribes to, in plaintext (`src/firebase-quickbooks.js`). Veryon, FlightAware config, the charter mailbox, and Stream are the same shape. Connecting a second operator would overwrite Skyway’s tokens or share them.

7. **Secrets and branding are process-wide.** Vercel env vars cannot vary per hostname. Resend’s from-address, MapKit’s origin, and OAuth redirect URIs are Skyway’s.

8. **Crons have no tenant loop and no tenant cap.** The FlightAware poll runs every minute against every `trip-state` document. That is already a full-collection read. It cannot be given a second company’s tails on Skyway’s AeroAPI key.

9. **Public tokens are not namespaced.** Trip, AOG, service, and operator tokens are HMAC of an id in the one database. They need a tenant id inside the signed payload before any second tenant exists.

10. **Scale of the client.** `src/App.jsx` is about 29,500 lines in one module. A rewrite into a new framework before the data boundary exists would put the live console at risk and still leave Firestore shared.

Firestore can carry a `tenantId` field and rules that compare it to a custom claim. That is a useful bridge for Skyway-only hardening. It is not row-level security. The Admin SDK would still be above the rules. This codebase uses the Admin SDK as its normal server path.

### Options considered

**Stay on Firestore and add `tenantId` plus rules.** Smallest first diff. It does not give a database-enforced boundary on the API routes, crons, or import scripts. Whole-collection listeners have to be rewritten anyway. Singleton integration documents have to be split anyway. Rejected as the end state.

**Database or schema per tenant.** Strongest blast-radius limit, and the migration tool must run once per tenant. Vercel serverless functions would open a different connection per request, which fights Neon/Supabase pool limits. Crons become a fan-out. Use this later as an enterprise contract option for a customer who requires a dedicated database. Do not use it as the default for the first ten customers.

**Rewrite the UI in Next.js, then add Postgres.** Next.js middleware is a clean place for host routing. The operations console is the Vite app the crews use today, including the Capacitor shell that ships `dist/`. Rewriting it is a larger risk to Skyway’s uptime than adding Postgres beside it. A later super-admin app can be a separate surface if that is easier. It is not phase 1.

**Postgres with row-level security, Vite app kept.** This is the recommendation. Supabase is the closer replacement for Firebase (Auth, Postgres RLS, Storage, Realtime). Neon plus Clerk (or another SSO product) keeps the database vendor and the identity vendor separate and is the stronger SAML story. Both are a replatform of data and login. The React screens stay.

Trade-off to accept: two read paths during the move. Skyway’s unmigrated collections still come from Firestore. Every other tenant, and every migrated collection, comes from Postgres under RLS. A repository module per collection hides that from the screens. New tenants are never inserted into `appusers`. That is what keeps a half-finished migration from mixing two companies in one Firestore query.

## Target architecture

### Tenancy model

One shared Postgres schema. Every tenant-owned row has `tenant_id uuid not null`. Row-level security policies allow a row only when `tenant_id` equals the current transaction setting `app.tenant_id`.

The application sets that setting from the server after it has verified the session and loaded membership. The client never supplies `tenant_id` as the authority. A request may include the host, and the server checks that the host’s tenant matches the membership. A mismatch is a 403.

Platform operators (Jake) use a database role that can read the control-plane tables (`tenants`, `subscriptions`, `domains`, health). That role does not have a policy that selects operational rows. Opening a tenant’s trips is a separate audited action that sets `app.tenant_id` for one transaction and writes `audit_events`. Support access is off unless Jake turns it on for that tenant.

Force RLS even for the table owner (`FORCE ROW LEVEL SECURITY`) so a mistaken superuser-style query from the app still fails. The migration role that backfills Skyway is not the role the web app uses.

Indexes start with `tenant_id` on every tenant table. Unique constraints that are global today become unique per tenant (`(tenant_id, tail)`, `(tenant_id, email)` on memberships).

### Auth and RBAC

Replace the `@flyskyway.com` gate with membership.

- A user account is a person (email, auth subject).
- A membership is `(user_id, tenant_id, role, status)`.
- Status is `invited`, `active`, or `disabled`.
- Skyway’s current roles map directly: `crew`, `sales`, `ops`, `maint`, `accounting`, `admin`.
- Add `owner` for the customer’s first admin (billing and user admin). Skyway’s existing `admin` users can be `owner` or stay `admin`; Jake should pick one, listed below.
- Platform roles live in a different table, `platform_operators`. They are not a tenant role named admin. The super-admin panel checks this table.

Permissions are a matrix in the database, not a new string scattered through `App.jsx`. Example: `users.invite`, `users.role.assign`, `trips.read`, `trips.broker_share`, `pilot_docs.read_all`, `billing.manage`, `integrations.connect`. The existing role names are bundles of those permissions so screens can keep their checks while the server enforces the permission.

Sign-in:

- Each tenant has an allowed email domain list and an identity provider record (Microsoft Entra tenant id, client id, and later a SAML metadata URL).
- Skyway’s provider is the existing single-tenant Entra app. Users keep signing in with Microsoft. The Firebase project remains the session store until that tenant’s auth cutover flag is flipped.
- A new company’s users are created in the new auth system (Supabase Auth or Clerk). They never get a Firebase user in `skyway-ops-app`.
- Invite flow: tenant owner enters an email. The server writes an invited membership. The person signs in with the tenant’s IdP. The server links the account only if the email’s domain is on that tenant’s allow-list, or the invite was for that exact address. Unknown Microsoft accounts do not auto-provision as `crew` the way Skyway’s bootstrap does today.
- Self-serve signup, if Jake wants it, creates a tenant in `trialing` and an `owner` membership. It does not create operational rows until the tenant is active.
- SSO/SAML is a column set on the identity provider, gated by plan. The schema is there in phase 2. The SAML connection UI can wait for the first customer who requires it.
- Session cookies are host-scoped. A cookie on `acme.skyway.app` is not sent to `www.skyway.app`.
- Mobile: the Capacitor app needs a tenant code or company email domain before Microsoft opens, because the native shell has no hostname. That screen is new. The published Skyway app should keep defaulting to Skyway so crews are not asked to pick a company.

Stop client writes to `role`, `approved`, and `active` as soon as memberships exist. `api/delete-user.js` becomes “remove this membership”, not “delete the Firebase Auth user”, so a person who later joins a second tenant is not destroyed.

### Branding and routing

`tenants` holds `name`, `legal_name`, `app_name`, `tagline`, `logo_url`, `logo_mark_url`, accent colors for dark and light, `contact_email`, `contact_phone`, and `email_from`.

`tenant_domains` holds `hostname`, `kind` (`primary`, `subdomain`, `custom`), and `verified_at`.

Resolution order on every request:

1. If the host is `www.skyway.app`, `skyway.app`, or `135ops.app`, the tenant is Skyway. This mapping is a row in `tenant_domains` and a hardcoded fallback in the resolver so a database outage does not blank the live site or attach it to another tenant.
2. Else if the host is `{slug}.skyway.app` (or `{slug}.135ops.app` if that is the product zone), look up the slug.
3. Else look up a verified custom domain.
4. Else 404. Do not fall through to Skyway’s data.

The Vite app cannot do this in `vercel.json` rewrites alone. Add one Edge route, `api/tenant-context.js`, that reads `Host` and returns the public brand payload (name, colors, logo URLs). The boot script in `index.html` applies CSS variables before React paints, the same way `applyBrandAccent()` does today. `src/brand.js` becomes a reader of that payload. The compiled `skyway` / `elite` objects stay as the offline fallback for Skyway only.

Custom domains are Vercel project domains plus a DNS check stored on `tenant_domains`. OAuth redirect URIs for QuickBooks, Microsoft, and Veryon must be registered per host or must use a single platform callback (`auth.skyway.app`) that redirects back to the tenant host. The platform callback is the one that scales. Per-tenant redirect URIs will hit provider limits.

Email uses the tenant’s `email_from` and logo. Skyway keeps `noreply@send.flyskyway.com` until Resend domains exist for the product. Other tenants either send from a platform domain (`via skyway.app`) or verify their own domain in Resend. That verification is part of branding, not part of phase 1.

PWA: `public/manifest.json` is static. Phase 3 serves a small dynamic manifest from the Edge route so the installed name and icons follow the tenant. The native store listing stays Skyway’s until Jake wants white-label binaries.

### Stripe billing

Use Stripe Billing. Do not build an invoice engine.

- One Stripe Customer per tenant. Store `stripe_customer_id` on `tenants`.
- Products and Prices are the tiers Jake defines. Seat count is the subscription item quantity. Aircraft count or module add-ons are additional items if the pricing needs them.
- Checkout creates the subscription. The Customer Portal updates the card and the seat count.
- Webhooks (`customer.subscription.updated`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`) write `subscriptions` and `subscription_items`, then rebuild that tenant’s effective features from the Price’s row in `plan_features`. The app reads the effective table. It does not trust the browser’s claim about the plan.
- A Stripe subscription status of `trialing` is the whole-account trial. It is separate from a per-feature trial, which the super-admin sets on one module. Account-trial expiry follows the past-due / suspend choice below. Feature-trial expiry turns that module off and leaves the rest of the subscription alone.
- Which modules a Price includes is the catalog in the next section, not a free-form metadata string.
- Skyway Aviation is an internal subscription with no card, marked `billing_exempt`. A failed webhook must not suspend tenant #1.
- The super-admin panel can comp, extend a trial, or suspend. Suspend sets `tenants.status = suspended`. The resolver still returns the brand, and the app shows a suspended screen. Data stays. Crons skip suspended tenants.
- Stripe secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are platform env vars. They are not per tenant.

### Feature entitlements

Jake’s super-admin panel turns individual modules on or off per company. A module the tenant has not paid for, and that no override has opened, is absent from that company’s app. It is not shown as a locked or greyed-out item. Crews, dispatchers, and the tenant’s own admins do not see the nav entry, the page, or an “upgrade” prompt. The only place the full catalog is listed is the platform panel.

Enforcement is on the server. Hiding a button is the visible half. The API and the data access for that module refuse the call even if a modified client asks for it.

#### Catalog

Keys match the navigation in `src/App.jsx` (`NAV_SECTIONS` / `NAV_GROUPS`) plus the modules that live inside a screen rather than as their own tab. A child is on only when it resolves on and every ancestor resolves on. Force-on on a child does not punch through a parent that is off. Turning a parent off hides the whole group, because `useNavGroups` already drops a group whose children are all gone.

`always_on` keys are the product shell. They are not priced and the panel does not offer a switch. A company that cannot manage its own users is not a tenant.

| Key | Always on | What the user sees today | What the server must refuse when off |
| --- | --- | --- | --- |
| `core.home` | yes | Nav `home` | — |
| `core.users` | yes | Nav `users`. Invites, roles, disable. | `api/delete-user.js` stays available to tenant owners. It is not a paid module. |
| `core.settings` | yes | Nav `settings`. Fleet and org settings the tenant is allowed to edit. | `api/admin-settings.js` for that tenant’s own fleet. |
| `flights.schedule` | | Nav `schedule`, `archive`. JetInsight feed and manual trips. | `api/ical.js` for that tenant’s feed URL. Reads of `manual-trips` and the schedule slice of `trip-state`. |
| `flights.availability` | | Nav `availability`. | Availability records. |
| `flights.airport_data` | | Nav `airport-data` (Airport & Fuel). | `api/iflightplanner-fbos.js` and the fuel/FBO writes. Public airport reference data stays global. |
| `dispatch` | | Nav `ops` (labeled Dispatch). Trip board, status steps, FRAT on the trip (`TripFrat.jsx`, `app-config/frat`). | `api/ops-control-action.js`. Trip-state mutations. FRAT settings writes. |
| `dispatch.tracking` | | Nav `tracking`. Live fleet map. | `api/flightaware-*`, the minute poll for this tenant, `flightaware-state` for its tails. |
| `dispatch.manifests` | | Nav `manifests`. Passenger names and ID capture. | `manifests`, `api/generate-manifest.js`, `api/parse-id.js`, `api/cleanup-pax-ids.js` for this tenant. |
| `dispatch.lodging` | | Nav `lodging`. | `travel-bookings`, `tripHotelBookings`. |
| `dispatch.broker_share` | | “Share with broker” on a trip. Not its own tab. | `api/trip-share.js` minting, and `api/trip-public.js` resolution. Existing links stop opening when the feature goes off. |
| `dispatch.broker_report` | | Crew block on the broker page, and the email/PDF from the safety workstream (pull request #33). Not its own tab. Depends on `dispatch`. | `api/pilot-report-email`. `trip.crewReports` is omitted. The public page still loads the itinerary when `dispatch.broker_share` is on. |
| `crew.duty` | | Nav `duty`. | `duty-periods-v2`, `duty-outside-flying-v2`, `api/duty-start-pair.js`, `api/duty-end-pair.js`, `api/duty-admin-action.js`, `api/duty-backfill-pairs.js`. |
| `crew.currency` | | Nav `currency`. | `pilot-currencies`, `api/currency-alerts.js`. |
| `crew.safety_rating` | | Inside Currency: hours, rating, minimums, Import from Wyvern. Pull request #33. Parent `crew.currency`. | `pilot-logbooks`, `pilot-flight-log`, `app-config/pilot-safety`, `scripts/import-wyvern.mjs`. |
| `crew.pilot_docs` | | Pilot certificates, medicals, passports (`PilotDocs.jsx`, `pilot-docs`). | `pilot-docs` reads and writes, `api/parse-pilot-doc.js`, `api/bulk-download-pilot-docs.js`, storage prefix `pilot-docs/`. |
| `crew.reports` | | Nav `reports`. | `reports`. |
| `crew.wear` | | Nav `wear`. | `wear-*` collections and `api/wear-notify.js`, `api/wear-vision-check.js`. |
| `maintenance` | | Nav `maint`. Squawks, MEL, AML, due list, Veryon. | `maint-*`, `mel-*`, `aml-*`, `mx-projects`, `mxDueItems`, `api/mel-ingest.js`, `api/mel-search.js`, `api/mx-due-list-parse.js`, `api/veryon-*`. |
| `maintenance.aog` | | Nav `aog`, plus service requests. | `aog-events`, `aogCoverage`, `service-requests`, `api/aog-*`, `api/service-*`. Public tech links stop resolving. |
| `comms` | | Nav `comms`. Stream and legacy trip chat. | `api/stream-token.js` (do not upsert the user), `conversations`, `trips/{id}/messages`. |
| `comms.teams` | | Nav `teams`. | `api/teams.js`. |
| `email.mailbox` | | Nav `mailbox`. | `api/user-mail*.js`, `user-mailboxes`. |
| `email.charter_inbox` | | Nav `inbox` (shared charter mailbox). | `api/charter-mail.js` and the charter-mail collections. |
| `finance.expenses` | | Nav `expenses`. | `expenses` and receipt storage. |
| `finance.wallet` | | Nav `wallet`. | `wallet-cards`. |
| `finance.accounting` | | Nav `accounting`. QuickBooks. | `api/quickbooks-*`. Do not start OAuth. Ignore the singleton `quickbooks/connection` for this tenant. |
| `integrations.foreflight` | | ForeFlight panel on the trip and in settings. Parent `dispatch`. | `api/foreflight-*`. |
| `platform.custom_domain` | | No nav item. Branding settings gain the custom-domain form only when this is on. | Custom-domain verify and attach. |
| `platform.saml` | | No nav item. | Saving an IdP of kind `saml`. |
| `platform.audit_export` | | No nav item. Tenant admins get an export action only when this is on. | The export query. Inserts into `audit_events` still happen either way. |

`crew.safety_rating` and `dispatch.broker_report` are separate switches. A company can track currency without the Wyvern rating, and can share a trip link without the crew vetting block. The rating workstream’s code is not edited by this plan. When that pull request merges, those screens check these two keys.

#### How a feature becomes on

For one tenant and one key, at time `now`:

1. If the catalog row is `always_on`, it is on.
2. If it has a parent and the parent is off, it is off.
3. Else if an override exists and (`expires_at` is null or `expires_at` is still in the future):
   - `force_off` → off
   - `force_on` → on
   - `trial` → on (`expires_at` is required)
4. Else the key is on when any **active** subscription item’s Price has that key in `plan_features`. Expired overrides fall through to this step. They are not a hidden force-off.
5. A `billing_exempt` tenant (Skyway) uses plan `internal`, which contains every key, unless a `force_off` override says otherwise.

There is no override row for “inherit”. Deleting the row returns the tenant to the plan. New tenants with no subscription and no exempt flag get plan `none`, which contains only the `always_on` keys, until Jake force-ons a module, starts a feature trial, or Stripe attaches a Price.

Add-on Prices are extra subscription items. The plan set is the union of every active item. Safety rating can be a line item without being bundled into the base tier.

The whole-account Stripe status `trialing` does not, by itself, turn every module on. The trial Price has its own `plan_features` rows. Jake picks that list (decision below). A feature trial is the override mode `trial` and can outlive or sit beside the account trial.

#### Effective rows, so a toggle is the next request

Do not cache entitlements in the serverless function, and do not wait for the client to redeploy. `tenant_feature_effective` is the read model.

The same database transaction that saves an override, or applies a Stripe Price change:

1. Upserts or deletes `tenant_feature_overrides`.
2. Recomputes every row in `tenant_feature_effective` for that tenant.
3. Increments `tenants.entitlements_version`.
4. Inserts the audit row.

API handlers read `tenant_feature_effective` from the primary on each request. A toggle Jake saves is in force on the next request after the commit. Feature-trial expiry needs no job to take effect: the resolver compares `expires_at` to `now` during the recompute, and a one-minute job recomputes tenants whose `expires_at` has passed so the effective table and the version bump happen even if nobody clicks. Until that minute runs, the API still treats `expires_at <= now` as expired when it reads, so the off switch does not wait for the job. The job exists so the version bumps and open browsers drop the nav.

#### Super-admin toggles

On the tenant’s page in `platform.skyway.app`, each catalog row shows the plan default, the current source (`plan`, `force_on`, `force_off`, `trial`), and the expiry. The control is three actions plus clear:

- **Force on.** Optional end time. Use this to comp a module.
- **Force off.** Optional end time. Wins over the Price. Use this when a customer must lose a module before the billing period ends.
- **Trial.** End time required. The module is on until that timestamp, then the plan applies again.
- **Clear.** Removes the override.

The panel shows the tree. Children sit under the parent. A child control is disabled in the panel when the parent is off, with the reason visible to Jake only (“parent dispatch is off”). Tenant users never see that sentence.

Skyway is seeded to plan `internal` with every key and zero overrides. Saving a `force_off` for Skyway is allowed, and it is the one way the live company loses a module. Do not seed any `force_off`.

#### Server enforcement

One helper, `requireFeature(ctx, key)`, used at the top of every route in the catalog table. `ctx` is the membership already resolved for the host. The helper reads the effective row.

- Missing or `enabled = false`: respond **404** with the same body as an unknown route (`{ "error": "Not found" }`). Do not return 402, and do not name the feature. A 402 tells the caller a paid module exists.
- Crons do not 404. They skip that tenant for that job and continue the others. The FlightAware poll does not call AeroAPI for a tenant with `dispatch.tracking` off. Currency alerts skip `crew.currency` off.
- Public token routes (`trip-public`, `aog-public`, `service-public`, `operator-flight`) check the feature for the tenant inside the token. A link minted yesterday dies as soon as the feature is off.
- Repository methods declare the key they serve and call the same helper before the query. Postgres policies on those tables also call `feature_enabled(tenant_id, key)`, a `SECURITY DEFINER` function over `tenant_feature_effective`, so a route that forgot the helper still cannot read the rows. The function is false when the row is missing.
- Break-glass support access can read a module that is off. That path sets a transaction flag the policy allows, and it writes `entitlement.bypass` to the audit log. Tenant sessions cannot set the flag.
- Platform operators toggling features use the migration/platform role on the control-plane tables only. They do not run the query as the tenant.

**Firestore gap, stated plainly.** New tenants never use Firestore, so the helper and the policy are the whole gate. Skyway’s data stays in Firestore until its wave in phase 6, and the browser writes those collections with the client SDK, which the helper cannot see. Hiding the nav still happens immediately, and that is what crews use. A hand-built client could still write a Skyway collection that has not moved. Do not treat `force_off` as a hard stop for a Skyway module until that collection’s read source is Postgres. After the wave, the same 404 and the same policy apply to Skyway on the next request.

#### UI: hidden, not disabled

`NAV_SECTIONS` gains a `feature` field (the key in the table above). `useAllowedSections` keeps the role check and adds `features.has(section.feature)`. `useNavGroups` already removes empty groups, so a company with no crew modules loses the Crew group entirely, on desktop and on the phone bottom bar.

In-page tabs that are not leaves use the same set. On a trip, passengers check `dispatch.manifests`, FRAT and the status board check `dispatch`, lodging checks `dispatch.lodging`, the flight-plan panel checks `integrations.foreflight`, and the email tab checks `email.charter_inbox`. Currency renders hours, rating, minimums, and Wyvern import only when `crew.safety_rating` is on. The broker email action renders only when `dispatch.broker_report` is on.

`GET /api/tenant-context` returns `features` (the enabled keys) and `entitlementsVersion`. The client keeps that list in memory. It also watches the version: Supabase realtime on the tenant row, or a poll on focus and every few seconds if realtime is not the provider. When the version changes, replace the list. If the open section’s key is no longer present, set the section to `home`. Do not toast the feature name. Do not leave the old screen mounted behind an overlay.

There is no client-side “disabled” style, no lock icon, and no in-app catalog of unpurchased modules. Stripe Customer Portal will show the Price names Jake configures in Stripe. That is outside the ops UI. Name those Prices the way a customer should see them on an invoice.

A direct attempt to open a hidden section (saved tab-order, old `localStorage`, a query string) is treated as an unknown section and lands on home.

#### Audit

Every override write, clear, plan rebuild, and observed trial expiry appends `audit_events`. The app role can insert and cannot update or delete.

| Action | When | `metadata` |
| --- | --- | --- |
| `entitlement.override.upsert` | Jake saves force on, force off, or trial | `feature`, `mode`, `expiresAt`, `previous`, `reason` |
| `entitlement.override.clear` | Jake clears the override | `feature`, `previous` |
| `entitlement.plan.applied` | Stripe webhook changes the Price set | `priceIds`, `enabled`, `disabled` (keys that flipped) |
| `entitlement.trial.expired` | The minute job sees a trial or a dated force that just lapsed | `feature`, `mode`, `expiresAt` |
| `entitlement.bypass` | Break-glass read of a module that is off | `feature`, `ticket` or reason |

`actor_user_id` is the platform operator for the first two. It is null for the webhook and the expiry job, with `actor_role = 'system'`. `entity_type` is `feature`. `entity_id` is the key. Do not put customer operational records in `metadata`.

The tenant’s own admins can read these rows only when `platform.audit_export` is on, and only their tenant’s rows. They cannot read another company’s toggles. Jake sees them on the platform panel without that entitlement.

### Super-admin panel

A separate host, recommended `platform.skyway.app`, not a tab inside a tenant’s console. It authenticates only `platform_operators`.

It can:

- Create a tenant (name, slug, primary domain, plan, trial end).
- Create the first owner invite.
- Turn each feature on or off for that tenant (force on, force off, or a feature trial with an expiry), overriding the Stripe tier. This is the first screen of the panel, and it ships as soon as enforcement exists, before the health widgets.
- See subscription status, seat count, and last invoice state from the local `subscriptions` table.
- Suspend, reinstate, and schedule deletion.
- See platform health: cron last success, email queue depth, webhook failures, auth errors.
- Open a tenant’s operational data only through the audited break-glass action.

It cannot run a Firestore query that returns two tenants. The panel’s data source for customer operations is Postgres with `app.tenant_id` set, one tenant at a time. Skyway’s not-yet-migrated collections are visible in the panel only as “still on legacy store”, not as a mixed list.

### Audit log

`audit_events` is append-only: `id`, `tenant_id` (null for platform events), `actor_user_id`, `actor_role`, `action`, `entity_type`, `entity_id`, `metadata` (no document bodies, no tokens), `ip`, `user_agent`, `created_at`.

Write a row for: invite, role change, disable, sign-in success and failure, break-glass, subscription change, feature override, feature-trial expiry, integration connect and disconnect, export, broker-report email, Wyvern import, and suspend. Feature toggles are specified in the entitlements section.

Postgres privileges: the app role can `INSERT` and `SELECT` its own tenant. It cannot `UPDATE` or `DELETE`. Exports are an entitlement.

The existing `ops-audit` subcollection and duty `adminEdits` arrays stay until those collections move, then fold into this table.

### Secrets, backups, monitoring

- Platform secrets stay in Vercel env: Stripe, database URL, auth provider secret, Resend, the legacy Firebase service account, `CRON_SECRET`.
- Per-tenant secrets (QuickBooks refresh token, Veryon token, FlightAware key, Microsoft mail secret, ForeFlight, Wyvern, iCal feed URL) go in `tenant_secrets`, ciphertext only, with a key stored outside the database (KMS or a separate secrets manager). The browser never subscribes to them. This replaces `quickbooks/connection` plaintext tokens before any second QuickBooks company is connected.
- Backups: enable point-in-time recovery on the Postgres provider before Skyway’s first collection moves. Take a Firestore export of `appusers` and a Storage inventory the same day. Retention is a decision below. Test a restore once before calling the migration done.
- Monitoring: one error tracker (the Vercel project plus a Sentry-style sink if Jake wants paging). Cron handlers already return JSON; record success and failure on `job_runs (tenant_id, job, started_at, ok)`. Alert the platform operator, not Jake’s personal inbox, when a job fails.
- The Firebase service account remains until the last Skyway collection moves. After that, delete it from the runtime or reduce it to a locked archive project.

### What stays global

Airport reference cache, FAA weather and NOTAM cache, and the product’s own marketing site. The marketing site is out of scope here. The operations app and the marketing pages should not share a database.

## Data model (control plane)

These tables exist in phase 1. Operational tables are created in the wave that moves that collection, with the same `tenant_id` and RLS pattern.

```text
tenants
  id uuid pk
  slug text unique          -- 'skyway'
  legal_name text
  app_name text
  status text               -- provisioning | active | trialing | past_due | suspended | canceled
  billing_exempt boolean
  created_at timestamptz

tenant_domains
  id uuid pk
  tenant_id uuid fk
  hostname text unique
  kind text                 -- pinned | subdomain | custom
  verified_at timestamptz

tenant_branding
  tenant_id uuid pk
  logo_url text
  accent_dark text
  accent_light text
  contact_email text
  contact_phone text
  tagline text
  email_from text

users
  id uuid pk
  email text unique
  firebase_uid text unique null   -- Skyway's current uid, until auth cutover
  auth_subject text null          -- new provider subject
  name text

memberships
  id uuid pk
  tenant_id uuid
  user_id uuid
  role text
  status text
  unique (tenant_id, user_id)

platform_operators
  user_id uuid pk
  role text                 -- owner | support

identity_providers
  id uuid pk
  tenant_id uuid
  kind text                 -- microsoft | saml | google
  entra_tenant_id text null
  domains text[]

subscriptions
  tenant_id uuid pk
  stripe_customer_id text
  stripe_subscription_id text
  plan_id uuid null
  status text
  seat_quantity int
  trial_ends_at timestamptz
  current_period_end timestamptz

features
  key text pk                 -- 'dispatch', 'crew.safety_rating', ...
  parent_key text null        -- null, or another features.key
  label text
  always_on boolean           -- core shell, user admin, settings
  nav_section text null       -- NAV_SECTIONS id when this key is a leaf
  sort int

plans
  id uuid pk
  code text unique            -- 'internal', 'none', plus Jake's tier codes
  stripe_price_id text unique null
  name text

plan_features
  plan_id uuid
  feature_key text
  primary key (plan_id, feature_key)

tenant_feature_overrides
  tenant_id uuid
  feature_key text
  mode text                   -- force_on | force_off | trial
  expires_at timestamptz null -- required for trial; optional end for force_*
  reason text
  updated_by uuid
  updated_at timestamptz
  primary key (tenant_id, feature_key)

tenant_feature_effective
  tenant_id uuid
  feature_key text
  enabled boolean
  source text                 -- always_on | plan | force_on | force_off | trial
  expires_at timestamptz null
  primary key (tenant_id, feature_key)

-- tenants.entitlements_version int not null default 1
-- bumped in the same transaction as any override or plan rebuild

tenant_secrets
  tenant_id uuid
  name text                 -- quickbooks_refresh_token, ical_url, ...
  ciphertext bytea
  primary key (tenant_id, name)

audit_events
  id uuid pk
  tenant_id uuid null
  actor_user_id uuid null
  action text
  entity_type text
  entity_id text
  metadata jsonb
  created_at timestamptz

job_runs
  id uuid pk
  tenant_id uuid null
  job text
  ok boolean
  detail text
  started_at timestamptz
```

Operational tables follow the collection inventory. Examples once their wave starts:

- `trips` from `trip-state` and `manual-trips`, primary key `(tenant_id, id)` where `id` is the current Firestore doc id so links and HMAC tokens keep working.
- `pilot_logbooks (tenant_id, user_id)` from `pilot-logbooks`.
- `pilot_flight_log (tenant_id, id)` from `pilot-flight-log`.
- `safety_standards (tenant_id)` from `app-config/pilot-safety`, one row per tenant, seeded with the Registered Standard defaults from that PR.
- `fleet_aircraft (tenant_id, tail)` from `app-config/fleet` and `maint-aircraft`.

Foreign keys point at `tenants`. Cross-tenant foreign keys are not allowed. A trip’s crew uids must be memberships of the same `tenant_id`.

## Migration of Skyway into tenant #1

Goal: zero data loss and no cutover window where www.skyway.app is down or reading another company’s data.

Principles:

- Add the control plane beside Firestore. Do not switch the live reads in phase 1.
- Pin `www.skyway.app`, `skyway.app`, and `135ops.app` to slug `skyway` in code and in `tenant_domains`.
- Copy, compare counts, then switch one collection. Firestore remains the source until the compare passes.
- Keep Firestore document ids as primary keys.
- New tenants do not get Firestore documents.
- Take a Firestore export before the first collection switch, and again before each wave.
- Skyway is `billing_exempt` so Stripe cannot suspend production.

Sequence for each collection wave:

1. Create the Postgres table and RLS.
2. Backfill from `appusers` with `tenant_id = skyway`. Scripts run with the migration role, not the app role.
3. Dual-write: Skyway writes go to Firestore and Postgres. Dual-write failure on Postgres logs and does not block the Firestore write, until the compare is clean for a full operating cycle (a busy trip day, plus the nightly currency and passenger-ID jobs).
4. Compare: document counts, and checksums of the fields crews actually use (trip id, tail, times, user email, role).
5. Flip a per-collection flag `read_source = postgres` for tenant `skyway` only.
6. Watch the error tracker. Flip back to Firestore if the screen is wrong. The flag is the rollback.
7. Stop Firestore writes for that collection. Keep the documents as a read-only archive until the next backup cycle, then delete in a later explicit job.

Users first, because every other row points at a uid. Map `users/{firebaseUid}` to `users.firebase_uid` and a membership with the same role. `approved !== true` becomes membership status `invited` or a disabled state, matching today’s pending screen. Do not email those people again and do not change their passwords. They do not have passwords; they have Microsoft.

Auth cutover for Skyway is its own flag, after memberships match the Firestore profiles one-to-one. Until that flag, `src/firebase-auth.js` is unchanged in behavior. The new membership row is a shadow.

Files and Storage move in the same wave as the collection that stores the path. Copy the object to `tenants/skyway/...`, write the new path, verify a signed URL, then delete the old object in a later job. Passenger ID images are on a five-day retention (`api/cleanup-pax-ids.js`). Do not extend that retention during the copy.

Public HMAC tokens: when a collection moves, the token payload gains `tenantId` and the verifier checks it. Old tokens without a tenant id are accepted only for Skyway, and only until their existing expiry (trip links already expire 24 hours after landing). That keeps broker links sent yesterday working.

## Phased roadmap

Each phase ships on its own and leaves www.skyway.app usable. Effort is the amount of the system that has to change, not a calendar estimate.

### Phase 1 — Foundation

**This is the phase everything else depends on.** No second company can be invited yet. Skyway’s screens keep reading Firestore.

Scope:

- Provision Postgres (Supabase or Neon; decision below) with the control-plane tables, forced RLS, the app role, and the migration role.
- Insert tenant `skyway`, branding copied from `src/brand.js`, and pinned domains `www.skyway.app`, `skyway.app`, `135ops.app`.
- Shadow-copy `users` into `users` + `memberships`. Read-only. Login stays on Firebase.
- Edge route `api/tenant-context.js`. For the three pinned hosts, return Skyway. For any other host, return 404. Do not branch the UI on it yet, except a log line, so a bad deploy cannot theme the live site as someone else.
- Feature catalog, plan `internal` (every key) and plan `none` (always-on keys only), empty override table, and `tenant_feature_effective` computed for Skyway as all on. `requireFeature` exists and is covered by tests. It is not yet called by the live routes, so Skyway’s screens do not change.
- `job_runs` and `audit_events` tables, unused by product code except a nightly row that says the shadow copy matched.
- Isolation tests: with the app role, a transaction scoped to a fake tenant id returns zero Skyway rows; a transaction with no `app.tenant_id` returns zero rows; the migration role is not used by any `api/` handler. Entitlement tests: plan `none` resolves only `core.*`; a `trial` override is on before `expires_at` and off after; `force_off` beats the internal plan; a child stays off when its parent is off.
- Export Firestore `appusers` once and record where the export lives.
- Check the live Firestore rules into git as a snapshot (`firestore.rules`) so the current boundary is reviewable. That snapshot is documentation of the gap. Shipping it to Firebase is a separate, explicit apply, not an accidental rules change.

Does not include Stripe, the super-admin toggle screen, subdomains for customers, or moving trips. The catalog and the resolver are here because billing and the panel both call them.

Risk: a shadow copy that writes back into Firestore. The job must be select-from-Firestore, insert-into-Postgres only. Risk: the Edge route accidentally becoming the source of brand on production. Keep the UI on `src/brand.js` until phase 3.

Rollback: drop the new tables. The live app never read them.

### Phase 2 — Identity, invites, and tenant admin

Scope:

- Membership becomes the authorization source for new API checks, starting with `api/admin-settings.js`, `api/delete-user.js`, and `api/auth-profile-bootstrap.js`.
- Tenant owner invite and user list, inside the existing admin settings area, reading memberships.
- Server endpoints for role, approve, and disable. Remove the client `updateDoc` path in `approveUser` / `updateUserProfile` for those fields once the server path is live for Skyway.
- Identity provider row for Skyway’s Entra tenant. Domain allow-list `flyskyway.com`.
- New-tenant users created only in the new auth provider. Skyway’s flag stays on Firebase until the shadow memberships match and Jake signs off on one rehearsal login.
- Mobile: Skyway build unchanged. The tenant-code screen exists behind a flag for non-Skyway builds.
- Call `requireFeature` from the routes in the catalog. Extend `useAllowedSections` with the feature key. Hidden sections unmount to home when `entitlements_version` changes. Skyway resolves every key, so the live nav does not lose a tab.
- First platform screen, on `platform.skyway.app`: the feature tree for a tenant (force on, force off, trial with expiry, clear), writing the audit row in the same transaction. The rest of the panel (health, suspend, break-glass) stays in phase 5. Until this screen exists, overrides are not edited by hand in production.

Depends on phase 1.

Risk: locking crews out. Ship the server role check in shadow mode (log disagreements with the Firestore profile, do not enforce) before enforcing. The rehearsal is a single admin account, then a crew account, on a preview host that is not `www.skyway.app`.

Effort: large. Every `verifyIdToken` helper (`api/_quickbooks.js`, `api/_charter-mail.js`, `api/_foreflight.js`, `api/_user-mail.js`, duty routes, and the rest) needs one shared `requireMembership()` instead of a fresh Firebase init and a one-off role string.

### Phase 3 — Branding, subdomains, email identity

Scope:

- `src/brand.js` reads tenant context. CSS variables stay the mechanism.
- Wildcard `*.skyway.app` (or the product zone Jake picks) on the Vercel project.
- Custom domain verification.
- Email signature, cron broker mail, and report PDFs use tenant branding.
- Dynamic web manifest.
- Replace hardcoded recipient lists with per-tenant notification settings. Skyway’s first settings row is the current Jake / Jim / Zack / MX list, so mail does not change recipients until someone edits it.

Depends on phase 1. Can run beside phase 2.

Risk: OAuth callbacks. Microsoft, QuickBooks, and Veryon are registered for `www.skyway.app`. Subdomain hosts must use a platform callback. Do not point Skyway’s existing callback at a new host in the same change.

Effort: medium for the web theme. Medium again for email and OAuth. Native white-label binaries are out of this phase.

### Phase 4 — Stripe

Scope:

- Products, Prices, Checkout, Customer Portal, webhooks, `subscriptions`.
- Each Price gets a `plans` row and the `plan_features` Jake chose. The webhook rebuilds `tenant_feature_effective` and bumps `entitlements_version` in that transaction. Overrides are left in place, so a force-off still wins after an upgrade.
- Seat quantity enforced at invite time (cannot invite past the quantity).
- Skyway `billing_exempt` on plan `internal`.
- Suspended and `past_due` behavior: read-only versus hard block. Default in this plan is read-only for `past_due` and hard block for `suspended`, so a failed card does not strand a crew mid-trip. Jake can choose otherwise. A hard block is the tenant status, not a feature toggle. It does not flip every key to off in the catalog.
- Account trial is the trial Price’s feature list. Per-feature trials stay on the override row from phase 2.

Depends on phases 1 and 2. Invites in phase 2 should already call a single `assertSeatAvailable()` that returns “allowed” until Stripe is on.

Risk: webhook delay of a few seconds before the effective table updates. The API reads that table, not a stale copy of Stripe. Invite checks should re-read Stripe if the local period end is stale, for the seat count only. A force-off must not be cleared by the webhook.

Effort: medium, and it is new code rather than a rewrite of `App.jsx`.

### Phase 5 — Platform super-admin

Scope:

- `platform.skyway.app`, extending the feature screen from phase 2.
- Create tenant, send owner invite, set plan, suspend, reinstate.
- Health from `job_runs`, email queue, Stripe status.
- Break-glass with an audit row.
- No mixed-tenant lists of trips, passengers, or pilot documents.

Depends on phases 1, 2, and 4. Feature toggles themselves do not wait for this phase.

Risk: building this as a hidden route inside `App.jsx` and reusing the Firebase admin token. Keep it a separate entry point with `platform_operators`.

Effort: medium. New screens, small compared with the operations console.

### Phase 6 — Move operational data, in waves

Do these one wave at a time. Each wave is its own deploy and its own rollback flag. New tenants read Postgres from the start of wave A; they have no legacy rows.

| Wave | Collections | Why this order |
| --- | --- | --- |
| A | `users` (already shadowed), `app-config` fleet / frat / tab order, `maint-aircraft` | Small, and every screen needs the fleet and the directory. |
| B | `trip-state`, `manual-trips`, `manifests`, `tripHotelBookings`, public trip tokens | Core daily use. Highest care. Dual-write across a real trip day before the read flip. |
| C | `duty-periods-v2`, `duty-outside-flying-v2`, legacy `duty-state` and `dutyRecords`, `pilot-currencies`, `pilot-docs` | Regulatory crew records. Includes currency cron. |
| D | Pull request #33: `pilot-logbooks`, `pilot-flight-log`, `app-config/pilot-safety`, broker report email | Only after that PR has merged. If it has not merged, this wave waits. Do not fork those files in the tenancy branch. |
| E | Maintenance: squawks, MEL, AML, wear, MX projects, due items | Large, slightly less live-critical than the trip board. |
| F | `expenses`, `wallet-cards`, QuickBooks, Veryon | After `tenant_secrets` exists. Stop writing plaintext tokens into Firestore as part of this wave. |
| G | Charter mail, user mailboxes, `email-queue`, ForeFlight | Per-tenant OAuth apps. |
| H | Conversations and Stream | One Stream app per tenant, or channel ids prefixed by tenant id and a hard filter on every token. Prefixed channels are the smaller step. A separate Stream app is the stronger step. |
| I | Storage objects and passenger-ID cleanup | With the collection that owns the path. Cleanup cron gains `tenant_id` so it cannot delete another company’s objects. |
| J | FlightAware state and the minute poll | Last, because the poll is global and the API key becomes per tenant. |

Reference caches (airports, weather, NOTAMs) stay shared.

Risk on every wave: dual-write drift. The compare job is the exit criterion, not a visual check of one screen. Risk on wave B: broker links. Old tokens stay valid for Skyway only.

Effort: large in total, and each wave is medium. Wave B and wave C are the ones that can disrupt crews if the read flag flips early.

### Phase 7 — Enterprise closeout

Scope:

- SAML connection UI, behind the entitlement.
- Audit export.
- Restore drill from PITR, documented.
- Pen-test checklist: cross-tenant read on every repository, token for tenant A against tenant B’s trip id, Storage signed URL from another tenant, Stream channel id guessed, cron running with an empty tenant id, and a tenant with `crew.safety_rating` off calling the logbook and broker-report routes (expect the same 404 as an unknown path, and zero rows).
- Remove the Firebase service account from the runtime after wave J.
- Dedicated-database option for a single enterprise contract, using the same schema, only if a customer requires it.

Depends on phase 6 for the Firebase retirement. SAML can start as soon as phase 2’s `identity_providers` table exists.

## Decisions Jake needs to make

1. **Product hostname.** Is the SaaS brand `skyway.app` (`acme.skyway.app`) or `135ops.app` (`acme.135ops.app`)? Skyway Aviation the operator should keep `www.skyway.app` either way. Mixing the operator’s brand and the product’s brand on one apex will confuse customers and the Entra redirect URIs.

2. **Custom domains in the first sale, or subdomains only.** Subdomains are enough to prove branding. Custom domains add DNS support load and a platform OAuth callback.

3. **Postgres and auth vendors.** Supabase (database, auth, storage, realtime in one place) or Neon plus Clerk (or equivalent). This plan’s schema fits both. The Firebase project stays until wave J regardless.

4. **Pricing and packaging.** Tier names, monthly price, what a seat is (every login, or pilots only), whether aircraft count is priced, and the account-trial length. For each Price, which catalog keys are included. The catalog in this document is the switch list. Skyway stays on plan `internal` (every key) unless Jake force-offs one. Confirm there is no in-app upgrade page. Unpaid modules stay hidden, and Stripe invoices are the place a customer sees a product name.

5. **Past-due behavior.** This plan uses read-only when a card fails, and a hard block only when the platform suspends the tenant. Confirm that a crew on a live trip is never locked out by Stripe.

6. **Who may see customer data.** Platform staff see subscription and health only, unless a break-glass switch is on. Confirm Jake wants that, including for his own support work.

7. **Skyway admin role.** Map today’s `admin` users to tenant `owner` (can manage billing) or keep them as `admin` and assign one owner. Jake’s personal Microsoft account is the natural owner and the natural `platform_operators` row. Those are two different hats and should be two different logins or an explicit switch, so a Skyway-ops session is not silently a platform session.

8. **Identity providers for customers.** Microsoft only at first (matches the app), or Google as well. SAML can be schema-ready and UI-later.

9. **Elite Jets.** `src/brand.js` contains a full Elite Jets brand. Is that a second real company that must become tenant #2, a demo skin, or dead code?

10. **Native apps.** One App Store app with a company code, or a white-label binary per customer. The first is the right default. The bundle id `com.flyskyway.ops` cannot be the id of a customer-branded store listing.

11. **FlightAware and QuickBooks.** Each customer brings their own AeroAPI key and their own QuickBooks company. Confirm Skyway will not resell Skyway’s keys inside the subscription.

12. **Wyvern.** Each operator supplies their own ACES export and, later, their own FMS API credentials. The safety-rating module is an entitlement, not a shared pilot database.

13. **Retention and backups.** How long Postgres PITR and the Firestore archive are kept, and who is allowed to download an export. Passenger IDs should stay on the existing five-day deletion.

14. **Notification mail.** Keep sending duty and AOG alerts to the current personal inboxes until the tenant settings screen is edited, or move them to role-based lists (`ops@`, `mx@`) in the same change.

## Suggested first implementation slice

Phase 1 only, on a branch that does not touch `src/App.jsx` behavior:

- Postgres project and the control-plane SQL, including RLS tests and entitlement resolver tests.
- Skyway tenant row, pinned domains, plan `internal` with every feature key, and an effective table that matches. No overrides.
- A one-way shadow copy of `users`.
- Edge tenant context that 404s unknown hosts and returns Skyway for the pinned hosts, unused by the UI.
- Firestore rules snapshot committed, not applied.

After that slice, a second empty tenant can exist in Postgres and still be unable to see a single Skyway document, because its data path does not exist yet and Firestore is not shared with it.
