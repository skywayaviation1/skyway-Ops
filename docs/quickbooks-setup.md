# QuickBooks Online direct connection

Skyway Ops can connect one QuickBooks Online company. The dedicated
**Accounting** page is visible to accounting and administrators and reads QBO
reports, card accounts, posted purchases, Bills, and account balances directly.

## Intuit application

1. Create an app in the [Intuit Developer dashboard](https://developer.intuit.com/app/developer/dashboard).
2. Enable the **QuickBooks Online Accounting** scope.
3. Register the exact redirect URI:

   `https://www.skyway.app/api/quickbooks-oauth-callback`

   The value must match `INTUIT_REDIRECT_URI` character for character.
4. Start with an Intuit sandbox company. Switch to production only after the
   chart-of-accounts mappings and sample expense sync are verified.

## Vercel environment variables

Set these for the production deployment and redeploy:

| Variable | Value |
| --- | --- |
| `INTUIT_CLIENT_ID` | Intuit app client ID |
| `INTUIT_CLIENT_SECRET` | Intuit app client secret |
| `INTUIT_REDIRECT_URI` | `https://www.skyway.app/api/quickbooks-oauth-callback` |
| `INTUIT_ENV` | `sandbox` while testing, then `production` |
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
