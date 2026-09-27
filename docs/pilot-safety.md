# Pilot safety rating and broker pilot report

The rating is an operator-owned crew vetting summary. It is not a WYVERN Ltd PASS or Wingman score. Shipped hour minimums and the requirement list are industry-typical Part 135 turbine charter defaults. Admins replace them under Settings → Pilot safety rating. Saved values live at `app-config/pilot-safety`.

## What is stored

`pilot-logbooks/{uid}`

```
{
  uid,
  pilotName,
  hours: {
    totalTime, pic, sic, multiEngine, turbine, night, instrument,
    last90Days, last6Months, last12Months, landings,
    timeInType: [{ type, hours }]
  },
  baseline: {                 // snapshot the automatic log adds to; never a broker field
    asOf: 'YYYY-MM-DD',       // flights are added only when block-in is a later UTC date
    source: 'Wyvern' | 'manual',
    hours: { /* same shape as hours */ }
  },
  hoursMeta: {                // rewritten when the rolled total changes
    asOf, baselineAsOf, baselineSource,
    flownSince: { totalTime, pic, sic, multiEngine, turbine, night, landings },
    last6Months, nightUncomputed, note
  },
  certificate: {
    level: 'ATP' | 'Commercial' | 'Private' | '',
    instrument: true | false | null,
    multiEngine: true | false | null,
    typeRatings: [string]
  },
  drugAlcohol: { enrolled: true | false | null, enrolledDate, programName },
  internalNotes,          // never copied onto a broker report
  wyvern: {               // present after an ACES import; never copied onto a broker report
    id, source: 'Wyvern', importedAt, hoursAsOf, verificationStatus, position
  },
  updatedAt, updatedBy, updatedByName
}
```

Do not put certificate numbers, dates of birth, addresses, medical limitations, or document file URLs in this collection. Those stay on `pilot-docs`, which the rating reads only for certificate grade, ratings text, medical class, and medical expiration.

Checks, training, and the medical class/expiration used day to day stay on the existing `pilot-currencies/{uid}` record and are edited on the Currency screen. The rating reads:

- §135.293 written/oral (`groundOralGeneral293a`)
- §135.293 aircraft knowledge (worst recorded aircraft-specific oral; N/A types are ignored)
- §135.293 competency check (same rule for the competency group)
- §135.297 PIC instrument proficiency check (PIC seat only)
- §135.299 PIC line check (PIC seat only)
- recurrent training, CRM, hazmat, and security training (`tfsspTraining`)
- medical class and expiration
- drug and alcohol enrollment on the logbook

`last90Days` and `last12Months` use the logbook figure when one is saved. If that field is blank, flight time already recorded on `duty-periods-v2` fills it. The source is shown on the rating breakdown.

## Import from Wyvern

Pilot Safety → Import from Wyvern accepts the operator’s ACES export as JSON (an array, or an object with `pilots`, `records`, `data`, or `crew`) or as a CSV with a header row. Field names are matched loosely (`pilotName` / `name`, `flightHours.totalTime` / `Total Time`, `135.297 Completed`, and so on) because the export columns are not fixed yet.

Only rows marked active (`Active`, `Active Pilot`, `current`, `employed`) are imported. Everyone else is listed and skipped. Each active row is matched to an existing user by email, then by normalized name (including `Last, First`), then by a Wyvern ID already stored on that pilot’s logbook. Ambiguous matches stay unmatched until an admin picks the pilot or skips the row.

The preview splits the file into matched, conflicts, and unmatched. A conflict is a saved hour, certificate, medical, or check date that the file would change. Importing overwrites those fields with the Wyvern values. Fields the file leaves blank stay as they are. The write uses `pilot-logbooks/{uid}` and, when the file includes a medical or a check, `pilot-currencies/{uid}`, so a second import updates the same documents. The screen recomputes the safety rating from those records. Each imported logbook stores `wyvern.source`, `wyvern.importedAt`, the Wyvern ID, the hours as-of date, verification status, and position. Phone numbers, certificate numbers, dates of birth, addresses, and document files are not written.

An import is the baseline snapshot. `baseline.asOf` is the file’s hours-as-of date, or the UTC date of the import when the file has none. `baseline.hours` is that snapshot. Completed flights that block in after that date are added on the next sync. A later import replaces the snapshot; it does not create a second baseline, and flights already inside the new as-of date are not added again. Conflict checks compare the file with `baseline.hours` when an as-of date is set, so hours flown since the last import are not flagged as a conflict.

The same rules run from a laptop with a service account:

```
FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/import-wyvern.mjs ./wyvern-pilots.json
FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/import-wyvern.mjs ./wyvern-pilots.json --apply
```

That command is a dry run until `--apply`. It refuses to write while any active pilot is unmatched or ambiguous. `--skip-unmatched` updates the matched rows and leaves the rest. `preview/fixtures/wyvern-sample.json` is fictitious sample data for the preview harness and tests.

## Flight log

`pilot-flight-log/{entryId}` is one credit for one pilot on one leg.

```
{
  id, uid, pilotName, role: 'PIC' | 'SIC',
  tripUid, origin, destination, tail, aircraftType,
  multiEngine, turbine,
  blockOut, blockIn, blockHours,
  flightOff, flightOn, flightHours,
  nightHours, nightStatus: 'computed' | 'unknown' | 'manual',
  landings, timeSource: 'flightaware' | 'schedule' | 'manual',
  status: 'credited' | 'void', voidReason,
  manual, manualOverride,
  audit: [{ at, byUid, byName, action, note }]
}
```

The entry id for a scheduled leg is `{uid}__leg_{PIC|SIC}_{tripUid}`. The same leg updates that document; it is not inserted again.

Time source, in order:

1. FlightAware actual out–in on `trip-state/{tripUid}.oooi` (block). Off–on is stored as flight time when the webhook or the tracking poll recorded it. ForeFlight in this app is a dispatch connection and does not record out/off/on/in.
2. The JetInsight schedule start and end, once the leg has ended, labeled `schedule`.

Duty periods are a daily sum of the same flying, so they are not added on top of the log. They still fill a blank last-90-day or last-12-month field when no baseline as-of date exists.

A leg is skipped when it is still in the future, is HOLD or maintenance, is the same airport at both ends, or the trip is cancelled. A cancelled trip that is still in the schedule voids its credit. A trip that simply disappears from the iCal window is kept; an admin voids it. A manual correction (`manualOverride`) is not overwritten by a later sync. Voiding and correcting require a note and append to `audit` (the last 12 lines are kept).

Block time (out–in) is what the totals use. Flight time (off–on) is stored beside it. Landings count as one per credited leg. Multi-engine and turbine come from the aircraft record (`icaoType` and display name). An unrecognized type counts as total, PIC, and SIC only. Night is civil twilight along the route, using airport coordinates. If either airport has no coordinates, `nightStatus` is `unknown` and that leg is left for a manual night entry.

Career totals are `baseline.hours` plus credited block time whose block-in UTC date is after `baseline.asOf`. A flight on the as-of date itself is treated as already inside the snapshot. Instrument time stays at the baseline. Last 90 days, last 6 months, and last 12 months are the share of the baseline figure that still overlaps the window (an estimate, because the snapshot is not a day-by-day log) plus logged flights after the as-of date that fall in the window. Last 6 months and landings are shown; they are not part of the 0–100 score.

Opening Pilot Safety as admin or ops runs the sync. Crew see their own log and do not write it. `scripts/rebuild-pilot-hours.mjs` recomputes stored totals from the ledger and the baseline; it does not read the iCal feed.

```
FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/rebuild-pilot-hours.mjs
FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/rebuild-pilot-hours.mjs --apply
```

## How the tier is decided

The 0–100 score is 55% experience and 45% requirements with the shipped weights. Each required hour contributes `min(actual / minimum, 1)` (a blank required hour contributes 0). Each included requirement contributes full credit when current, partial credit when expiring, and none when expired or not on file.

The tier is rule-based, so a high score cannot hide a failed item:

- **Does Not Meet** — a required hour is missing or below the minimum, or a required item is expired or not on file (including a certificate below the minimum, or drug and alcohol enrollment not confirmed).
- **Caution** — every minimum is met, and at least one required item is expiring soon.
- **Meets Standard** — every required hour is met and every required item is current.

The standing rating on the crew screen uses the PIC seat. A broker report for a trip scores each pilot in the seat they are assigned, so a PIC-only line check is not charged to the SIC. Unmarked aircraft-specific checks are not failures when another type in that group is recorded; mark types the pilot does not fly N/A on Currency.

## Broker report

`BrokerPilotReport` and both PDF builders render `brokerPilotReport()`. That function copies named fields only. It includes operator, pilot name, seat, aircraft type, generated date, the flight-time as-of date, certificate grade, instrument and multi-engine (yes/no), type ratings, medical class and Valid / Expiring soon / Expired, the hours summary, requirement status with completion and due dates, the score, the tier, and the reasons. The as-of date is the day the totals were last rolled forward. When a baseline date is present, the report also names that snapshot.

It does not include certificate numbers, date of birth, home address, medical expiration or limitations, internal notes, document files, email, or phone.

The public trip link (`GET /api/trip-public`) attaches `trip.crewReports` after the existing token, revocation, rotation, and 24-hour-after-landing checks. A failed lookup yields an empty list and does not take the tracking page down.

Emailing a report (`POST /api/pilot-report-email`) is limited to admin, ops, and sales. The server rebuilds the sanitized report and attaches a PDF through Resend. The shared email queue does not carry attachments, which is why this send does not go through `email-enqueue`.

## Security rules

This repo has no `firestore.rules` file checked in. Apply the following on the `appusers` database before relying on client writes. Server routes use the Admin SDK and bypass these rules.

```
match /pilot-logbooks/{uid} {
  allow read: if isSelf(uid) || isRole(['admin', 'ops', 'sales']);
  allow write: if isRole(['admin', 'ops']);
}

match /pilot-flight-log/{entryId} {
  allow read: if isRole(['admin', 'ops', 'sales'])
    || (isSignedIn() && resource.data.uid == request.auth.uid);
  allow create, update: if isRole(['admin', 'ops']);
  allow delete: if false;
}

match /app-config/pilot-safety {
  allow read: if isSignedIn();
  allow write: if isRole(['admin']);
}
```

`pilot-currencies` and `pilot-docs` keep their existing rules. Sales can read logbooks so they can send a broker report; they cannot edit hours. Pilots can read their own logbook and cannot write it, matching the screen (Currency remains the place pilots do not edit either — ops and admin edit both).

`isSelf`, `isRole`, and `isSignedIn` should be the same helpers the rest of the database uses.
