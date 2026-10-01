# Skyway Ops audit — Cursor-era build

**For:** Jake, President, Skyway Aviation  
**Scope:** `main` at `e20e988` (29 Aug 2026) plus live `https://www.skyway.app` on 7 Sep 2026  
**Method:** repo review, `npm run verify:sso`, and unauthenticated probes of production `/api/*`. No application code was changed.

This is an ops-console readiness review, not a feature recap. The product is already useful. The gaps that matter now are authorization holes, missing rules-in-repo, and a few deployment settings that will bite crew (or auditors) before the next feature does.

---

## Executive summary

- **Microsoft sign-in is correctly designed.** Live SSO checks all pass: same-origin `authDomain=www.skyway.app`, `/__/auth/*` proxy, Skyway tenant `aef6138f-…`, Entra redirect `https://www.skyway.app/__/auth/handler`. Do not rip this out.
- **Apex `skyway.app` is fine without being a Firebase authorized domain.** Vercel 308s it to `www` before any JS runs. Adding the apex is optional insurance, not a fix for the errors you are seeing.
- **The live `auth/network-request-failed` and `auth/redirect-session-lost` errors are mostly environmental, not a broken Entra/Firebase wiring.** The first is a failed Identity Toolkit / helper call (WAF, blocked Google APIs, flaky network). The second is the client correctly reporting “OAuth started, no session came back” — usually a cancelled prompt, not a misconfiguration.
- **Vercel `x-vercel-mitigated: deny` is a platform bot/DDoS response, not an app bug.** It will 403 datacenter / AI-browser / some VPN exits. Crew on cell/home/office should be fine. **Do not turn on Attack Challenge Mode** in front of this PWA + OAuth flow.
- **Several production APIs have no auth.** From this environment, unauthenticated callers could generate malfunction/load-manifest PDFs, drain the email queue, run currency alerts, nudge AOG chat, and trigger FlightAware polling. `cleanup-pax-ids` is the only cron that fails closed.
- **Authorization is split and incomplete.** Server profile bootstrap is sound (`crew` / `approved: false`). But the browser can write `role`, `approved`, and `active` directly to Firestore, and **Firestore/Storage rules are not in this repo**, so the real security boundary cannot be reviewed or versioned.
- **Cursor-era delivery is fast and uneven.** ~21 `cursor/*` branches, PRs of 7–18k lines, and `src/App.jsx` at **29,547 lines**. Auth/SSO work is unusually careful. Older email/PDF/cron endpoints were not brought up to the same standard.
- **Fix security and deploy hygiene before the next large agent PR.** Draft PR #22 (FBO calling agent, +7k) should wait until the open APIs and rules gap are closed.

---

## What's solid

**Identity model.** Microsoft-only, single-tenant Entra, `@flyskyway.com` verified emails, server-side profile create, pending-approval gate. `api/auth-profile-bootstrap.js` refuses non-Microsoft tokens and will not let a client pick its own role. Account merge for legacy password users is thought through (`api/auth-link-microsoft.js`, `src/auth-account-merge.js`).

**Same-origin redirect.** Required for installed iPhone. `vercel.json` proxies `/__/auth/:path*` to `skyway-ops-app.firebaseapp.com` ahead of the SPA catch-all. Confirmed live: helper HTML is Firebase’s, not the app shell. `docs/microsoft-sso-setup.md` and `scripts/verify-microsoft-sso.mjs` are the best operational docs in the repo — run `npm run verify:sso` after every identity change.

**Login UX for admins.** Stage + code + AADSTS mapping + “technical detail” panel. `auth/redirect-session-lost` already branches: if same-origin is on, it tells you the prompt was probably cancelled instead of sending you to redo Safari storage fixes.

**Some privileged APIs are done right.** `api/admin-settings.js` and `api/ops-control-action.js` check role **and** `approved` **and** `active`. Public broker/operator/AOG portals use HMAC tokens with expiry (`api/_trip-token.js`, `api/_operator-token.js`, `api/_aog-token.js`). `api/dev-auth-bypass.js` returns 404 in production (confirmed).

**PWA / iPhone.** Long-polling Firestore, network-first JS, stale-chunk reload, Home Screen install path. This is a real crew surface, not a desktop-only toy.

**Tests where logic was extracted.** Duty pairing, availability, FRAT, QBO helpers, auth-environment (popup vs redirect), account-merge rules. 40 test files; the *shape* of testing is correct even though auth/API gates are under-tested.

---

## Top risks / bugs (severity order)

### 1. Critical — Unauthenticated production APIs that send mail, mint tokens, or write data

**Evidence (live, 7 Sep 2026, no credentials):**

| Endpoint | Result |
|---|---|
| `POST /api/generate-report` `{previewOnly:true}` | **200**, PDF generated, recipients listed (`jake@`, `zack@`, `jim@`, `mx@`) |
| `POST /api/generate-manifest` `{previewOnly:true}` | **200**, load-manifest PDF generated |
| `GET /api/email-queue-drain` | **200** `{processed:0, scanned:0}` — job ran |
| `GET /api/currency-alerts` | **200** `{scanned:23, …}` — job ran against live currency docs |
| `GET /api/flightaware-cron-poll` | **200** `{polled:8}` — `CRON_SECRET` is unset or fail-open |
| `GET /api/aog-chat-nudge` | **200** `{nudged:0}` |
| `GET /api/cleanup-pax-ids` | **401** — the one cron that is correct |
| `POST /api/aog-offer-send` | **500** `PUBLIC_BASE_URL not configured` — unauthenticated, saved only by a missing env var |

Code: `api/generate-report.js` (no `idToken`), `api/generate-manifest.js` (same), `api/aog-offer-send.js` (same), `api/mx-due-list-parse.js` (no auth; writes `mxDueItems` via Admin SDK), `api/email-queue-drain.js` (comment: “no auth header check”), `api/currency-alerts.js`, `api/flightaware-cron-poll.js` (secret optional).

**Impact:** Anyone on the internet can email forged 135.65 malfunction reports and load manifests, burn Resend/FlightAware/Anthropic quota, and (if they learn a coverage doc id) mint AOG accept/decline links. This is the highest-priority item in the product.

**Do this:** Require a verified Firebase token + approved profile + role on every user-facing sender. Require `Authorization: Bearer $CRON_SECRET` on every cron and **fail closed** in production if the secret is missing. Copy `api/cleanup-pax-ids.js`. Set `PUBLIC_BASE_URL=https://www.skyway.app` so AOG offers work *after* auth is added — not before.

### 2. Critical — Client can write `role` / `approved` / `active`; rules not in git

```529:537:src/firebase-auth.js
export async function updateUserProfile(uid, patch) {
  const allowed = [
    'name', 'callsign', 'role', 'jetinsightName', 'approved', 'active',
    ...
  ];
  await updateDoc(doc(db, 'users', uid), safe);
}
```

`approveUser` is a direct client `updateDoc`. Docs (`docs/microsoft-sso-setup.md`) *describe* rules that deny self-service privilege changes. **There is no `firestore.rules`, `storage.rules`, or `firebase.json` in this repository.** If the console rules are loose — or drift — any signed-in user can promote themselves.

**Do this:** Export current rules from Firebase into the repo this week. Lock `/users/{uid}` so only Cloud Functions / Admin SDK (or a dedicated `api/admin-users.js`) can change `role`, `approved`, `active`, `email`, `authProvider`. Point the UI at that API. Treat “rules only live in the console” as an audit finding for a 135 ops system.

### 3. High — Preview deployments mint a full admin

`api/dev-auth-bypass.js` + hostname detection in `src/firebase-auth.js`. On `VERCEL_ENV=preview` the endpoint creates `developer@flyskyway.com` / UID `skyway-development-admin` with `role: admin`, `approved: true`. Production 404s (confirmed). The comment is honest: anyone with an unprotected preview URL is an admin.

**Do this:** Turn on Vercel Deployment Protection for all previews (SSO or password). Treat a leaked `*.vercel.app` URL as a credential. Do not disable the bypass until Microsoft works on previews — it cannot, because preview hostnames are ephemeral — but do not leave previews public. The open draft `cursor/dev-login-bypass-4b8e` (PR #19) should not widen this.

### 4. High — Token-only APIs (no approved / role)

`send-email` / `email-enqueue` accept any valid Firebase token (confirmed: missing token → 401, but a pending/unapproved account would pass). Same pattern: `aog-link`, `service-link`, `send-push`, `wear-notify`, `parse-receipt`, `mel-search`. `delete-user` and `duty-admin-action` check role but not `approved`/`active`.

**Do this:** One helper — `requireApprovedUser(req, roles?)` — used everywhere. Pending or disabled accounts must not send mail or mint vendor links.

### 5. High — `PUBLIC_BASE_URL` unset; stale authorized domains

AOG offer send is dead in production because `PUBLIC_BASE_URL` is missing. Firebase authorized domains currently include `www.skyway.app` (good), `localhost`, default Firebase hosts, `skyway-ops.vercel.app`, **`flyskyway.com`** (the marketing site, not this app), and **two stale preview hostnames**. Apex `skyway.app` is absent (see below).

**Do this:** Set `PUBLIC_BASE_URL`. Remove stale preview hosts and `flyskyway.com` unless you truly serve the Auth SDK there. Adding `skyway.app` is harmless insurance; it is not required while the 308 holds.

### 6. Medium — No security headers; CORS `*` on the HTML and many APIs

Live `www.skyway.app` sends `access-control-allow-origin: *` and HSTS only. No CSP, no `X-Frame-Options` / `frame-ancestors`, no `X-Content-Type-Options`. ~28 API handlers also set `*`, including mail and delete-user.

**Do this:** In `vercel.json` headers: `Content-Security-Policy` (start report-only), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`. Restrict API CORS to `https://www.skyway.app`. Keep `*` only on intentional public token pages.

### 7. Medium — Client secrets / config hygiene

Firebase **web** config in `src/firebase.js` is expected to be public. Restrict that API key in Google Cloud (HTTP referrers + API restrictions) so it is not a blank check for Identity Toolkit from arbitrary origins. `authDomain` is env-driven in `firebase.js` but **hardcoded** to `skyway-ops-app.firebaseapp.com` in `src/firebase-storage.js`, `src/firebase-expenses.js`, and `public/firebase-messaging-sw.js` — drift waiting to happen. No `.env.example` despite `.gitignore` allowing one. Calendar the Entra client secret expiry; when it lapses, **every** login fails at once with `auth/invalid-credential` / `AADSTS7000222`.

### 8. Medium — `App.jsx` monolith + dead password-era UI

29,547 lines. `LegacyLoginScreen` (~450 lines) and `VerificationScreen` call `signIn` / `resendVerification` that **do not exist** on `firebase-auth.js`. `authState === 'unverified'` is unreachable. Users admin still offers password reset. `docs/iphone-installation.md` still says the canonical host is `skyway-ops.vercel.app`.

**Do this:** Delete the dead screens this week (small, safe). Do **not** start a rewrite of `App.jsx`. Extract only when a feature is already being touched. Update the iPhone doc to `www.skyway.app`.

### 9. Medium — Role vocabulary and admin-init drift

UI roles: `crew | sales | ops | maint | accounting | admin`. Duty/ForeFlight also use `pilot` / `chief-pilot`. `INTEGRATION.md` still says `"pilot"`. ~60 copies of `getAdmin()` in `api/`. New features added shared helpers (`_quickbooks.js`, `_charter-mail.js`); old ones did not.

**Do this:** One `api/_auth.js`. One `src/roles.js`. Stop adding new `getAdmin()` copies.

### 10. Low — Test gaps on the paths that fail in production

`auth-environment.test.mjs` covers popup-vs-redirect **policy**. Nothing exercises `watchAuth`, `completeMicrosoftRedirect`, `auth-profile-bootstrap`, or “this handler requires approved+role”. Several tests currently fail in a clean checkout (asset / import drift; 277/292 passed here). Agent PRs keep landing source-string assertions that rot.

**Do this:** Add handler-level tests that grep/require `CRON_SECRET` / `verifyIdToken` + approved on the endpoints in #1 and #4. Do not wait for a full Playwright SSO suite.

---

## Live auth errors and the Vercel 403

### What is actually configured (verified)

```
App origin:          https://www.skyway.app
Apex:                https://skyway.app  →  308 → www
authDomain:          www.skyway.app          (same-origin)
Authorized domain:   www.skyway.app          (apex not listed)
Helper proxy:        /__/auth/* → skyway-ops-app.firebaseapp.com
Tenant:              aef6138f-7c46-448a-95fe-dda7a700b80f
Entra client:        6e65ee4c-d6b7-4a1b-9dfe-0056be0946d1
Redirect URI:        https://www.skyway.app/__/auth/handler
Dev bypass (prod):   404
```

`npm run verify:sso` against production: **all observable checks passed.** The client secret and “Web vs SPA platform” in Entra cannot be seen from outside; if Microsoft’s prompt succeeds and Firebase then returns `auth/invalid-credential`, look there first.

### `auth/network-request-failed` at stage `redirect-result`

This is `getRedirectResult(auth)` **throwing**, not returning empty. The browser never finished talking to Identity Toolkit and/or the same-origin helper.

Typical causes, in order:

1. **Vercel mitigation / firewall 403’d `/__/auth/*` or the document** for that client (`x-vercel-mitigated: deny`). The Microsoft redirect then lands on a deny page instead of the Firebase helper.
2. **The browser blocked `identitytoolkit.googleapis.com`** (privacy browser, AI browser, corporate SSL inspection, aggressive ad-block).
3. Transient network on a phone that backgrounded mid-redirect.

It is **not** “wrong tenant” or “apex missing from authorized domains.” Those produce different codes (`AADSTS50194`, `auth/unauthorized-domain`).

**What to change:** Keep same-origin auth. Improve the login copy for this code (VPN / ad-block / retry — not “check your connection”). In Vercel Firewall, **exclude `/__/auth/*` from any challenge** and do not enable Attack Challenge Mode on this project. If you need bot defense, challenge `/` if you must, never the OAuth helper.

This environment’s cloud IP was **not** 403’d today (HTML and APIs returned 200). So the mitigation you saw is intermittent or ASN-specific — typical of Vercel system mitigation, not a permanent Attack Mode setting. Check Vercel → Firewall → live logs for `x-vercel-mitigated` when a crew member reports it.

### `auth/redirect-session-lost` / stage `redirect-no-session`

The client sets `sessionStorage.skyway_oauth_redirect_at`, sends the browser to Microsoft, and on return `getRedirectResult` is empty and there is no `currentUser`. With same-origin already on, this almost always means:

- the person closed or cancelled the Microsoft prompt, or
- `sessionStorage` was dropped (Safari private, some in-app browsers, restored tab after a crash).

The login screen already says so when `sameOrigin === true`. Treat repeat reports **after a completed Microsoft password/MFA** as a WAF/helper problem (see above), not as “add apex to authorized domains.”

**Do not** switch back to `authDomain=skyway-ops-app.firebaseapp.com`. That re-breaks installed iPhone. **Do not** switch the default flow to popup on desktop; popup is the iOS-PWA fallback only.

### Apex vs www

Hypothesis confirmed: apex is absent on purpose, and that is correct while Vercel 308s. Firebase checks the origin the SDK is running on. Crew never run JS on `skyway.app`. Entra’s redirect URI is www. Leave it. Optionally add the apex later if you ever stop the 308.

### AI browsers and Cursor cloud browsers

They will keep failing. They look like bots (datacenter IP, odd UA, partitioned storage). An internal 135 console should not be optimized for them. Tell crew: **Safari or Chrome, `https://www.skyway.app`, preferably the Home Screen icon.** Use `npm run verify:sso` from a normal network when debugging identity, not from an AI browser.

### Stale iPhone doc

`docs/iphone-installation.md` still lists `skyway-ops.vercel.app` as the primary host. Production is `www.skyway.app`. Update the checklist so the next agent does not “fix” auth back to the old hostname.

---

## How Cursor work shaped the codebase

| Fact | Number |
|---|---|
| Commits on this clone | ~800 |
| Cursor Agent commits | 180 (~21% of authors) |
| Open `origin/cursor/*` branches | 21 |
| Largest merged agent PRs | #13 +15.7k, #1 +16.6k, #4 +18.8k, #9 +7.4k |
| `src/App.jsx` | 29,547 lines |
| `/api` handlers | 88 + 17 helpers |

Pattern: vertical slices land on `cursor/<feature>-42f5`, then an integration merge (`1a41675` bundled availability + email + FRAT + ForeFlight). Newer slices (QBO, charter mail, SSO) come with shared helpers and tests. Older slices (PDF email, crons, user profile writes) were left as “it works in the UI.” That is why auth looks mature and `/api/generate-report` has no auth.

Draft PR #22 (Vapi/Twilio FBO calling, +7k) is the same pattern. Do not merge it until items 1–3 above are closed — a phone-calling agent on an open API surface is the wrong next increment.

---

## Suggested next 2-week priority

### Days 1–3 — close the open doors (no new features)

1. Auth-gate `generate-report`, `generate-manifest`, `aog-offer-send`, `mx-due-list-parse` (approved + role). Preview-only PDF must also require a session.
2. `CRON_SECRET` required on `email-queue-drain`, `aog-chat-nudge`, `currency-alerts`, `flightaware-cron-poll`, `airport-coords-refresh`, `service-chat-nudge`. Fail closed if unset in production.
3. Set `PUBLIC_BASE_URL=https://www.skyway.app`. Confirm Entra client-secret expiry date on a calendar.
4. Enable Vercel Deployment Protection on Preview. Confirm Attack Challenge Mode is **off**. Add a Firewall exception for `/__/auth/*` if any custom rules exist.

### Days 4–7 — make authorization real

5. Export Firestore + Storage rules into the repo. Deny client writes to `role` / `approved` / `active` / `email` / `authProvider`.
6. Add `api/admin-users.js` (or similar) for approve / role / disable; change `updateUserProfile` so the browser cannot send those fields.
7. Introduce `api/_auth.js` (`requireApprovedUser`, `requireCronSecret`) and switch `send-email`, `email-enqueue`, `aog-link`, `service-link`, `delete-user` onto it.
8. Restrict the Firebase web API key by HTTP referrer (`https://www.skyway.app/*`).

### Days 8–10 — auth UX and headers

9. Replace the `auth/network-request-failed` one-liner with the same style as redirect-session-lost (VPN / blocker / retry / “if you finished Microsoft, this is a network/WAF problem”).
10. Add the security headers in `vercel.json`. Remove `Access-Control-Allow-Origin: *` from authenticated APIs.
11. Delete `LegacyLoginScreen` / `VerificationScreen` / password-reset copy. Fix `docs/iphone-installation.md`.

### Days 11–14 — only then, product

12. Hygiene tests that fail the build if a new `/api/*` handler ships without an auth helper.
13. Review draft PR #22 against the new auth helper; do not merge a calling agent that can be invoked without an approved ops session.
14. Leave the `App.jsx` split for later. If something must move, start with Users admin (it is the privilege UI).

### Explicitly later

- Native mobile (PR #7 foundation is not on `main`).
- Multi-tenant marketing / `135ops.app`.
- Replacing redirect with a custom Entra SPA flow.
- Adding `skyway.app` to authorized domains (optional, low value while 308 exists).

---

## What this audit did **not** do

- Did not read production Firestore rules (they are not in git).
- Did not complete a real Microsoft login (no company account in this environment).
- Did not enable or inspect Vercel Firewall config (not in the repo). Check the dashboard for Attack Mode and custom IP rules.
- Unauthenticated probes **did** execute `email-queue-drain`, `currency-alerts` (0 emails sent), `flightaware-cron-poll` (8 tails), and `aog-chat-nudge`. No mail was sent from the PDF endpoints (`previewOnly: true`). Rotate nothing on that basis, but treat those URLs as already exercised by the public internet.

---

## Quick commands

```bash
npm run verify:sso                      # live identity chain
npm run verify:sso -- https://www.skyway.app
npm test                                # unit/hygiene; some asset tests fail in a bare checkout
```

When a crew member cannot sign in, collect the login screen’s **Technical detail** block (stage, code, helper host, same-origin, AADSTS text) plus whether they used Safari Home Screen vs an in-app / AI browser. That block was built for this exact conversation.
