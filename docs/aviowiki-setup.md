# aviowiki setup

Skyway Ops reads airport, FBO, and fuel data from the paid aviowiki API.
The browser never receives `AVIOWIKI_API_TOKEN`, webhook secrets, or the raw
provider payload beyond the airports an approved user asked for.

Docs: https://docs.aviowiki.com

## Environment

`AVIOWIKI_API_TOKEN` is already set as a sensitive variable on both Vercel
projects, for Production and Preview. Do not print it, commit it, or copy it
into `VITE_*`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `AVIOWIKI_API_TOKEN` | Yes, for live data | Paid API token. Sent only as `Authorization: Bearer <token>`. |
| `AVIOWIKI_BASE_URL` | No | Defaults to `https://api.aviowiki.com`. |
| `AVIOWIKI_WEBHOOK_SECRET` | Yes, before webhooks will be accepted | The `secret` returned when the subscription is created. **Not set yet.** |

Set `AVIOWIKI_WEBHOOK_SECRET` on Production and Preview for every Vercel
project that serves `www.skyway.app`, then redeploy. Until it is set,
`POST /api/aviowiki-webhook` responds `503` and does not change the cache.

## What the app calls

1. `GET /free/airports/icao/{icao}` resolves an identifier to an aviowiki aid.
   A FAA 3-letter code that misses is retried with a `K` prefix (`TEB` then `KTEB`).
2. `GET /airports/{aid}` plus runways and operational notes.
   `GET /airports/{aid}/availability?local=true&dateTime={local midnight}`
   loads hours, customs, ATC, and fire cover for that airport's local day.
3. `GET /airports/{aid}/providers/all`, keeping `HANDLING` and `FUEL` only.
   An FBO is a handling provider whose `handlingProvider.serviceLevel` is `FBO`.
4. `GET /providers/{aid}/fuelProducts/all` for each of those providers.
   Prices in litres or imperial gallons are converted to US gallons. A price
   whose currency is not USD is flagged and is not treated as a US dollar price.
5. Results are cached in Firestore collection `aviowiki-cache` (airport identity,
   runways, and notes 30 days; the local-day availability window 24 hours;
   providers 24 hours; fuel 6 hours), with a short in-memory copy, coalesced
   duplicate loads, and stale data if aviowiki errors. The availability cache
   is separate so a corrected local-day window is not stuck behind the 30-day
   airport document.

`/api/aviowiki-fbos` and `/api/aviowiki-airport` use the same Firebase session
and role check as `/api/iflightplanner-fbos` (`crew`, `pilot`, `sales`, `ops`,
`admin`, approved and active). If the API token is missing, those routes still
return `200` with `configured: false` and the FBO screen hides the aviowiki
sections. Runway and airport-name data can still come from the existing
OurAirports cache.

On the FBO screen, aviowiki is the source for the provider list, contacts,
services, payment-card chips, and the verified badge (`featuredOrder` `-1`).
iFlightPlanner remains the source for US dollars per gallon and `updatedAt`.
An aviowiki price is shown only as a labeled fallback when iFlightPlanner has
no posted price for that fuel.

## Webhook

Register this HTTPS endpoint. It must be unique in the aviowiki account:

```text
https://www.skyway.app/api/aviowiki-webhook
```

Create the subscription with the paid token (the token stays in your shell
history only if you paste it there — prefer a secret manager):

```bash
curl -X POST "https://api.aviowiki.com/webhooks" \
  -H "Authorization: Bearer $AVIOWIKI_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.skyway.app/api/aviowiki-webhook",
    "types": [
      "AIRPORT",
      "RUNWAY",
      "AIRPORT_AVAILABILITY",
      "AIRPORT_NOTES",
      "PROVIDER",
      "PROVIDER_AVAILABILITY",
      "PROVIDER_PRODUCT",
      "FUEL_PRODUCT",
      "FUEL_COST"
    ],
    "authHeader": "Bearer PASTE_THE_SECRET_FROM_THIS_RESPONSE"
  }'
```

The `201` body includes `secret` once. That value is the HMAC key.

1. Copy `secret` into Vercel as `AVIOWIKI_WEBHOOK_SECRET` for Production and Preview.
2. Put the same value in `authHeader` as `Bearer <secret>` (update the subscription with `PUT /webhooks/{aid}` if you could not set it on create).
3. Redeploy so the function sees the variable.

aviowiki signs each delivery with `Aviowiki-Signature`:

```text
Aviowiki-Signature: t=<unix milliseconds>,v1=<hex hmac-sha256>
```

The signed message is `{timestamp}.{raw body}` using the subscription secret.
Skyway rejects signatures older or newer than five minutes. If that header is
absent, the same secret is accepted as:

- `Authorization: Bearer <AVIOWIKI_WEBHOOK_SECRET>`
- `x-aviowiki-webhook-secret: <AVIOWIKI_WEBHOOK_SECRET>`
- `https://www.skyway.app/api/aviowiki-webhook?token=<AVIOWIKI_WEBHOOK_SECRET>`

Prefer the signature plus `authHeader`. The query-token URL is a fallback and
will appear in access logs, so do not use it once the signature path works.

A `DATA_CHANGE` event deletes the cached airport, provider, and fuel documents
indexed by the aids in the payload (`data.aid`, parent aid, and any aid in
`data.url`). `FLIGHT_UPDATE` events are acknowledged and ignored. The handler
must return `2xx` within 30 seconds; a `5xx` asks aviowiki to retry.

`GET https://www.skyway.app/api/aviowiki-webhook` reports whether
`AVIOWIKI_WEBHOOK_SECRET` is present. It does not reveal the secret.
