# QuickBooks Online direct connection

Skyway Ops can connect one QuickBooks Online company and sync approved charges
directly from **Expenses → QuickBooks**. Accounting and administrators can
connect, configure account mappings, reconcile card reports, and sync.

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
2. Open **Expenses → QuickBooks**.
3. Select **Connect QuickBooks** and approve the company in Intuit.
4. Open **Account mappings**.
5. Map every Skyway expense category to the intended QBO expense account.
6. Map Capital One and Amex to their matching QBO credit-card accounts.

The default account names are suggestions only. Direct sync fails clearly
rather than posting to an incorrect account when an account cannot be found.

## Sync behavior

- Company-card expenses must be approved and reconciled to a card statement.
  They sync as QBO **Purchase** entities against the mapped credit-card account.
- Personal-card expenses must be approved. They sync as QBO **Bills** payable
  to the submitting crew member.
- Merchants and crew reimbursement payees are resolved as QBO Vendors and
  created when missing.
- `SW-<expense-id>` is used as QBO `DocNumber`; retries recover the existing
  entity instead of creating a duplicate.
- A successful sync writes QBO transaction ID/type, company ID, actor,
  timestamp, and sync history back to the expense.
- Tokens refresh automatically on the server. Rotated refresh tokens are
  persisted immediately and never sent to browsers.

The CSV export remains available as a recovery/import option even when direct
sync is connected.
