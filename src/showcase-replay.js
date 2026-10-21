// Year-to-date trade-show replay.
//
// Pure schedule, geometry, and privacy projection. The browser page and the
// public API both go through this module so a leg can only reach the TV with
// the fields listed in PUBLIC_LEG_KEYS.
//
// The JetInsight feed window (retainRelevantLegs) is about three days back
// and 21 days ahead. /api/schedule-legs-cron merge-writes that window into
// legs/{uid} and does not delete older documents, so the collection is the
// archive. Flights that left the feed before a cron run observed them are
// not stored. Playback uses whatever completed legs exist.

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
export const SHOWCASE_ROUTE_SAMPLES = 48;
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
  const abbreviated = Number.isFinite(storedFrom) && (storedFrom - safeStart) > SHOWCASE_ABBREVIATE_GAP_MS;
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
    return {
      ...leg,
      playStart,
      playEnd: playStart + playDur,
      blockHours: Math.max(0, (arrival - departure) / 3_600_000),
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

function ranked(map, limit = 5) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

/**
 * Counters and panels for the legs that have finished by `playMs`.
 * `place(code, lat, lng)` returns `{ country, state }`.
 */
export function showcaseSnapshot(scheduled, playMs, place, window) {
  const { active, finished, holding } = frameActors(scheduled, playMs);
  let nm = 0;
  let hours = 0;
  const airports = new Set();
  const states = new Set();
  const countries = new Set();
  const destinations = new Map();
  const routes = new Map();
  const tails = new Map();
  const remember = (code, lat, lng) => {
    if (!code) return;
    airports.add(code);
    const hit = typeof place === 'function' ? place(code, lat, lng) : null;
    if (hit?.state) states.add(hit.state);
    if (hit?.country) countries.add(hit.country);
  };
  for (const leg of finished) {
    nm += leg.nm || 0;
    hours += leg.blockHours || 0;
    remember(leg.from, leg.fromLat, leg.fromLng);
    remember(leg.to, leg.toLat, leg.toLng);
    destinations.set(leg.to, (destinations.get(leg.to) || 0) + 1);
    const route = `${leg.from} → ${leg.to}`;
    routes.set(route, (routes.get(route) || 0) + 1);
    tails.set(leg.tail, (tails.get(leg.tail) || 0) + 1);
  }
  for (const leg of active) tails.set(leg.tail, tails.get(leg.tail) || 0);
  return {
    flights: finished.length,
    nm,
    sm: nm * SM_PER_NM,
    hours,
    airports: airports.size,
    states: states.size,
    countries: countries.size,
    active: active.length,
    holding,
    dateMs: replayDateMs(playMs, window),
    topDestinations: ranked(destinations),
    topRoutes: ranked(routes),
    tails: [...tails.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([tail, count]) => ({ tail, count, color: showcaseTailColor(tail) })),
  };
}

const TAIL_COLORS = ['#5eead4', '#7dd3fc', '#c4b5fd', '#fcd34d', '#fda4af', '#86efac'];

export function showcaseTailColor(tail) {
  let hash = 0;
  const text = String(tail || '');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  return TAIL_COLORS[hash % TAIL_COLORS.length];
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
