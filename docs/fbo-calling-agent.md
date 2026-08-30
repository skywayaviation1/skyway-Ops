# FBO calling agent

Skyway Ops places outbound FBO calls through **Vapi** (voice LLM) over **Twilio**
(PSTN). Vercel never holds an open phone session. Skyway owns the schedule,
verified facts, arming, webhooks, transcripts, and ops notifications.

This is the recommended vendor pairing for Skyway: Vapi has outbound assistants,
function calling, transcripts, structured end-of-call data, and warm transfer.
Twilio lets the public caller ID be **Skyway Aviation, 1-727-605-5000**
(`+17276055000`) after that number is imported or hosted on the Twilio account
and attached as the Vapi phone number.

## Go-live rule

Ops must **arm each trip**. The calendar never auto-dials. A 15-minute cron
(`/api/fbo-call-schedule`) only places jobs that were armed.

## What the agent may say

- Verified tail, route, FBO name, airport, schedule, passenger **count**
- Catering / special items from the trip sheet
- iFlightPlanner phone (and hours only when that feed has an hours column)
- **Lead passenger name only when ground transportation is requested**

It must not invent hours, prices, hangar availability, or other passenger names.
Uncertain or sensitive questions transfer to Skyway operations.

## Environment (server only — never `VITE_*`)

| Variable | Purpose |
| --- | --- |
| `VAPI_API_KEY` | Vapi private key |
| `VAPI_PHONE_NUMBER_ID` | Vapi ID of the Twilio number that shows +1-727-605-5000 |
| `VAPI_ASSISTANT_ID` | Optional pre-built assistant; otherwise Skyway sends an inline assistant |
| `VAPI_WEBHOOK_SECRET` | HMAC secret for `POST /api/fbo-call-webhook` |
| `FBO_CALL_OPS_TRANSFER_NUMBER` | Warm-transfer destination (defaults to +17276055000) |
| `IFLIGHTPLANNER_CLIENT_ID` / `IFLIGHTPLANNER_CLIENT_SECRET` | FBO phone lookup |
| `INTERNAL_API_SECRET` | Existing server-to-server secret |
| `CRON_SECRET` | Optional Vercel cron bearer |
| `OPS_ALERT_EMAILS` | Ops notification recipients |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Admin SDK |

In Vapi, set the assistant server URL to:

`https://www.skyway.app/api/fbo-call-webhook`

## Operator workflow

1. Administrator enables FBO calling in Organization settings after the env vars
   are deployed.
2. Open a flight → Operations → **FBO calls**.
3. Confirm the iFlightPlanner match and phone. Arm departure and/or arrival.
4. The agent dials about 2 hours before departure and 90 minutes before arrival
   (configurable). Failed attempts retry, then email ops.
5. Transcripts and structured confirmations stay on the trip. They are **not**
   copied onto broker public tracking links.
6. If the trip changes after a completed call, ops can queue an **update** call.

## Collections

- `fbo-call-jobs/{id}` — dial jobs
- `fbo-call-events/{id}` — webhook dedup
- `trip-state/{tripId}.fboCalls` — UI mirror
- `app-config/fbo-call` — lead times and enable flag (not API keys)
- `email-queue` — ops notifications
