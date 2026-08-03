# Development authentication bypass

Skyway Ops can automatically sign into a fixed development administrator on
Vercel Preview deployments. This exists only to unblock application development
while Microsoft SSO is being finalized.

## Behavior

- Vercel Preview hostnames are detected automatically by the client.
- `/api/dev-auth-bypass` creates/signs in `developer@flyskyway.com`.
- Its Firestore profile is `admin`, `approved: true`, and marked
  `authProvider: dev-bypass`.
- A permanent warning banner is shown inside the app.
- The endpoint returns **404 unconditionally when `VERCEL_ENV=production`**,
  even if a client flag was accidentally shipped.

## Security warning

Anyone who can open an unprotected preview URL can receive this admin session.
Enable Vercel Deployment Protection for preview deployments while the bypass
exists. Do not share an unprotected preview URL outside the development team.

## Required preview environment

`FIREBASE_SERVICE_ACCOUNT_JSON` must be available in Vercel's Preview
environment. No additional bypass variable is needed on Vercel Preview.

For another non-production environment running through `vercel dev`, set both:

```text
DEV_AUTH_BYPASS=true
VITE_DEV_AUTH_BYPASS=true
```

Plain `vite` cannot use the bypass because it does not serve the `/api`
function; use `vercel dev`.

## Production launch checklist

Before the application is declared production-ready:

1. Delete `api/dev-auth-bypass.js`.
2. Remove the development path from `src/firebase-auth.js`.
3. Remove the development banner from `src/App.jsx`.
4. Remove any `DEV_AUTH_BYPASS` / `VITE_DEV_AUTH_BYPASS` environment values.
5. Delete or disable the Firebase Auth user `skyway-development-admin`.
6. Delete `users/skyway-development-admin` from the named `appusers` database.
7. Verify Microsoft SSO on the production domain.
