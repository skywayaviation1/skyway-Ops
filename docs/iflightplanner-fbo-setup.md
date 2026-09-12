# iFlightPlanner FBO and Fuel-Price Setup

Skyway Ops reads iFlightPlanner's v2 FBO dataset through a server-only OAuth
client. Browser code never receives the OAuth client ID, client secret, access
token, or complete provider dataset.

## Production environment

Set these variables in the production deployment and redeploy:

| Variable | Value |
| --- | --- |
| `IFLIGHTPLANNER_CLIENT_ID` | OAuth 2 client ID issued by iFlightPlanner |
| `IFLIGHTPLANNER_CLIENT_SECRET` | OAuth 2 client secret issued by iFlightPlanner |
| `IFLIGHTPLANNER_BASE_URL` | Optional. API base. Defaults to `https://dev.iflightplanner.com/api/v2`. **Required when using production credentials**, because iFlightPlanner issues different credentials for their dev and production environments |
| `IFLIGHTPLANNER_SCOPE` | Optional. Application instance value, only if iFlightPlanner issued one |
| `INTERNAL_API_SECRET` | Existing Skyway server-to-server secret |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Firebase Admin service account |

Environment variables are scoped per environment on Vercel and only reach a new
deployment. A value added to Production is absent from a branch Preview, and a
value added without redeploying never reaches a running function.

Do not put either iFlightPlanner credential in `VITE_*`, client source, Firestore,
or a committed `.env` file. `VITE_*` variables are bundled into browser
JavaScript and are public.

The secret supplied during initial setup should be rotated after deployment if
it was ever pasted into a ticket, chat, log, or other durable record. Update
`IFLIGHTPLANNER_CLIENT_SECRET` with the replacement and redeploy.

## Data flow

1. `api/_iflightplanner.js` sends HTTP Basic client credentials to
   `<base>/oauth2/token` with `grant_type=client_credentials` (plus `scope` when
   configured). iFlightPlanner's written OAuth instructions specify an
   `application/x-www-form-urlencoded` body while their OpenAPI schema declares
   the same endpoint as `application/json`, so the form encoding is tried first
   and JSON is used as a fallback.
2. The access token is held only in warm server memory until shortly before
   expiry.
3. The server calls `/api/v2/airports/fbos/data` with the Bearer token.
4. The JSON response's `data` field is parsed as RFC 4180-style CSV.
5. The normalized dataset is cached in warm server memory for six hours.
6. `/api/iflightplanner-fbos` authenticates the signed-in Skyway user and returns
   only the requested airports (maximum ten).

The raw columns for each matching provider are retained in the server response
alongside normalized contact and fuel-price fields. This makes the integration
tolerant of additional provider columns without hiding them from later code.

## User interface

Open **Flights → Airport & Fuel**. Enter FAA or ICAO identifiers separated by
commas. An optional planned uplift in gallons calculates:

`estimated uplift = posted retail price per gallon × planned gallons`

That estimate deliberately excludes taxes, contract pricing, call-out,
handling, ramp, overnight, and minimum-uplift fees. Posted retail prices can
change without notice and must be confirmed directly with the FBO before
dispatch or quoting.

## Checking it from the app

Open **Flights → Airport & Fuel** and press **Check feed connection**.
Administrators get a live token exchange plus data request; the result names the
failing stage:

| Stage | Meaning |
| --- | --- |
| `configuration` | The credential variables are absent from the deployment that served the request |
| `authorization` | The token endpoint rejected the Client ID/Secret |
| `entitlement` | HTTP 403: the token is valid but the dataset is not enabled for this client, or the credentials belong to the provider's other environment |
| `data` | The provider returned something other than a CSV payload |
| `live` | Working. Reports record count, how many carry posted prices, and the CSV columns |

## Troubleshooting

- **"iFlightPlanner is not configured"** — one or both environment variables
  are absent from the deployed environment. Adding them locally does not update
  production.
- **Authorization failed** — rotate the client secret, confirm that the Client
  ID and Secret are from the same developer account, and redeploy.
- **HTTP 403 at the data stage** — the token exchange worked, so the credentials
  are valid. `/airports/fbos/data` publishes only `200` and `401` in the
  provider schema, so a `403` is a per-client permission gate rather than a
  malformed request. Ask iFlightPlanner to enable the **FBO & Fuel Price Data**
  permission for the API client, quoting the provider message shown by the feed
  check. Their API grants permissions per client — other endpoints in the same
  schema carry notes such as "requires extended API permissions".

  Rule out two other causes first: the credentials may belong to their other
  environment (set `IFLIGHTPLANNER_BASE_URL` to match the credentials you
  hold), and `IFLIGHTPLANNER_SCOPE` should be set *only* if they issued an
  application-instance name — their schema states a single instance should send
  no scope. When only the fuel-price dataset is licensed, Skyway automatically
  falls back to it and reports prices without FBO contact details.
- **No FBO records** — try both FAA and ICAO forms (`APF` and `KAPF`). The
  endpoint checks both automatically, but the provider may not cover that
  airport.
- **Prices missing for an FBO** — the provider has a business record but no
  currently posted numeric retail price in that row. The UI does not turn
  "Call" or blank values into zero-dollar prices.

Provider schema:
https://dev.iflightplanner.com/API/Docs/v2/swagger/schema.json
