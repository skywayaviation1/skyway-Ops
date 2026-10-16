// View model for the single-flight tracking screen.
//
// Pure on purpose: the glass panels render this object and nothing else, so
// a missing trip id, cabin class, or broker number cannot be invented in the
// component. Trip IDs come only from readTripId.

import { formatLocalDate, formatLocalTime } from './airports.js';
import { readTripId, selectFlightLeg } from './fleet-tracking.js';

const CITIES = {
  ACK: 'Nantucket', APF: 'Naples', ASE: 'Aspen', ATL: 'Atlanta', AUS: 'Austin',
  BED: 'Bedford', BJI: 'Bemidji', BNA: 'Nashville', BOS: 'Boston', BUR: 'Burbank',
  CHS: 'Charleston', CLE: 'Cleveland', CLT: 'Charlotte', CMH: 'Columbus',
  CVG: 'Cincinnati', DAL: 'Dallas', DCA: 'Washington', DEN: 'Denver',
  DFW: 'Dallas', DTW: 'Detroit', EGE: 'Eagle', EWR: 'Newark', EYW: 'Key West',
  FLL: 'Fort Lauderdale', FXE: 'Fort Lauderdale', GON: 'Groton', HND: 'Las Vegas',
  HOU: 'Houston', HPN: 'White Plains', HYA: 'Hyannis', IAD: 'Dulles',
  IAH: 'Houston', IND: 'Indianapolis', INT: 'Winston-Salem', JAC: 'Jackson',
  JAX: 'Jacksonville', JFK: 'New York', LAS: 'Las Vegas', LAX: 'Los Angeles',
  LGA: 'New York', MCI: 'Kansas City', MCO: 'Orlando', MDW: 'Chicago',
  MIA: 'Miami', MMU: 'Morristown', MSP: 'Minneapolis', MSO: 'Missoula',
  MTH: 'Marathon', OAK: 'Oakland', OKC: 'Oklahoma City', OPF: 'Miami',
  ORD: 'Chicago', PBI: 'West Palm Beach', PDK: 'Atlanta', PHX: 'Phoenix',
  PVU: 'Provo', PWK: 'Chicago', SAN: 'San Diego', SAT: 'San Antonio',
  SAV: 'Savannah', SDL: 'Scottsdale', SFB: 'Orlando', SFO: 'San Francisco',
  SJC: 'San Jose', SLC: 'Salt Lake City', SNA: 'Santa Ana', STL: 'St Louis',
  TEB: 'Teterboro', TPA: 'Tampa', TRK: 'Truckee', TVC: 'Traverse City',
  VNY: 'Van Nuys',
  MYNN: 'Nassau', MYAM: 'Marsh Harbour', MYEH: 'Eleuthera', MYEM: 'Eleuthera',
  MYGF: 'Freeport', MUHA: 'Havana', MWCR: 'Grand Cayman',
};

const TIMELINE_STEPS = [
  { id: 'crew_onsite', label: 'Crew onsite' },
  { id: 'aircraft_ready', label: 'Aircraft ready' },
  { id: 'catering_aboard', label: 'Catering aboard' },
  { id: 'pax_arrived', label: 'Passengers arrived' },
  { id: 'pax_boarded', label: 'Passengers boarded' },
  { id: 'taxi_dep', label: 'Taxi out' },
  { id: 'wheels_up', label: 'Wheels up' },
  { id: 'landed', label: 'Landed' },
];

function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function bare(code) {
  const value = String(code || '').trim().toUpperCase();
  if (!value) return '';
  return value.length === 4 && value.startsWith('K') ? value.slice(1) : value;
}

export function airportCity(code, explicit) {
  const named = String(explicit || '').trim();
  if (named) return named;
  const raw = String(code || '').trim().toUpperCase();
  if (!raw) return null;
  return CITIES[raw] || CITIES[bare(raw)] || null;
}

export function airportClock(value, code) {
  const ms = toMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  try {
    const { time, tz } = formatLocalTime(date, code);
    const day = formatLocalDate(date, code);
    return {
      ms,
      date: day,
      time,
      tz: tz || '',
      label: `${time}${tz ? ` ${tz}` : ''}`,
    };
  } catch {
    return null;
  }
}

export function formatSpan(ms) {
  if (!Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function eventAt(statuses, id) {
  if (!statuses || typeof statuses !== 'object') return null;
  const direct = statuses[id];
  const directMs = toMs(direct?.timestamp ?? direct?.at ?? direct?.ts);
  if (directMs != null) return directMs;
  for (const value of Object.values(statuses)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const nested = value[id];
    const nestedMs = toMs(nested?.timestamp ?? nested?.at ?? nested?.ts);
    if (nestedMs != null) return nestedMs;
  }
  return null;
}

export function aloftLevel(levels, altitudeFt) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const target = Number.isFinite(altitudeFt) ? altitudeFt : 35000;
  return levels.reduce((best, level) => {
    if (!level || !Number.isFinite(level.altitude)) return best;
    if (!best) return level;
    return Math.abs(level.altitude - target) < Math.abs(best.altitude - target) ? level : best;
  }, null);
}

function stateFor(tripStates, uid) {
  if (!tripStates || !uid) return null;
  if (typeof tripStates.get === 'function') return tripStates.get(uid) || null;
  return tripStates[uid] || null;
}

/**
 * One object the detail chrome can render. `tripId` is readTripId's answer
 * and nothing else. Segment id is the parsed trip-sheet flight number.
 */
export function buildFlightViewModel({
  tail,
  telemetry = null,
  trips = [],
  tripStates = null,
  aircraftMeta = null,
  detail = null,
  now = Date.now(),
  operatorName = '',
} = {}) {
  const leg = selectFlightLeg(tail, trips, telemetry, now);
  const tripState = stateFor(tripStates, leg?.uid);
  const airborne = telemetry?.airborne === true || (detail?.actualOff && !detail?.actualOn);
  const landed = !airborne && Boolean(detail?.actualOn || telemetry?.actualOn);
  const scheduled = !airborne && !landed && leg && (toMs(leg.start) || 0) > now;

  const originCode = (airborne || telemetry?.origin)
    ? (telemetry?.origin || detail?.origin?.code || leg?.info?.from || null)
    : (telemetry?.lastOrigin || telemetry?.groundedAt || leg?.info?.from || null);
  const destinationCode = airborne
    ? (telemetry?.destination || detail?.destination?.code || leg?.info?.to || null)
    : (telemetry?.groundedAt || telemetry?.destination || detail?.destination?.code || leg?.info?.to || null);

  const departInstant = airborne
    ? (telemetry?.actualOff || detail?.actualOff || leg?.start)
    : (detail?.actualOff || detail?.scheduledOff || leg?.start);
  const arriveInstant = airborne
    ? (telemetry?.estimatedOn || detail?.estimatedOn || detail?.scheduledOn || leg?.end)
    : (detail?.actualOn || telemetry?.actualOn || detail?.scheduledOn || leg?.end);

  const departure = airportClock(departInstant, originCode);
  const arrival = airportClock(arriveInstant, destinationCode);
  const offMs = toMs(telemetry?.actualOff || detail?.actualOff || (airborne ? departInstant : null));
  const etaMs = toMs(telemetry?.estimatedOn || detail?.estimatedOn || (airborne ? arriveInstant : null));
  const elapsedMs = airborne && offMs != null ? Math.max(0, now - offMs) : null;
  const remainingMs = airborne && etaMs != null ? etaMs - now : null;

  let progress = Number.isFinite(telemetry?.progressPercent) ? telemetry.progressPercent : null;
  if (progress == null && Number.isFinite(detail?.progressPercent)) progress = detail.progressPercent;
  if (progress == null && elapsedMs != null && remainingMs != null && remainingMs > 0) {
    progress = (elapsedMs / (elapsedMs + remainingMs)) * 100;
  }
  if (landed) progress = 100;
  if (scheduled) progress = 0;

  const phase = airborne ? 'enroute' : landed ? 'landed' : scheduled ? 'scheduled' : 'ground';
  const phaseLabel = {
    enroute: 'En Route',
    landed: 'Landed',
    scheduled: 'Scheduled',
    ground: 'On ground',
  }[phase];

  const timeline = TIMELINE_STEPS.map((step) => ({
    ...step,
    at: eventAt(tripState?.statuses, step.id),
  })).filter((step) => step.at != null);

  if (airborne && offMs != null && !timeline.some((step) => step.id === 'wheels_up')) {
    timeline.push({ id: 'enroute', label: 'En Route', at: offMs });
  }
  timeline.sort((a, b) => a.at - b.at);

  const currentEvent = airborne
    ? { id: 'enroute', label: 'En Route', at: offMs }
    : (timeline[timeline.length - 1] || null);

  const paxOverride = typeof tripState?.paxOverride === 'number' ? tripState.paxOverride : null;
  const pax = paxOverride != null ? paxOverride : (Number.isFinite(Number(leg?.info?.pax)) ? Number(leg.info.pax) : null);
  const segmentId = tripState?.tripSheetData?.flightNumber ?? null;
  const customer = String(leg?.info?.customer || '').trim();

  return {
    tail: String(tail || '').toUpperCase(),
    leg,
    phase,
    phaseLabel,
    live: airborne,
    pill: airborne ? `Live · ${phaseLabel}` : phaseLabel,
    originCode: originCode ? String(originCode).toUpperCase() : null,
    destinationCode: destinationCode ? String(destinationCode).toUpperCase() : null,
    originCity: airportCity(originCode, detail?.origin?.city || telemetry?.originCity),
    destinationCity: airportCity(destinationCode, detail?.destination?.city || telemetry?.destinationCity),
    routeLabel: originCode && destinationCode
      ? `${String(originCode).toUpperCase()}→${String(destinationCode).toUpperCase()}`
      : null,
    type: aircraftMeta?.displayName || detail?.aircraftType || leg?.info?.aircraftType || '',
    pax,
    departure,
    arrival,
    elapsedMs,
    remainingMs,
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null,
    altitude: airborne && Number.isFinite(telemetry?.altitude) ? telemetry.altitude : null,
    groundspeed: airborne && Number.isFinite(telemetry?.groundspeed) ? telemetry.groundspeed : null,
    heading: airborne && Number.isFinite(telemetry?.heading) ? telemetry.heading : null,
    polledAt: toMs(telemetry?.polledAt || telemetry?.lastKnownAt),
    tripId: readTripId(tripState, leg),
    segmentId: segmentId == null || segmentId === '' ? null : String(segmentId),
    customer,
    operator: operatorName || '',
    timeline,
    currentEvent,
    arriveCode: destinationCode ? String(destinationCode).toUpperCase() : null,
  };
}

export { selectFlightLeg };
