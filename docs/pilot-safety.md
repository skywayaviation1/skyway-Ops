# Pilot safety rating and broker pilot report

The rating is an operator-owned crew vetting summary that uses the Wyvern Registered Standard as its shipped defaults, split by PIC and SIC. Brokers see a crew summary only when every assigned pilot meets that standard. It is not a live WYVERN Ltd audit. Admins replace the minimums in Compliance → Currency → Rating minimums. Saved values live at `app-config/pilot-safety`.

## What is stored

`pilot-logbooks/{uid}`

```
{
  uid,
  pilotName,
  hours: {
    totalTime, pic, sic, fixedWing, rotorWing, singleEngine, multiEngine,
    multiEngine90, multiEngine12, turbine, night, instrument,
    last90Days, last6Months, last12Months, landings,
    timeInType: [{ type, hours, picHours }]
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
    typeRatings: [string],
    typeVerified: true | false | null,
    country: string
  },
  background: { employment, accident: true | false | null, enforcement: true | false | null },
  drugAlcohol: { enrolled: true | false | null, enrolledDate, programName },
  internalNotes,          // never copied onto a broker report
  wyvern: {               // present after an ACES import; never copied onto a broker report
    id, source: 'Wyvern', importedAt, hoursAsOf, verificationStatus, position,
    hiredOn, base, newHireHours, passStatus, certificateIssuedOn, faaVerifiedOn, backgroundCheckedOn
  },
  updatedAt, updatedBy, updatedByName
}
```

Do not put certificate numbers, dates of birth, addresses, medical limitations, or document file URLs in this collection. Those stay on `pilot-docs`, which the rating reads only for certificate grade, ratings text, medical class, and medical expiration.

Checks, training, and the medical class/expiration used day to day stay on the existing `pilot-currencies/{uid}` record and are edited on the Currency screen. The rating reads:

- indoctrination (`basicIndoctrination`, presence only)
- aircraft-specific training (worst recorded `groundOral293a_*`; N/A types are ignored)
- simulator / competency training (worst recorded `sim293b_*` or `competencyCheck293`), including a motion-simulator note
- §135.297 instrument proficiency check (PIC seat, 6 months unless the saved minimum says otherwise)
- §135.299 line check (PIC seat, 7 months unless the saved minimum says otherwise)
- recurrent training
- medical class and expiration, plus last medical date when Currency has one
- UPRT and enhanced pilot training dates, as flags only

CRM, hazmat, security, and drug-and-alcohol enrollment stay on the record and are not part of this standard.

`last90Days` and `last12Months` use the logbook figure when one is saved. If that field is blank, flight time already recorded on `duty-periods-v2` fills it. The source is shown on the rating breakdown.

## Import from Wyvern

Compliance → Currency → Import from Wyvern accepts the operator’s ACES export as JSON (an array, or an object with `pilots`, `records`, `data`, or `crew`) or as a CSV with a header row. Field names are matched loosely (`pilotName` / `name`, `flightHours.totalTime` / `Total Time`, `135.297 Completed`, and so on) because the export columns are not fixed yet.

Only rows marked active (`Active`, `Active Pilot`, `Active on Roster`, `current`, `employed`) are imported. `employment_status` such as Full Time is stored as employment and does not, by itself, mark the row active. Everyone else is listed and skipped. Each active row is matched to an existing user by email, then by normalized name, then by a Wyvern ID already stored on that pilot’s logbook. Name matching ignores case, treats a middle name on only one side as the same person, and collapses a surname typed twice (`Mina Pell Pell` matches `Mina Quinn Pell`). Ambiguous matches stay unmatched until an admin picks the pilot or skips the row.

The active-pilot JSON is one object per pilot: roster and employment, a certificate object (type, country, ratings — never the certificate number), medical class and check date, background AID/EIS text reduced to yes/no, an experience object (totals, fixed-wing, rotor, single- and multi-engine, and `by_type`), checks, and `type_ratings`. A type string such as `CE-525, CE-525S` stays one active type. Wyvern leaves check expiry empty, so the importer fills due dates from the completion date and the PIC intervals in Rating minimums (medical 12, IPC 6, line check 7, aircraft, recurrent, and simulator 12). Indoctrination is stored as a completion with no due date. An explicit expiry already in the file is kept. Rows whose PIC time exceeds total time, or whose other hour blocks disagree the same way, stay in the preview with a warning. Free-text notes are not imported.

`src/wyvern-outbound.js` shapes a hours payload (`skyway-wyvern-hours-1`) for a future push of auto-logged hours to Wyvern’s FMS Update API. That API and the quarterly Excel vendor export are not connected: there are no credentials or API docs in this app, and `wyvernOutboundStatus()` reports both as unavailable.

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

Opening Currency as admin or ops runs the sync. Crew see their own log and do not write it. `scripts/rebuild-pilot-hours.mjs` recomputes stored totals from the ledger and the baseline; it does not read the iCal feed.

```
FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/rebuild-pilot-hours.mjs
FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/rebuild-pilot-hours.mjs --apply
```

## How the tier is decided

Each pilot is scored against both the PIC column and the SIC column of `standards.positions`. A position Does Not Meet when a required hour is missing or short, or a required item is Expired or Not Validated. Expires in 30 Days and Expires in 7 Days still meet that position and mark the rating caution. Current meets. With no assigned seat, the standing rating meets when at least one position meets, and the screen shows which seats qualify plus a gap analysis of unmet items. A trip report scores each pilot in the seat they are assigned, so a PIC line check and instrument proficiency check are not charged to the SIC.

Shipped PIC / SIC minimums: medical class 1 / 2, medical validity 12 / 12 months, indoctrination required / required, line check 7 months / not required, instrument proficiency check 6 months / not required, max active type ratings 2 / 2, confirmed type required / not required, aircraft-specific, recurrent, and simulator training 12 / 12 months, motion simulator required / required, total time 2500 / 1000, PIC time 1000 / 0, fixed-wing 2000 / 1000, multi-engine 1000 / 50, multi-engine last 12 months 150 / 50, multi-engine last 90 days 30 / 30, instrument 100 / 50, turbine 1000 / 30, time in type 200 / 30, PIC time in type 100 / 0.

Flags such as Type Not Verified, UPRT Not Verified, and EPT Not Verified are shown and do not by themselves fail the standard. Total time last updated more than three months ago is flagged; automatic flight-log updates keep that date current.

Unmarked aircraft-specific checks are not failures when another type in that group is recorded; mark types the pilot does not fly N/A on Currency.

## Broker report

Brokers see a crew summary only when every assigned pilot meets the seat they are flying. If anyone does not meet, `buildBrokerCrewReports()` returns an empty list. The share page then has no crew section: no failing status, no gap list, and no placeholder. Pass/fail detail and the gap analysis stay in Compliance → Currency. That screen tells an admin which seat is hidden and which items are short. Email and PDF download are blocked when the pilot meets neither seat, and the email route returns those internal reasons to the signed-in admin. A pilot who meets only one seat can still send the green summary for that seat; assigning them to the seat they miss leaves the trip crew report off.

When the crew does meet, `brokerPilotReport()` is a short crew list. Pilot-in-Command is on the left and Second-in-Command on the right. Each column has the name, certificate type, country, type rating, medical class, and last medical date, then green rows for employment, accident/incident/sanctions, the hour totals, and the check dates. Every value is a green pill because a failing report is never built. A generated date and the hours as-of date sit under the Crew heading. The share page places this block at the bottom, under the trip details. The emailed PDF uses the same list.

It does not include certificate numbers, date of birth, home address, medical expiration or limitations, internal notes, document files, email, phone, operator or insurance blocks, flags, or waivers.

The public trip link (`GET /api/trip-public`) attaches `trip.crewReports` after the existing token, revocation, rotation, and 24-hour-after-landing checks. A failed lookup, or a crew that does not meet, yields an empty list and does not take the tracking page down.

Emailing a report (`POST /api/pilot-report-email`) is limited to admin, ops, and sales. The server rebuilds the crew summary and refuses to send when the pilot does not meet. A send that is allowed attaches a PDF through Resend. The shared email queue does not carry attachments, which is why this send does not go through `email-enqueue`.

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
