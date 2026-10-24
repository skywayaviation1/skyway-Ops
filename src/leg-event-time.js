/* =============================================================================
   WHEELS-UP / LANDED TIMES AND AIRBORNE ETA
   =============================================================================
   A wheels-up or landed milestone keeps the first time it was recorded.
   Turning the step off and back on, or triggering it again, must not replace
   that time with the click. The click is stored separately as recordedAt.

   ETA while airborne:
     1. FlightAware estimated_on (flightaware-state.estimatedOn), written by
        the AeroAPI poll.
     2. Original wheels-up plus the scheduled block (scheduled arrival minus
        scheduled departure).
     3. Scheduled arrival, when neither of those is available.
   ============================================================================= */

import { statusEventAt } from './trip-status.js';

export const PRESERVED_EVENT_STEPS = new Set(['wheels_up', 'landed']);

const MAX_EVENT_AGE_MS = 18 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_BLOCK_MS = 18 * 60 * 60 * 1000;

export function toEventMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** ICAO K-prefix and IATA compare equal (KTEB and TEB). */
export function airportsMatch(a, b) {
  const norm = (code) => {
    const upper = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!upper) return '';
    return upper.length === 4 && upper.startsWith('K') ? upper.slice(1) : upper;
  };
  const left = norm(a);
  const right = norm(b);
  return Boolean(left) && left === right;
}

/**
 * The time a milestone happened. `originalTimestamp` wins over a later
 * `timestamp`, so a client that stamps "now" on top of an existing event
 * does not move the clock readers use for the timeline, duty, or ETA.
 */
export function originalEventAt(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return toEventMs(entry.originalTimestamp) ?? statusEventAt(entry);
}

/** Active milestone only. A cleared event lives in preservedEvents and is not airborne. */
export function activeWheelsUpAt(state) {
  return originalEventAt(state?.statuses?.wheels_up);
}

export function activeLandedAt(state) {
  return originalEventAt(state?.statuses?.landed);
}

export function wheelsUpAtFromState(state) {
  if (!state || typeof state !== 'object') return null;
  return activeWheelsUpAt(state) ?? originalEventAt(state.preservedEvents?.wheels_up);
}

export function landedAtFromState(state) {
  if (!state || typeof state !== 'object') return null;
  return activeLandedAt(state) ?? originalEventAt(state.preservedEvents?.landed);
}

function stateFor(tripStates, uid) {
  if (!tripStates || !uid) return null;
  if (typeof tripStates.get === 'function') return tripStates.get(uid) || null;
  return tripStates[uid] || null;
}

/** Leg whose wheels-up is still open, else the leg inside its scheduled block. */
export function legForAirborneEta(trips, tripStates, tail, now = Date.now()) {
  const normalized = String(tail || '').toUpperCase();
  const legs = (Array.isArray(trips) ? trips : []).filter((trip) => (
    String(trip?.info?.tail || '').toUpperCase() === normalized
    && trip?.info?.isFlight !== false
  ));
  const marked = legs.find((trip) => {
    const state = stateFor(tripStates, trip.uid);
    return activeWheelsUpAt(state) != null && activeLandedAt(state) == null;
  });
  const chosen = marked || legs.find((trip) => {
    const start = toEventMs(trip.start);
    const end = toEventMs(trip.end);
    return start != null && start <= now && (end == null || end >= now);
  }) || null;
  return {
    trip: chosen,
    state: chosen ? stateFor(tripStates, chosen.uid) : null,
  };
}

/**
 * FlightAware actual_off / actual_on when it belongs to this leg.
 * A grounded snapshot's previous actual_off is not a new departure.
 */
export function flightAwareEventMs(stepId, flightAware, { from = null, to = null, now = Date.now() } = {}) {
  if (!flightAware || typeof flightAware !== 'object') return null;
  if (stepId === 'wheels_up') {
    if (flightAware.airborne === false && (flightAware.actualOn || flightAware.groundedSince)) return null;
    const ms = toEventMs(flightAware.actualOff);
    if (ms == null) return null;
    if (flightAware.origin && from && !airportsMatch(flightAware.origin, from)) return null;
    if (ms > now + MAX_FUTURE_SKEW_MS || now - ms > MAX_EVENT_AGE_MS) return null;
    return ms;
  }
  if (stepId === 'landed') {
    if (flightAware.airborne === true) return null;
    const ms = toEventMs(flightAware.actualOn) ?? toEventMs(flightAware.groundedSince);
    if (ms == null) return null;
    const dest = flightAware.destination || flightAware.groundedAt;
    if (dest && to && !airportsMatch(dest, to)) return null;
    if (ms > now + MAX_FUTURE_SKEW_MS || now - ms > MAX_EVENT_AGE_MS) return null;
    return ms;
  }
  return null;
}

/**
 * Timestamp to store when wheels-up or landed is turned on.
 * An existing original time is kept. The click never replaces it.
 */
export function resolveMilestoneOn({
  stepId,
  existing = null,
  preserved = null,
  clickedAt,
  flightAware = null,
  from = null,
  to = null,
  now = clickedAt,
}) {
  const kept = originalEventAt(existing) ?? originalEventAt(preserved);
  const prior = existing || preserved || null;
  if (kept != null && PRESERVED_EVENT_STEPS.has(stepId)) {
    return {
      timestamp: kept,
      originalTimestamp: kept,
      recordedAt: clickedAt,
      timestampSource: prior?.timestampSource || 'preserved',
      faFlightId: prior?.faFlightId || flightAware?.faFlightId || null,
      kept: true,
      author: prior?.author || null,
      coords: prior?.coords || null,
      notified: prior?.notified === true,
    };
  }
  const faMs = PRESERVED_EVENT_STEPS.has(stepId)
    ? flightAwareEventMs(stepId, flightAware, { from, to, now })
    : null;
  if (faMs != null) {
    return {
      timestamp: faMs,
      originalTimestamp: faMs,
      recordedAt: clickedAt,
      timestampSource: 'flightaware',
      faFlightId: flightAware?.faFlightId || null,
      kept: false,
      author: null,
      coords: null,
      notified: false,
    };
  }
  return {
    timestamp: clickedAt,
    originalTimestamp: PRESERVED_EVENT_STEPS.has(stepId) ? clickedAt : null,
    recordedAt: clickedAt,
    timestampSource: 'manual',
    faFlightId: null,
    kept: false,
    author: null,
    coords: null,
    notified: false,
  };
}

/** Copy a cleared wheels-up / landed event so the next ON can restore it. */
export function preserveClearedEvent(entry, clearedAt = Date.now()) {
  const at = originalEventAt(entry);
  if (at == null) return null;
  return {
    originalTimestamp: at,
    timestamp: at,
    timestampSource: entry?.timestampSource || 'preserved',
    faFlightId: entry?.faFlightId || null,
    author: entry?.author || null,
    coords: entry?.coords || null,
    notified: entry?.notified === true,
    clearedAt,
  };
}

/**
 * Clock shown for a milestone. A stored original wins. FlightAware actual
 * off/on fills in only when nothing has been recorded yet.
 */
export function displayedMilestoneAt({
  stepId,
  entry = null,
  flightAware = null,
  from = null,
  to = null,
  now = Date.now(),
} = {}) {
  const stored = originalEventAt(entry);
  if (stored != null) {
    return { atMs: stored, source: entry?.timestampSource || 'preserved' };
  }
  const faMs = flightAwareEventMs(stepId, flightAware, { from, to, now });
  if (faMs != null) return { atMs: faMs, source: 'flightaware' };
  return { atMs: null, source: null };
}

/**
 * Arrival estimate for an airborne leg.
 * FlightAware estimated_on wins. Otherwise original wheels-up plus the
 * scheduled block. Otherwise the scheduled arrival.
 */
export function airborneEta({
  flightAware = null,
  wheelsUpAt = null,
  scheduledStart = null,
  scheduledEnd = null,
  to = null,
} = {}) {
  const faEta = toEventMs(flightAware?.estimatedOn);
  const destOk = !flightAware?.destination || !to || airportsMatch(flightAware.destination, to);
  if (faEta != null && destOk) {
    return {
      etaMs: faEta,
      iso: typeof flightAware.estimatedOn === 'string' ? flightAware.estimatedOn : null,
      source: 'flightaware',
    };
  }
  const start = toEventMs(scheduledStart);
  const end = toEventMs(scheduledEnd);
  const off = toEventMs(wheelsUpAt);
  if (off != null && start != null && end != null && end > start) {
    const block = end - start;
    if (block > 0 && block <= MAX_BLOCK_MS) {
      return { etaMs: off + block, iso: null, source: 'wheels-up-block' };
    }
  }
  if (end != null) return { etaMs: end, iso: null, source: 'scheduled' };
  return { etaMs: null, iso: null, source: null };
}

export function etaInstant(result) {
  if (!result || result.etaMs == null) return null;
  return result.iso || new Date(result.etaMs).toISOString();
}

export function airborneProgressPct({
  now = Date.now(),
  wheelsUpAt = null,
  etaMs = null,
  reportedPercent = null,
} = {}) {
  if (reportedPercent != null && reportedPercent !== '') {
    const reported = Number(reportedPercent);
    if (Number.isFinite(reported)) return Math.max(0, Math.min(100, reported));
  }
  const start = toEventMs(wheelsUpAt);
  const end = toEventMs(etaMs);
  if (start == null || end == null || end <= start) return null;
  return Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
}
