/**
 * Aircraft availability and insertion planning.
 *
 * Pure calculation layer for the Availability screen. It reads the active
 * schedule, estimates block/flight time from aircraft performance, inserts any
 * required repositioning, enforces ground turns, and (when crew are selected)
 * checks planned duty/rest and rolling flight time.
 *
 * This is a planning aid, not a release. Published aircraft performance,
 * actual winds, airport limitations, MEL/CDL effects, and the operator's
 * approved manual remain controlling.
 */

import { lookupCoords } from './airport-coords.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const AVAILABILITY_RULES = Object.freeze({
  turnMinutes: 45,
  maxFlightMinutes24h: 10 * 60,
  maxDutyMinutes: 14 * 60,
  minRestMinutes: 10 * 60,
  preDutyMinutes: 45,
  postDutyMinutes: 30,
  searchStepMinutes: 15,
  maxDelayMinutes: 7 * 24 * 60,
});

/**
 * Planning profiles, deliberately conservative and aligned with the types
 * already present in the schedule/currency system. Cruise is not block speed:
 * climb/descent and taxi are added separately below.
 */
export const AIRCRAFT_PERFORMANCE = Object.freeze({
  C25A: { label: 'Citation CJ2', cruiseKts: 360, climbDescentMinutes: 18, taxiMinutes: 15 },
  C25B: { label: 'Citation CJ3', cruiseKts: 380, climbDescentMinutes: 18, taxiMinutes: 15 },
  C25C: { label: 'Citation CJ4', cruiseKts: 410, climbDescentMinutes: 18, taxiMinutes: 15 },
  C525: { label: 'CitationJet family', cruiseKts: 380, climbDescentMinutes: 18, taxiMinutes: 15 },
  C56X: { label: 'Citation Excel/XLS', cruiseKts: 400, climbDescentMinutes: 20, taxiMinutes: 15 },
  C680: { label: 'Citation Sovereign', cruiseKts: 430, climbDescentMinutes: 22, taxiMinutes: 15 },
  LJ60: { label: 'Learjet 60', cruiseKts: 430, climbDescentMinutes: 20, taxiMinutes: 15 },
  LR60: { label: 'Learjet 60', cruiseKts: 430, climbDescentMinutes: 20, taxiMinutes: 15 },
  SF50: { label: 'Vision Jet', cruiseKts: 300, climbDescentMinutes: 18, taxiMinutes: 12 },
  AS50: { label: 'AS350', cruiseKts: 125, climbDescentMinutes: 5, taxiMinutes: 5 },
  EC30: { label: 'EC130', cruiseKts: 130, climbDescentMinutes: 5, taxiMinutes: 5 },
  GENERIC_JET: { label: 'Generic light jet', cruiseKts: 370, climbDescentMinutes: 20, taxiMinutes: 15 },
});

const roundUp = (value, increment = 5) => Math.ceil(value / increment) * increment;
const normalize = (value) => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
const validMs = (value) => {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export function parseRouting(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[→>]/g, ' ')
    .split(/[\s,;/\\-]+/)
    .map(normalize)
    .filter(Boolean)
    .filter((airport, index, list) => index === 0 || airport !== list[index - 1]);
}

export function aircraftProfile(icaoType) {
  const key = String(icaoType || '').toUpperCase().replace(/[\s-]/g, '');
  if (AIRCRAFT_PERFORMANCE[key]) return { id: key, ...AIRCRAFT_PERFORMANCE[key] };
  if (key.startsWith('C25')) return { id: 'C525', ...AIRCRAFT_PERFORMANCE.C525 };
  if (key.includes('60') && (key.startsWith('LJ') || key.startsWith('LR'))) {
    return { id: 'LJ60', ...AIRCRAFT_PERFORMANCE.LJ60 };
  }
  return { id: 'GENERIC_JET', ...AIRCRAFT_PERFORMANCE.GENERIC_JET, assumed: true };
}

function radians(degrees) {
  return degrees * Math.PI / 180;
}

export function greatCircleNm(a, b) {
  if (!a || !b) return null;
  const lat1 = radians(Number(a.lat));
  const lat2 = radians(Number(b.lat));
  const dLat = lat2 - lat1;
  const dLon = radians(Number(b.lng) - Number(a.lng));
  if (![lat1, lat2, dLat, dLon].every(Number.isFinite)) return null;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function estimateLeg(from, to, icaoType, coordinateLookup = lookupCoords) {
  const origin = normalize(from);
  const destination = normalize(to);
  if (!origin || !destination) return { ok: false, reason: 'Both airports are required' };
  if (origin === destination) {
    return {
      ok: true,
      from: origin,
      to: destination,
      distanceNm: 0,
      flightMinutes: 0,
      blockMinutes: 0,
      profile: aircraftProfile(icaoType),
    };
  }
  const a = coordinateLookup(origin);
  const b = coordinateLookup(destination);
  if (!a || !b) {
    return {
      ok: false,
      from: origin,
      to: destination,
      reason: `Airport coordinates unavailable for ${!a ? origin : destination}`,
    };
  }
  const profile = aircraftProfile(icaoType);
  const distanceNm = greatCircleNm(a, b);
  const flightMinutes = roundUp(
    (distanceNm / profile.cruiseKts) * 60 + profile.climbDescentMinutes,
    5,
  );
  const blockMinutes = roundUp(flightMinutes + profile.taxiMinutes, 5);
  return {
    ok: true,
    from: origin,
    to: destination,
    distanceNm: Math.round(distanceNm),
    flightMinutes,
    blockMinutes,
    profile,
  };
}

function tripCrewNames(trip) {
  return [trip?.info?.pic, trip?.info?.sic].map((name) => String(name || '').trim()).filter(Boolean);
}

function nameTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function crewNameMatches(a, b) {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return false;
  if (left.join(' ') === right.join(' ')) return true;
  return left[0] === right[0] && left[left.length - 1] === right[right.length - 1];
}

function isOperationalFlight(trip) {
  if (!trip?.info) return false;
  if (trip.info.isFlight === false || trip.info.isOps === false) return false;
  return !['HOLD', 'MX', 'TRAINING'].includes(String(trip.info.category || '').toUpperCase());
}

function normalizeScheduleTrip(trip, tailType) {
  if (!isOperationalFlight(trip)) return null;
  const startMs = validMs(trip.start);
  if (startMs == null) return null;
  const estimate = estimateLeg(trip.info.from, trip.info.to, tailType);
  let endMs = validMs(trip.end);
  if (endMs == null || endMs <= startMs) {
    endMs = startMs + (estimate.ok ? estimate.blockMinutes : 60) * MINUTE_MS;
  }
  const blockMinutes = Math.max(1, Math.round((endMs - startMs) / MINUTE_MS));
  return {
    id: trip.uid || `schedule-${startMs}`,
    kind: 'scheduled',
    startMs,
    endMs,
    from: normalize(trip.info.from),
    to: normalize(trip.info.to),
    flightMinutes: estimate.ok ? Math.min(blockMinutes, estimate.flightMinutes) : blockMinutes,
    blockMinutes,
    tail: normalize(trip.info.tail),
    crewNames: tripCrewNames(trip),
    label: `${normalize(trip.info.from)} → ${normalize(trip.info.to)}`,
    source: trip,
  };
}

export function normalizeTailSchedule(trips, tail, icaoType) {
  const wanted = normalize(tail);
  return (Array.isArray(trips) ? trips : [])
    .filter((trip) => normalize(trip?.info?.tail) === wanted)
    .map((trip) => normalizeScheduleTrip(trip, icaoType))
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs);
}

function buildRequestedItinerary(route, startMs, icaoType, rules) {
  const movements = [];
  let cursor = startMs;
  let distanceNm = 0;
  let flightMinutes = 0;
  for (let i = 0; i < route.length - 1; i += 1) {
    const estimate = estimateLeg(route[i], route[i + 1], icaoType);
    if (!estimate.ok) return { ok: false, reason: estimate.reason };
    const movement = {
      id: `request-${i}`,
      kind: 'request',
      startMs: cursor,
      endMs: cursor + estimate.blockMinutes * MINUTE_MS,
      ...estimate,
      label: `${estimate.from} → ${estimate.to}`,
      proposed: true,
    };
    movements.push(movement);
    distanceNm += estimate.distanceNm;
    flightMinutes += estimate.flightMinutes;
    cursor = movement.endMs;
    if (i < route.length - 2) cursor += rules.turnMinutes * MINUTE_MS;
  }
  return {
    ok: true,
    movements,
    endMs: cursor,
    durationMinutes: Math.round((cursor - startMs) / MINUTE_MS),
    distanceNm,
    flightMinutes,
  };
}

function reposition(from, to, icaoType, kind) {
  if (!from || !to) return { ok: false, reason: 'Aircraft position is unknown' };
  if (normalize(from) === normalize(to)) return null;
  const estimate = estimateLeg(from, to, icaoType);
  if (!estimate.ok) return estimate;
  return { ...estimate, kind, proposed: true, label: `${estimate.from} → ${estimate.to}` };
}

function dedupeCrew(crew) {
  const result = [];
  for (const member of Array.isArray(crew) ? crew : []) {
    const name = String(member?.name || member || '').trim();
    if (!name) continue;
    if (result.some((existing) => crewNameMatches(existing.name, name))) continue;
    result.push({
      uid: member?.uid || member?.id || null,
      name,
      role: member?.role || null,
    });
  }
  return result;
}

function overlapMinutes(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB)) / MINUTE_MS;
}

function rollingFlightMinutes(events, windowEndMs) {
  const windowStart = windowEndMs - 24 * HOUR_MS;
  return events.reduce((sum, event) => {
    const duration = Math.max(1, (event.endMs - event.startMs) / MINUTE_MS);
    const overlap = overlapMinutes(event.startMs, event.endMs, windowStart, windowEndMs);
    return sum + event.flightMinutes * (overlap / duration);
  }, 0);
}

function mergeDutyWindows(windows, minRestMs) {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const merged = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (!last || window.startMs - last.endMs >= minRestMs) {
      merged.push({ ...window, ids: [window.id], proposed: Boolean(window.proposed) });
    } else {
      last.endMs = Math.max(last.endMs, window.endMs);
      last.ids.push(window.id);
      last.proposed = last.proposed || Boolean(window.proposed);
    }
  }
  return merged;
}

/**
 * Check selected crew against schedule-derived duty and recorded duty periods.
 * Scheduled block time is counted conservatively as flight time when airport
 * performance is unavailable.
 */
export function evaluateCrewFit({
  crew,
  allTrips,
  movements,
  dutyPeriods = [],
  rules = AVAILABILITY_RULES,
  tailTypeByTail = {},
}) {
  const selected = dedupeCrew(crew);
  if (selected.length === 0) {
    return {
      status: 'not-checked',
      legal: true,
      members: [],
      reasons: ['Select PIC/SIC to check duty, rest, and rolling flight time'],
    };
  }

  const results = [];
  for (const member of selected) {
    const matchingPeriods = (Array.isArray(dutyPeriods) ? dutyPeriods : [])
      .filter((period) => {
        if (member.uid && period?.pilotUid === member.uid) return true;
        return crewNameMatches(period?.pilotName, member.name);
      })
      .filter((period) => period?.confirmStatus !== 'pending' && period?.confirmStatus !== 'declined');
    const recordedTripIds = new Set(matchingPeriods.map((period) => period.tripId).filter(Boolean));

    const scheduled = (Array.isArray(allTrips) ? allTrips : [])
      .filter(isOperationalFlight)
      .filter((trip) => tripCrewNames(trip).some((name) => crewNameMatches(name, member.name)))
      .filter((trip) => !recordedTripIds.has(trip.uid))
      .map((trip) => normalizeScheduleTrip(
        trip,
        tailTypeByTail[normalize(trip.info.tail)] || trip.info.aircraftType,
      ))
      .filter(Boolean);

    const flightEvents = [
      ...scheduled,
      ...matchingPeriods
        .filter((period) => Number(period.flightTimeMs) > 0)
        .map((period) => ({
          id: period.id || `duty-${period.dutyOnAt}`,
          startMs: Number(period.dutyOnAt),
          endMs: Number(period.dutyOffAt || Date.now()),
          flightMinutes: Number(period.flightTimeMs) / MINUTE_MS,
        }))
        .filter((event) => Number.isFinite(event.startMs) && Number.isFinite(event.endMs)),
      ...movements,
    ];

    const dutyWindows = [
      ...scheduled.map((event) => ({
        id: event.id,
        startMs: event.startMs - rules.preDutyMinutes * MINUTE_MS,
        endMs: event.endMs + rules.postDutyMinutes * MINUTE_MS,
        proposed: false,
      })),
      ...matchingPeriods.map((period) => ({
        id: period.id || `duty-${period.dutyOnAt}`,
        startMs: Number(period.dutyOnAt),
        endMs: Number(period.dutyOffAt || Date.now()),
        proposed: false,
      })).filter((window) => Number.isFinite(window.startMs) && Number.isFinite(window.endMs)),
      {
        id: '_proposed_',
        startMs: Math.min(...movements.map((movement) => movement.startMs))
          - rules.preDutyMinutes * MINUTE_MS,
        endMs: Math.max(...movements.map((movement) => movement.endMs))
          + rules.postDutyMinutes * MINUTE_MS,
        proposed: true,
      },
    ];

    const blocks = mergeDutyWindows(dutyWindows, rules.minRestMinutes * MINUTE_MS);
    const proposedBlock = blocks.find((block) => block.proposed);
    const dutyMinutes = proposedBlock
      ? (proposedBlock.endMs - proposedBlock.startMs) / MINUTE_MS
      : 0;
    // Check at every proposed movement and every scheduled leg pulled into the
    // same continuous duty block. Otherwise a request could look legal at its
    // own landing but make the already-scheduled next leg exceed 10h/24.
    const checkpoints = [
      ...movements.map((movement) => movement.endMs),
      ...scheduled
        .filter((event) => (
          proposedBlock
          && event.startMs >= proposedBlock.startMs
          && event.startMs <= proposedBlock.endMs
        ))
        .map((event) => event.endMs),
    ];
    const maxRolling = Math.max(
      0,
      ...checkpoints.map((checkpoint) => rollingFlightMinutes(flightEvents, checkpoint)),
    );
    const dutyLegal = dutyMinutes <= rules.maxDutyMinutes;
    const flightLegal = maxRolling <= rules.maxFlightMinutes24h + 0.01;
    const previousBlock = blocks
      .filter((block) => block.endMs <= proposedBlock.startMs)
      .sort((a, b) => b.endMs - a.endMs)[0];
    const restMinutes = previousBlock
      ? (proposedBlock.startMs - previousBlock.endMs) / MINUTE_MS
      : null;
    const reasons = [];
    if (!dutyLegal) {
      reasons.push(
        `${member.name}: ${formatDuration(dutyMinutes)} continuous duty exceeds ${formatDuration(rules.maxDutyMinutes)}`,
      );
    }
    if (!flightLegal) {
      reasons.push(
        `${member.name}: ${formatDuration(maxRolling)} flight in rolling 24h exceeds ${formatDuration(rules.maxFlightMinutes24h)}`,
      );
    }

    results.push({
      ...member,
      legal: dutyLegal && flightLegal,
      dutyMinutes: Math.round(dutyMinutes),
      maxRollingFlightMinutes: Math.round(maxRolling),
      restMinutes: restMinutes == null ? null : Math.round(restMinutes),
      dutyStartMs: proposedBlock?.startMs || null,
      dutyEndMs: proposedBlock?.endMs || null,
      reasons,
    });
  }

  const reasons = results.flatMap((result) => result.reasons);
  return {
    status: reasons.length ? 'illegal' : 'legal',
    legal: reasons.length === 0,
    members: results,
    reasons,
  };
}

function createAircraftCandidate({
  tail,
  icaoType,
  homeBase,
  previous,
  next,
  route,
  startMs,
  planningNowMs,
  rules,
}) {
  const position = previous?.to || normalize(homeBase);
  if (!position) {
    return { ok: false, reason: 'No prior destination or configured home base' };
  }

  const repoIn = reposition(position, route[0], icaoType, 'reposition-in');
  if (repoIn && !repoIn.ok) return { ok: false, reason: repoIn.reason };

  const readyAfterPrevious = Math.max(
    Number.isFinite(planningNowMs) ? planningNowMs : -Infinity,
    previous ? previous.endMs + rules.turnMinutes * MINUTE_MS : -Infinity,
  );
  const earliestByAircraft = repoIn
    ? readyAfterPrevious + (repoIn.blockMinutes + rules.turnMinutes) * MINUTE_MS
    : readyAfterPrevious;
  const candidateStart = Math.max(startMs, earliestByAircraft);

  const itinerary = buildRequestedItinerary(route, candidateStart, icaoType, rules);
  if (!itinerary.ok) return itinerary;
  const finalAirport = route[route.length - 1];
  const repoOut = next ? reposition(finalAirport, next.from, icaoType, 'reposition-out') : null;
  if (repoOut && !repoOut.ok) return { ok: false, reason: repoOut.reason };

  let latestStart = Infinity;
  if (next) {
    const timeAfterRequest = repoOut
      ? rules.turnMinutes + repoOut.blockMinutes + rules.turnMinutes
      : rules.turnMinutes;
    latestStart = next.startMs
      - (itinerary.durationMinutes + timeAfterRequest) * MINUTE_MS;
  }
  if (candidateStart > latestStart) {
    return {
      ok: false,
      reason: `Gap is ${formatDuration(Math.max(0, (next.startMs - readyAfterPrevious) / MINUTE_MS))}; routing needs more time`,
    };
  }

  const movements = [];
  if (repoIn) {
    const endMs = candidateStart - rules.turnMinutes * MINUTE_MS;
    movements.push({
      ...repoIn,
      id: `repo-in-${tail}-${candidateStart}`,
      startMs: endMs - repoIn.blockMinutes * MINUTE_MS,
      endMs,
    });
  }
  movements.push(...itinerary.movements);
  if (repoOut) {
    const repositionStart = itinerary.endMs + rules.turnMinutes * MINUTE_MS;
    movements.push({
      ...repoOut,
      id: `repo-out-${tail}-${candidateStart}`,
      startMs: repositionStart,
      endMs: repositionStart + repoOut.blockMinutes * MINUTE_MS,
    });
  }

  return {
    ok: true,
    tail,
    icaoType,
    profile: aircraftProfile(icaoType),
    homeBase: normalize(homeBase),
    startMs: candidateStart,
    requestEndMs: itinerary.endMs,
    movementEndMs: movements[movements.length - 1].endMs,
    latestStartMs: latestStart,
    delayMinutes: Math.max(0, Math.round((candidateStart - startMs) / MINUTE_MS)),
    route,
    movements,
    requestDistanceNm: itinerary.distanceNm,
    requestFlightMinutes: itinerary.flightMinutes,
    requestBlockMinutes: itinerary.durationMinutes,
    repositionMinutes: [repoIn, repoOut].filter(Boolean)
      .reduce((sum, leg) => sum + leg.blockMinutes, 0),
    repositionDistanceNm: [repoIn, repoOut].filter(Boolean)
      .reduce((sum, leg) => sum + leg.distanceNm, 0),
    previous,
    next,
  };
}

/**
 * Evaluate one tail in each schedule gap, advancing in 15-minute steps when a
 * crew limit requires a later departure. Returns the earliest legal placement.
 */
export function evaluateTailAvailability({
  tail,
  icaoType,
  homeBase,
  allTrips,
  route,
  requestedStartMs,
  planningNowMs = Date.now(),
  crew = [],
  dutyPeriods = [],
  rules = AVAILABILITY_RULES,
  tailTypeByTail = {},
}) {
  const schedule = normalizeTailSchedule(allTrips, tail, icaoType);
  const maxStart = requestedStartMs + rules.maxDelayMinutes * MINUTE_MS;
  const nearMisses = [];

  for (let gap = 0; gap <= schedule.length; gap += 1) {
    const previous = gap > 0 ? schedule[gap - 1] : null;
    const next = gap < schedule.length ? schedule[gap] : null;
    const base = createAircraftCandidate({
      tail,
      icaoType,
      homeBase,
      previous,
      next,
      route,
      startMs: requestedStartMs,
      planningNowMs,
      rules,
    });
    if (!base.ok) {
      nearMisses.push(base.reason);
      continue;
    }

    const latest = Math.min(base.latestStartMs, maxStart);
    for (
      let candidateStart = base.startMs;
      candidateStart <= latest;
      candidateStart += rules.searchStepMinutes * MINUTE_MS
    ) {
      const candidate = createAircraftCandidate({
        tail,
        icaoType,
        homeBase,
        previous,
        next,
        route,
        startMs: candidateStart,
        planningNowMs,
        rules,
      });
      if (!candidate.ok) break;
      const crewFit = evaluateCrewFit({
        crew,
        allTrips,
        movements: candidate.movements,
        dutyPeriods,
        rules,
        tailTypeByTail,
      });
      if (crewFit.legal) {
        const warnings = [];
        if (candidate.profile.assumed) {
          warnings.push('Aircraft type not configured; generic light-jet performance used');
        }
        if (
          candidate.previous
          && candidate.startMs - candidate.previous.endMs > 72 * HOUR_MS
        ) {
          warnings.push(
            `Last scheduled position is ${formatDuration(
              (candidate.startMs - candidate.previous.endMs) / MINUTE_MS,
            )} old; confirm current aircraft location`,
          );
        }
        return {
          ...candidate,
          requestedStartMs,
          delayMinutes: Math.max(
            0,
            Math.round((candidate.startMs - requestedStartMs) / MINUTE_MS),
          ),
          crewFit,
          status: candidate.startMs === requestedStartMs ? 'fits' : 'delayed',
          warnings,
        };
      }
      nearMisses.push(...crewFit.reasons);
    }
  }

  return {
    ok: false,
    tail,
    icaoType,
    requestedStartMs,
    status: 'no-fit',
    reasons: [...new Set(nearMisses)].slice(0, 6),
  };
}

export function rankTailAvailability({
  fleet,
  allTrips,
  route,
  requestedStartMs,
  planningNowMs = Date.now(),
  crew,
  dutyPeriods,
  rules = AVAILABILITY_RULES,
}) {
  const tailTypeByTail = Object.fromEntries((fleet || []).map((aircraft) => [
    normalize(aircraft.tail),
    aircraft.icaoType,
  ]));
  const results = (fleet || []).map((aircraft) => evaluateTailAvailability({
    tail: aircraft.tail,
    icaoType: aircraft.icaoType,
    homeBase: aircraft.homeBase,
    allTrips,
    route,
    requestedStartMs,
    planningNowMs,
    crew,
    dutyPeriods,
    rules,
    tailTypeByTail,
  }));
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (!a.ok) return String(a.tail).localeCompare(String(b.tail));
    if (a.delayMinutes !== b.delayMinutes) return a.delayMinutes - b.delayMinutes;
    if (a.repositionMinutes !== b.repositionMinutes) {
      return a.repositionMinutes - b.repositionMinutes;
    }
    return String(a.tail).localeCompare(String(b.tail));
  });
}

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) return `${mins}m`;
  if (!mins) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

