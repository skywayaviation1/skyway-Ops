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
   **Also grant the `email` claim.** The app requests the `openid`, `profile`
   and `email` scopes, but Entra only issues an address if the account has a
   mail attribute and the app registration is configured to return it (Token
   configuration → add optional claim → `email`). Without it, sign-in
   completes and is then refused with `auth/missing-email`, because
   authorization is by verified company address.
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
| `auth/missing-email` — "Microsoft signed you in but returned no email address" | Entra issued a token with no `email` claim. Access is granted by verified company address, so there is nothing to authorize against. | Confirm the account has a mail address in Entra, and that the app registration requests the `email` scope and includes the email optional claim. The app requests `openid profile email`; Entra still has to be willing to issue it. |
| `auth/redirect-session-lost` — sign-in succeeds at Microsoft, then returns to the login page | The browser blocked the cross-origin sign-in helper's storage. Standard behaviour in Safari and installed iPhone apps. | Apply the same-origin auth domain below. |
| `auth/profile-identity-mismatch` | The Microsoft address does not match `users/{uid}.email`. | Relink or correct the profile in Firestore rather than creating a second one. |

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

### Preview deployments cannot use this

Vercel branch and commit deployments get a new hostname on every build
(`skyway-ops-git-<branch>-<hash>-<scope>.vercel.app`). Firebase Authorized
domains and Entra redirect URIs both require exact hostnames, so an ephemeral
preview address cannot be wired up in any lasting way.

Preview deployments use the development-auth bypass rather than Microsoft,
because their callback hostnames are ephemeral. Verify real Microsoft sign-in
on the stable production address — `skyway-ops.vercel.app` or a custom domain
such as `ops.flyskyway.com` — where the configuration below is set once.

To switch it on:

1. Set `VITE_FIREBASE_AUTH_DOMAIN` in Vercel to the app's own hostname, for
   example `skyway-ops.vercel.app`. Set it separately on every production
   Vercel project that serves the app; the hostname must match the project.
2. Add `https://skyway-ops.vercel.app/__/auth/handler` to the Entra application's
   redirect URIs. Keep the old firebaseapp.com handler registered until the
   change is verified in production.
3. Confirm that hostname is in Firebase Authorized domains (step 4).
4. Redeploy.

The current stable aliases are `skyway-ops.vercel.app` and
`skyway-ops-wv8r.vercel.app`. Prefer one canonical production project and
domain; if both remain user-facing, each needs its own Vercel variable,
Firebase Authorized Domain entry, and Entra redirect URI.

### Installed iPhone compatibility fallback

Same-origin redirect remains the production configuration to use. As a safety
net, the client detects an installed iOS PWA whose auth helper is still
cross-origin and uses Firebase's user-gesture popup flow for that login. Normal
browser sessions and correctly configured installed apps continue to use
redirect. This fallback prevents WebKit storage partitioning from silently
losing the session, but it is not a substitute for registering the stable
same-origin callback above.

Redirect completion runs once at application boot, before the auth observer.
It is no longer dependent on the login screen mounting, so successful,
pending-approval, and rejected returns all consume Firebase's one-shot result
consistently.

Reference: [Firebase — best practices for `signInWithRedirect`](https://firebase.google.com/docs/auth/web/redirect-best-practices).

## Existing users

Microsoft must return the same email address already stored in
`users/{uid}.email`. If Firebase reports
`auth/account-exists-with-different-credential`, link or migrate that user in
Firebase Authentication rather than creating a duplicate operational profile.

## Diagnosing `auth/redirect-session-lost` when same-origin is already configured

If `VITE_FIREBASE_AUTH_DOMAIN` already matches the serving hostname, this error
is **not** the Safari storage problem. Confirm the configuration is live, then
look elsewhere.

Verify the deployment actually shipped the setting. `VITE_*` variables are
compiled in at build time, so the value must appear in the served bundle and the
project must have been redeployed after the variable was set:

```bash
HOST=www.skyway.app
ASSET=$(curl -s "https://$HOST" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | tail -1)
curl -s "https://$HOST/$ASSET" | grep -o '"[^"]*"\.trim()||"[^"]*"'
# expect the configured hostname before .trim()
```

Verify the same-origin proxy serves Firebase's real helper, including its
relative scripts. If any of these return HTML instead of JavaScript, the handler
page cannot execute and sign-in returns with no session:

```bash
for p in /__/auth/handler /__/auth/handler.js /__/auth/experiments.js; do
  curl -s -o /dev/null -w "$p %{http_code} %{content_type}\n" "https://$HOST$p"
done
# expect 200 text/html for handler and 200 text/javascript for the scripts
```

Confirm the apex domain redirects to the canonical host rather than serving the
app itself. Firebase persistence is per-origin, so `skyway.app` and
`www.skyway.app` serving independently would strand the session on whichever
origin the helper used:

```bash
curl -s -o /dev/null -D- https://skyway.app/ | grep -i '^location'
# expect a 308 to the canonical host
```

When all three pass, the remaining causes are, in order of likelihood:

1. the Microsoft prompt was cancelled or dismissed — retry once;
2. the hostname is missing from Firebase Authentication → Authorized domains;
3. `https://<host>/__/auth/handler` is missing from the Entra app's redirect URIs;
4. the account is outside the tenant in `VITE_MICROSOFT_TENANT_ID`;
5. the account has no `email` claim, which surfaces as `auth/missing-email`.

The login screen's **Technical detail for an administrator** shows the recorded
stage, the auth domain in use, whether the helper is same-origin, and how long
the browser was away, which separates a cancelled prompt from a blocked helper.
