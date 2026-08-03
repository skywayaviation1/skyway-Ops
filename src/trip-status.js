/* =============================================================================
   TRIP STATUS EVENT HELPERS
   =============================================================================
   Status events are written in two places with the same shape:

     App.jsx  updateStatus()            → { timestamp, coords, author, notified }
     api/flightaware-*  autoFire        → { timestamp, author, coords, autoFired }

   Both use `timestamp`. Several readers were written against `.at`, which is
   the field name the public broker API (api/trip-public.js) normalizes to
   before serving trip-track. Reading `.at` off a raw Firestore document
   therefore always yielded undefined:

     • OpsConsole dropped the time from every status tooltip.
     • FlightBoard's stale-airborne guard never fired, so a trip whose
       wheels_up was never followed by a landed event stayed "AIRBORNE" on
       the board indefinitely.

   Read every status timestamp through statusEventAt() so the two shapes stay
   interchangeable regardless of which writer produced the record.
   ============================================================================= */

/**
 * Milliseconds since epoch for a status event, or null when absent/malformed.
 * Accepts `timestamp` (Firestore writers), `at` (public API), and `ts`.
 */
export function statusEventAt(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.timestamp ?? entry.at ?? entry.ts;
  const ms = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** True when the step has been recorded at all, regardless of shape. */
export function statusEventDone(entry) {
  if (!entry) return false;
  if (entry.completed === true) return true;
  return statusEventAt(entry) !== null || typeof entry === 'object';
}
