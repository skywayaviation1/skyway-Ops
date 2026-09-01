# FBO calling agent

Skyway Ops places outbound FBO calls through **Vapi** (voice LLM) over **Twilio**
(PSTN). Vercel never holds an open phone session. Skyway owns the schedule,
verified facts, arming, webhooks, transcripts, and ops notifications.

This is the recommended vendor pairing for Skyway: Vapi has outbound assistants,
function calling, transcripts, structured end-of-call data, and warm transfer.
Twilio lets the public caller ID be **Skyway Aviation, +1 (813) 859-5943**
(`+18138595943`) after that number is imported or hosted on the Twilio account
and attached as the Vapi phone number.

## Go-live rule

Ops must **arm each trip**. The calendar never auto-dials. A 5-minute cron
(`/api/fbo-call-schedule`) only places jobs that were armed.

The uploaded trip sheet is authoritative for the departure and arrival FBO
names and phone numbers. iFlightPlanner is not used by the calling workflow. An
ops/admin user must explicitly verify the trip-sheet FBO, airport, and phone for
each leg before it can be armed. The verification is recorded on the call job.
If the uploaded sheet has no dialable phone, the call remains blocked.
Ops may replace the parsed phone for a trip; the override is shown, hashed into
the verified facts, and recorded on the job.

## What the agent may say

- Verified tail, route, FBO name, airport, schedule, passenger **count**
- Tail numbers in aviation phonetics with each digit spoken separately
  (`N444AM` → “November 4, 4, 4, Alpha Mike”)
- Times in **local military (24-hour)** clock at the FBO airport
  (`1630 local EDT`, never AM/PM)
- Catering / special items from the trip sheet
- FBO phone parsed from the uploaded trip sheet
- **No passenger names**

It must not invent hours, prices, hangar availability, or passenger names.
Uncertain or sensitive questions transfer to Skyway operations.

## Environment (server only — never `VITE_*`)

| Variable | Purpose |
| --- | --- |
| `VAPI_API_KEY` | Vapi private key (`VAPI_PRIVATE_KEY`, `VAPI_KEY`, and `VAPI_TOKEN` also accepted) |
| `VAPI_PHONE_NUMBER_ID` | Optional Vapi record ID for +1 (813) 859-5943 (`VAPI_PHONE_ID` also accepted); when absent or set to the telephone number, Skyway finds the record by number |
| `VAPI_ASSISTANT_ID` | Optional pre-built assistant; otherwise Skyway sends an inline assistant |
| `VAPI_WEBHOOK_SECRET` | HMAC secret for `POST /api/fbo-call-webhook` |
| `FBO_CALL_OPS_TRANSFER_NUMBER` | Warm-transfer destination (defaults to +18138595943) |
| `INTERNAL_API_SECRET` | Existing server-to-server secret |
| `CRON_SECRET` | Optional Vercel cron bearer |
| `OPS_ALERT_EMAILS` | Ops notification recipients |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Admin SDK |

In Vapi, set the assistant server URL to:

`https://www.skyway.app/api/fbo-call-webhook`

## Who owns the prompt and voice

| `VAPI_ASSISTANT_ID` | `VAPI_PROMPT_SOURCE` | Result |
| --- | --- | --- |
| set | unset or `dashboard` | The saved assistant's Vapi Dashboard prompt, first message, voice, transcriber, and analysis are used. Edits in Vapi apply to the next call. |
| set | `skyway` | Skyway's built-in Peter prompt, voice, and ops checklist override the Dashboard. |
| unset | any | Skyway sends a complete inline assistant. Dashboard edits have no effect because no saved assistant is used. |

Organization settings shows which source is active.

Skyway always overrides delivery settings — webhook URL and events, recording,
transcript artifacts, and live monitoring — so transcripts, recordings, and
listen-live keep working no matter who owns the conversation.

If the Dashboard owns the prompt, keep these trip variables in it:
`{{tail_number}}`, `{{aircraft_type}}`, `{{arrival_date}}`,
`{{arrival_time_local}}`, `{{arriving_pax_count}}`, `{{departure_date}}`,
`{{departure_time_local}}`, `{{departing_pax_count}}`, `{{parking_request}}`,
and `{{special_instructions}}`. To keep the ops confirmation checklist
populated, define the same structured-output field names in the Dashboard
analysis plan, or set `VAPI_PROMPT_SOURCE=skyway`.

One-off voice tasks use `VAPI_VOICE_TASK_ASSISTANT_ID` when you want a saved
assistant for them. The entered task is still supplied as `{{task}}` and
appended as a system message so the task cannot be lost.

Peter's concise Logistics Specialist prompt is in
[`docs/vapi-fbo-assistant-prompt.md`](./vapi-fbo-assistant-prompt.md). Skyway
also sends this prompt through `assistantOverrides.model` on every outbound
call, so a stale saved-assistant prompt cannot replace it.

## Operator workflow

1. Administrator enables FBO calling in Organization settings after the env vars
   are deployed.
2. Open a flight → Operations → **FBO calls**.
3. Review the trip-sheet FBO, airport, and phone. If needed, enter a replacement
   phone and select **Use number**, then verify the effective call details.
4. With **Call immediately when armed** selected (the default), arming places
   the initial call immediately. An arrival call also creates a fresh
   re-verification call for two hours before arrival.
5. Use **Call now** to pull any armed/scheduled job forward. While a call is
   active, **Listen live** streams Vapi's two-channel PCM audio in the browser.
   Failed attempts retry, then email ops.
6. Completed calls show an FBO confirmation checklist for movement, fuel,
   hangar, catering, ground transportation, and hours. Ops/admin can request a
   fresh, short-lived private playback link for the recorded call.
7. **Retry call** creates a new immediate call linked to the finished original,
   preserving its checklist, transcript, and recording. **Delete** removes only
   finished call history; active and scheduled calls cannot be deleted.
8. Transcripts, checklists, and recordings stay on the trip. They are **not**
   copied onto broker public tracking links.
9. If the trip changes after a completed call, ops can queue an **update** call.

## “Vapi keys missing” when the variables are set in Vercel

Skyway reads these variables on the server on every request, so the chip in
Settings reports what **the running deployment** can see. When it says a key is
missing, Organization settings names the exact variable. Work through these in
order:

1. **Redeploy.** Vercel injects environment variables at build time, so a value
   saved after the last deploy is not in the running deployment. Redeploy the
   Production deployment after saving.
2. **Check the environment.** The variable must be enabled for **Production**,
   not only Preview or Development.
3. **Check the name.** A leading or trailing space in the variable name creates a
   different variable. Skyway also accepts Vapi's own labels
   (`VAPI_PRIVATE_KEY`, `VAPI_PHONE_ID`).
4. **`VITE_` prefix.** `VITE_*` variables are compiled into the browser bundle
   and are never read as server credentials. Settings flags this, and the key
   must be rotated because a published bundle exposed it.

Wrapping quotes and trailing newlines are stripped when the value is read, so a
value pasted as `"key"` still authenticates.

`VAPI_PHONE_NUMBER_ID` is Vapi's record ID, not the printed telephone number.
For Skyway's +1 (813) 859-5943 number it is optional: with a valid API key,
Skyway lists the organization's Vapi phone records and selects that number
automatically. The number must already be imported from Twilio into Vapi.

## Collections

- `fbo-call-jobs/{id}` — dial jobs
- `fbo-call-events/{id}` — webhook dedup
- `trip-state/{tripId}.fboCalls` — UI mirror
- `app-config/fbo-call` — lead times and enable flag (not API keys)
- `email-queue` — ops notifications
