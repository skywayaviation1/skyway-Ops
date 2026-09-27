// Completed-leg credits on top of a baseline hour snapshot.
//
// Time source, in order:
//   1. FlightAware actual out/in (block) and off/on (airborne), stored on the
//      trip as oooi. This is the only actual-time feed the app persists.
//   2. The schedule's start/end once the leg has ended. JetInsight's iCal
//      block is the crew assignment and the route; it is labeled "schedule"
//      so it can be corrected.
// ForeFlight in this app is a dispatch connection and does not record OOOI.
// Duty periods are a daily sum of the same flying, so they are not added here.

import { lookupCoords } from './airport-coords.js';
import { matchCrewUser } from './pilot-safety.js';

const RAD = Math.PI / 180;
const DAY = 86400000;
const MAX_BLOCK_HOURS = 18;

const JET_MULTI = new Set([
  'C25A', 'C25B', 'C25C', 'C525', 'C56X', 'C560', 'C680', 'C68A', 'C750',
  'CL30', 'CL35', 'E55P', 'E550', 'H25B', 'GLF4', 'GLF5', 'LJ60',
]);
const SINGLE_TURBINE = new Set(['SF50', 'PC12', 'TBM7', 'TBM8', 'TBM9', 'C208']);
const MULTI_TURBOPROP = new Set(['BE20', 'B350', 'BE30', 'C441']);

export function roundHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}

export function hoursBetween(start, end) {
  const a = toMs(start);
  const b = toMs(end);
  if (a == null || b == null || b <= a) return null;
  const hours = (b - a) / 3600000;
  if (hours > MAX_BLOCK_HOURS) return null;
  return roundHours(hours);
}

function toMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function classifyAircraft(meta = {}, fallbackType = '') {
  const icao = String(meta.icaoType || '').trim().toUpperCase();
  const name = `${meta.displayName || ''} ${fallbackType || ''}`.toLowerCase();
  let turbine = null;
  let multiEngine = null;
  if (SINGLE_TURBINE.has(icao) || /vision|sf50|pc-?12|\btbm\b|caravan/.test(name)) {
    turbine = true;
    multiEngine = false;
  } else if (JET_MULTI.has(icao) || /citation|phenom|challenger|hawker|gulfstream|lear|falcon|praetor|legacy/.test(name)) {
    turbine = true;
    multiEngine = true;
  } else if (MULTI_TURBOPROP.has(icao) || /king air|turboprop/.test(name)) {
    turbine = true;
    multiEngine = true;
  } else if (/baron|twin piston|seneca/.test(name)) {
    turbine = false;
    multiEngine = true;
  } else if (/piston|sr22|cessna 1/.test(name)) {
    turbine = false;
    multiEngine = false;
  }
  return {
    turbine,
    multiEngine,
    typeLabel: String(meta.displayName || fallbackType || icao || 'Aircraft').slice(0, 40),
    known: turbine != null && multiEngine != null,
  };
}

function sunAltitudeDeg(date, lat, lng) {
  const jd = date.getTime() / DAY + 2440587.5;
  const n = jd - 2451545.0;
  const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
  const g = (((357.528 + 0.9856003 * n) % 360 + 360) % 360) * RAD;
  const lambda = ((L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) % 360) * RAD;
  const epsilon = (23.439 - 0.0000004 * n) * RAD;
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const gmst = ((280.46061837 + 360.98564736629 * (jd - 2451545)) % 360 + 360) % 360;
  const ha = gmst * RAD + lng * RAD - ra;
  const latR = lat * RAD;
  const sinAlt = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

function interpolate(from, to, t) {
  const φ1 = from.lat * RAD;
  const λ1 = from.lng * RAD;
  const φ2 = to.lat * RAD;
  const λ2 = to.lng * RAD;
  const delta = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2
    + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
  ));
  if (delta < 1e-8) return from;
  const a = Math.sin((1 - t) * delta) / Math.sin(delta);
  const b = Math.sin(t * delta) / Math.sin(delta);
  const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
  const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
  const z = a * Math.sin(φ1) + b * Math.sin(φ2);
  return {
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD,
    lng: Math.atan2(y, x) / RAD,
  };
}

/**
 * Night is civil twilight (sun below -6°), sampled along the route.
 * Returns null when either airport has no coordinates.
 */
export function nightHoursBetween(start, end, fromCode, toCode, lookup = lookupCoords) {
  const startMs = toMs(start);
  const endMs = toMs(end);
  const block = hoursBetween(start, end);
  if (block == null || startMs == null) return { hours: null, status: 'unknown' };
  const from = lookup(fromCode);
  const to = lookup(toCode);
  if (!from || !to) return { hours: null, status: 'unknown' };
  const steps = Math.max(2, Math.ceil((endMs - startMs) / (6 * 60 * 1000)));
  let nightSteps = 0;
  for (let i = 0; i < steps; i += 1) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const point = interpolate(from, to, t);
    const altitude = sunAltitudeDeg(new Date(startMs + (endMs - startMs) * t), point.lat, point.lng);
    if (altitude < -6) nightSteps += 1;
  }
  return { hours: roundHours(block * (nightSteps / steps)) ?? 0, status: 'computed' };
}

function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
}

function tripStateFor(tripStates, uid) {
  if (!tripStates) return null;
  if (tripStates instanceof Map) return tripStates.get(uid) || null;
  return tripStates[uid] || null;
}

function aircraftFor(aircraftByTail, tail) {
  if (!aircraftByTail || !tail) return {};
  return aircraftByTail[tail] || aircraftByTail[tail.toUpperCase()] || {};
}

function completedTimes(trip, state, now) {
  const oooi = state?.oooi || {};
  const endMs = toMs(trip.end);
  const ended = endMs != null && endMs <= now;
  const actualBlock = hoursBetween(oooi.actualOut, oooi.actualIn);
  const actualFlight = hoursBetween(oooi.actualOff, oooi.actualOn);
  if (actualBlock != null || (oooi.actualIn && actualFlight != null)) {
    const blockHours = actualBlock != null ? actualBlock : actualFlight;
    const blockOut = oooi.actualOut || oooi.actualOff;
    const blockIn = oooi.actualIn || oooi.actualOn;
    return {
      completed: true,
      timeSource: 'flightaware',
      blockOut,
      blockIn,
      flightOff: oooi.actualOff || '',
      flightOn: oooi.actualOn || '',
      blockHours,
      flightHours: actualFlight,
      faFlightId: oooi.faFlightId || '',
    };
  }
  if (!ended) return { completed: false };
  const blockHours = hoursBetween(trip.start, trip.end);
  if (blockHours == null) return { completed: false };
  return {
    completed: true,
    timeSource: 'schedule',
    blockOut: trip.start instanceof Date ? trip.start.toISOString() : String(trip.start),
    blockIn: trip.end instanceof Date ? trip.end.toISOString() : String(trip.end),
    flightOff: '',
    flightOn: '',
    blockHours,
    flightHours: null,
    faFlightId: '',
  };
}

function disqualified(trip, state) {
  const info = trip?.info || {};
  if (info.isFlight === false) return 'Not a flight';
  const category = String(info.category || '').toUpperCase();
  if (['HOLD', 'MX'].includes(category)) return 'Not a flight';
  if (info.from && info.to && String(info.from).toUpperCase() === String(info.to).toUpperCase()) return 'Not a flight';
  const disposition = String(state?.opsDisposition || '').toLowerCase();
  if (disposition === 'cancelled' || disposition === 'canceled') return 'Cancelled';
  if (state?.cancelled === true) return 'Cancelled';
  return '';
}

export function proposeLegCredits({
  trips = [],
  tripStates = null,
  aircraftByTail = {},
  users = [],
  now = Date.now(),
  lookup = lookupCoords,
} = {}) {
  const desired = [];
  for (const trip of trips || []) {
    if (!trip?.uid) continue;
    const state = tripStateFor(tripStates, trip.uid);
    const reason = disqualified(trip, state);
    const times = reason ? { completed: false } : completedTimes(trip, state, now);
    if (!times.completed) continue;
    const info = trip.info || {};
    const tail = String(info.tail || '').toUpperCase();
    const aircraft = classifyAircraft(aircraftFor(aircraftByTail, tail), info.aircraftType);
    const night = nightHoursBetween(times.blockOut, times.blockIn, info.from, info.to, lookup);
    const seats = [
      ['PIC', info.pic],
      ['SIC', info.sic],
    ];
    for (const [role, name] of seats) {
      const clean = String(name || '').trim();
      if (!clean) continue;
      const user = matchCrewUser(clean, users);
      if (!user?.uid) continue;
      const legKey = `leg_${role}_${safeId(trip.uid)}`;
      desired.push({
        id: `${user.uid}__${legKey}`,
        uid: user.uid,
        pilotName: user.name || clean,
        role,
        legKey,
        tripUid: String(trip.uid),
        origin: String(info.from || '').toUpperCase(),
        destination: String(info.to || '').toUpperCase(),
        tail,
        aircraftType: aircraft.typeLabel,
        multiEngine: aircraft.multiEngine,
        turbine: aircraft.turbine,
        categoryKnown: aircraft.known,
        blockOut: times.blockOut || '',
        blockIn: times.blockIn || '',
        flightOff: times.flightOff || '',
        flightOn: times.flightOn || '',
        blockHours: times.blockHours,
        flightHours: times.flightHours,
        nightHours: night.hours,
        nightStatus: night.status,
        landings: 1,
        timeSource: times.timeSource,
        faFlightId: times.faFlightId || '',
        status: 'credited',
        voidReason: '',
        manual: false,
        manualOverride: false,
      });
    }
  }
  return desired;
}

function auditLine(action, note, editor, now) {
  return {
    at: now,
    byUid: editor?.uid || 'flight-log',
    byName: editor?.name || editor?.email || 'Flight log',
    action,
    note: String(note || '').slice(0, 240),
  };
}

function sameCredit(left, right) {
  const fields = [
    'blockHours', 'flightHours', 'nightHours', 'nightStatus', 'landings', 'status',
    'timeSource', 'origin', 'destination', 'tail', 'aircraftType', 'role',
    'multiEngine', 'turbine', 'blockOut', 'blockIn',
  ];
  return fields.every((field) => left?.[field] === right?.[field]);
}

export function mergeFlightEntries(desired, existing, { now = Date.now(), editor = null } = {}) {
  const current = new Map((existing || []).map((entry) => [entry.id, entry]));
  const writes = [];
  const next = [];
  const seen = new Set();

  for (const proposal of desired || []) {
    seen.add(proposal.id);
    const prev = current.get(proposal.id);
    if (!prev) {
      const created = {
        ...proposal,
        audit: [auditLine('credited', `${proposal.timeSource} ${proposal.origin}-${proposal.destination}`, editor, now)],
        updatedAt: now,
      };
      writes.push(created);
      next.push(created);
      continue;
    }
    if (prev.manual && !prev.tripUid) {
      next.push(prev);
      continue;
    }
    if (prev.manualOverride) {
      next.push(prev);
      continue;
    }
    if (prev.status === 'void' && prev.manual) {
      next.push(prev);
      continue;
    }
    const merged = {
      ...prev,
      ...proposal,
      manual: false,
      manualOverride: false,
      audit: prev.audit || [],
      updatedAt: prev.updatedAt || now,
    };
    if (!sameCredit(prev, merged)) {
      merged.audit = [...(prev.audit || []), auditLine(
        'updated',
        `${proposal.timeSource} block ${proposal.blockHours}h`,
        editor,
        now,
      )].slice(-12);
      merged.updatedAt = now;
      writes.push(merged);
    }
    next.push(merged);
  }

  for (const prev of current.values()) {
    if (seen.has(prev.id)) continue;
    if (prev.manual && !prev.tripUid) {
      next.push(prev);
      continue;
    }
    if (!prev.tripUid) {
      next.push(prev);
      continue;
    }
    const stillThere = (desired || []).some((entry) => entry.tripUid === prev.tripUid && entry.role === prev.role);
    if (stillThere) {
      next.push(prev);
      continue;
    }
    // The leg is not in this schedule pass. Keep it. A removed iCal row is
    // not proof of cancellation; an admin voids it, or a later pass that
    // still contains the trip and marks it cancelled will void it below.
    next.push(prev);
  }

  return { entries: next, writes };
}

export function voidEntry(entry, reason, editor, now = Date.now()) {
  if (!entry || entry.status === 'void') return entry;
  return {
    ...entry,
    status: 'void',
    voidReason: String(reason || 'Voided').slice(0, 120),
    audit: [...(entry.audit || []), auditLine('voided', reason, editor, now)].slice(-12),
    updatedAt: now,
  };
}

export function applyManualFlightEdit(entry, patch, editor, now = Date.now()) {
  const note = String(patch?.note || '').trim();
  if (!note) throw new Error('A note is required for a manual correction.');
  const next = { ...entry, manualOverride: true, manual: entry.manual || !entry.tripUid };
  if (patch.blockHours != null) next.blockHours = roundHours(patch.blockHours);
  if (patch.flightHours != null) next.flightHours = roundHours(patch.flightHours);
  if (patch.nightHours != null) {
    next.nightHours = roundHours(patch.nightHours);
    next.nightStatus = 'manual';
  }
  if (patch.landings != null) next.landings = Math.max(0, Math.round(Number(patch.landings) || 0));
  if (patch.role === 'PIC' || patch.role === 'SIC') next.role = patch.role;
  if (patch.aircraftType) next.aircraftType = String(patch.aircraftType).slice(0, 40);
  next.audit = [...(entry.audit || []), auditLine('corrected', note, editor, now)].slice(-12);
  next.updatedAt = now;
  return next;
}

export function newManualFlightEntry({ uid, pilotName, patch, editor, now = Date.now() }) {
  const note = String(patch?.note || '').trim();
  if (!note) throw new Error('A note is required for a manual entry.');
  if (!uid) throw new Error('Pilot is required.');
  const blockHours = roundHours(patch.blockHours);
  if (blockHours == null) throw new Error('Block time is required.');
  const id = `manual_${safeId(uid)}_${now.toString(36)}`;
  const nightStatus = patch.nightHours == null || patch.nightHours === '' ? 'unknown' : 'manual';
  return {
    id,
    uid,
    pilotName: pilotName || '',
    role: patch.role === 'SIC' ? 'SIC' : 'PIC',
    legKey: id,
    tripUid: '',
    origin: String(patch.origin || '').toUpperCase().slice(0, 8),
    destination: String(patch.destination || '').toUpperCase().slice(0, 8),
    tail: String(patch.tail || '').toUpperCase().slice(0, 8),
    aircraftType: String(patch.aircraftType || '').slice(0, 40),
    multiEngine: patch.multiEngine === true ? true : patch.multiEngine === false ? false : null,
    turbine: patch.turbine === true ? true : patch.turbine === false ? false : null,
    categoryKnown: patch.multiEngine != null && patch.turbine != null,
    blockOut: patch.blockOut || '',
    blockIn: patch.blockIn || '',
    flightOff: '',
    flightOn: '',
    blockHours,
    flightHours: roundHours(patch.flightHours),
    nightHours: nightStatus === 'manual' ? roundHours(patch.nightHours) : null,
    nightStatus,
    landings: Math.max(0, Math.round(Number(patch.landings ?? 1) || 0)),
    timeSource: 'manual',
    faFlightId: '',
    status: 'credited',
    voidReason: '',
    manual: true,
    manualOverride: true,
    audit: [auditLine('manual', note, editor, now)],
    updatedAt: now,
  };
}

function addHours(left, right) {
  if (left == null && right == null) return null;
  return roundHours((Number(left) || 0) + (Number(right) || 0));
}

function afterBaseline(entry, asOf) {
  if (!asOf || entry?.status !== 'credited') return false;
  const ms = toMs(entry.blockIn);
  if (ms == null) return false;
  return ymd(ms) > asOf;
}

function inWindow(entry, startMs, endMs) {
  const ms = toMs(entry.blockIn);
  return ms != null && ms > startMs && ms <= endMs;
}

function baselineOverlap(amount, asOf, windowDays, now) {
  if (amount == null || !asOf) return 0;
  const asOfEnd = toMs(`${asOf}T23:59:59.999Z`);
  if (asOfEnd == null) return 0;
  const windowStart = now - windowDays * DAY;
  const baselineStart = asOfEnd - windowDays * DAY;
  const overlap = Math.min(now, asOfEnd) - Math.max(windowStart, baselineStart);
  if (overlap <= 0) return 0;
  return roundHours(Number(amount) * (overlap / (windowDays * DAY))) ?? 0;
}

function sumField(entries, pick, asOf) {
  let total = 0;
  for (const entry of entries) {
    if (!afterBaseline(entry, asOf)) continue;
    const value = pick(entry);
    if (value == null) continue;
    total += Number(value) || 0;
  }
  return roundHours(total) ?? 0;
}

export function rollUpPilotHours({
  baseline = null,
  storedHours = null,
  entries = [],
  now = Date.now(),
} = {}) {
  const asOf = baseline?.asOf || '';
  const base = baseline?.hours || storedHours || {};
  const credited = (entries || []).filter((entry) => entry.status === 'credited');
  const flown = {
    totalTime: 0,
    pic: 0,
    sic: 0,
    multiEngine: 0,
    turbine: 0,
    night: 0,
    landings: 0,
  };
  let nightUncomputed = 0;
  if (asOf) {
    flown.totalTime = sumField(credited, (entry) => entry.blockHours, asOf);
    flown.pic = sumField(credited, (entry) => (entry.role === 'PIC' ? entry.blockHours : 0), asOf);
    flown.sic = sumField(credited, (entry) => (entry.role === 'SIC' ? entry.blockHours : 0), asOf);
    flown.multiEngine = sumField(credited, (entry) => (entry.multiEngine === true ? entry.blockHours : 0), asOf);
    flown.turbine = sumField(credited, (entry) => (entry.turbine === true ? entry.blockHours : 0), asOf);
    flown.night = sumField(credited, (entry) => (entry.nightStatus === 'computed' || entry.nightStatus === 'manual' ? entry.nightHours : 0), asOf);
    flown.landings = sumField(credited, (entry) => entry.landings, asOf) ?? 0;
    nightUncomputed = credited.filter((entry) => afterBaseline(entry, asOf) && entry.nightStatus === 'unknown').length;
  }

  const hours = {
    totalTime: asOf ? addHours(base.totalTime, flown.totalTime) : base.totalTime ?? null,
    pic: asOf ? addHours(base.pic, flown.pic) : base.pic ?? null,
    sic: asOf ? addHours(base.sic, flown.sic) : base.sic ?? null,
    multiEngine: asOf ? addHours(base.multiEngine, flown.multiEngine) : base.multiEngine ?? null,
    turbine: asOf ? addHours(base.turbine, flown.turbine) : base.turbine ?? null,
    night: asOf ? addHours(base.night, flown.night) : base.night ?? null,
    instrument: base.instrument ?? null,
    fixedWing: base.fixedWing ?? null,
    rotorWing: base.rotorWing ?? null,
    singleEngine: base.singleEngine ?? null,
    multiEngine90: base.multiEngine90 ?? null,
    multiEngine12: base.multiEngine12 ?? null,
    last90Days: null,
    last6Months: null,
    last12Months: null,
    landings: asOf ? addHours(base.landings, flown.landings) : base.landings ?? null,
    timeInType: Array.isArray(base.timeInType) ? base.timeInType.map((entry) => ({ ...entry })) : [],
  };

  if (asOf) {
    const byType = new Map(hours.timeInType.map((entry) => [entry.type.toLowerCase(), { ...entry }]));
    for (const entry of credited) {
      if (!afterBaseline(entry, asOf) || !entry.aircraftType) continue;
      const key = entry.aircraftType.toLowerCase();
      const prev = byType.get(key) || { type: entry.aircraftType, hours: 0, picHours: null };
      prev.hours = addHours(prev.hours, entry.blockHours);
      if (entry.role === 'PIC') prev.picHours = addHours(prev.picHours, entry.blockHours);
      byType.set(key, prev);
    }
    hours.timeInType = [...byType.values()];
    const recentMulti = (days, field) => {
      const fromLog = sumField(
        credited.filter((entry) => inWindow(entry, now - days * DAY, now) && entry.multiEngine === true),
        (entry) => entry.blockHours,
        asOf,
      );
      return addHours(baselineOverlap(base[field], asOf, days, now), fromLog);
    };
    if (base.multiEngine90 != null) hours.multiEngine90 = recentMulti(90, 'multiEngine90');
    if (base.multiEngine12 != null) hours.multiEngine12 = recentMulti(365, 'multiEngine12');
    const recent = (days, field) => {
      const fromLog = sumField(
        credited.filter((entry) => inWindow(entry, now - days * DAY, now)),
        (entry) => entry.blockHours,
        asOf,
      );
      return addHours(baselineOverlap(base[field], asOf, days, now), fromLog);
    };
    hours.last90Days = recent(90, 'last90Days');
    hours.last6Months = recent(183, 'last6Months');
    hours.last12Months = recent(365, 'last12Months');
  } else {
    hours.last90Days = base.last90Days ?? null;
    hours.last6Months = base.last6Months ?? null;
    hours.last12Months = base.last12Months ?? null;
  }

  const note = !asOf
    ? 'Set a baseline as-of date before completed flights are added.'
    : [
      `Baseline ${asOf} plus flights that blocked in after that date.`,
      'Instrument time stays at the baseline.',
      nightUncomputed ? `${nightUncomputed} leg${nightUncomputed === 1 ? '' : 's'} still need night time.` : '',
    ].filter(Boolean).join(' ');

  return {
    hours,
    flownSince: flown,
    meta: {
      asOf: ymd(now),
      baselineAsOf: asOf,
      baselineSource: baseline?.source || '',
      flownSince: flown,
      last6Months: hours.last6Months,
      nightUncomputed,
      note,
    },
  };
}

function hoursClose(left, right) {
  const keys = ['totalTime', 'pic', 'sic', 'multiEngine', 'turbine', 'night', 'instrument', 'fixedWing', 'rotorWing', 'singleEngine', 'multiEngine90', 'multiEngine12', 'last90Days', 'last6Months', 'last12Months', 'landings'];
  for (const key of keys) {
    const a = left?.[key] ?? null;
    const b = right?.[key] ?? null;
    if (a == null && b == null) continue;
    if (a == null || b == null || Math.abs(Number(a) - Number(b)) > 0.05) return false;
  }
  const typeKey = (hours) => (hours?.timeInType || [])
    .map((entry) => `${String(entry.type || '').toLowerCase()}:${entry.hours ?? ''}:${entry.picHours ?? ''}`)
    .sort()
    .join('|');
  return typeKey(left) === typeKey(right);
}

export function planFlightLogSync({
  trips = null,
  tripStates = null,
  aircraftByTail = {},
  users = [],
  existingEntries = [],
  logbooks = {},
  now = Date.now(),
  editor = null,
  lookup = lookupCoords,
} = {}) {
  if (!Array.isArray(trips)) return { entryWrites: [], logbookPatches: [], entries: existingEntries };
  const desired = proposeLegCredits({ trips, tripStates, aircraftByTail, users, now, lookup });
  const present = new Set((trips || []).map((trip) => trip.uid));
  const cancelled = [];
  for (const entry of existingEntries || []) {
    if (!entry.tripUid || !present.has(entry.tripUid) || entry.status === 'void') continue;
    const trip = trips.find((item) => item.uid === entry.tripUid);
    const state = tripStateFor(tripStates, entry.tripUid);
    const reason = trip ? disqualified(trip, state) : '';
    if (reason) cancelled.push(voidEntry(entry, reason, editor, now));
  }
  const voidIds = new Set(cancelled.map((entry) => entry.id));
  const baseExisting = (existingEntries || []).map((entry) => voidIds.has(entry.id)
    ? cancelled.find((item) => item.id === entry.id)
    : entry);
  const merged = mergeFlightEntries(desired, baseExisting, { now, editor });
  const voidWrites = cancelled.filter((entry) => {
    const prev = (existingEntries || []).find((item) => item.id === entry.id);
    return prev && prev.status !== 'void';
  });
  const entryWrites = [...voidWrites, ...merged.writes.filter((entry) => !voidIds.has(entry.id))];

  const byUid = new Map();
  for (const entry of merged.entries) {
    if (!byUid.has(entry.uid)) byUid.set(entry.uid, []);
    byUid.get(entry.uid).push(entry);
  }
  const logbookPatches = [];
  for (const [uid, book] of Object.entries(logbooks || {})) {
    if (!book?.baseline?.asOf) continue;
    const rolled = rollUpPilotHours({
      baseline: book.baseline,
      storedHours: book.hours,
      entries: byUid.get(uid) || [],
      now,
    });
    if (hoursClose(book.hours, rolled.hours) && book.hoursMeta?.asOf === rolled.meta.asOf
      && book.hoursMeta?.nightUncomputed === rolled.meta.nightUncomputed) continue;
    logbookPatches.push({ uid, hours: rolled.hours, hoursMeta: rolled.meta });
  }
  return { entryWrites, logbookPatches, entries: merged.entries };
}
