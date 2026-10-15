// Pure helpers for the full-screen TV flight board (?board=1).
// The compact schedule card does not use this module.

import { lookupCoords } from './airport-coords.js';
import { buildFleetMapScene, fleetMarkerCallout, formatMarkerTime, readTripId } from './fleet-tracking.js';

export const TV_DESIGN_WIDTH = 1920;
export const TV_DESIGN_HEIGHT = 1080;
/** Header, then a map that keeps about two thirds of the width, then the day strip. */
export const TV_HEADER_PX = 56;
export const TV_PANEL_PX = 600;
export const OCC_ACCENT = '#2dd4bf';
export const TV_WX_REFRESH_MS = 5 * 60 * 1000;

const OCC_CATEGORY = {
  VFR: '#34d399',
  MVFR: '#60a5fa',
  IFR: '#f87171',
  LIFR: '#e879f9',
};

const CREW_STEPS = [
  { id: 'crew_onsite', label: 'CREW ONSITE' },
  { id: 'aircraft_ready', label: 'A/C READY' },
  { id: 'catering_aboard', label: 'CATERING' },
  { id: 'pax_arrived', label: 'PAX IN' },
  { id: 'pax_boarded', label: 'PAX BOARDED' },
  { id: 'taxi_dep', label: 'TAXI' },
];

const PHASE_LABEL = {
  pending: 'PENDING',
  preflight: 'PRE-FLT',
  airborne: 'AIRBORNE',
  landed: 'LANDED',
  completed: 'DONE',
};

/** CSS scale for the 1920×1080 frame: min(100vw/1920, 100vh/1080). */
export function tvBoardScale(viewportWidth, viewportHeight) {
  const width = Number(viewportWidth);
  const height = Number(viewportHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.min(width / TV_DESIGN_WIDTH, height / TV_DESIGN_HEIGHT);
}

/** Share of the 1920 frame given to the map. The panel is a fixed rail. */
export function occMapShare(frameWidth = TV_DESIGN_WIDTH, panelWidth = TV_PANEL_PX) {
  const width = Number(frameWidth) || TV_DESIGN_WIDTH;
  const panel = Math.max(0, Number(panelWidth) || 0);
  return (width - panel) / width;
}

/**
 * Compact Gantt under the map. Row height shrinks so every tail stays on
 * screen, and the strip itself stays short enough that the map remains the hero.
 */
export function occGanttMetrics(tailCount, { maxHeight = 200 } = {}) {
  const count = Math.max(0, Number(tailCount) || 0);
  if (count === 0) return { axis: 0, row: 0, height: 0 };
  const axis = 18;
  const row = Math.max(16, Math.min(22, Math.floor((maxHeight - axis) / count)));
  return { axis, row, height: axis + count * row };
}

/**
 * Pixel budget for the right rail. Airborne cards and departure rows shrink
 * so the stack never scrolls inside the frame.
 */
export function occPanelBudget({
  airborneCount = 0,
  departureCount = 0,
  tailCount = 0,
  height = 800,
} = {}) {
  const airN = Math.max(0, Number(airborneCount) || 0);
  const depN = Math.max(0, Number(departureCount) || 0);
  const tails = Math.max(0, Number(tailCount) || 0);
  const label = 22;
  const fleetCols = 4;
  const fleetRows = tails === 0 ? 0 : Math.max(1, Math.ceil(tails / fleetCols));
  const fleetRow = 24;
  const pad = 8;
  const fixed = label * 3 + fleetRows * fleetRow + pad;
  const room = Math.max(0, height - fixed);
  const airIdeal = 66;
  const depIdeal = 30;
  const airGap = 6;
  const airGaps = airN > 1 ? (airN - 1) * airGap : 0;
  let airCard = airN === 0 ? 0 : airIdeal;
  let depRow = depN === 0 ? 0 : depIdeal;
  let need = airN * airCard + airGaps + depN * depRow;
  if (need > room && need > 0) {
    const airNeed = airN * airIdeal + airGaps;
    if (depN > 0 && airNeed <= room) {
      depRow = Math.max(14, Math.floor((room - airNeed) / depN));
      airCard = airIdeal;
    } else {
      const scale = room / need;
      airCard = airN ? Math.max(32, Math.floor(airIdeal * scale)) : 0;
      depRow = depN ? Math.max(14, Math.floor(depIdeal * scale)) : 0;
    }
    let usedFlex = airN * airCard + airGaps + depN * depRow;
    if (usedFlex > room && depN > 0) {
      depRow = Math.max(14, Math.floor((room - airN * airCard - airGaps) / depN));
      usedFlex = airN * airCard + airGaps + depN * depRow;
    }
    if (usedFlex > room && airN > 0) {
      airCard = Math.max(28, Math.floor((room - depN * depRow - airGaps) / airN));
    }
  }
  let used = fixed + (airN * airCard) + airGaps + (depN * depRow);
  if (used > height && depN > 0) {
    depRow = Math.max(0, depRow - Math.ceil((used - height) / depN));
    used = fixed + (airN * airCard) + airGaps + (depN * depRow);
  }
  if (used > height && airN > 0) {
    airCard = Math.max(0, airCard - Math.ceil((used - height) / airN));
    used = fixed + (airN * airCard) + airGaps + (depN * depRow);
  }
  return { label, airCard, airGap, depRow, fleetRow, fleetCols, fleetRows, used, height, room };
}

/** Local wall clock, UTC, and Zulu. The zone name sits with the local clock. */
export function formatBoardClocks(now, timeZone) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return { local: '', utc: '', zulu: '', zone: '', day: '' };
  const localOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
  const utcOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' };
  const dayOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  if (timeZone) {
    localOptions.timeZone = timeZone;
    dayOptions.timeZone = timeZone;
  }
  let local = '';
  let utc = '';
  let day = '';
  let zone = 'LOCAL';
  try {
    local = date.toLocaleTimeString('en-US', localOptions);
    utc = date.toLocaleTimeString('en-US', utcOptions);
    day = date.toLocaleDateString('en-US', dayOptions);
    const named = date.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}),
    });
    zone = named.split(' ').pop() || zone;
  } catch {
    local = date.toLocaleTimeString('en-US', { ...localOptions, timeZone: 'UTC' });
    utc = date.toLocaleTimeString('en-US', utcOptions);
    day = date.toLocaleDateString('en-US', { ...dayOptions, timeZone: 'UTC' });
    zone = 'UTC';
  }
  const zulu = `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
  return { local, utc, zulu, zone, day };
}

/** 24-hour table time so ETD and ETA columns align. */
export function formatBoardTableTime(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (timeZone) options.timeZone = timeZone;
  try {
    return date.toLocaleTimeString('en-US', options);
  } catch {
    return date.toLocaleTimeString('en-US', { ...options, timeZone: 'UTC' });
  }
}

export function isTvBoardRequest(search = '') {
  try {
    const query = typeof search === 'string' ? search : String(search || '');
    return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query).get('board') === '1';
  } catch {
    return false;
  }
}

export function formatBoardClock(now, timeZone) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return '';
  const options = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  if (timeZone) options.timeZone = timeZone;
  try {
    return date.toLocaleString('en-US', options);
  } catch {
    return date.toLocaleString('en-US', { ...options, timeZone: 'UTC' });
  }
}

/** Latest logged pre-flight step, in checklist order. */
export function currentCrewStep(state) {
  const statuses = state?.statuses || {};
  let label = null;
  for (const step of CREW_STEPS) {
    if (statuses[step.id]) label = step.label;
  }
  return label;
}

function remainLabel(etaMs, now) {
  if (!Number.isFinite(etaMs)) return null;
  const remainMs = etaMs - now;
  if (remainMs <= 0) return 'landing';
  const hours = Math.floor(remainMs / 3_600_000);
  const minutes = Math.floor((remainMs % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Countdown to a departure. Due once the scheduled time has passed. */
export function formatDepartureCountdown(start, now) {
  const ms = new Date(start).getTime() - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'DUE';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return remain ? `${hours}h ${remain}m` : `${hours}h`;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function airborneProgress(trip, faPosition, now) {
  const reported = clampPercent(faPosition?.progressPercent);
  if (reported != null) return reported;
  const start = new Date(faPosition?.actualOff || trip?.start).getTime();
  const end = new Date(faPosition?.estimatedOn || trip?.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return clampPercent(((now - start) / (end - start)) * 100);
}

function formatOccAltitude(ft) {
  const n = Number(ft);
  if (!Number.isFinite(n)) return '';
  if (n >= 18000) return `FL${Math.round(n / 100)}`;
  return `${Math.round(n).toLocaleString()} ft`;
}

function formatOccSpeed(kt) {
  const n = Number(kt);
  return Number.isFinite(n) ? `${Math.round(n)} kt` : '';
}

/**
 * One fixed-height TV row. Trip identity is readTripId only — a numeric
 * trip number is never copied onto the row.
 */
export function buildTvBoardRow({
  trip,
  state = null,
  phase = 'pending',
  faPosition = null,
  now = Date.now(),
  timeZone,
} = {}) {
  const info = trip?.info || {};
  const tripId = readTripId(state, trip);
  const airborne = phase === 'airborne';
  const etaSource = airborne ? (faPosition?.estimatedOn || trip?.end || null) : null;
  const timeSource = airborne ? etaSource : trip?.start;
  const etaMs = etaSource ? new Date(etaSource).getTime() : NaN;
  const pax = Number(info.pax);
  return {
    uid: trip?.uid || null,
    phase,
    statusLabel: PHASE_LABEL[phase] || PHASE_LABEL.pending,
    stepLabel: phase === 'preflight' ? currentCrewStep(state) : null,
    timeLabel: formatMarkerTime(timeSource, timeZone),
    timeKind: airborne ? 'eta' : 'etd',
    etdLabel: formatBoardTableTime(airborne ? (faPosition?.actualOff || trip?.start) : trip?.start, timeZone),
    etaLabel: formatBoardTableTime(airborne ? (faPosition?.estimatedOn || trip?.end) : trip?.end, timeZone),
    remainLabel: airborne ? remainLabel(etaMs, now) : null,
    countdown: airborne ? null : formatDepartureCountdown(trip?.start, now),
    progress: airborne ? airborneProgress(trip, faPosition, now) : null,
    altitudeLabel: airborne ? formatOccAltitude(faPosition?.altitude) : '',
    speedLabel: airborne ? formatOccSpeed(faPosition?.groundspeed) : '',
    tail: info.tail || '',
    tripId,
    from: info.from || '',
    to: info.to || '',
    crew: [info.pic, info.sic].filter(Boolean),
    pax: Number.isFinite(pax) && pax > 0 ? pax : null,
  };
}

/** Shared fleet scene, with every bubble label forced on for the wall. */
export function buildTvMapScene(args) {
  const scene = buildFleetMapScene(args || {});
  return {
    ...scene,
    aircraft: (scene.aircraft || []).map((item) => ({ ...item, showLabel: true })),
  };
}

/** US 3-letter identifiers become the K-prefixed ICAO the weather API stores. */
export function normalizeBoardAirport(code) {
  const value = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!value) return null;
  if (value.length === 3 && /^[A-Z]{3}$/.test(value)) return `K${value}`;
  return value;
}

function formatBoardWind(dir, kt, gustKt) {
  if (kt == null || kt === '') return null;
  const speed = Number(kt);
  if (!Number.isFinite(speed)) return null;
  if (speed === 0) return 'CALM';
  const direction = dir != null && dir !== '' && Number.isFinite(Number(dir))
    ? `${String(dir).padStart(3, '0')}°`
    : 'VRB';
  const gust = Number(gustKt);
  const gustText = Number.isFinite(gust) && gust > speed ? ` G${gust}` : '';
  return `${direction}/${speed}kt${gustText}`;
}

/**
 * METAR line for the wall: flight category, wind, visibility, ceiling.
 * A missing ceiling is clear. Returns null when there is no observation.
 */
export function formatBoardWeather(metar) {
  if (!metar || typeof metar !== 'object') return null;
  const category = metar.flightCategory ? String(metar.flightCategory).toUpperCase() : null;
  const wind = formatBoardWind(metar.windDir, metar.windKt, metar.windGustKt);
  const visibility = metar.visibilitySm != null && metar.visibilitySm !== '' && Number.isFinite(Number(metar.visibilitySm))
    ? `${metar.visibilitySm} SM`
    : null;
  const hasCeiling = metar.ceilingFt != null && metar.ceilingFt !== '' && Number.isFinite(Number(metar.ceilingFt));
  const ceiling = hasCeiling ? `${metar.ceilingFt} ft` : (category || wind || visibility ? 'CLR' : null);
  if (!category && !wind && !visibility && !ceiling) return null;
  return {
    category,
    wind,
    visibility,
    ceiling,
    line: [category, wind, visibility, ceiling].filter(Boolean).join(' · '),
  };
}

/** Departure and arrival of every listed leg, plus each aircraft's weather airport. */
export function boardWeatherAirports(rows, cards) {
  const codes = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const from = normalizeBoardAirport(row?.from);
    const to = normalizeBoardAirport(row?.to);
    if (from) codes.add(from);
    if (to) codes.add(to);
  }
  for (const card of Array.isArray(cards) ? cards : []) {
    const airport = normalizeBoardAirport(card?.weatherAirport);
    if (airport) codes.add(airport);
  }
  return [...codes].sort();
}

/**
 * One managed tail for the aircraft strip. Trip identity is the same
 * readTripId path the map bubbles use. Weather is the airport the aircraft
 * is at, or the next airport when it is airborne or its position is unknown.
 */
export function buildTvAircraftCard({
  tail,
  telemetry = null,
  trips = [],
  tripStates = null,
  now = Date.now(),
  timeZone,
} = {}) {
  const callout = fleetMarkerCallout({
    tail, telemetry, trips, tripStates, now, timeZone,
  });
  const airborne = telemetry?.airborne === true;
  const upcoming = (Array.isArray(trips) ? trips : [])
    .filter((trip) => String(trip?.info?.tail || '').toUpperCase() === String(tail || '').toUpperCase())
    .filter((trip) => {
      const start = new Date(trip.start).getTime();
      return Number.isFinite(start) && start > now;
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
  const nextAirport = upcoming?.info?.from || null;
  const currentAirport = telemetry?.groundedAt || telemetry?.lastKnownAirport || null;
  const location = airborne
    ? (callout.destination || telemetry?.destination || null)
    : (currentAirport || nextAirport);
  return {
    tail: tail || '',
    statusLabel: airborne ? 'AIRBORNE' : 'ON GROUND',
    location: location ? String(location).trim().toUpperCase() : '',
    timeKind: airborne ? 'eta' : 'etd',
    timeLabel: airborne ? callout.etaLabel : callout.departureLabel,
    tripId: callout.tripId,
    weatherAirport: normalizeBoardAirport(location),
  };
}

function airportLatLon(code) {
  const point = lookupCoords(code);
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return { lat: point.lat, lon: point.lng };
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/** Spherical arc between two {lat, lon} points, as [lat, lon] pairs. */
export function greatCircleArc(from, to, steps = 32) {
  if (!from || !to) return [];
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);
  const lat2 = toRad(to.lat);
  const lon2 = toRad(to.lon);
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
  )));
  if (!Number.isFinite(d) || d === 0) return [[from.lat, from.lon], [to.lat, to.lon]];
  const points = [];
  const count = Math.max(2, steps);
  for (let i = 0; i <= count; i += 1) {
    const f = i / count;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);
    points.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  return points;
}

/**
 * Today's legs as great-circle routes. Airborne legs are solid up to the
 * aircraft and dashed onward. Upcoming legs are dashed. Landed legs are a
 * muted solid.
 */
export function buildOccRoutes({ trips = [], phaseOf, aircraft = [] } = {}) {
  const routes = [];
  for (const trip of trips) {
    const from = airportLatLon(trip?.info?.from);
    const to = airportLatLon(trip?.info?.to);
    if (!from || !to) continue;
    const phase = typeof phaseOf === 'function' ? phaseOf(trip) : 'pending';
    const tail = String(trip?.info?.tail || '').toUpperCase();
    const live = (aircraft || []).find((item) => item.airborne === true && String(item.tail || '').toUpperCase() === tail);
    if (phase === 'airborne' && live && Number.isFinite(live.lat) && Number.isFinite(live.lon)) {
      const here = { lat: live.lat, lon: live.lon };
      routes.push({
        points: greatCircleArc(from, here),
        color: OCC_ACCENT,
        weight: 2.25,
        opacity: 0.95,
        dashed: false,
      });
      routes.push({
        points: greatCircleArc(here, to),
        color: OCC_ACCENT,
        weight: 2,
        opacity: 0.8,
        dashed: true,
      });
    } else if (phase === 'landed' || phase === 'completed') {
      routes.push({
        points: greatCircleArc(from, to, 24),
        color: '#94a3b8',
        weight: 1.5,
        opacity: 0.32,
        dashed: false,
      });
    } else {
      routes.push({
        points: greatCircleArc(from, to, 24),
        color: OCC_ACCENT,
        weight: 1.5,
        opacity: 0.5,
        dashed: true,
      });
    }
  }
  return routes;
}

/** One flight-category dot per airport on today's legs. */
export function buildOccAirports(trips, weather) {
  const seen = new Map();
  for (const trip of Array.isArray(trips) ? trips : []) {
    for (const raw of [trip?.info?.from, trip?.info?.to]) {
      const code = normalizeBoardAirport(raw);
      if (!code || seen.has(code)) continue;
      const point = airportLatLon(code);
      if (!point) continue;
      const payload = weather?.[code];
      const metar = payload?.metar || payload?.parsed || payload;
      const wx = formatBoardWeather(metar);
      seen.set(code, {
        code,
        lat: point.lat,
        lon: point.lon,
        tone: 'neutral',
        small: true,
        category: wx?.category || null,
        color: OCC_CATEGORY[wx?.category] || '#8b9aab',
      });
    }
  }
  return [...seen.values()];
}

function zonedOffsetMs(utcMs, timeZone) {
  const date = new Date(utcMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return asUtc - utcMs;
}

/** Midnight-to-midnight window in the board timezone. */
export function boardDayBounds(now, timeZone) {
  const date = new Date(now);
  const zone = timeZone || 'UTC';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
  }
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  const utcGuess = Date.UTC(pick('year'), pick('month') - 1, pick('day'), 0, 0, 0);
  const startMs = utcGuess - zonedOffsetMs(utcGuess, zone);
  return { startMs, endMs: startMs + 86_400_000 };
}

/**
 * One horizontal bar per leg, grouped by tail, across the local day.
 * `nowRatio` places the current-time line.
 */
function stateForTimeline(tripStates, uid) {
  if (!tripStates || !uid) return null;
  if (typeof tripStates.get === 'function') return tripStates.get(uid) || null;
  return tripStates[uid] || null;
}

export function buildOccTimeline({
  tails = [],
  trips = [],
  tripStates = null,
  phaseOf,
  now = Date.now(),
  timeZone,
} = {}) {
  const { startMs, endMs } = boardDayBounds(now, timeZone);
  const span = endMs - startMs;
  const clamp = (ms) => Math.min(endMs, Math.max(startMs, ms));
  const rows = (Array.isArray(tails) ? tails : []).map((tail) => {
    const key = String(tail || '').toUpperCase();
    const bars = (Array.isArray(trips) ? trips : [])
      .filter((trip) => String(trip?.info?.tail || '').toUpperCase() === key)
      .map((trip) => {
        const start = new Date(trip.start).getTime();
        const endRaw = new Date(trip.end).getTime();
        const end = Number.isFinite(endRaw) ? endRaw : start + 60 * 60_000;
        if (!Number.isFinite(start)) return null;
        const leftMs = clamp(start);
        const rightMs = clamp(Math.max(end, start + 60_000));
        return {
          uid: trip.uid || `${key}-${start}`,
          tripId: readTripId(stateForTimeline(tripStates, trip.uid), trip),
          from: trip?.info?.from || '',
          to: trip?.info?.to || '',
          phase: typeof phaseOf === 'function' ? phaseOf(trip) : 'pending',
          left: (leftMs - startMs) / span,
          width: Math.max(0.008, (rightMs - leftMs) / span),
        };
      })
      .filter(Boolean);
    return { tail: key, bars };
  });
  const nowRatio = Math.min(1, Math.max(0, (now - startMs) / span));
  const ticks = [0, 6, 12, 18].map((hour) => ({
    label: String(hour).padStart(2, '0'),
    ratio: hour / 24,
  }));
  return { startMs, endMs, nowRatio, ticks, rows };
}
