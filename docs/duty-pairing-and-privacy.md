# Paired duty synchronization and privacy

## Privacy boundary

Duty and compliance records are private personnel data.

- Crew can subscribe to and export only records whose `pilotUid` is their own
  Firebase UID.
- Crew never receive their partner's duty record, confirmation state, rest,
  flight time, legality, findings, or audit trail.
- A crew member may know that their own period is linked; the linked document
  id is used only by server endpoints to synchronize start/end.
- Ops, sales, maintenance, and accounting do not receive fleet-wide duty data.
- Only the `admin` role can read the all-pilot report, calendar, crew board,
  historical repair preview, or admin correction endpoints.

These application gates complement — and do not replace — Firestore Security
Rules. The deployed rules must enforce:

```text
crew:  read/write duty-periods-v2 only where pilotUid == request.auth.uid
admin: read all duty-periods-v2
```

There is no rules file in this repository, so verify the deployed Firebase
rules separately before production rollout.

## Live paired duty

For a two-pilot assignment, selecting the complementary PIC/SIC is required.
Either pilot can initiate:

1. `/api/duty-start-pair` verifies the Firebase caller is one of the two pilots.
2. It verifies both profiles are active and approved.
3. One transaction refuses an existing open period and creates two reciprocal
   records at the same `dutyOnAt`.
4. The caller is self-attested. The partner record is operationally on-duty but
   pending until that pilot personally confirms fitness/rest.
5. The response includes only the caller's own record.
6. `/api/duty-end-pair` accepts crew-supplied time/flight details only against
   the caller's own period, then atomically closes the linked record at the same
   duty-off time.

## Historical repair

The administrator report has **Sync paired crew**:

1. Preview stores a server-side, 30-minute audit snapshot.
2. Apply recomputes against current duty records; browser-supplied action ids
   are never accepted.
3. Strong evidence is processed in order:
   - repair one-way or dangling `partnerPeriodId`;
   - link one unique complementary PIC/SIC period on the same tail/time;
   - create a missing counterpart only when one trip and one active approved
     profile resolve unambiguously.
4. Existing overlaps, multiple candidates, missing roles, and ambiguous names
   are skipped for manual review.
5. Creates copy shared operational facts: duty on/off, flight time, trip, tail,
   location, assignment, and excursion reason. They do **not** copy the other
   pilot's rest, overrides, finding approvals, or audit history.
6. The whole repair must fit one atomic Firestore batch. Larger plans fail
   without partial writes.
7. Every run and every affected record receives an admin audit entry.

## Over-14-hour verification

Any pilot duty-off, admin time correction, finding approval, or historical
create that records more than 14 hours requires an explicit verification.

The verification is stored with actor, timestamp, and source. The server emails:

- `Jim@flyskyway.com`
- `Jake@flyskyway.com`
- `zack.taylor@flyskyway.com`

Email delivery uses `RESEND_API_KEY` and `OPS_FROM_EMAIL` (or the verified
`noreply@send.flyskyway.com` fallback). Delivery failures are logged to
`duty-alert-failures`; they do not roll back a duty-off that already committed.

## Finding approvals

Each Requires Attention finding can be approved individually with a required
disposition note. Approval acknowledges review; it does not rewrite underlying
duty facts. Approved findings leave the outstanding queue and remain visible
under the **Approved findings** report filter and in the record audit trail.

