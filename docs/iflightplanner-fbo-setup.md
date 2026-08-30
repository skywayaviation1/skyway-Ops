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
| `INTERNAL_API_SECRET` | Existing Skyway server-to-server secret |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Firebase Admin service account |

Do not put either iFlightPlanner credential in `VITE_*`, client source, Firestore,
or a committed `.env` file. `VITE_*` variables are bundled into browser
JavaScript and are public.

The secret supplied during initial setup should be rotated after deployment if
it was ever pasted into a ticket, chat, log, or other durable record. Update
`IFLIGHTPLANNER_CLIENT_SECRET` with the replacement and redeploy.

## Data flow

1. `api/_iflightplanner.js` sends HTTP Basic credentials to
   `https://dev.iflightplanner.com/api/v2/oauth2/token` with
   `{"grant_type":"client_credentials"}`.
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
dispatch or quoting. Operating hours are included when the provider CSV has an
hours column; otherwise Skyway treats hours as unknown.

## Troubleshooting

- **"iFlightPlanner is not configured"** — one or both environment variables
  are absent from the deployed environment. Adding them locally does not update
  production.
- **Authorization failed** — rotate the client secret, confirm that the Client
  ID and Secret are from the same developer account, and redeploy.
- **No FBO records** — try both FAA and ICAO forms (`APF` and `KAPF`). The
  endpoint checks both automatically, but the provider may not cover that
  airport.
- **Prices missing for an FBO** — the provider has a business record but no
  currently posted numeric retail price in that row. The UI does not turn
  "Call" or blank values into zero-dollar prices.

Provider schema:
https://dev.iflightplanner.com/API/Docs/v2/swagger/schema.json
