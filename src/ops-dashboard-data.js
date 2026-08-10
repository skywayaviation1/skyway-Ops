// src/ops-dashboard-data.js
//
// Pure derivation layer for the operations dashboard. Everything here takes
// already-fetched data and returns view models; nothing subscribes, fetches,
// or renders. Keeping it separate means the fleet-state and exception rules —
// the parts that decide what a controller sees first — can be reasoned about
// and tested without mounting React or Firestore.

import { computeOutstanding } from './ops-readiness.js';
import { statusEventAt, statusEventDone } from './trip-status.js';

export const MS_HOUR = 3600_000;

export function normalizeTail(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Strips the ICAO K-prefix so KTEB and TEB compare equal. */
export function normalizeAirport(code) {
  const upper = String(code || '').toUpperCase().trim();
  return upper.length === 4 && upper.startsWith('K') ? upper.slice(1) : upper;
}

export function startOfDay(at = Date.now()) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function toMillis(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A revenue/positioning leg that actually moves an aircraft. Maintenance,
 * training and crew-hold blocks share the calendar but must not count as
 * flying, or every utilization number on the board is wrong.
 */
export function isFlightLeg(trip) {
  const info = trip?.info;
  if (!info || info.isFlight === false) return false;
  if (['HOLD', 'MX', 'TRAINING'].includes(String(info.category || '').toUpperCase())) return false;
  const from = normalizeAirport(info.from);
  const to = normalizeAirport(info.to);
  if (from && to && from === to) return false; // same-airport block, not a leg
  return true;
}

export function legHours(trip) {
  const start = toMillis(trip?.start);
  const end = toMillis(trip?.end);
  if (!start || !end || end <= start) return 0;
  return (end - start) / MS_HOUR;
}

function stateForTrip(tripStates, uid) {
  if (!tripStates || !uid) return null;
  return typeof tripStates.get === 'function' ? tripStates.get(uid) || null : tripStates[uid] || null;
}

function normalizedPerson(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function pilotMatchesAssignment(pilotName, assignedName) {
  const pilot = normalizedPerson(pilotName);
  const assigned = normalizedPerson(assignedName);
  if (!pilot.length || !assigned.length) return false;
  if (pilot.join(' ') === assigned.join(' ')) return true;
  const overlap = pilot.filter((token) => assigned.includes(token)).length;
  return overlap >= Math.min(2, pilot.length, assigned.length);
}

function telemetryMatchesTrip(position, trip) {
  if (!position || !trip) return false;
  const sameTail = normalizeTail(position.ident) === normalizeTail(trip.info?.tail);
  if (!sameTail) return false;
  const origin = normalizeAirport(position.origin);
  const destination = normalizeAirport(position.destination || position.groundedAt);
  const from = normalizeAirport(trip.info?.from);
  const to = normalizeAirport(trip.info?.to);
  return (!origin || !from || origin === from) && (!destination || !to || destination === to);
}

/** Actual airborne time from FlightAware-fired steps, with live telemetry fallback. */
export function actualFlightMsForTrip(trip, state, position, now = Date.now()) {
  const statuses = state?.statuses || {};
  const off = statusEventAt(statuses.wheels_up)
    || (telemetryMatchesTrip(position, trip) ? toMillis(position.actualOff) : null);
  if (!off) return 0;
  const on = statusEventAt(statuses.landed)
    || (telemetryMatchesTrip(position, trip) ? toMillis(position.actualOn) : null)
    || (position?.airborne === true && telemetryMatchesTrip(position, trip) ? now : null);
  if (!on || on <= off) return 0;
  return on - off;
}

export function flightPhase(trip, state, position, now = Date.now()) {
  const statuses = state?.statuses || {};
  if (state?.completed === true) return 'complete';
  if (statusEventDone(statuses.landed)) return 'landed';
  if (position?.airborne === true && telemetryMatchesTrip(position, trip)) return 'airborne';
  if (statusEventDone(statuses.wheels_up)) {
    const off = statusEventAt(statuses.wheels_up);
    return off && now - off <= 12 * MS_HOUR ? 'airborne' : 'landed';
  }
  if (
    statusEventDone(statuses.taxi_dep)
    || statusEventDone(statuses.aircraft_ready)
    || statusEventDone(statuses.crew_onsite)
  ) return 'preflight';
  const start = toMillis(trip?.start);
  if (start != null && start < now) return 'delayed';
  return 'scheduled';
}

export function buildTodayFlightRows(trips, tripStates, positions, now = Date.now()) {
  const dayStart = startOfDay(now);
  const dayEnd = dayStart + 24 * MS_HOUR;
  return (Array.isArray(trips) ? trips : [])
    .filter(isFlightLeg)
    .filter((trip) => {
      const start = toMillis(trip.start);
      return start != null && start >= dayStart && start < dayEnd;
    })
    .map((trip) => {
      const tail = normalizeTail(trip.info?.tail);
      const state = stateForTrip(tripStates, trip.uid);
      const position = positions?.[tail] || null;
      return {
        uid: trip.uid,
        tail,
        from: normalizeAirport(trip.info?.from),
        to: normalizeAirport(trip.info?.to),
        startAt: toMillis(trip.start),
        endAt: toMillis(trip.end),
        pic: trip.info?.pic || '',
        sic: trip.info?.sic || '',
        scheduledMs: legHours(trip) * MS_HOUR,
        actualMs: actualFlightMsForTrip(trip, state, position, now),
        phase: flightPhase(trip, state, position, now),
        estimatedOn: telemetryMatchesTrip(position, trip) ? position?.estimatedOn || null : null,
      };
    })
    .sort((a, b) => (a.startAt || 0) - (b.startAt || 0));
}

export function buildOnDutyRows({
  dutyPeriods = [],
  trips = [],
  tripStates = null,
  positions = {},
  now = Date.now(),
}) {
  return (Array.isArray(dutyPeriods) ? dutyPeriods : [])
    .filter((period) => (
      period?.status === 'on'
      && period.confirmStatus !== 'pending'
      && period.confirmStatus !== 'declined'
      && Number.isFinite(period.dutyOnAt)
    ))
    .map((period) => {
      const dutyEndAt = period.dutyOnAt + 14 * MS_HOUR;
      const assigned = (Array.isArray(trips) ? trips : [])
        .filter(isFlightLeg)
        .filter((trip) => {
          const start = toMillis(trip.start);
          if (start == null) return false;
          const end = toMillis(trip.end) || start;
          if (end < period.dutyOnAt || start > dutyEndAt) return false;
          return pilotMatchesAssignment(period.pilotName, trip.info?.pic)
            || pilotMatchesAssignment(period.pilotName, trip.info?.sic);
        });
      const scheduledFlightMs = assigned.reduce(
        (sum, trip) => sum + legHours(trip) * MS_HOUR,
        0,
      );
      const actualFlightMs = assigned.reduce((sum, trip) => {
        const tail = normalizeTail(trip.info?.tail);
        return sum + actualFlightMsForTrip(
          trip,
          stateForTrip(tripStates, trip.uid),
          positions?.[tail],
          now,
        );
      }, 0);
      return {
        uid: period.pilotUid,
        name: period.pilotName || 'Unknown pilot',
        dutyOnAt: period.dutyOnAt,
        dutyEndAt,
        remainingMs: Math.max(0, dutyEndAt - now),
        overLimit: now > dutyEndAt,
        overByMs: Math.max(0, now - dutyEndAt),
        tail: period.tail || assigned[0]?.info?.tail || null,
        role: period.role || null,
        scheduledFlightMs,
        actualFlightMs,
        reportedFlightMs: Number(period.flightTimeMs || 0),
        assignedTrips: assigned.length,
      };
    })
    .sort((a, b) => a.remainingMs - b.remainingMs || a.name.localeCompare(b.name));
}

/* ── Fleet state ─────────────────────────────────────────────────────────
   Two independent axes, deliberately not collapsed into one value:

     airworthiness — can the aircraft legally fly at all (AOG / MEL / OK)
     activity      — what it is doing right now (airborne / turn / idle)

   A controller needs both. An aircraft can be mid-flight with an open MEL,
   and an AOG aircraft still has a schedule that has to be re-crewed. */

export const FLEET_STATE = {
  AOG: { id: 'AOG', label: 'AOG', tone: 'danger', rank: 0 },
  AIRBORNE: { id: 'AIRBORNE', label: 'Airborne', tone: 'accent', rank: 1 },
  TURN: { id: 'TURN', label: 'In turn', tone: 'warning', rank: 2 },
  SCHEDULED: { id: 'SCHEDULED', label: 'Scheduled', tone: 'info', rank: 3 },
  COMPLETE: { id: 'COMPLETE', label: 'Day complete', tone: 'success', rank: 4 },
  AVAILABLE: { id: 'AVAILABLE', label: 'Available', tone: 'neutral', rank: 5 },
};

function activityState({ position, activeLeg, nextLeg, completedToday }) {
  if (position?.airborne) return FLEET_STATE.AIRBORNE;
  if (activeLeg) return FLEET_STATE.TURN;
  if (nextLeg) return FLEET_STATE.SCHEDULED;
  if (completedToday > 0) return FLEET_STATE.COMPLETE;
  return FLEET_STATE.AVAILABLE;
}

/**
 * One row per tail: the aircraft's airworthiness, where it physically is, and
 * what it is scheduled to do next.
 *
 * `airworthiness` comes from the maintenance module rather than being
 * re-derived here, so the board can never disagree with the maintenance
 * screens about whether an aircraft is grounded.
 */
export function buildFleetRows({
  fleetTails = [],
  trips = [],
  positions = {},
  tripStates = null,
  aogEvents = [],
  aircraftByTail = {},
  deriveAircraftStatus,
  now = Date.now(),
}) {
  // Tails on the schedule that are not part of the managed fleet — charter
  // partners and vendor lift appear in the same calendar feed. They still get
  // a row, because a controller has to see everything moving today, but they
  // are flagged so fleet availability is not computed against them.
  const managed = new Set(fleetTails.map(normalizeTail).filter(Boolean));
  const dayStart = startOfDay(now);
  const dayEnd = dayStart + 24 * MS_HOUR;

  const legsByTail = new Map();
  for (const trip of trips) {
    const tail = normalizeTail(trip?.info?.tail);
    if (!tail) continue;
    if (!legsByTail.has(tail)) legsByTail.set(tail, []);
    legsByTail.get(tail).push(trip);
  }

  const activeAog = new Map();
  for (const event of aogEvents) {
    if (event?.status !== 'active') continue;
    const tail = normalizeTail(event.tail);
    if (tail && !activeAog.has(tail)) activeAog.set(tail, event);
  }

  const allTails = [...managed];
  for (const tail of legsByTail.keys()) {
    if (!managed.has(tail)) allTails.push(tail);
  }

  return allTails.map((rawTail) => {
    const tail = normalizeTail(rawTail);
    const all = (legsByTail.get(tail) || []).slice().sort(
      (a, b) => (toMillis(a.start) || 0) - (toMillis(b.start) || 0),
    );

    const today = all.filter((trip) => {
      const start = toMillis(trip.start);
      return start != null && start >= dayStart && start < dayEnd;
    });
    const flightLegs = today.filter(isFlightLeg);

    let activeLeg = null;
    let completedToday = 0;
    for (const trip of today) {
      const start = toMillis(trip.start);
      const end = toMillis(trip.end);
      if (start != null && start <= now && (end == null || end >= now)) activeLeg = activeLeg || trip;
      else if (end != null && end < now) completedToday += 1;
    }

    // The next departure is looked up across the whole schedule, not just the
    // calendar day. At 23:50 the flight that matters is the 01:30 departure,
    // and a day-bounded search would report the aircraft as free for the night.
    const nextLeg = all.find((trip) => (toMillis(trip.start) || 0) > now) || null;

    const position = positions[tail] || null;
    const aogEvent = activeAog.get(tail) || null;
    const maintenance = typeof deriveAircraftStatus === 'function'
      ? deriveAircraftStatus(tail)
      : { status: 'AIRWORTHY', reasons: [], melOpen: 0 };

    // An open AOG event grounds the aircraft even when no grounding squawk
    // has been written yet — the event is raised first during a real AOG.
    const grounded = maintenance.status === 'AOG' || Boolean(aogEvent);
    const airworthiness = grounded
      ? {
        status: 'AOG',
        reasons: aogEvent
          ? [aogEvent.issueDescription || 'AOG event open', ...maintenance.reasons]
          : maintenance.reasons,
        melOpen: maintenance.melOpen,
      }
      : maintenance;

    const state = grounded
      ? FLEET_STATE.AOG
      : activityState({ position, activeLeg, nextLeg, completedToday });

    const referenceLeg = activeLeg || nextLeg || null;
    const tripState = tripStates && referenceLeg ? tripStates.get(referenceLeg.uid) || null : null;

    return {
      tail,
      offFleet: !managed.has(tail),
      // Never guess aircraft type from a tail. Administrators maintain the
      // verified fleet metadata in Admin Settings.
      type: String(aircraftByTail?.[tail]?.displayName || '').trim(),
      state,
      airworthiness,
      aogEvent,
      position,
      location: describeLocation(position, activeLeg, nextLeg),
      legs: all,
      legsToday: today,
      flightLegsToday: flightLegs.length,
      hoursToday: Math.round(flightLegs.reduce((sum, leg) => sum + legHours(leg), 0) * 10) / 10,
      activeLeg,
      nextLeg,
      completedToday,
      statusSteps: tripState ? Object.keys(tripState.statuses || {}).length : 0,
    };
  }).sort((a, b) => (
    // Managed aircraft first, then by how much attention the state needs.
    Number(a.offFleet) - Number(b.offFleet)
    || a.state.rank - b.state.rank
    || a.tail.localeCompare(b.tail)
  ));
}

/** Where the aircraft physically is, preferring live telemetry over schedule. */
export function describeLocation(position, activeLeg, nextLeg) {
  if (position?.airborne) {
    const from = position.origin || activeLeg?.info?.from || '';
    const to = position.destination || activeLeg?.info?.to || '';
    return {
      kind: 'airborne',
      label: from && to ? `${normalizeAirport(from)} → ${normalizeAirport(to)}` : 'En route',
      altitude: Number.isFinite(position.altitude) ? position.altitude : null,
      groundspeed: Number.isFinite(position.groundspeed) ? position.groundspeed : null,
      eta: position.estimatedOn || null,
      progress: Number.isFinite(position.progressPercent) ? position.progressPercent : null,
    };
  }
  const at = position?.groundedAt
    || activeLeg?.info?.from
    || nextLeg?.info?.from
    || '';
  return {
    kind: 'ground',
    label: at ? normalizeAirport(at) : 'Unknown',
    since: position?.groundedSince || null,
  };
}

/* ── Exceptions ───────────────────────────────────────────────────────────
   The queue is the point of the dashboard: it answers "what needs a human
   right now", ordered so the top of the list is always the most costly thing
   to ignore. Severity ranks before recency deliberately — a stale AOG still
   outranks a fresh expense report. */

export const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

export function buildExceptions({
  fleetRows = [],
  crewRows = [],
  squawks = [],
  pilotDocs = [],
  expenses = [],
  trips = [],
  tripStates = null,
  now = Date.now(),
  expirationStatus,
}) {
  const items = [];

  for (const row of fleetRows) {
    if (row.state.id !== 'AOG') continue;
    const upcoming = row.legsToday.filter((leg) => (toMillis(leg.start) || 0) > now).length;
    items.push({
      id: `aog-${row.tail}`,
      severity: 'critical',
      group: 'Aircraft',
      title: `${row.tail} is AOG`,
      detail: row.airworthiness.reasons[0]
        || row.aogEvent?.issueDescription
        || 'Grounding discrepancy open',
      meta: upcoming > 0 ? `${upcoming} leg${upcoming === 1 ? '' : 's'} still scheduled today` : 'No further legs today',
      section: 'aog',
    });
  }

  for (const row of fleetRows) {
    if (row.state.id === 'AOG') continue;
    if (row.airworthiness.status !== 'RESTRICTED') continue;
    items.push({
      id: `mel-${row.tail}`,
      severity: 'warning',
      group: 'Aircraft',
      title: `${row.tail} dispatching on MEL`,
      detail: row.airworthiness.reasons[0] || 'Open MEL deferral',
      meta: `${row.airworthiness.melOpen} open deferral${row.airworthiness.melOpen === 1 ? '' : 's'}`,
      section: 'maint',
    });
  }

  for (const crew of crewRows) {
    if (crew.legality?.status !== 'illegal') continue;
    items.push({
      id: `crew-illegal-${crew.uid}`,
      severity: 'critical',
      group: 'Crew',
      title: `${crew.name} is not legal`,
      detail: crew.legality.blockers?.[0]?.message || 'Duty or rest limit exceeded',
      meta: crew.state === 'ON DUTY' ? 'Currently on duty' : crew.state.toLowerCase(),
      section: 'duty',
    });
  }
  for (const crew of crewRows) {
    if (crew.legality?.status !== 'warning') continue;
    items.push({
      id: `crew-warn-${crew.uid}`,
      severity: 'warning',
      group: 'Crew',
      title: `${crew.name} approaching a limit`,
      detail: crew.legality.warnings?.[0]?.message || 'Duty limit approaching',
      meta: crew.state.toLowerCase(),
      section: 'duty',
    });
  }

  // A leg leaving soon with no PIC is a dispatch failure in progress.
  const soonCutoff = now + 4 * MS_HOUR;
  for (const trip of trips) {
    const start = toMillis(trip?.start);
    if (start == null || start < now || start > soonCutoff) continue;
    if (!isFlightLeg(trip)) continue;
    if (String(trip.info?.pic || '').trim()) continue;
    items.push({
      id: `nocrew-${trip.uid}`,
      severity: 'critical',
      group: 'Dispatch',
      title: `${trip.info?.tail || 'Unassigned'} has no PIC`,
      detail: `${normalizeAirport(trip.info?.from)} → ${normalizeAirport(trip.info?.to)}`,
      meta: `Departs in ${formatCountdown(start - now)}`,
      section: 'schedule',
      tripUid: trip.uid,
      dispatchView: 'control',
    });
  }

  // Readiness gaps share the exact rules used by the detailed flight-control
  // board. Keep only the next four hours in this executive queue; Dispatch
  // carries the complete rolling 48-hour board.
  const readinessCodes = new Set([
    'ops-hold',
    'no-sheet',
    'no-dispatch',
    'no-broker',
    'no-pax',
    'no-sic',
    'no-origin-fbo',
    'no-destination-fbo',
  ]);
  for (const trip of trips) {
    const start = toMillis(trip?.start);
    if (start == null || start < now || start > soonCutoff || !isFlightLeg(trip)) continue;
    const state = tripStates?.get?.(trip.uid) || null;
    for (const gap of computeOutstanding(trip, state, now)) {
      if (!readinessCodes.has(gap.code)) continue;
      items.push({
        id: `readiness-${trip.uid}-${gap.code}`,
        severity: gap.severity === 'critical' ? 'critical'
          : gap.severity === 'warn' ? 'warning' : 'info',
        group: 'Dispatch',
        title: `${trip.info?.tail || 'Trip'} · ${gap.label}`,
        detail: `${normalizeAirport(trip.info?.from)} → ${normalizeAirport(trip.info?.to)}`,
        meta: `Departs in ${formatCountdown(start - now)}`,
        section: 'schedule',
        tripUid: trip.uid,
        dispatchView: 'control',
      });
    }
  }

  const groundingSquawks = squawks.filter(
    (s) => s?.grounding === true && s.status !== 'closed' && s.status !== 'deferred',
  );
  const openSquawks = squawks.filter((s) => s?.status === 'open' && s.grounding !== true);
  if (openSquawks.length > 0) {
    items.push({
      id: 'squawks-open',
      severity: 'info',
      group: 'Maintenance',
      title: `${openSquawks.length} open squawk${openSquawks.length === 1 ? '' : 's'}`,
      detail: openSquawks[0]?.description || 'Awaiting maintenance action',
      meta: groundingSquawks.length > 0 ? `${groundingSquawks.length} grounding` : 'None grounding',
      section: 'maint',
    });
  }

  if (typeof expirationStatus === 'function') {
    const expired = [];
    const expiring = [];
    for (const doc of pilotDocs) {
      const status = expirationStatus(doc, now);
      if (status.state === 'expired') expired.push({ doc, status });
      else if (status.state === 'soon') expiring.push({ doc, status });
    }
    if (expired.length > 0) {
      items.push({
        id: 'docs-expired',
        severity: 'critical',
        group: 'Crew',
        title: `${expired.length} expired crew document${expired.length === 1 ? '' : 's'}`,
        detail: expired[0].doc.pilotName
          ? `${expired[0].doc.pilotName} — ${expired[0].doc.docType}`
          : 'Crew qualification expired',
        meta: 'Blocks assignment',
        section: 'currency',
      });
    }
    if (expiring.length > 0) {
      items.push({
        id: 'docs-soon',
        severity: 'warning',
        group: 'Crew',
        title: `${expiring.length} document${expiring.length === 1 ? '' : 's'} expiring`,
        detail: expiring[0].doc.pilotName
          ? `${expiring[0].doc.pilotName} — ${expiring[0].doc.docType}`
          : 'Expiring within 60 days',
        meta: `Soonest ${expiring[0].status.days}d`,
        section: 'currency',
      });
    }
  }

  const pendingExpenses = expenses.filter(
    (e) => e?.status === 'pending' || e?.status === 'needs_review',
  );
  if (pendingExpenses.length > 0) {
    items.push({
      id: 'expenses-pending',
      severity: 'info',
      group: 'Finance',
      title: `${pendingExpenses.length} expense${pendingExpenses.length === 1 ? '' : 's'} to review`,
      detail: pendingExpenses[0]?.vendor || 'Awaiting approval',
      meta: 'Pending approval',
      section: 'expenses',
    });
  }

  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Fleet-level counters for the posture strip.
 *
 * Availability is measured against the managed fleet only. Counting partner
 * and vendor tails that happen to share the calendar would inflate the
 * denominator and make the ratio meaningless as a dispatch metric.
 */
export function summarizeFleet(fleetRows, trips, now = Date.now()) {
  const dayStart = startOfDay(now);
  const dayEnd = dayStart + 24 * MS_HOUR;
  const todayLegs = trips.filter((trip) => {
    const start = toMillis(trip.start);
    return start != null && start >= dayStart && start < dayEnd && isFlightLeg(trip);
  });
  const fleet = fleetRows.filter((r) => !r.offFleet);

  return {
    total: fleet.length,
    offFleet: fleetRows.length - fleet.length,
    airborne: fleet.filter((r) => r.state.id === 'AIRBORNE').length,
    aog: fleet.filter((r) => r.state.id === 'AOG').length,
    restricted: fleet.filter(
      (r) => r.state.id !== 'AOG' && r.airworthiness.status === 'RESTRICTED',
    ).length,
    available: fleet.filter((r) => r.state.id !== 'AOG').length,
    legsToday: todayLegs.length,
    hoursToday: Math.round(todayLegs.reduce((sum, leg) => sum + legHours(leg), 0) * 10) / 10,
    completedToday: todayLegs.filter((leg) => (toMillis(leg.end) || 0) < now).length,
    remainingToday: todayLegs.filter((leg) => (toMillis(leg.start) || 0) > now).length,
  };
}

/**
 * Timeline geometry for the schedule board.
 *
 * The window rolls with the clock rather than running midnight to midnight: a
 * calendar day is almost empty by late evening, which is exactly when the
 * overnight and early-morning departures matter most. A small look-back keeps
 * the leg that just landed on screen for context.
 *
 * Percentages rather than pixels, so the same model drives a phone and a wall
 * display. Legs crossing either edge are clamped instead of overflowing.
 */
export function buildTimeline(fleetRows, now = Date.now(), {
  lookbackHours = 2,
  windowHours = 24,
} = {}) {
  // Anchor to a whole hour so the axis labels stay round.
  const windowStart = Math.floor((now - lookbackHours * MS_HOUR) / MS_HOUR) * MS_HOUR;
  const windowMs = windowHours * MS_HOUR;
  const windowEnd = windowStart + windowMs;
  const pct = (ms) => Math.min(100, Math.max(0, ((ms - windowStart) / windowMs) * 100));

  const rows = fleetRows.map((row) => ({
    tail: row.tail,
    state: row.state,
    blocks: (row.legs || row.legsToday || []).map((leg) => {
      const start = toMillis(leg.start);
      const end = toMillis(leg.end) || (start != null ? start + MS_HOUR : null);
      if (start == null || end == null) return null;
      if (end < windowStart || start > windowEnd) return null;
      const left = pct(start);
      const width = Math.max(1.2, pct(end) - left);
      return {
        uid: leg.uid,
        left,
        width,
        from: normalizeAirport(leg.info?.from),
        to: normalizeAirport(leg.info?.to),
        start,
        end,
        isFlight: isFlightLeg(leg),
        done: end < now,
        active: start <= now && end >= now,
      };
    }).filter(Boolean),
  }));

  // Tick every four hours, labelled in local wall-clock time.
  const ticks = [];
  for (let i = 0; i <= windowHours; i += 4) {
    const at = windowStart + i * MS_HOUR;
    ticks.push({ at, left: (i / windowHours) * 100, label: new Date(at).getHours() });
  }

  return { windowStart, windowEnd, ticks, nowPct: pct(now), rows };
}
