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
    last90Days, last12Months,
    timeInType: [{ type, hours }]
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

The same rules run from a laptop with a service account:

```
FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/import-wyvern.mjs ./wyvern-pilots.json
FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/import-wyvern.mjs ./wyvern-pilots.json --apply
```

That command is a dry run until `--apply`. It refuses to write while any active pilot is unmatched or ambiguous. `--skip-unmatched` updates the matched rows and leaves the rest. `preview/fixtures/wyvern-sample.json` is fictitious sample data for the preview harness and tests.

## How the tier is decided

The 0–100 score is 55% experience and 45% requirements with the shipped weights. Each required hour contributes `min(actual / minimum, 1)` (a blank required hour contributes 0). Each included requirement contributes full credit when current, partial credit when expiring, and none when expired or not on file.

The tier is rule-based, so a high score cannot hide a failed item:

- **Does Not Meet** — a required hour is missing or below the minimum, or a required item is expired or not on file (including a certificate below the minimum, or drug and alcohol enrollment not confirmed).
- **Caution** — every minimum is met, and at least one required item is expiring soon.
- **Meets Standard** — every required hour is met and every required item is current.

The standing rating on the crew screen uses the PIC seat. A broker report for a trip scores each pilot in the seat they are assigned, so a PIC-only line check is not charged to the SIC. Unmarked aircraft-specific checks are not failures when another type in that group is recorded; mark types the pilot does not fly N/A on Currency.

## Broker report

`BrokerPilotReport` and both PDF builders render `brokerPilotReport()`. That function copies named fields only. It includes operator, pilot name, seat, aircraft type, generated date, certificate grade, instrument and multi-engine (yes/no), type ratings, medical class and Valid / Expiring soon / Expired, the hours summary, requirement status with completion and due dates, the score, the tier, and the reasons.

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

match /app-config/pilot-safety {
  allow read: if isSignedIn();
  allow write: if isRole(['admin']);
}
```

`pilot-currencies` and `pilot-docs` keep their existing rules. Sales can read logbooks so they can send a broker report; they cannot edit hours. Pilots can read their own logbook and cannot write it, matching the screen (Currency remains the place pilots do not edit either — ops and admin edit both).

`isSelf`, `isRole`, and `isSignedIn` should be the same helpers the rest of the database uses.
