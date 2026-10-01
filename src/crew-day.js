// Crew-day pairing and schedule classification.
//
// JetInsight publishes a "Crew assignment" calendar block alongside the real
// legs. That block often has no route and a window that spans several days.
// It is not a flight, and it is not the crew pairing. The pairing is computed
// here from the real legs a PIC and SIC share on one local calendar day.
//
// This module never writes duty records. Fit-for-duty still has to be
// attested by each pilot. Callers use the pairing to show both pilots the
// same legs and to pre-select the partner when duty starts.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PLACEHOLDER_AIRPORTS = new Set([
  '', '----', '---', '—', '-', 'TBD', 'TBA', 'UNKNOWN', 'N/A', 'NA',
]);

export function toMillis(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && typeof value.toMillis === 'function') {
    try {
      const t = value.toMillis();
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function isPlaceholderAirport(code) {
  const c = String(code ?? '').trim().toUpperCase();
  return PLACEHOLDER_AIRPORTS.has(c);
}

/** Strip a US K-prefix so KTPA and TPA compare as the same field. */
export function normalizeAirport(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c || isPlaceholderAirport(c)) return '';
  if (c.length === 4 && c.startsWith('K') && /^[A-Z]{3}$/.test(c.slice(1))) return c.slice(1);
  return c;
}

/**
 * First + last tokens, lowercased. Single-letter middle initials are dropped
 * so "DAVID C CHEN" and "David Chen" are the same person.
 */
export function crewIdentity(name) {
  const tokens = String(name || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && /[a-z]/.test(t));
  if (tokens.length < 2) return '';
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

export function crewNamesMatch(a, b) {
  const left = crewIdentity(a);
  const right = crewIdentity(b);
  return Boolean(left && left === right);
}

/**
 * JetInsight sometimes omits the "(FROM - TO)" group and puts the event
 * kind after a dash: "Crew 525CR - Crew assignment".
 */
export function splitScheduleTypeSuffix(rest) {
  const match = String(rest || '').match(
    /^(.*?)\s+-\s+(crew assignment|hold|other|maintenance|mx out|training)\s*$/i,
  );
  if (!match) return null;
  return { customer: match[1].trim(), tripType: match[2].trim() };
}

/**
 * Category rules shared with the iCal parser. A block with no route, a
 * same-airport pair, a "needs repositioning" flag, or the words "crew
 * assignment" is a hold, not a flight.
 */
export function finalizeScheduleCategory({
  tripType = '',
  summary = '',
  customer = '',
  from = '',
  to = '',
  pax = 0,
  description = '',
} = {}) {
  const t = String(tripType || '').toLowerCase();
  let category;
  if (t.includes('maintenance') || t.includes('mx out') || t.includes('fms')) category = 'MX';
  else if (t.includes('training')) category = 'TRAINING';
  else if (t.includes('crew assignment') || t.includes('hold') || t.includes('other')) category = 'HOLD';
  else if (t.includes('ferry')) category = 'FERRY';
  else if (t.includes('positioning')) category = 'REPO';
  else if (t.includes('charter')) category = Number(pax) === 0 ? 'REPO' : 'REVENUE';
  else if (t.includes('owner')) category = 'OWNER';
  else if (Number(pax) >= 1) category = 'REVENUE';
  else category = 'REPO';

  const fromNorm = normalizeAirport(from);
  const toNorm = normalizeAirport(to);
  if (fromNorm && toNorm && fromNorm === toNorm && !['MX', 'TRAINING', 'HOLD'].includes(category)) {
    category = 'HOLD';
  }

  const blob = `${summary}\n${description}\n${customer}\n${tripType}`;
  if (/needs?\s+repositioning/i.test(blob)) category = 'HOLD';
  if (/crew assignment/i.test(blob)) category = 'HOLD';
  if (
    (isPlaceholderAirport(from) || isPlaceholderAirport(to))
    && !['MX', 'TRAINING'].includes(category)
  ) {
    category = 'HOLD';
  }

  const legType = category === 'REVENUE' || category === 'OWNER' ? 'REVENUE' : 'REPO';
  return {
    category,
    legType,
    isFlight: !['MX', 'TRAINING', 'HOLD'].includes(category),
    isOps: ['REVENUE', 'REPO', 'FERRY', 'OWNER'].includes(category),
  };
}

export function isCrewAssignmentRecord(trip) {
  const info = trip?.info || {};
  const blob = [info.tripType, info.customer, info.rawSummary, info.notes, info.summary]
    .filter(Boolean)
    .join(' ');
  return /crew assignment/i.test(blob);
}

/** A leg the crew should treat as flying: a route, two different airports, not a hold. */
export function isRealFlightLeg(trip) {
  const info = trip?.info;
  if (!info) return false;
  if (isCrewAssignmentRecord(trip)) return false;
  if (info.isFlight === false) return false;
  const category = String(info.category || '').toUpperCase();
  if (['HOLD', 'MX', 'TRAINING'].includes(category)) return false;
  if (isPlaceholderAirport(info.from) || isPlaceholderAirport(info.to)) return false;
  const fromNorm = normalizeAirport(info.from);
  const toNorm = normalizeAirport(info.to);
  if (!fromNorm || !toNorm || fromNorm === toNorm) return false;
  return true;
}

export function resolveCrewTimeZone(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Calendar day (YYYY-MM-DD) of an instant in the crew member's timezone. */
export function localDayKey(ms, timeZone) {
  const t = toMillis(ms);
  if (t == null) return '';
  const tz = resolveCrewTimeZone(timeZone);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(t));
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(t));
  }
}

function tripStartMs(trip) {
  return toMillis(trip?.start ?? trip?.info?.start);
}

function seatName(trip, seat) {
  return String(trip?.info?.[seat] || '').trim();
}

function legId(trip) {
  return trip?.uid || trip?.id || trip?.info?.uid || trip?.info?.tripId || '';
}

/**
 * Group real legs by local day and PIC+SIC identity.
 * A tail change on the same day stays one pairing. A leg that names only
 * one seat is attached only when that pilot has exactly one partner that day.
 */
export function buildCrewDayPairings(trips, { timeZone } = {}) {
  const tz = resolveCrewTimeZone(timeZone);
  const legs = (Array.isArray(trips) ? trips : []).filter(isRealFlightLeg);
  const byPair = new Map();
  const solo = [];

  for (const trip of legs) {
    const start = tripStartMs(trip);
    if (start == null) continue;
    const day = localDayKey(start, tz);
    const picName = seatName(trip, 'pic');
    const sicName = seatName(trip, 'sic');
    const picId = crewIdentity(picName);
    const sicId = crewIdentity(sicName);
    if (picId && sicId) {
      const key = `${day}|${picId}|${sicId}`;
      let group = byPair.get(key);
      if (!group) {
        group = {
          id: key,
          day,
          timeZone: tz,
          picName,
          sicName,
          tails: new Set(),
          legIds: [],
          legs: [],
        };
        byPair.set(key, group);
      }
      const tail = String(trip.info?.tail || '').trim().toUpperCase();
      if (tail) group.tails.add(tail);
      const id = legId(trip);
      if (id && !group.legIds.includes(id)) group.legIds.push(id);
      group.legs.push(trip);
    } else if (picId || sicId) {
      solo.push({ trip, day, picId, sicId });
    }
  }

  for (const item of solo) {
    const named = item.picId || item.sicId;
    const candidates = [...byPair.values()].filter((group) => (
      group.day === item.day
      && (crewIdentity(group.picName) === named || crewIdentity(group.sicName) === named)
    ));
    if (candidates.length !== 1) continue;
    const group = candidates[0];
    const tail = String(item.trip.info?.tail || '').trim().toUpperCase();
    if (tail) group.tails.add(tail);
    const id = legId(item.trip);
    if (id && !group.legIds.includes(id)) group.legIds.push(id);
    group.legs.push(item.trip);
  }

  return [...byPair.values()].map((group) => ({
    id: group.id,
    day: group.day,
    timeZone: group.timeZone,
    picName: group.picName,
    sicName: group.sicName,
    tails: [...group.tails],
    legIds: group.legIds,
    legs: group.legs.slice().sort((a, b) => (tripStartMs(a) || 0) - (tripStartMs(b) || 0)),
  }));
}

/**
 * The other pilot on this crew member's single pairing for the local day
 * that contains `atMs`. Null when the day has no pair, or more than one.
 */
export function partnerOnCrewDay(trips, pilotName, atMs, timeZone) {
  const tz = resolveCrewTimeZone(timeZone);
  const when = toMillis(atMs);
  if (when == null || !crewIdentity(pilotName)) return null;
  const day = localDayKey(when, tz);
  const mine = buildCrewDayPairings(trips, { timeZone: tz }).filter((pairing) => (
    pairing.day === day
    && (crewNamesMatch(pairing.picName, pilotName) || crewNamesMatch(pairing.sicName, pilotName))
  ));
  if (mine.length !== 1) return null;
  const pairing = mine[0];
  const iAmPic = crewNamesMatch(pairing.picName, pilotName);
  const name = iAmPic ? pairing.sicName : pairing.picName;
  if (!crewIdentity(name)) return null;
  return {
    name,
    role: iAmPic ? 'SIC' : 'PIC',
    myRole: iAmPic ? 'PIC' : 'SIC',
    pairing,
  };
}

/** Real legs this pilot is named on, plus legs attached through the day's pairing. */
export function legsVisibleToCrew(trips, pilotName, timeZone) {
  const tz = resolveCrewTimeZone(timeZone);
  const list = Array.isArray(trips) ? trips : [];
  const visible = new Set();
  for (const pairing of buildCrewDayPairings(list, { timeZone: tz })) {
    const onPair = crewNamesMatch(pairing.picName, pilotName) || crewNamesMatch(pairing.sicName, pilotName);
    if (!onPair) continue;
    for (const id of pairing.legIds) visible.add(id);
  }
  return list.filter((trip) => {
    if (!isRealFlightLeg(trip)) return false;
    const id = legId(trip);
    if (id && visible.has(id)) return true;
    return crewNamesMatch(trip.info?.pic, pilotName) || crewNamesMatch(trip.info?.sic, pilotName);
  });
}

/**
 * Schedule timing for a hero card.
 * A window that still covers "now" but started days ago, or has been open
 * for more than 18 hours, is stale — it must not be the in-progress flight.
 */
export function classifyFlightTiming(trip, now = Date.now()) {
  const start = tripStartMs(trip);
  const end = toMillis(trip?.end ?? trip?.info?.end);
  const at = toMillis(now) ?? Date.now();
  if (start == null) return 'upcoming';
  if (end != null && end < at) return 'past';
  const age = at - start;
  const covers = start <= at && (end == null || end >= at);
  if (covers) {
    const duration = end != null ? end - start : null;
    const stale = age >= 2 * DAY_MS
      || (end == null && age > 18 * HOUR_MS)
      || (duration != null && duration > 18 * HOUR_MS && age > 18 * HOUR_MS);
    return stale ? 'stale' : 'active';
  }
  if (start <= at + 12 * HOUR_MS) return 'imminent';
  return 'upcoming';
}

/** Earliest real leg that is active, then imminent, then upcoming. */
export function selectFocusTrip(trips, now = Date.now()) {
  const at = toMillis(now) ?? Date.now();
  const buckets = { active: [], imminent: [], upcoming: [] };
  for (const trip of trips || []) {
    if (!isRealFlightLeg(trip)) continue;
    const kind = classifyFlightTiming(trip, at);
    if (buckets[kind]) buckets[kind].push(trip);
  }
  const byStart = (a, b) => (tripStartMs(a) || 0) - (tripStartMs(b) || 0);
  const trip = buckets.active.sort(byStart)[0]
    || buckets.imminent.sort(byStart)[0]
    || buckets.upcoming.sort(byStart)[0]
    || null;
  if (!trip) return { trip: null, timing: null };
  const kind = classifyFlightTiming(trip, at);
  return {
    trip,
    timing: { kind, isActive: kind === 'active', isImminent: kind === 'imminent' },
  };
}

/** Elapsed duty from the attested duty-on instant. Never from a trip departure. */
export function dutyClockState(period, now = Date.now()) {
  const dutyOnAt = toMillis(period?.dutyOnAt);
  if (dutyOnAt == null) return null;
  const at = toMillis(now) ?? Date.now();
  const maxMs = 14 * HOUR_MS;
  const elapsedMs = Math.max(0, at - dutyOnAt);
  const releaseAt = dutyOnAt + maxMs;
  return {
    dutyOnAt,
    elapsedMs,
    releaseAt,
    remainingMs: Math.max(0, releaseAt - at),
    maxMs,
  };
}

/** Domestic (C/M/K airport code) show is 60 minutes; otherwise 90. */
export function showOffsetMinutes(from) {
  return /^[CMK]/.test(String(from || '').trim()) ? 60 : 90;
}

export function showTimeMs(trip) {
  if (!isRealFlightLeg(trip)) return null;
  const start = tripStartMs(trip);
  if (start == null) return null;
  return start - showOffsetMinutes(trip?.info?.from) * 60_000;
}
