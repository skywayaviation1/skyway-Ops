// Year-to-date trade-show replay.
//
// Pure schedule, geometry, and privacy projection. The browser page and the
// public API both go through this module so a leg can only reach the TV with
// the fields listed in PUBLIC_LEG_KEYS.
//
// data/showcase-legs-2026.csv is the primary archive (date, origin, destination,
// block hours — no trip, booking, or crew). A leg is included when its calendar
// date is on or before today in America/New_York, so future rows in the file
// wait until that morning. Firestore legs are merged only for dates after the
// file's coverage, and can attach a tail onto a matching file row.

import { distanceNm } from './tracking-map.js';

export const SHOWCASE_TIME_ZONE = 'America/New_York';
export const SHOWCASE_ORIGIN = 'https://skyway.app';
/** Full-year (or stored-range) flight phase. Inside the 2–3 minute brief. */
export const SHOWCASE_PLAY_MS = 150_000;
/** Hold on the finished network before the loop restarts. */
export const SHOWCASE_HOLD_MS = 8_000;
export const SHOWCASE_LOOP_MS = SHOWCASE_PLAY_MS + SHOWCASE_HOLD_MS;
export const SHOWCASE_MIN_LEG_MS = 4_200;
export const SHOWCASE_MAX_LEG_MS = 7_600;
/** A stored range that starts well after Jan 1 plays across its own dates. */
export const SHOWCASE_ABBREVIATE_GAP_MS = 7 * 24 * 60 * 60 * 1000;
export const SHOWCASE_CACHE_MS = 15 * 60 * 1000;
export const SHOWCASE_ROUTE_SAMPLES = 24;
export const SHOWCASE_MAX_LEGS = 12_000;

export const PUBLIC_LEG_KEYS = Object.freeze([
  'tail',
  'from',
  'to',
  'fromLat',
  'fromLng',
  'toLat',
  'toLng',
  'departure',
  'arrival',
  'block',
]);

const SKIP_CATEGORIES = new Set(['HOLD', 'MX', 'MAINTENANCE', 'TRAINING']);
const SM_PER_NM = 1.150779448;

export function isShowcaseToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function showcasePath(token) {
  return `/showcase/${token}`;
}

export function showcaseUrl(token, origin = SHOWCASE_ORIGIN) {
  const base = String(origin || SHOWCASE_ORIGIN).replace(/\/+$/, '');
  return `${base}${showcasePath(token)}`;
}

/** `/showcase` and `/showcase/<token>` are the public TV route. Anything else is null. */
export function parseShowcasePath(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  if (path !== '/showcase' && !path.startsWith('/showcase/')) return null;
  if (path === '/showcase') return { token: '' };
  let token = path.slice('/showcase/'.length);
  try { token = decodeURIComponent(token); } catch { /* keep the raw segment */ }
  if (token.includes('/')) return { token: '' };
  return { token };
}

export function zonedParts(ms, timeZone = SHOWCASE_TIME_ZONE) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const bag = {};
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function timeZoneOffsetMs(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - ms;
}

/** Midnight on January 1 of the instant's calendar year, in the showcase zone. */
export function zonedStartOfYearMs(ms, timeZone = SHOWCASE_TIME_ZONE) {
  const year = zonedParts(ms, timeZone).year;
  let utc = Date.UTC(year, 0, 1, 5, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    utc = Date.UTC(year, 0, 1, 0, 0, 0) - timeZoneOffsetMs(utc, timeZone);
  }
  return utc;
}

export function formatShowcaseDate(ms, timeZone = SHOWCASE_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(ms));
  const bag = {};
  for (const part of parts) bag[part.type] = part.value;
  return {
    day: `${bag.month} ${bag.day}`.toUpperCase(),
    year: bag.year,
  };
}

export function formatShowcaseCount(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n);
}

function normCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 3 || code.length > 5) return '';
  return code;
}

function normTail(value) {
  const tail = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (tail.length < 2 || tail.length > 8) return '';
  return tail;
}

function instantMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

export function isCompletedShowcaseLeg(raw, { now, yearStart }) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.cancelled === true) return false;
  if (raw.isFlight === false) return false;
  const category = String(raw.category || raw.legType || '').toUpperCase();
  if (SKIP_CATEGORIES.has(category)) return false;
  const from = normCode(raw.from);
  const to = normCode(raw.to);
  if (!from || !to || from === to) return false;
  if (!normTail(raw.tail)) return false;
  const departure = instantMs(raw.departure || raw.start);
  const arrival = instantMs(raw.arrival || raw.end);
  if (departure == null || arrival == null || arrival <= departure) return false;
  if (departure < yearStart || arrival > now) return false;
  return true;
}

/**
 * Project one stored leg down to the public shape.
 * Returns null when the airports cannot be placed on the map.
 */
export function projectShowcaseLeg(raw, lookupCoords) {
  const from = normCode(raw?.from);
  const to = normCode(raw?.to);
  const tail = normTail(raw?.tail);
  const fromHit = typeof lookupCoords === 'function' ? lookupCoords(from) : null;
  const toHit = typeof lookupCoords === 'function' ? lookupCoords(to) : null;
  const fromLat = Number(fromHit?.lat ?? fromHit?.latitude);
  const fromLng = Number(fromHit?.lng ?? fromHit?.lon ?? fromHit?.longitude);
  const toLat = Number(toHit?.lat ?? toHit?.latitude);
  const toLng = Number(toHit?.lng ?? toHit?.lon ?? toHit?.longitude);
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) return null;
  const departure = instantMs(raw.departure || raw.start);
  const arrival = instantMs(raw.arrival || raw.end);
  const nm = distanceNm({ lat: fromLat, lon: fromLng }, { lat: toLat, lon: toLng });
  if (!Number.isFinite(nm) || nm < 1) return null;
  const given = Number(raw.block);
  const clockHours = (arrival - departure) / 3_600_000;
  const block = Number.isFinite(given) && given > 0
    ? Math.round(given * 10) / 10
    : Math.round(clockHours * 10) / 10;
  return {
    tail,
    from,
    to,
    fromLat: roundCoord(fromLat),
    fromLng: roundCoord(fromLng),
    toLat: roundCoord(toLat),
    toLng: roundCoord(toLng),
    departure: new Date(departure).toISOString(),
    arrival: new Date(arrival).toISOString(),
    block,
  };
}

/** Calendar date in the showcase zone, `YYYY-MM-DD`. */
export function showcaseDayKey(ms, timeZone = SHOWCASE_TIME_ZONE) {
  const parts = zonedParts(ms, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * Owner route file: `date,orig,dest,block`. Blank lines and the header are
 * ignored. Block hours stay at one decimal, matching the source.
 */
export function parseShowcaseHistoryCsv(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0 && /^date\s*,/i.test(line)) continue;
    const parts = line.split(',');
    if (parts.length < 4) continue;
    const date = parts[0].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const block = Math.round(Number(parts[3]) * 10) / 10;
    rows.push({
      date,
      from: normCode(parts[1]),
      to: normCode(parts[2]),
      block,
    });
  }
  return rows;
}

function zonedClockMs(date, minutesFromMidnight, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = Math.floor(minutesFromMidnight % 60);
  const second = Math.round((minutesFromMidnight % 1) * 60);
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(utc, timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const want = Date.UTC(year, month - 1, day, hour, minute, second);
    utc += want - asUtc;
  }
  return utc;
}

function canonCode(code) {
  const normalized = normCode(code);
  if (normalized.length === 4 && normalized.startsWith('K') && /^[A-Z]{3}$/.test(normalized.slice(1))) {
    return normalized.slice(1);
  }
  return normalized;
}

function placeable(code, lookup) {
  if (!code || typeof lookup !== 'function') return false;
  const hit = lookup(code);
  const lat = Number(hit?.lat ?? hit?.latitude);
  const lng = Number(hit?.lng ?? hit?.lon ?? hit?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/**
 * History rows are the schedule through the file's last date. Firestore adds
 * a tail when the same Eastern date and city pair exist, and adds a leg only
 * when its date is after that coverage and still on or before today.
 * Same-airport rows and codes the coordinate cache cannot place are skipped.
 */
export function buildShowcaseArchive({
  historyRows = [],
  storedLegs = [],
  now = Date.now(),
  lookupCoords,
  timeZone = SHOWCASE_TIME_ZONE,
} = {}) {
  const yearStart = zonedStartOfYearMs(now, timeZone);
  const today = showcaseDayKey(now, timeZone);
  const year = zonedParts(now, timeZone).year;
  const yearStartKey = `${year}-01-01`;
  let coverageEnd = '';
  let coverageStart = '';
  for (const row of historyRows || []) {
    const date = row?.date;
    if (!date) continue;
    if (!coverageEnd || date > coverageEnd) coverageEnd = date;
    if (!coverageStart || date < coverageStart) coverageStart = date;
  }
  const useHistory = Boolean(coverageStart) && coverageStart <= `${year}-01-08`;
  if (!useHistory) {
    const selected = selectShowcaseLegs(storedLegs, { now, lookupCoords, timeZone });
    return {
      ...selected,
      archive: 'stored',
      unresolved: [],
      coverageEnd: coverageEnd || null,
    };
  }

  const unresolved = new Set();
  const byDay = new Map();
  for (const row of historyRows || []) {
    if (!row?.date || row.date < yearStartKey || row.date > today) continue;
    if (!row.from || !row.to || row.from === row.to) continue;
    if (!Number.isFinite(row.block) || row.block <= 0) continue;
    const list = byDay.get(row.date) || [];
    list.push(row);
    byDay.set(row.date, list);
  }

  const tails = new Map();
  const extras = [];
  const completed = [];
  for (const raw of storedLegs || []) {
    if (!isCompletedShowcaseLeg(raw, { now, yearStart })) continue;
    completed.push(raw);
  }
  completed.sort((a, b) => instantMs(a.departure || a.start) - instantMs(b.departure || b.start));
  for (const raw of completed) {
    const date = showcaseDayKey(instantMs(raw.departure || raw.start), timeZone);
    const from = normCode(raw.from);
    const to = normCode(raw.to);
    if (date > coverageEnd) {
      extras.push(raw);
      continue;
    }
    const key = `${date}|${canonCode(from)}|${canonCode(to)}`;
    const queue = tails.get(key) || [];
    queue.push(normTail(raw.tail));
    tails.set(key, queue);
  }

  const built = [];
  for (const date of [...byDay.keys()].sort()) {
    const list = byDay.get(date);
    const count = list.length;
    list.forEach((row, index) => {
      if (!placeable(row.from, lookupCoords)) unresolved.add(row.from);
      if (!placeable(row.to, lookupCoords)) unresolved.add(row.to);
      if (!placeable(row.from, lookupCoords) || !placeable(row.to, lookupCoords)) return;
      const minutes = (7 * 60) + (count <= 1 ? 0 : (index / count) * 14 * 60);
      const departure = zonedClockMs(date, minutes, timeZone);
      const arrival = departure + row.block * 3_600_000;
      const queue = tails.get(`${date}|${canonCode(row.from)}|${canonCode(row.to)}`);
      const tail = queue?.length ? queue.shift() : '';
      const leg = projectShowcaseLeg({
        from: row.from,
        to: row.to,
        tail,
        block: row.block,
        departure,
        arrival,
      }, lookupCoords);
      if (leg) built.push(leg);
    });
  }

  for (const raw of extras) {
    const departure = instantMs(raw.departure || raw.start);
    const date = showcaseDayKey(departure, timeZone);
    if (date > today) continue;
    const from = normCode(raw.from);
    const to = normCode(raw.to);
    if (from && !placeable(from, lookupCoords)) unresolved.add(from);
    if (to && !placeable(to, lookupCoords)) unresolved.add(to);
    const leg = projectShowcaseLeg(raw, lookupCoords);
    if (!leg) continue;
    const duplicate = built.some((row) => (
      showcaseDayKey(Date.parse(row.departure), timeZone) === date
      && row.from === leg.from
      && row.to === leg.to
      && row.block === leg.block
    ));
    if (!duplicate) built.push(leg);
  }

  built.sort((a, b) => (
    Date.parse(a.departure) - Date.parse(b.departure)
    || String(a.tail).localeCompare(String(b.tail))
    || a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
  ));
  const truncated = built.length > SHOWCASE_MAX_LEGS;
  return {
    yearStart,
    now,
    truncated,
    archive: 'history',
    unresolved: [...unresolved].sort(),
    coverageEnd,
    legs: truncated ? built.slice(built.length - SHOWCASE_MAX_LEGS) : built,
  };
}

export function selectShowcaseLegs(rawLegs, {
  now = Date.now(),
  lookupCoords,
  timeZone = SHOWCASE_TIME_ZONE,
} = {}) {
  const yearStart = zonedStartOfYearMs(now, timeZone);
  const legs = [];
  for (const raw of rawLegs || []) {
    if (!isCompletedShowcaseLeg(raw, { now, yearStart })) continue;
    const leg = projectShowcaseLeg(raw, lookupCoords);
    if (!leg) continue;
    legs.push(leg);
  }
  legs.sort((a, b) => (
    Date.parse(a.departure) - Date.parse(b.departure)
    || a.tail.localeCompare(b.tail)
    || a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
  ));
  const truncated = legs.length > SHOWCASE_MAX_LEGS;
  return {
    yearStart,
    now,
    truncated,
    legs: truncated ? legs.slice(legs.length - SHOWCASE_MAX_LEGS) : legs,
  };
}

export function publicShowcaseBody(selected, now = selected?.now || Date.now()) {
  const legs = (selected?.legs || []).map((leg) => {
    const out = {};
    for (const key of PUBLIC_LEG_KEYS) out[key] = leg[key];
    return out;
  });
  const storedFrom = legs.length ? legs[0].departure : null;
  const storedTo = legs.length ? legs[legs.length - 1].arrival : null;
  return {
    year: zonedParts(now).year,
    rangeStart: new Date(selected.yearStart).toISOString(),
    rangeEnd: new Date(now).toISOString(),
    generatedAt: new Date(now).toISOString(),
    storedFrom,
    storedTo,
    truncated: selected?.truncated === true,
    archive: selected?.archive === 'history' ? 'history' : 'stored',
    legs,
  };
}

/**
 * When the archive does not reach back to January, the loop plays the stored
 * dates across the same 2.5 minutes. A full archive still starts on Jan 1.
 */
export function playbackWindow(body) {
  const yearStart = Date.parse(body?.rangeStart);
  const end = Date.parse(body?.rangeEnd);
  const storedFrom = Date.parse(body?.storedFrom);
  const safeEnd = Number.isFinite(end) ? end : Date.now();
  const safeStart = Number.isFinite(yearStart) ? yearStart : safeEnd;
  const abbreviated = body?.archive === 'history'
    ? false
    : Number.isFinite(storedFrom) && (storedFrom - safeStart) > SHOWCASE_ABBREVIATE_GAP_MS;
  const start = abbreviated ? storedFrom : safeStart;
  return {
    start,
    end: Math.max(safeEnd, start + 1),
    abbreviated,
    yearStart: safeStart,
  };
}

export function legScreenMs(departureMs, arrivalMs) {
  const hours = Math.max(0, (arrivalMs - departureMs) / 3_600_000);
  const t = Math.max(0, Math.min(1, hours / 5));
  return SHOWCASE_MIN_LEG_MS + (SHOWCASE_MAX_LEG_MS - SHOWCASE_MIN_LEG_MS) * t;
}

/**
 * Map real departures onto the flight phase. Same-day flights share the
 * screen because their start times stay a fraction of a flight apart, while
 * each leg is given a few seconds so the icon can actually travel the route.
 * The last departure still finishes before the hold.
 */
export function scheduleShowcasePlayback(legs, window) {
  const start = window.start;
  const span = Math.max(1, window.end - start);
  const launchWindow = Math.max(1, SHOWCASE_PLAY_MS - SHOWCASE_MAX_LEG_MS);
  return (legs || []).map((leg) => {
    const departure = Date.parse(leg.departure);
    const arrival = Date.parse(leg.arrival);
    const fraction = Math.max(0, Math.min(1, (departure - start) / span));
    const playStart = fraction * launchWindow;
    const playDur = legScreenMs(departure, arrival);
    const clockHours = Math.max(0, (arrival - departure) / 3_600_000);
    const given = Number(leg.block);
    return {
      ...leg,
      playStart,
      playEnd: playStart + playDur,
      blockHours: Number.isFinite(given) && given > 0 ? given : clockHours,
      nm: distanceNm(
        { lat: leg.fromLat, lon: leg.fromLng },
        { lat: leg.toLat, lon: leg.toLng },
      ) || 0,
    };
  });
}

export function replayDateMs(playMs, window) {
  if (playMs >= SHOWCASE_PLAY_MS) return window.end;
  const p = Math.max(0, Math.min(1, playMs / SHOWCASE_PLAY_MS));
  return window.start + p * (window.end - window.start);
}

export function initialPlayMs({ at, reducedMotion } = {}) {
  if (reducedMotion) return SHOWCASE_PLAY_MS;
  if (at === 'hold') return SHOWCASE_PLAY_MS;
  if (at === 'finale') return SHOWCASE_PLAY_MS + Math.round(SHOWCASE_HOLD_MS * 0.78);
  const n = Number(at);
  if (Number.isFinite(n)) return Math.max(0, Math.min(1, n)) * SHOWCASE_PLAY_MS;
  return 0;
}

export function frameActors(scheduled, playMs) {
  const holding = playMs >= SHOWCASE_PLAY_MS;
  const active = [];
  const finished = [];
  for (const leg of scheduled || []) {
    if (holding || leg.playEnd <= playMs) {
      finished.push(leg);
    } else if (leg.playStart <= playMs && leg.playEnd > leg.playStart) {
      active.push({
        ...leg,
        f: (playMs - leg.playStart) / (leg.playEnd - leg.playStart),
      });
    }
  }
  return { active, finished, holding };
}

/** Counters for the legs that have finished by `playMs`. */
export function showcaseSnapshot(scheduled, playMs, window) {
  const { active, finished, holding } = frameActors(scheduled, playMs);
  let nm = 0;
  let hours = 0;
  const airports = new Set();
  for (const leg of finished) {
    nm += leg.nm || 0;
    hours += leg.blockHours || 0;
    if (leg.from) airports.add(leg.from);
    if (leg.to) airports.add(leg.to);
  }
  return {
    flights: finished.length,
    nm,
    sm: nm * SM_PER_NM,
    hours,
    airports: airports.size,
    active: active.length,
    holding,
    dateMs: replayDateMs(playMs, window),
  };
}

/** Stable key for a tail, or for the city pair when the archive has no tail. */
export function showcaseColorKey(leg) {
  if (leg && typeof leg === 'object') {
    if (leg.tail) return leg.tail;
    return `${leg.from || ''}-${leg.to || ''}`;
  }
  return String(leg || '');
}

// One Skyway accent. The booth does not color routes by tail.
const BRAND_ARC = ['#3FA9CC', '#7EB6CC'];

export function showcaseTailPalette() {
  return { core: BRAND_ARC[0], edge: BRAND_ARC[1] };
}

export function showcaseTailColor(tail) {
  return showcaseTailPalette(tail).core;
}

function rad(deg) { return (deg * Math.PI) / 180; }
function deg(radian) { return (radian * 180) / Math.PI; }

function angularDistance(lat1, lon1, lat2, lon2) {
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Spherical interpolation. The fraction is along the great-circle arc. */
export function interpolateGreatCircle(a, b, fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  if (f === 0) return { lat: a.lat, lng: a.lng };
  if (f === 1) return { lat: b.lat, lng: b.lng };
  const lat1 = rad(a.lat);
  const lon1 = rad(a.lng);
  const lat2 = rad(b.lat);
  const lon2 = rad(b.lng);
  const distance = angularDistance(lat1, lon1, lat2, lon2);
  if (distance < 1e-8) return { lat: a.lat, lng: a.lng };
  const A = Math.sin((1 - f) * distance) / Math.sin(distance);
  const B = Math.sin(f * distance) / Math.sin(distance);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return {
    lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: deg(Math.atan2(y, x)),
  };
}

/** Initial great-circle bearing in degrees, clockwise from north. */
export function bearingDeg(a, b) {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δλ = rad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function sampleRoute(a, b, steps = SHOWCASE_ROUTE_SAMPLES) {
  const from = { lat: a.lat, lng: a.lng };
  const to = { lat: b.lat, lng: b.lng };
  const points = [];
  for (let i = 0; i <= steps; i += 1) points.push(interpolateGreatCircle(from, to, i / steps));
  return points;
}

export function pointAlong(samples, fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  const scaled = f * (samples.length - 1);
  const index = Math.min(samples.length - 2, Math.floor(scaled));
  const next = Math.min(samples.length - 1, index + 1);
  const local = scaled - index;
  const from = samples[Math.max(0, index)];
  const to = samples[next];
  return {
    lat: from.lat + (to.lat - from.lat) * local,
    lng: from.lng + (to.lng - from.lng) * local,
    heading: bearingDeg(from, to),
    index: next,
  };
}

export function legEndpoints(leg) {
  return {
    from: { lat: leg.fromLat, lng: leg.fromLng },
    to: { lat: leg.toLat, lng: leg.toLng },
  };
}
