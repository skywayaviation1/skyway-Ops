# Microsoft company sign-in — complete setup

Skyway Ops accepts Microsoft identities only, and only those whose verified
email ends exactly in `@flyskyway.com`. A new identity receives a `crew`
profile with `approved: false`; an existing administrator must approve it.

Sign-in spans four places — the Entra app registration, Firebase
Authentication, Vercel environment variables, and Vercel routing — and a
mistake in any one of them surfaces in the browser as the same unhelpful
error. Run the verifier before changing anything:

```bash
npm run verify:sso                      # defaults to https://www.skyway.app
npm run verify:sso -- https://other.host
```

It walks the real request chain against the live deployment and names the
stage that is wrong, instead of leaving you to guess which console to open.

## Current production configuration

These are the live values. The verifier confirms each one from outside.

| Setting | Value |
| --- | --- |
| App origin | `https://www.skyway.app` (apex `skyway.app` 308-redirects here) |
| Firebase project | `skyway-ops-app` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `www.skyway.app` (same-origin — required for iPhone) |
| `VITE_MICROSOFT_TENANT_ID` | `aef6138f-7c46-448a-95fe-dda7a700b80f` |
| Entra application (client) ID | `6e65ee4c-d6b7-4a1b-9dfe-0056be0946d1` |
| Redirect URI Firebase sends | `https://www.skyway.app/__/auth/handler` |

None of these are secrets: the browser bundle and the Microsoft authorization
URL already expose all of them. The client secret is the only secret, and it
lives solely in the Firebase console.

## Setup

1. **Entra application.** A **single-tenant** app registration in the Skyway
   directory. Single-tenant is deliberate — a multi-tenant registration would
   let accounts from any other organisation reach sign-in, leaving the
   company-domain check as the only thing refusing them.

2. **Redirect URI, registered under the "Web" platform.** Add
   `https://www.skyway.app/__/auth/handler`, exactly, including the
   `/__/auth/handler` path. The platform matters as much as the URL: Firebase
   redeems the authorization code from a server using a client secret, and
   Entra refuses that for URIs registered under "Single-page application".
   That combination fails *after* the person successfully signs in, which is
   why it looks like a rejected account rather than a settings mistake.

3. **Email claim.** The app requests `openid`, `profile` and `email`, but Entra
   only issues an address if the account has a mail attribute and the
   registration returns it (Token configuration → add optional claim →
   `email`). Without it sign-in completes and is then refused with
   `auth/missing-email`, because authorization is by verified company address.

4. **Client secret.** Firebase Authentication → Sign-in method → Microsoft
   takes the Entra application (client) ID and a client secret. Copy the secret
   **Value**, not the **Secret ID** — Entra shows both, they look alike, and the
   Value is only displayed once, immediately after you create it. Entra secrets
   also expire; note the expiry date, because the app will sign in perfectly
   until it lapses and then fail for everyone at once.

5. **Authorized domains.** Firebase Authentication → Settings → Authorized
   domains needs every hostname the app is served from, as a bare hostname with
   no scheme or port: `www.skyway.app`, the Vercel aliases, and `localhost`.
   Omitting one produces `auth/unauthorized-domain`.

6. **Same-origin auth domain.** `VITE_FIREBASE_AUTH_DOMAIN=www.skyway.app`, and
   `vercel.json` proxies `/__/auth/*` to `skyway-ops-app.firebaseapp.com` ahead
   of the single-page catch-all. See the section below for why this is not
   optional here.

7. **Tenant.** `VITE_MICROSOFT_TENANT_ID` is the Entra Directory (tenant) ID.
   Sign-in must target a specific directory: a single-tenant registration
   refuses Microsoft's shared `/common` endpoint with **AADSTS50194**. When the
   variable is unset the company domain `flyskyway.com` is used as the
   directory instead, which also works. `VITE_*` values are compiled in at build
   time, so setting one without redeploying changes nothing.

8. **Service account.** `FIREBASE_SERVICE_ACCOUNT_JSON` must be available to
   `/api/auth-profile-bootstrap`, which provisions profiles server-side.

9. **Firestore rules** for the named `appusers` database:
   - deny client creation of `/users/{uid}` profiles;
   - prevent users changing their own `role`, `approved`, `active`, `email`, or
     `authProvider`;
   - require an approved, active profile for operational collections.

The React domain check is experience, not the security boundary. The bootstrap
endpoint verifies the signed Firebase token and the sign-in provider before
creating a least-privilege profile; Firestore rules close the direct-client
paths that never pass through React.

## Why same-origin sign-in is required

`signInWithRedirect` sends the browser to `authDomain` to run Firebase's
sign-in helper, then back to the app. When `authDomain` is a different origin,
Safari and every browser that partitions third-party storage block that
helper's storage, so the redirect completes with no session and the person
lands back on the login screen with nothing explaining why. Skyway Ops is used
as an installed iPhone app, where this is the default behaviour, so the
same-origin proxy is a requirement rather than a tuning option.

As a safety net the client detects an installed iOS app whose helper is still
cross-origin and uses Firebase's popup flow for that login. That prevents a
silent failure; it does not replace the configuration above.

Redirect completion runs once at application boot, before the auth observer, so
successful, pending-approval, and rejected returns all consume Firebase's
one-shot result consistently.

Reference: [Firebase — best practices for `signInWithRedirect`](https://firebase.google.com/docs/auth/web/redirect-best-practices).

### Preview deployments cannot use Microsoft sign-in

Vercel branch deployments get a new hostname on every build. Firebase
Authorized domains and Entra redirect URIs both require exact hostnames, so an
ephemeral preview address cannot be wired up in any lasting way. Previews use
the development-auth bypass instead. Verify real Microsoft sign-in on
`www.skyway.app`.

## When every external check passes and sign-in still fails

Two settings cannot be observed from outside the deployment, and both fail
*after* Microsoft has already accepted the person — which is why the app
reports something that sounds like a bad account:

1. **The client secret in Firebase is wrong or expired.** Symptom:
   `auth/invalid-credential`, or `AADSTS7000215` / `AADSTS7000222` in the
   login screen's technical detail. Issue a new secret in Entra under
   Certificates & secrets and paste its **Value** into the Firebase Microsoft
   provider.
2. **The redirect URI is registered under "Single-page application" instead of
   "Web".** Symptom: `auth/invalid-credential`, or `AADSTS9002327`. Move the
   `/__/auth/handler` URL to the Web platform in the Entra app registration.

Entra's own **Sign-in logs** (Entra ID → Monitoring → Sign-in logs) record every
attempt with the exact failure reason, including ones the browser never sees.
That is the fastest way to separate these two.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `auth/invalid-credential` after the Microsoft prompt succeeded | Firebase could not redeem the code against Entra. | The two causes above: client secret, or Web vs single-page platform. |
| `auth/unauthorized-domain` | The **web address serving the app** is not allowlisted. Nothing to do with the email domain. | Add the hostname from the on-screen error to Firebase Authorized domains (step 5). |
| `auth/operation-not-allowed` | Microsoft provider is off. | Enable it under Firebase Authentication → Sign-in method. |
| `auth/invalid-oauth-client-id` | Entra client ID or secret wrong or expired. | Re-enter both in the Firebase Microsoft provider. |
| `auth/missing-email` | Entra issued a token with no `email` claim, and access is granted by verified company address. | Confirm the account has a mail address and the registration returns the email claim (step 3). |
| `auth/redirect-session-lost` — sign-in succeeds at Microsoft, then returns to the login page | If the helper is cross-origin, the browser blocked its storage. If it is already same-origin, the prompt was most likely cancelled or dismissed. | Apply same-origin sign-in (step 6), or retry. Run `npm run verify:sso` to tell the two apart. |
| `auth/profile-identity-mismatch` | The Microsoft address does not match `users/{uid}.email`. | Relink or correct the profile in Firestore rather than creating a second one. |
| `auth/account-exists-with-different-credential` | The email already exists as a password account. | Link or migrate the user in Firebase Authentication. |
| `permission-denied` from Firestore on the login screen | Expected. Data subscriptions start before sign-in completes and are refused until there is a session. | Nothing, unless it persists after a successful sign-in — then it is a Firestore rules problem, not an auth one. |

The login screen prints the failing code, the specific console setting to
change, and a **Technical detail for an administrator** panel carrying the
recorded stage, the auth domain in use, whether the helper is same-origin, and
Microsoft's own AADSTS text. Include that panel's contents in any bug report.

## Directory refusals (AADSTS codes)

Microsoft reports directory-level refusals as `AADSTS` codes, which Firebase
wraps in `auth/invalid-credential`. The login screen extracts and explains the
code rather than showing the generic wrapper.

| Code | Meaning | Fix |
| --- | --- | --- |
| `AADSTS50194` | Single-tenant app registration, but sign-in used `/common`. | Set `VITE_MICROSOFT_TENANT_ID` and redeploy (step 7). Do not make the app multi-tenant. |
| `AADSTS50011` | Redirect URI not registered. | Add `https://www.skyway.app/__/auth/handler` in Entra (step 2). |
| `AADSTS9002327` | Redirect URI is registered as a single-page application. | Move it to the Web platform (step 2). |
| `AADSTS700016` | Application ID not recognised. | Check the client ID in the Firebase Microsoft provider. |
| `AADSTS7000215` | Client secret wrong. | Issue a new Entra secret and update Firebase (step 4). |
| `AADSTS7000222` | Client secret expired. | Same, and note the new expiry date. |
| `AADSTS90002` | Directory does not exist. | `VITE_MICROSOFT_TENANT_ID` is not a real tenant ID. |
| `AADSTS50020` | Account is outside the directory. | Sign in with the `@flyskyway.com` work account. |
| `AADSTS65001` | Admin consent not granted. | Grant consent for `openid`, `profile`, `email`. |

## Existing users

Microsoft must return the same address already stored in `users/{uid}.email`.
On `auth/account-exists-with-different-credential`, link or migrate that user
in Firebase Authentication rather than creating a duplicate profile.
