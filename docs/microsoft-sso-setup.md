# Microsoft company sign-in setup

The application only accepts Microsoft identities whose verified email ends
exactly in `@flyskyway.com`. New identities receive a `crew` profile with
`approved: false`; an existing Skyway administrator must approve access.

## Setup steps

1. **Entra application.** In Microsoft Entra ID, create a **single-tenant** web
   application.
2. **Redirect URI.** Add the callback URL that Firebase shows when you enable
   the Microsoft provider. It looks like
   `https://skyway-ops-app.firebaseapp.com/__/auth/handler` — the trailing
   `/__/auth/handler` matters.
3. **Enable the provider.** In Firebase Authentication → Sign-in method, enable
   Microsoft with the Entra application (client) ID and client secret.
4. **Authorize the app's web address.** In Firebase Authentication → Settings →
   **Authorized domains**, add every hostname the app is served from:
   - the production domain (for example `ops.flyskyway.com`)
   - the Vercel domain (for example `skyway-ops.vercel.app`)
   - `localhost` for local development
   Add the bare hostname with no scheme and no port.
   **Skipping this is what produces `auth/unauthorized-domain`.**
5. **Tenant lock.** Set `VITE_MICROSOFT_TENANT_ID` in Vercel to the Entra
   Directory (tenant) ID.
6. **Service account.** Confirm `FIREBASE_SERVICE_ACCOUNT_JSON` is available to
   `/api/auth-profile-bootstrap`.
7. **Disable password auth** once existing users can sign in with their
   matching Microsoft company accounts.
8. **Firestore rules** for the named `appusers` database:
   - deny client creation of `/users/{uid}` profiles;
   - prevent users from changing their own `role`, `approved`, `active`,
     `email`, or `authProvider`;
   - require approved/active profiles for operational collections.

The React domain check improves the experience, but it is not the security
boundary. The bootstrap endpoint verifies the signed Firebase token and the
sign-in provider before creating a least-privilege profile. Disabling password
auth and enforcing Firestore rules closes the direct-client paths that never
pass through React.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `auth/unauthorized-domain` | The **web address serving the app** is not allowlisted. Nothing to do with the email domain. | Add the hostname shown in the on-screen error to Firebase Authentication → Settings → Authorized domains (step 4). |
| `auth/operation-not-allowed` | Microsoft provider is off. | Enable it under Firebase Authentication → Sign-in method. |
| `auth/invalid-oauth-client-id` | Entra client ID or secret is wrong or expired. | Re-enter both in the Firebase Microsoft provider. Entra client secrets expire — check the expiry date. |
| `AADSTS50011: redirect URI does not match` (shown on the Microsoft page, not in the app) | The Entra app registration does not list the Firebase handler URL. | Add the exact `https://<authDomain>/__/auth/handler` URL to the Entra app's redirect URIs (step 2). |
| `auth/account-exists-with-different-credential` | The email already exists as a password account. | Link or migrate the user in Firebase Authentication rather than creating a second profile. |
| Sign-in loops back to the login screen on iPhone with no error | Safari blocks the cross-origin sign-in helper's storage. | Apply the same-origin auth domain below. |

The login screen prints the failing error code and, for the configuration
faults above, the specific console setting to change.

## Same-origin auth domain (needed for iOS / Safari)

`signInWithRedirect` sends the browser to `authDomain` to run Firebase's
sign-in helper and then back to the app. When `authDomain` is a different
origin from the app, Safari — and any browser that partitions third-party
storage — blocks that helper's storage access, so the redirect completes with
no session and the user silently lands back on the login screen. Because
Skyway Ops is used as an installed iPhone PWA, expect to need this.

The plumbing is already in the repository and is inert until switched on:

- `vercel.json` transparently proxies `/__/auth/*` to
  `skyway-ops-app.firebaseapp.com`, ahead of the SPA catch-all.
- `src/firebase.js` reads `VITE_FIREBASE_AUTH_DOMAIN` and falls back to the
  default Firebase domain when it is unset.

To switch it on:

1. Set `VITE_FIREBASE_AUTH_DOMAIN` in Vercel to the app's own hostname, for
   example `ops.flyskyway.com`.
2. Add `https://ops.flyskyway.com/__/auth/handler` to the Entra application's
   redirect URIs. Keep the old firebaseapp.com handler registered until the
   change is verified in production.
3. Confirm that hostname is in Firebase Authorized domains (step 4).
4. Redeploy.

Reference: [Firebase — best practices for `signInWithRedirect`](https://firebase.google.com/docs/auth/web/redirect-best-practices).

## Existing users

Microsoft must return the same email address already stored in
`users/{uid}.email`. If Firebase reports
`auth/account-exists-with-different-credential`, link or migrate that user in
Firebase Authentication rather than creating a duplicate operational profile.
