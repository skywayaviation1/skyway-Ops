// Pure helpers for the full-screen TV flight board (?board=1).
// The compact schedule card does not use this module.

import { buildFleetMapScene, formatMarkerTime, readTripId } from './fleet-tracking.js';

export const TV_DESIGN_WIDTH = 1920;
export const TV_DESIGN_HEIGHT = 1080;
export const TV_HEADER_PX = 132;
export const TV_PAGE_CHROME_PX = 36;
export const TV_ROW_PX = 114;
export const TV_PAGE_ROWS = 8;
export const TV_PAGE_MS = 12_000;

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
};

/** CSS scale for the 1920×1080 frame: min(100vw/1920, 100vh/1080). */
export function tvBoardScale(viewportWidth, viewportHeight) {
  const width = Number(viewportWidth);
  const height = Number(viewportHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.min(width / TV_DESIGN_WIDTH, height / TV_DESIGN_HEIGHT);
}

/**
 * Rows that fit the 1080p frame. A 4K viewport scales that frame by 2, so
 * the count stays the same and the type gets larger.
 */
export function tvPageSize(viewportWidth = TV_DESIGN_WIDTH, viewportHeight = TV_DESIGN_HEIGHT) {
  const scale = tvBoardScale(viewportWidth, viewportHeight);
  const frameHeight = Number(viewportHeight) / scale;
  const usedHeight = Math.min(frameHeight, TV_DESIGN_HEIGHT);
  const listHeight = usedHeight - TV_HEADER_PX - TV_PAGE_CHROME_PX;
  const fit = Math.floor(listHeight / TV_ROW_PX);
  return Math.max(1, fit || TV_PAGE_ROWS);
}

export function tvPageCount(rowCount, pageSize = TV_PAGE_ROWS) {
  const size = Math.max(1, Number(pageSize) || TV_PAGE_ROWS);
  const count = Math.max(0, Number(rowCount) || 0);
  return Math.max(1, Math.ceil(count / size));
}

export function tvPageIndex(nowMs, rowCount, {
  pageSize = TV_PAGE_ROWS,
  intervalMs = TV_PAGE_MS,
  originMs = 0,
} = {}) {
  const pages = tvPageCount(rowCount, pageSize);
  if (pages <= 1) return 0;
  const elapsed = Math.max(0, Number(nowMs) - Number(originMs));
  const interval = Math.max(1, Number(intervalMs) || TV_PAGE_MS);
  return Math.floor(elapsed / interval) % pages;
}

export function tvPageSlice(rows, nowMs, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const pageSize = options.pageSize ?? TV_PAGE_ROWS;
  const index = tvPageIndex(nowMs, list.length, { ...options, pageSize });
  const start = index * pageSize;
  return {
    index,
    pageCount: tvPageCount(list.length, pageSize),
    rows: list.slice(start, start + pageSize),
  };
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
