// Duty tail assignment.
//
// A pilot's aircraft assignment for a duty period comes from the trip they are
// flying at duty-on. This module finds that trip so the duty record always
// carries the tail the pilot is assigned to for the 14-hour period, without the
// pilot having to type it.

const HOUR_MS = 60 * 60 * 1000;

function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function tripTail(trip) {
  const tail = trip?.info?.tail || trip?.tail || '';
  return String(tail || '').trim().toUpperCase() || null;
}

/**
 * Find the trip a pilot is assigned to at the start of a duty period.
 *
 * `trips` are already scoped to this pilot's assignments. The chosen trip is
 * the one whose flight window covers the duty-on time; otherwise the next trip
 * beginning within the duty period (default 14 hours). A short pre-window lets a
 * pilot go on duty a little before the first departure.
 *
 * Only trips that have a tail contribute, because the point is to record the
 * assigned aircraft.
 */
export function findAssignedTrip(trips, dutyOnAtMs, windowHours = 14) {
  const onAt = toMs(dutyOnAtMs);
  if (!onAt || !Array.isArray(trips)) return null;
  const windowEnd = onAt + windowHours * HOUR_MS;
  const preWindow = onAt - 2 * HOUR_MS;
  let best = null;
  let bestScore = null;
  for (const trip of trips) {
    if (!tripTail(trip)) continue;
    const start = toMs(trip.start ?? trip.info?.start);
    if (start == null) continue;
    const end = toMs(trip.end ?? trip.info?.end) ?? (start + windowHours * HOUR_MS);
    const covers = start <= onAt && end >= onAt;
    const upcoming = start >= preWindow && start <= windowEnd;
    if (!covers && !upcoming) continue;
    // Prefer a trip already underway, then the soonest start.
    const score = covers ? -Math.abs(start - onAt) : windowEnd - start + 1e12;
    const rank = covers ? 0 : 1;
    if (
      best === null
      || rank < best.rank
      || (rank === best.rank && score > bestScore)
    ) {
      best = { trip, rank };
      bestScore = score;
    }
  }
  return best ? best.trip : null;
}

/** The tail a pilot is assigned to at duty-on, or null when none is found. */
export function assignedTailFor(trips, dutyOnAtMs, windowHours = 14) {
  return tripTail(findAssignedTrip(trips, dutyOnAtMs, windowHours));
}
