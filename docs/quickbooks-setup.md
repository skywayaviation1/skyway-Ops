# QuickBooks Online direct connection

Skyway Ops can connect one QuickBooks Online company. The dedicated
**Accounting** page is visible to accounting and administrators and reads QBO
reports, card accounts, posted purchases, Bills, and account balances directly.

## Intuit application

1. Create an app in the [Intuit Developer dashboard](https://developer.intuit.com/app/developer/dashboard).
2. Enable the **QuickBooks Online Accounting** scope.
3. Register the exact redirect URI **on the Production keys tab**:

   `https://www.skyway.app/api/quickbooks-oauth-callback`

   The value must match `INTUIT_REDIRECT_URI` character for character. Sandbox
   and production have separate keys and separate redirect URI lists; a
   production connection fails if the URI is only registered under sandbox.
4. Intuit requires an app to **go live** before production keys work. In the
   developer dashboard complete the app profile / EULA / host-domain steps and
   move the app to production, then copy the **Production** Client ID and
   Client Secret.

## Connecting to the real company (no sandbox)

Production is the default. The server only uses sandbox when `INTUIT_ENV` is
set literally to `sandbox`; any other value (or none) uses
`https://quickbooks.api.intuit.com`.

To connect the live books:

1. Set `INTUIT_CLIENT_ID` / `INTUIT_CLIENT_SECRET` to the **Production** keys.
2. Leave `INTUIT_ENV` unset, or set it to `production`.
3. Redeploy, then use **Accounting → Connection & export → Connect QuickBooks**
   and pick the real company in Intuit's account chooser.

If a connection was made earlier under sandbox, the Accounting page shows an
environment-mismatch warning. Disconnect and reconnect so tokens and the realm
ID belong to the live company — sandbox tokens are not valid in production.

## Vercel environment variables

Set these for the production deployment and redeploy:

| Variable | Value |
| --- | --- |
| `INTUIT_CLIENT_ID` | Intuit app client ID |
| `INTUIT_CLIENT_SECRET` | Intuit app client secret |
| `INTUIT_REDIRECT_URI` | `https://www.skyway.app/api/quickbooks-oauth-callback` |
| `INTUIT_ENV` | Omit for production; set to `sandbox` only for testing |
| `NEXT_PUBLIC_APP_URL` | `https://www.skyway.app` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Firebase Admin service account |

QuickBooks OAuth values are server-side; no `VITE_` variable is required.

## Connect and map accounts

1. Sign in as accounting or admin.
2. Open **Accounting → Connection & export**.
3. Select **Connect QuickBooks** and approve the company in Intuit.
4. Open **Account mappings**.
5. Map every Skyway expense category to the intended QBO expense account.
6. Map Capital One and Amex to their matching QBO credit-card accounts.

The default account names are suggestions only. Direct sync fails clearly
rather than posting to an incorrect account when an account cannot be found.

## Working in QuickBooks from the app

**Accounting → Invoices & A/R** and **Accounting → Customers** read and write
the connected company live:

- A/R aging buckets (current, 1–30, 31–60, 61–90, 90+)
- Invoice list filtered by open / overdue / paid
- Create an invoice against QuickBooks products & services, with quantity,
  rate, dates and memo
- Email an invoice using QuickBooks' own delivery (`/invoice/{id}/send`)
- Receive a payment against an invoice, optionally choosing the deposit account
- Create customers, reusing an existing customer when the display name matches
- Per-row link that opens the same transaction in QuickBooks Online

Everything posts through the standard Accounting API as the connected company,
so entries appear in QuickBooks immediately with normal audit history. Payroll,
banking rules, reconciliation workflows and the Banking → For Review queue stay
in QuickBooks Online; Intuit does not expose them to third-party apps.

## Sync behavior

- Company-card receipts are matched to **existing QBO Purchase transactions**
  already posted to the mapped credit-card account. Skyway links the receipt;
  it does not create a duplicate Purchase.
- Personal-card expenses must be approved. They sync as QBO **Bills** payable
  to the submitting crew member.
- Merchants and crew reimbursement payees are resolved as QBO Vendors and
  created when missing.
- Personal Bills use `SW-<expense-id>` as QBO `DocNumber`; retries recover the
  existing Bill instead of creating a duplicate.
- A successful sync writes QBO transaction ID/type, company ID, actor,
  timestamp, and sync history back to the expense.
- Tokens refresh automatically on the server. Rotated refresh tokens are
  persisted immediately and never sent to browsers.

The CSV export remains available as a recovery/import option even when direct
sync is connected.

## QuickBooks Banking-feed limitation

Intuit's standard QuickBooks Online Accounting API does **not** expose raw
transactions still sitting under Banking → For Review. Skyway can read and
match a card charge after it is posted/accepted into the QBO credit-card
register as a Purchase.

The operational flow is:

1. Linked card downloads its charge into QuickBooks.
2. Accounting adds/matches that charge in QBO so it is posted to the card
   register.
3. Open **Accounting → Receipt matching** in Skyway.
4. Skyway proposes matches using mapped card account, exact amount, ±5 days,
   and vendor similarity.
5. Accounting confirms the links. No statement upload is required.

Access to unreviewed card-feed rows would require a separate bank/card data
provider; it cannot be implemented with the QBO v3 API alone.
