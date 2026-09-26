# AOG mechanical recovery coverage

Charter Flight Support (CFS) offers aircraft-on-ground mechanical recovery coverage. Skyway collects the premium. Every trip includes 50% at no charge. A broker can buy 100%, ops can gift 100% (“added by Skyway”), or a checkout from a listed broker domain is recorded as 100% complimentary.

The broker is charged only the premium. The trip total is never sent to Stripe.

Default rates, editable on the AOG Coverage tab:

| Aircraft | Premium |
| --- | --- |
| Citation CJ3 | 1.5% of the signed charter trip total |
| Learjet 60 | 2% of the signed charter trip total |

An aircraft type with no rate cannot be upgraded.

## Email test mode (default ON)

Nothing in this feature reaches a broker or CFS until test mode is turned off. All of its outbound mail goes through `api/_notify-test-mode.js`.

| Variable | Meaning |
| --- | --- |
| `NOTIFY_TEST_MODE` | Unset, empty, or anything other than `false` / `0` / `no` / `off` is test mode. Only `NOTIFY_TEST_MODE=false` sends to the real recipients. |
| `NOTIFY_TEST_RECIPIENT` | Where test mail goes. Default `jake@flyskyway.com`. |

In test mode every To, Cc, and Bcc is replaced with the test recipient, the subject is prefixed with `[TEST]`, and the intended recipients are listed at the top of the body.

Tail-change mail should import this same helper. Do not copy the env names into a second switch.

## What gets emailed

- Checkout processed, rate exists: the checkout address is offered 50% included and 100% for the premium, with a per-trip link.
- Checkout domain is on the complimentary list: the checkout address is told they are covered at 100%, and CFS gets a bind email.
- 100% purchased (Stripe webhook): CFS bind email and a broker confirmation.
- 100% gifted from the trip page: CFS bind email only.
- 50% included: CFS is not emailed.

CFS bind mail is To `charter@charterflightsupport.com`, Cc `charters@flyskyway.com`. It includes trip ID, tail, aircraft, dates, route, trip total, coverage level, premium or `complimentary`, who elected it, and attaches the signed election PDF and the charter contract when those files are on record.

## Inbox scan

`GET /api/aog-recovery-inbox-scan` runs from Vercel cron every 10 minutes (`*/10 * * * *`). Ops can also press **Scan inbox** on the AOG Coverage tab (`POST` with a Firebase id token).

The job reads `charters@flyskyway.com` with the existing Microsoft Graph app-only client (`MICROSOFT_MAIL_TENANT_ID`, `MICROSOFT_MAIL_CLIENT_ID`, `MICROSOFT_MAIL_CLIENT_SECRET`, `CHARTER_MAILBOX_UPN`). It looks for broker checkout messages that contain a signed charter-contract PDF, saves the PDF, and extracts trip id, itinerary, aircraft, tail, route, dates, trip total, and the checkout email.

There is no real checkout sample in the repo yet. Extraction is isolated in `api/_aog-checkout-parser.js` (`provisional-1`) and covered by synthetic fixtures in `tests/fixtures/aog-checkout/`. Anything the parser is not sure about is stored on the record (`uncertainFields`, `needsReview`) for ops to correct. Adjust the label list in that file when a redacted sample arrives. Do not commit passenger or broker PII.

Each Graph message id is written to `aogRecoveryProcessed`. A message already marked recorded, skipped, or duplicate is not parsed again.

Matching uses the trip id when the schedule already has it (`trip-state` id or `tripSheetData.tripCode`), otherwise tail plus the first leg’s route. Unmatched checkouts are still saved and shown for ops to link.

## Charter contract on the trip

The signed charter PDF is attached to the trip even when coverage stays at the included 50%. It is stored once under `trip-contracts/{trip id}/charter-contract.pdf` (the same Storage layout style as trip sheets: one object, a download URL, metadata on `trip-state`). Every leg whose `tripSheetData.tripCode` or document id matches that trip id gets the same `charterContract` field, so the trip detail Documents block shows it on each leg.

Match order for the attachment:

1. Trip id, and then every leg that shares it.
2. Otherwise tail, route, and departure date (within 36 hours). A lone tail, or a route with no date, stays unmatched. Two different trip ids that both fit stay unmatched.

The same PDF (same sha256) does not create a second file. A different PDF replaces the current one and the previous file is copied to `trip-contracts/{trip id}/versions/{fingerprint}.pdf`. The attachment records the source mailbox message id, received time, and sender.

If nothing matches, the row stays in **Unmatched contracts** on the AOG Coverage tab. Ops enter a trip id or leg uid and **Attach to trip**, which writes the same field on every leg of that trip. Linking a coverage row does this too when the PDF is already stored.

## Public election and Stripe

The offer link is `/aog-coverage?token=…`. The token is 32 random bytes. The page does not require a Skyway login.

The broker types their full name, checks the agreement, and the server stores a signed PDF (name, agreement, timestamp, IP, user agent, terms version). They then pay on Stripe Checkout. The amount is the stored premium in cents. The browser cannot choose it. Card numbers are entered on Stripe and are not posted to Skyway.

`POST /api/aog-recovery-stripe-webhook` reads the raw body and verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`. Only `checkout.session.completed` with `payment_status=paid` and an amount equal to the locked premium records the payment and sends the bind email. A success redirect alone does not.

Stripe secret keys must be test mode (`sk_test_` or `rk_test_`). Live keys are rejected. Do not pass `payment_method_types`; Checkout uses the dashboard’s dynamic payment methods. Sessions are tagged with `integration_identifier` `aog_recovery_` plus 8 letters.

The terms on the page and in the PDF are a placeholder marked for Jake. Replace `src/aog-recovery-terms.js` and bump `AOG_COVERAGE_TERMS_VERSION` before turning test mode off.

## Ops tab

Aircraft → **AOG Coverage** (roles `ops` and `admin`, same gate as the previous AOG entry). The table lists trip id, broker, checkout email, tail, aircraft, dates, route, trip total, coverage level, premium, payment status, Stripe reference, contract links, offer time, and bind time. Filters and CSV export are on the page. Rates and complimentary domains are edited there and saved by `/api/aog-recovery-settings`.

The trip page has **Add 100% AOG** for ops and admin (`POST /api/aog-recovery-gift`).

The earlier accept/decline log (JetInsight invoice offers) is still available at the bottom of the tab. New checkouts do not use that flow.

## Reporting data model

No report screens are included. The fields below are what a later report should query. Cents and `electionSource` are canonical. Dollar fields (`tripTotal`, `premium`) are copies for the current screens and are always `cents / 100`.

Collection `aogRecovery` (database `appusers`):

| Field | Type |
| --- | --- |
| `currency` | string, always `usd` |
| `tripTotalCents` | integer or null. Contract trip total. |
| `premiumCents` | integer or null. `0` when the premium is not charged. |
| `ratePercent` | number or null. Rate applied, such as `1.5` or `2`. |
| `brokerCompany` | string. Whitespace collapsed and trimmed. |
| `brokerEmail` | string, lower case. Same address as `checkoutEmail`. |
| `brokerDomain` | string. The email domain. |
| `aircraftType` | string. Rate-table name when it matched. |
| `tail` | string, upper case. |
| `tripId` | string, upper case. |
| `origin`, `destination` | string ICAO. A 3-letter US code is stored with a `K` prefix. |
| `legCount` | integer or null. Linked legs when the trip matched, otherwise airports in the route minus one. |
| `coverageLevel` | `included_50`, `purchased_100`, `gifted_100`, `complimentary_100` |
| `electionSource` | `purchased`, `gifted`, `complimentary_domain`, or null when coverage is still the included 50%. |
| `paymentStatus` | `not_required`, `offer_pending`, `awaiting_payment`, `paid`, `complimentary`, `gifted`, `unavailable`, `refunded` |
| `stripeCheckoutSessionId`, `stripePaymentIntentId`, `stripeEventId`, `stripeRefundId` | strings |
| `departAt`, `returnAt`, `createdAt`, `updatedAt` | Firestore Timestamp |
| `departAtUtc`, `returnAtUtc`, `createdAtUtc`, `updatedAtUtc` | UTC ISO strings for the same instants. A date with no time is UTC midnight. |

Event history is append-only at `aogRecovery/{id}/coverageEvents/{eventId}`. Writers use create, so an existing event is never updated. Document id is `offer_sent`, `contract_signed`, or `bound` the first time, and `paid_{paymentIntent}` or `refunded_{refundId}` so a repeat webhook does not add a second row. A forced resend uses a new id. Event types: `offer_sent`, `contract_signed`, `paid`, `bound`, `refunded`. Each event stores `type`, `at` (Timestamp), `atUtc`, `amountCents`, `currency`, trip id, broker domain, aircraft, tail, coverage level, election source, payment status, and the Stripe ids known at that time.

The signed charter contract on the trip is not only a PDF. `trip-state/{leg}.charterContractData` holds the same money, identity, aircraft, ICAO route, leg count, and Timestamp/UTC date fields. Every leg of the trip gets the same object.

Composite indexes are in `firestore.indexes.json`. Deploy them to the named database, not as a ruleset:

```bash
firebase deploy --only firestore:indexes --project skyway-ops-app --database appusers
```

`firebase.json` points at that index file only. Do not deploy `firestore/aog-recovery.rules` by itself.

## Firestore

Merge `firestore/aog-recovery.rules` into the **appusers** database rules. Do not deploy that file as a complete ruleset.

| Collection | Client |
| --- | --- |
| `aogRecovery` | read: ops or admin. write: denied (Admin SDK only) |
| `aogRecoveryConfig` | read: ops or admin. write: denied |
| `aogRecoveryProcessed` | no client access |

## Routes

- `GET` or `POST /api/aog-recovery-inbox-scan`
- `GET` or `POST /api/aog-recovery-public`
- `POST /api/aog-recovery-stripe-webhook`
- `POST /api/aog-recovery-gift`
- `POST /api/aog-recovery-settings`
- `POST /api/aog-recovery-ops`
- `POST /api/aog-recovery-file`

## Setup checklist

1. Stripe test secret in Vercel as `STRIPE_SECRET_KEY` (`sk_test_…` or a restricted `rk_test_…`). Leave live keys off this project.
2. Stripe webhook endpoint `https://<deployment>/api/aog-recovery-stripe-webhook`, event `checkout.session.completed`, signing secret in `STRIPE_WEBHOOK_SECRET`. Use the test-mode endpoint while `sk_test_` is set.
3. Azure: the mailbox app already used for the shared inbox (`docs/charter-shared-inbox-setup.md`) needs application `Mail.Read` (application `Mail.ReadWrite` already includes read). Admin-consent it. Restrict the app to `charters@flyskyway.com` with an Exchange application access policy, or keep the existing RBAC scope that already limits the app to that mailbox. Do not add Mail permissions to the employee sign-in app.
   ```powershell
   New-ApplicationAccessPolicy -AppId <application-client-id> `
     -PolicyScopeGroupId charters@flyskyway.com `
     -AccessRight RestrictAccess `
     -Description "Skyway AOG checkout scan — charters mailbox only"
   ```
   Confirm with `Test-ApplicationAccessPolicy`. Graph credentials stay `MICROSOFT_MAIL_TENANT_ID`, `MICROSOFT_MAIL_CLIENT_ID`, `MICROSOFT_MAIL_CLIENT_SECRET`, `CHARTER_MAILBOX_UPN=charters@flyskyway.com`.
4. Vercel env: `NOTIFY_TEST_MODE` unset or `true`, `NOTIFY_TEST_RECIPIENT=jake@flyskyway.com`, `PUBLIC_BASE_URL` to the deployment origin, `CRON_SECRET` (Vercel sends it on the cron), `RESEND_API_KEY`, `OPS_FROM_EMAIL`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_STORAGE_BUCKET` if it differs from `skyway-ops-app.firebasestorage.app`.
5. Deploy so the 10-minute cron is registered. Merge the Firestore fragment. Replace the placeholder terms before `NOTIFY_TEST_MODE=false`.

## How to test in test mode

1. Leave `NOTIFY_TEST_MODE` unset. Confirm the AOG Coverage tab shows the test-mode banner.
2. Put a synthetic checkout (see `tests/fixtures/aog-checkout/`) in `charters@` with a PDF attached, or press **Scan inbox** after one arrives. The record should appear, including unmatched rows.
3. Open the offer link while signed out. Sign as a fake name, then pay with Stripe test card `4242 4242 4242 4242`. The webhook should mark the row paid.
4. Mail to the broker and to CFS should arrive only at the test recipient, subject starting with `[TEST]`, body listing the real To and Cc.
5. Gift 100% from a trip page and confirm a bind email is queued the same way, with premium `complimentary`.
6. Add a domain under Rates, re-scan a checkout from that domain, and confirm coverage becomes 100% complimentary without a card charge.
7. On a matched trip, open any leg and confirm Documents shows the signed charter contract, the sender, and the received time. Send the same PDF again and confirm the trip still has one current file. A checkout that matches no trip stays under Unmatched contracts until ops attaches it.

`npm test` uses synthetic fixtures only. It does not call Graph or Stripe.
