// Pure helpers for the full-screen TV flight board (?board=1).
// The compact schedule card does not use this module.

import { buildFleetMapScene, fleetMarkerCallout, formatMarkerTime, readTripId } from './fleet-tracking.js';

export const TV_DESIGN_WIDTH = 1920;
export const TV_DESIGN_HEIGHT = 1080;
export const TV_HEADER_PX = 80;
export const TV_STRIP_ROW_PX = 96;
export const TV_STRIP_MIN_CARD = 220;
/** Primary type never drops below this, so a packed day is still readable across the room. */
export const TV_FONT_FLOOR = 16;
export const TV_WX_REFRESH_MS = 5 * 60 * 1000;

export const TV_DENSITY = {
  lg: { time: 30, route: 26, tail: 26, meta: 16, wx: 15, status: 15, minRow: 100 },
  md: { time: 22, route: 20, tail: 20, meta: 14, wx: 13, status: 13, minRow: 72 },
  sm: { time: TV_FONT_FLOOR, route: TV_FONT_FLOOR, tail: TV_FONT_FLOOR, meta: 12, wx: 12, status: 12, minRow: 56 },
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

/** One row of aircraft cards across the 1920 frame, wrapping only when the fleet exceeds it. */
export function tvAircraftStrip(tailCount, frameWidth = TV_DESIGN_WIDTH) {
  const count = Math.max(0, Number(tailCount) || 0);
  if (count === 0) return { perRow: 1, rows: 0, rowHeight: 0, height: 0 };
  const perRow = Math.max(1, Math.min(count, Math.floor(frameWidth / TV_STRIP_MIN_CARD)));
  const rows = Math.ceil(count / perRow);
  return { perRow, rows, rowHeight: TV_STRIP_ROW_PX, height: rows * TV_STRIP_ROW_PX };
}

/** Pixels left for the leg list after the header and the aircraft strip. */
export function tvListHeight(tailCount, frameHeight = TV_DESIGN_HEIGHT) {
  return frameHeight - TV_HEADER_PX - tvAircraftStrip(tailCount).height;
}

/**
 * Fit every leg on one screen. A short list stays one column with large type.
 * A long list becomes two columns and the row height shrinks to the count.
 * There is no leftover page and no scroll.
 */
export function tvLegLayout(legCount, listHeight) {
  const count = Math.max(0, Number(legCount) || 0);
  const height = Math.max(1, Number(listHeight) || 1);
  if (count === 0) {
    return { columns: 1, rows: 1, rowHeight: height, density: TV_DENSITY.lg };
  }
  const singleHeight = height / count;
  if (singleHeight >= TV_DENSITY.lg.minRow) {
    return {
      columns: 1,
      rows: count,
      rowHeight: Math.min(singleHeight, 148),
      density: TV_DENSITY.lg,
    };
  }
  const rows = Math.ceil(count / 2);
  const rowHeight = height / rows;
  const density = rowHeight >= TV_DENSITY.lg.minRow
    ? TV_DENSITY.lg
    : rowHeight >= TV_DENSITY.md.minRow
      ? TV_DENSITY.md
      : TV_DENSITY.sm;
  return { columns: 2, rows, rowHeight, density };
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
    remainLabel: airborne ? remainLabel(etaMs, now) : null,
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
