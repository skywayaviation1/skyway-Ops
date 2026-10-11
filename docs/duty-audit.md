# Duty code and data-model audit

Audit date: 2026-10-11. Scope is the Part 135 duty engine on Firestore database `appusers`, collection `duty-periods-v2`, plus the pilot duty screen and the administrator duty panel. This pass read the pairing, crew-change, legality, admin-edit, and schedule-matching code. It did not read production documents. Findings below are from the code paths that write and judge those documents.

Regulatory numbers are unchanged: 14 CFR 135.267(b) is 8 hours single-pilot and 10 hours two-pilot flight time in any 24 consecutive hours, with 10 hours rest; 135.267(c) is the 14-hour regular duty period; 135.267(d) is 11 / 12 / 16 hours rest after a flight-time excursion.

## What was going wrong

### A swap was stored as single-pilot

When one pilot of a linked crew went off duty, two things could happen:

1. Older duty-off closed the partner as well (`closedByPartner`). The pilot who was still flying then had to start a new record. That new record was often `crewType: 'single'`, so the rest of the day was judged against the 8-hour limit. More than 60 minutes over 8 hours required 16 hours of rest under 135.267(d).
2. The later crew-change path left the stayer on duty but opened a segment with `crewType: 'awaiting'`. `segmentCountsAs` treated every non-`two` segment as single-pilot. Flight time that landed on that open segment, including a period total that had not been split yet, counted toward the 8-hour limit.

The Oct 1 shape is the concrete case. Daniel and Matt were paired. Daniel swapped out. Matt kept flying, 9.3 hours total, and Kameron joined. 9.3 hours as a paired crew is under the 10-hour two-pilot limit. Stored as single-pilot, it is a block and a 16-hour rest requirement. Matt’s duty-on must not move, and his flight time must not be rewritten to “fix” the flag.

### Duty-on did not have to follow the schedule

`partnerOnCrewDay` could pre-select the other pilot, but the start form still offered “1 pilot” and a way to clear the partner. Either pilot starting a scheduled tail+trip day could therefore open an unlinked record. The other pilot’s later duty-on created a second period instead of joining the open crew, because `duty-start-pair` refused when either pilot already had `status: 'on'`.

The crew day was also computed in the browser’s timezone. A pilot whose phone was not on Eastern could be matched to a different calendar day’s pairing than the pilot sitting next to them. Company duty days are Eastern.

### Admin corrections could rewrite the other pilot

The administrator time editor sent one duty-on and duty-off to every linked period. After a swap those times are not the same. Correcting Daniel’s duty-off moved Matt’s clock. The editor also used the browser’s local `datetime-local` value, so an admin outside Eastern saved a different instant than the wall clock they typed. The correction note was optional, so the audit trail could say only “Admin corrected duty times.”

### The report judged the whole period by one crew type

`recordIssues` compared `flightTimeMs` with 8 or 10 hours based on `period.crewType`. A two-pilot 9.3 hour day was fine only when the field was already `two`. A mislabeled `single` flagged the 8-hour limit even when the schedule and the other pilot’s record showed a crew. The printed report still said the rolling flight-time check was disabled. The live engine has used segment buckets (`flightTimeChecks`) since the crew-change work; the banner was stale.

`check_flightTime24h` in `src/duty-legality.js` is unused. It placed each period’s flight time at `dutyOnAt` and could double-count a window. It is not on the alert list. It was left in the file so this change does not pretend to delete a function another branch might still call. Nothing in this repo imports it.

### Pairing and overlap gaps the resync will not guess through

- One-way `partnerPeriodId` (A points at B, B does not point back) and a `partnerPeriodId` whose document is missing.
- Two duty periods for the same pilot that overlap. The report flags `OVERLAP`. Merging them would add flight time or drop a real duty-off, so resync does not merge. The existing Oct 1 correction tool can still collapse Matt’s split records into one continuous duty when an admin runs that specific tool. Schedule resync is the path that keeps each recorded time and only repairs the crew link.
- A scheduled pilot with no duty record at all. Creating one would invent duty and flight time. Resync reports the skip. The older “Sync paired crew” backfill can still create a counterpart when the evidence is unambiguous; that path copies the existing pilot’s times and is a different, explicit admin action.
- A duty period that overlaps two pairings by almost the same amount (two crew swaps inside one record, or two periods with nearly the same overlap). Resync skips that period instead of picking a partner.
- `confirmStatus: 'pending'` is still excluded from legality until that pilot attests. That is intentional. A pending partner is on the operational record but is not yet a legal duty period.

### Rest calculation

`extendedRestForPeriod` looks at the latest closed period and splits its flight time by segment. The 16-hour tier applies only when a single-pilot bucket exceeds 8 hours by more than 60 minutes, or a two-pilot bucket exceeds 10 hours by more than 60 minutes. The bug was the bucket, not the tier table. Rest is measured from that period’s own `dutyOffAt`. Ending only one pilot does not restart the other pilot’s duty or rest.

Outside commercial flying is added to both buckets, because it is flight time regardless of the Skyway crew. That behavior is unchanged.

## Fixes in this change

| Issue | Fix |
| --- | --- |
| Swap gap counted as single-pilot | The open segment stays `crewType: 'two'` with `awaitingReplacement`. Legacy `awaiting` segments also count as two-pilot. |
| Duty off closed both, or asked in the wrong order | Duty off defaults to **Crew off duty** (both). **Just me — swapping with another pilot** ends only that pilot. The stayer’s `dutyOnAt`, flight time, and paired designation stay. |
| Replacement could not join an open crew | `planScheduledDutyOn` joins the open crew when the other pilot is on duty and not already paired with someone else who is still on. The replacement’s own duty-on is the join time. They attest fit-for-duty themselves. |
| Scheduled pair could start single | The start form locks the seat and the partner when `partnerOnCrewDay` finds one pair for that Eastern day. |
| Crew day followed the phone timezone | Pairing uses the app timezone override, otherwise `America/New_York`. |
| Admin edit rewrote the partner and had no reason | A reason is required. Linked times change only when the admin checks “also apply to the linked pilot.” The editor is Eastern. |
| Report used one crew type for the whole period | Findings use `flightBuckets`. 9.3 two-pilot hours are not an 8-hour finding. |
| Records with no linked crew | The live board shows them. **Resync with schedule** (day, range, or pilot) rebuilds links from tail + trip assignments, shows a dry run, and writes only after confirm. Each write stores who, when, before, after, and the reason on the period and in `duty-audit-log`. |
| Stale “flight check disabled” copy | Report and printable footer describe the segment split. |

`OffDutyCard` passed `currentUserName={name}` from a scope where `name` was not defined. Opening Start Duty threw before the form rendered. The parent now passes the signed-in pilot’s name.

## What an admin still has to run

No migration runs on deploy. Existing Oct 1 documents stay as they are until an admin does one of these:

1. **Resync with schedule** for 2026-10-01 (or a range, or Matt). Dry-run first. For the split-record shape — Matt with Daniel, then a second Matt record with Kameron — the resync links each record to the pilot who actually overlapped that duty and sets the paired designation. It does not add or remove flight time. The unit test `Oct 1 resync links Daniel then Kameron` covers 9.3 hours moving off the single-pilot flag and off the 16-hour rest tier.
2. The older Oct 1 correction screen, if the desired record is one continuous Matt period instead of the two recorded periods. That tool is still explicit and still audited.

Ambiguous days stay in the dry-run “skipped” list.

## Rules and collections

Writes for resync, crew join, and admin corrections go through the Admin SDK, which bypasses security rules. The client still cannot update another pilot’s duty document.

New server-only collections:

- `duty-schedule-resync-previews` — 30-minute dry run (scope, schedule snapshot, fingerprint).
- `duty-audit-log` — one document per confirmed resync (who, when, reason, before/after, limit summary).

`firebase/appusers-duty.rules` is a fragment to merge into the **`appusers`** database. It denies client access to those collections. It is not a full ruleset and it is not a data migration. The feature works before that fragment is deployed, because the client never reads or writes those collections; the deny rules are so a broad client rule cannot expose them later. See that file for the exact match blocks.

`firebase/appreview.rules` is the App Review database only. It was not changed.
