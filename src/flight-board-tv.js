// Pure helpers for the full-screen TV flight board (?board=1).
// The compact schedule card does not use this module.

import { lookupCoords } from './airport-coords.js';
import { positionSaysAirborne } from './flightaware-active.js';
import { buildFleetMapScene, fleetMarkerCallout, formatMarkerTime, readTripId } from './fleet-tracking.js';
import {
  activeWheelsUpAt,
  airborneEta,
  airborneProgressPct,
  etaInstant,
} from './leg-event-time.js';

/** A departure this close to its ETD is treated as out, matching the office TV. */
export const BOARD_AIRBORNE_EARLY_MS = 40 * 60 * 1000;
const BOARD_AIRBORNE_LATE_MS = 45 * 60 * 1000;

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
export function occGanttMetrics(tailCount, { maxHeight = 320 } = {}) {
  const count = Math.max(0, Number(tailCount) || 0);
  if (count === 0) return { axis: 0, row: 0, height: 0, label: 0 };
  const axis = 28;
  const row = Math.max(30, Math.min(40, Math.floor((maxHeight - axis) / count)));
  return { axis, row, height: axis + count * row, label: 124 };
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
  const label = 26;
  const fleetCols = 4;
  const fleetRows = tails === 0 ? 0 : Math.max(1, Math.ceil(tails / fleetCols));
  const fleetRow = 26;
  const pad = 8;
  const fixed = label * 3 + fleetRows * fleetRow + pad;
  const room = Math.max(0, height - fixed);
  const airIdeal = 96;
  const depIdeal = 32;
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

function airborneProgress(trip, faPosition, now, state = null) {
  const wheelsUpAt = activeWheelsUpAt(state) || faPosition?.actualOff || trip?.start;
  const eta = airborneEta({
    flightAware: faPosition,
    wheelsUpAt,
    scheduledStart: trip?.start,
    scheduledEnd: trip?.end,
    to: trip?.info?.to,
  });
  const pct = airborneProgressPct({
    now,
    wheelsUpAt,
    etaMs: eta.etaMs,
    reportedPercent: faPosition?.progressPercent,
  });
  if (pct == null) return null;
  return clampPercent(pct);
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
  const wheelsUpAt = activeWheelsUpAt(state) || faPosition?.actualOff || null;
  const eta = airborne
    ? airborneEta({
      flightAware: faPosition,
      wheelsUpAt,
      scheduledStart: trip?.start,
      scheduledEnd: trip?.end,
      to: info.to,
    })
    : { etaMs: null, iso: null, source: null };
  const etaSource = airborne ? etaInstant(eta) : null;
  const timeSource = airborne ? etaSource : trip?.start;
  const etaMs = eta.etaMs;
  const pax = Number(info.pax);
  return {
    uid: trip?.uid || null,
    phase,
    statusLabel: PHASE_LABEL[phase] || PHASE_LABEL.pending,
    stepLabel: phase === 'preflight' ? currentCrewStep(state) : null,
    timeLabel: formatMarkerTime(timeSource, timeZone),
    timeKind: airborne ? 'eta' : 'etd',
    etdLabel: formatBoardTableTime(airborne ? (wheelsUpAt || trip?.start) : trip?.start, timeZone),
    etaLabel: formatBoardTableTime(airborne ? (etaSource || trip?.end) : trip?.end, timeZone),
    etaSource: airborne ? eta.source : null,
    remainLabel: airborne ? remainLabel(etaMs, now) : null,
    countdown: airborne ? null : formatDepartureCountdown(trip?.start, now),
    progress: airborne ? airborneProgress(trip, faPosition, now, state) : null,
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

function boardAirportsMatch(a, b) {
  const left = String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const right = String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!left || !right) return false;
  if (left === right) return true;
  const strip = (code) => (code.length === 4 && code.startsWith('K') ? code.slice(1) : code);
  return strip(left) === strip(right);
}

function boardState(tripStates, uid) {
  if (!tripStates || !uid) return null;
  if (typeof tripStates.get === 'function') return tripStates.get(uid) || null;
  return tripStates[uid] || null;
}

function boardLegTimes(trip) {
  const start = new Date(trip?.start).getTime();
  const endRaw = new Date(trip?.end).getTime();
  const end = Number.isFinite(endRaw) ? endRaw : (Number.isFinite(start) ? start + 2.5 * 3_600_000 : NaN);
  return { start, end };
}

function legHasLanded(state) {
  return Boolean(state?.completed || state?.archived || state?.statuses?.landed);
}

/**
 * One airborne leg per tail.
 *
 * FlightAware's boolean is not required. A leg inside its block, up to 40
 * minutes before ETD, or still inside 45 minutes after the scheduled arrival
 * is airborne unless the crew or FlightAware has recorded the landing.
 * That is the case the office TV showed as "N341CJ GYH ETD 9:00" at 8:37.
 */
export function boardAirbornePlan({ trips = [], positions = {}, tripStates = null, now = Date.now() } = {}) {
  const byTail = new Map();
  for (const trip of trips) {
    const tail = String(trip?.info?.tail || '').toUpperCase();
    if (!tail) continue;
    if (!byTail.has(tail)) byTail.set(tail, []);
    byTail.get(tail).push(trip);
  }
  const chosen = new Map();
  for (const [tail, legs] of byTail) {
    const fa = positions?.[tail] || null;
    const evidence = positionSaysAirborne(fa);
    const landedAfterStart = (trip) => {
      const { start } = boardLegTimes(trip);
      const on = new Date(fa?.actualOn).getTime();
      return Number.isFinite(on) && Number.isFinite(start) && on >= start;
    };
    const scored = legs
      .filter((trip) => !legHasLanded(boardState(tripStates, trip.uid)))
      .filter((trip) => !landedAfterStart(trip))
      .map((trip) => {
        const { start, end } = boardLegTimes(trip);
        const inBlock = Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
        const early = Number.isFinite(start) && now >= start - BOARD_AIRBORNE_EARLY_MS && now < start;
        const late = Number.isFinite(end) && now >= end && now < end + BOARD_AIRBORNE_LATE_MS;
        let score = 0;
        if (evidence && boardAirportsMatch(trip?.info?.from, fa?.origin)) score += 100;
        if (evidence && boardAirportsMatch(trip?.info?.to, fa?.destination)) score += 40;
        if (inBlock) score += 50;
        if (early) score += 20;
        if (late) score += 25;
        return { trip, score, start };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Math.abs((a.start || 0) - now) - Math.abs((b.start || 0) - now));
    if (scored[0]) chosen.set(tail, scored[0].trip);
  }
  return chosen;
}

/** Phase for one leg once boardAirbornePlan has picked the flying leg. */
export function boardLegPhase({ trip, stepPhase = 'pending', airborneTrip = null, now = Date.now() } = {}) {
  if (stepPhase === 'completed' || stepPhase === 'landed') return stepPhase;
  if (airborneTrip && trip?.uid && airborneTrip.uid === trip.uid) return 'airborne';
  const { start, end } = boardLegTimes(trip);
  // The block is over and this leg was not the one still being flown.
  if (Number.isFinite(end) && now >= end + BOARD_AIRBORNE_LATE_MS) return 'landed';
  // wheels_up on a leg the plan did not pick is not a second flying airplane.
  if (stepPhase === 'airborne') {
    if (Number.isFinite(end) && now >= end) return 'landed';
    if (Number.isFinite(start) && now < start) return 'preflight';
  }
  if ((stepPhase === 'pending' || stepPhase === 'preflight' || stepPhase === 'airborne') && Number.isFinite(start) && now > start + 15 * 60_000) {
    return 'delayed';
  }
  return stepPhase === 'airborne' ? 'preflight' : (stepPhase || 'pending');
}

function pointOnArc(from, to, fraction) {
  const arc = greatCircleArc(from, to, 24);
  if (arc.length === 0) return null;
  const index = Math.max(0, Math.min(arc.length - 1, Math.round(fraction * (arc.length - 1))));
  return { lat: arc[index][0], lon: arc[index][1] };
}

function routeBearing(from, to) {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Promote the planned airborne tails on a fleet scene. When FlightAware has
 * no live coordinate, the icon rides the great-circle at the elapsed fraction
 * instead of sitting on the departure airport with an ETD tag.
 */
export function placeBoardAircraft(aircraft, {
  plan,
  positions = {},
  tripStates = null,
  now = Date.now(),
  timeZone,
} = {}) {
  const list = Array.isArray(aircraft) ? aircraft.map((item) => ({ ...item })) : [];
  const byTail = new Map(list.map((item) => [String(item.tail || '').toUpperCase(), item]));
  for (const [tail, trip] of plan || []) {
    const from = airportLatLon(trip?.info?.from);
    const to = airportLatLon(trip?.info?.to);
    const fa = positions?.[tail] || null;
    const { start, end } = boardLegTimes(trip);
    const legState = boardState(tripStates, trip?.uid);
    const wheelsUpAt = activeWheelsUpAt(legState) || fa?.actualOff || null;
    const eta = airborneEta({
      flightAware: fa,
      wheelsUpAt,
      scheduledStart: trip?.start,
      scheduledEnd: trip?.end,
      to: trip?.info?.to,
    });
    const progressStart = wheelsUpAt ? new Date(wheelsUpAt).getTime() : start;
    const progressEnd = eta.etaMs || end;
    const elapsed = Number.isFinite(progressStart) && Number.isFinite(progressEnd) && progressEnd > progressStart
      ? Math.max(0.04, Math.min(0.96, (now - progressStart) / (progressEnd - progressStart)))
      : 0.35;
    const reported = Number(fa?.progressPercent);
    const fraction = Number.isFinite(reported) ? Math.max(0.04, Math.min(0.96, reported / 100)) : elapsed;
    const live = positionSaysAirborne(fa)
      && Number.isFinite(Number(fa?.latitude))
      && Number.isFinite(Number(fa?.longitude))
      ? { lat: Number(fa.latitude), lon: Number(fa.longitude) }
      : null;
    const here = live || (from && to ? pointOnArc(from, to, fraction) : null);
    const etaSource = etaInstant(eta) || trip?.end || null;
    const etaMs = eta.etaMs ?? new Date(trip?.end).getTime();
    let marker = byTail.get(tail);
    if (!marker && here) {
      marker = { id: tail, tail, showLabel: true };
      list.push(marker);
      byTail.set(tail, marker);
    }
    if (!marker || !here) continue;
    marker.lat = here.lat;
    marker.lon = here.lon;
    marker.airborne = true;
    marker.heading = Number.isFinite(Number(fa?.heading)) ? Number(fa.heading) : (from && to ? routeBearing(from, to) : marker.heading || 0);
    marker.altitude = Number.isFinite(Number(fa?.altitude)) ? Number(fa.altitude) : marker.altitude;
    marker.groundspeed = Number.isFinite(Number(fa?.groundspeed)) ? Number(fa.groundspeed) : marker.groundspeed;
    marker.origin = trip?.info?.from ? String(trip.info.from).toUpperCase() : null;
    marker.destination = (fa?.destination || trip?.info?.to || marker.destination || '')
      ? String(fa?.destination || trip?.info?.to || '').toUpperCase()
      : null;
    marker.tripId = readTripId(boardState(tripStates, trip?.uid), trip) || marker.tripId;
    marker.etaLabel = formatMarkerTime(etaSource, timeZone);
    marker.remainLabel = Number.isFinite(etaMs) ? remainLabel(etaMs, now) : null;
    marker.departureLabel = null;
    marker.progress = Math.round(fraction * 100);
  }
  return list;
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
        color: '#34d399',
        weight: 3.5,
        opacity: 1,
        dashed: false,
      });
      routes.push({
        points: greatCircleArc(here, to),
        color: '#34d399',
        weight: 2.5,
        opacity: 0.9,
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
        weight: 1.75,
        opacity: 0.62,
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
        hideCode: true,
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

function timelineHourLabel(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour: 'numeric',
      hour12: true,
    }).formatToParts(new Date(ms));
    const hour = parts.find((part) => part.type === 'hour')?.value || '';
    const period = (parts.find((part) => part.type === 'dayPeriod')?.value || '').toLowerCase();
    return `${hour}${period.startsWith('a') ? 'a' : 'p'}`;
  } catch {
    return `${new Date(ms).getUTCHours()}z`;
  }
}

function timelineClock(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/**
 * Visible day strip. Starts two hours ago and runs ten hours ahead, then
 * grows just enough to include today's legs so the right side is not an
 * empty half of a 24-hour axis.
 */
export function occTimelineWindow({ trips = [], now = Date.now() } = {}) {
  let startMs = now - 2 * 3_600_000;
  let endMs = now + 10 * 3_600_000;
  for (const trip of trips) {
    const { start, end } = boardLegTimes(trip);
    if (Number.isFinite(start)) startMs = Math.min(startMs, start - 30 * 60_000);
    if (Number.isFinite(end)) endMs = Math.max(endMs, end + 30 * 60_000);
    else if (Number.isFinite(start)) endMs = Math.max(endMs, start + 60 * 60_000);
  }
  if (endMs - startMs > 16 * 3_600_000) {
    startMs = now - 2 * 3_600_000;
    endMs = now + 10 * 3_600_000;
    for (const trip of trips) {
      const { start, end } = boardLegTimes(trip);
      if (Number.isFinite(start) && start < endMs && (end || start) > startMs) {
        startMs = Math.min(startMs, start - 20 * 60_000);
        endMs = Math.max(endMs, (Number.isFinite(end) ? end : start + 3_600_000) + 20 * 60_000);
      }
    }
  }
  return { startMs, endMs };
}

/**
 * One horizontal bar per leg, grouped by tail, across the operating window.
 * `nowRatio` places the current-time line.
 */
export function buildOccTimeline({
  tails = [],
  trips = [],
  tripStates = null,
  phaseOf,
  now = Date.now(),
  timeZone,
} = {}) {
  const { startMs, endMs } = occTimelineWindow({ trips, now });
  const span = Math.max(1, endMs - startMs);
  const clamp = (ms) => Math.min(endMs, Math.max(startMs, ms));
  const rows = (Array.isArray(tails) ? tails : []).map((tail) => {
    const key = String(tail || '').toUpperCase();
    const bars = (Array.isArray(trips) ? trips : [])
      .filter((trip) => String(trip?.info?.tail || '').toUpperCase() === key)
      .map((trip) => {
        const { start, end } = boardLegTimes(trip);
        if (!Number.isFinite(start)) return null;
        const finish = Number.isFinite(end) ? end : start + 60 * 60_000;
        const leftMs = clamp(start);
        const rightMs = clamp(Math.max(finish, start + 60_000));
        if (rightMs <= startMs || leftMs >= endMs) return null;
        const phase = typeof phaseOf === 'function' ? phaseOf(trip) : 'pending';
        const progress = phase === 'airborne' && finish > start
          ? Math.max(0.08, Math.min(0.98, (now - start) / (finish - start)))
          : (phase === 'landed' || phase === 'completed' ? 1 : 0);
        return {
          uid: trip.uid || `${key}-${start}`,
          tripId: readTripId(boardState(tripStates, trip.uid), trip),
          from: trip?.info?.from || '',
          to: trip?.info?.to || '',
          phase,
          left: (leftMs - startMs) / span,
          width: Math.max(0.02, (rightMs - leftMs) / span),
          progress,
        };
      })
      .filter(Boolean);
    return { tail: key, bars };
  });
  const ticks = [];
  const firstHour = Math.ceil(startMs / 3_600_000) * 3_600_000;
  for (let ms = firstHour; ms < endMs; ms += 3_600_000) {
    ticks.push({ label: timelineHourLabel(ms, timeZone), ratio: (ms - startMs) / span, ms });
  }
  return {
    startMs,
    endMs,
    nowRatio: Math.min(1, Math.max(0, (now - startMs) / span)),
    nowLabel: timelineClock(now, timeZone),
    ticks,
    rows,
  };
}
