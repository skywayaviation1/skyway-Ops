# FBO notifications

Departure reminders and arrival scheduling for handling FBOs. Trips are
addressed by the JetInsight trip ID (6–7 letters and digits). A numeric trip
number is not used.

The system reuses the existing mail path: `deliverNotification` in
`api/_email-transport.js`, the Skyway logo wrapper in `api/_email-signature.js`,
and `charters@flyskyway.com` as the ops contact and charter copy. aviowiki
provider lists come from `api/_aviowiki.js` (`HANDLING` / service level `FBO`).

## What ops sees

- Each flight leg has an **FBO** section: matched departure and arrival FBO,
  saved email, reminder status, arrival status, send / resend, manual confirm,
  mark scheduled, and a per-trip email disable.
- **FBO desk** (Flights → FBO desk, and a card on the ops home) lists upcoming
  legs that are not yet scheduled or confirmed, with date, airport, status,
  and missing-email filters.
- A CSR confirms on `https://www.skyway.app/fbo-confirm?token=…` without a
  login. The page shows tail, trip ID, ETA, passenger count or
  `EMPTY / repositioning`, services, and notes. It does not show passenger names.
- Confirmations and questions notify ops in the FBO desk and by email to
  `charters@flyskyway.com` (plus `OPS_ALERT_EMAILS` when set).

## Safety

Test mode is **on** until an administrator turns it off in Settings → FBO email
safety, or on the FBO desk. In test mode every FBO email is delivered to
`jake@flyskyway.com` with a banner naming the intended FBO. `FBO_EMAIL_TEST_MODE=1`
forces test mode even after the toggle.

Per-FBO opt-out lives on the directory entry. Per-trip disable is on the leg.
Every attempt is written to `fbo-email-log`.

Automatic departure mail, advance arrival mail, and the inbound notice are
**disabled**. `GET /api/fbo-departure-cron` is not on the Vercel cron
schedule. When `FBO_AUTO_NOTIFY_DISABLED=1`, that route returns
`{ ok: true, disabled: true }` immediately and does not read or write
Firestore or send mail. Manual send, resend, schedule, and confirm from the
FBO desk still work. If the kill switch is off and the route is called
directly, it still requires `Authorization: Bearer $CRON_SECRET`. Cancelled
legs are skipped.

The same departure time is not mailed twice. A changed departure time is a new
send, one hour before the new time.

Advance arrival mail goes out 24 hours before the scheduled arrival unless an
administrator changes the global lead, a leg overrides it, or ops turns it off
for that trip or FBO. Ops can also pick an exact send time. The same ETA is
not mailed twice. If the ETA moves by 15 minutes or more before the FBO
confirms, an update is sent. If they already confirmed, a time-change notice
is sent and the leg is marked needs re-confirm.

The inbound notice goes to the arrival FBO when the aircraft has actually
departed. While automatic sending is disabled, that notice is not sent on a
schedule. If `/api/fbo-departure-cron` runs with the kill switch off, it reads
FlightAware `flightaware-state/{tail}` (`actualOff`
matching the origin) and trip-state wheels-up / taxi (off-block) timestamps.
Scheduled time alone does not send it. Ops can press **Departed** on the leg
when there is no actual time. Each leg is mailed once.

## Go live

1. Set `FBO_LINK_SECRET` (at least 24 characters) and confirm `CRON_SECRET`,
   `FIREBASE_SERVICE_ACCOUNT_JSON`, `RESEND_API_KEY`, and `AVIOWIKI_API_TOKEN`
   are already present. Optional: `PUBLIC_APP_ORIGIN` (default
   `https://www.skyway.app`) and `OPS_ALERT_EMAILS`.
2. Merge the match blocks in `firebase/appusers-fbo-notify.rules` into the
   deployed **appusers** ruleset. Do not deploy that file alone and do not
   copy it onto `appreview`.
3. Deploy. Leave test mode on. Open a near-term leg, confirm the FBO match,
   and use **Send reminder now**. The message should arrive at
   `jake@flyskyway.com` with the intended FBO in the banner, and a row should
   appear in the audit list.
4. Open the confirm link from that test message (it is addressed to Jake, so
   the link is in his copy). Confirm the page loads with no passenger names.
5. When that looks right, an administrator chooses **Go live** in Settings.
   Do not set `FBO_EMAIL_TEST_MODE=1` in production if you intend to leave
   test mode.

## Firestore

| Collection | Purpose |
| --- | --- |
| `fbo-legs/{legUid}` | Per-leg match, reminder, and arrival confirmation |
| `fbo-directory/{AIRPORT}__{aid}` | Saved email, phone, contact, preferred, opt-out |
| `fbo-email-log/{id}` | Audit of every send |
| `fbo-ops-notices/{id}` | In-app confirmations and questions |
| `app-config/fbo-notify` | Test mode and arrival lead time |

The schedule itself still comes from the JetInsight feed. Ops clients sync the
next week of legs onto `fbo-legs` when the app is open. Automatic mail from
`/api/fbo-departure-cron` is disabled. When that route does run, it reads
`fbo-legs`; it does not fetch the feed itself.
