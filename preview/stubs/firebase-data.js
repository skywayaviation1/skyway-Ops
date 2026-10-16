import { fleetPositions, tripStates } from '../sample-data.js';

const emit = (value) => (cb) => {
  if (typeof cb === 'function') cb(value);
  return () => {};
};

import { TRIPS } from '../sample-data.js';

const noop = async () => {};

/** The shape the cron used to store: flag false, off-block only, or a string flag. */
function productionShape(positions) {
  const out = {};
  let flying = 0;
  for (const [tail, raw] of Object.entries(positions)) {
    if (raw?.airborne !== true) {
      out[tail] = raw;
      continue;
    }
    flying += 1;
    if (flying === 1) {
      out[tail] = {
        ...raw,
        airborne: false,
        actualOff: null,
        actualOut: raw.actualOff || raw.actualOut || new Date().toISOString(),
        actualOn: null,
        latitude: null,
        longitude: null,
      };
    } else {
      out[tail] = { ...raw, airborne: 'true' };
    }
  }
  return out;
}

function positionsForBoard() {
  const positions = fleetPositions();
  if (typeof window === 'undefined') return positions;
  const boardCase = new URLSearchParams(window.location.search).get('boardCase');
  if (boardCase === 'production') return productionShape(positions);
  if (boardCase !== 'parked') return positions;
  const parked = {};
  for (const [tail, raw] of Object.entries(positions)) {
    if (raw?.airborne === true && Number.isFinite(raw.latitude) && Number.isFinite(raw.longitude)) {
      parked[tail] = {
        ...raw,
        airborne: false,
        estimatedOn: null,
        groundedLat: raw.latitude,
        groundedLon: raw.longitude,
        groundedAt: raw.destination || raw.origin || null,
      };
    } else {
      parked[tail] = raw;
    }
  }
  return parked;
}

export const subscribeFleetPositions = (cb) => emit(positionsForBoard())(cb);
export const subscribeAllTripStates = (cb) => emit(tripStates())(cb);
export const subscribeAirportCache = (cb) => emit({})(cb);
export const subscribeManualTrips = (cb) => emit([])(cb);
export const subscribeToManualTrips = (cb) => emit([])(cb);
export const subscribeTripState = (uid, cb) => emit(tripStates().get(uid) || { statuses: {} })(cb);
export const subscribeToTripState = (uid, cb) => emit(tripStates().get(uid) || { statuses: {} })(cb);
export const fetchTripState = async (uid) => tripStates().get(uid)
  || { statuses: {}, preloadedPax: [], passengers: [] };
export const fetchTripStateForShare = async (uid) => tripStates().get(uid)
  || { statuses: {}, preloadedPax: [], passengers: [] };
export const fetchPreloadedPax = async () => [];
export const saveTripState = noop;
export const attachTripSheetToLeg = noop;
export const saveManualTrip = noop;
export const deleteManualTrip = noop;
export const seedTripMeta = noop;
export const setTripFboById = noop;
export const getTripSheetsForBackfill = async () => [];

/* Tab-order personalization: preview always uses the shipped default order. */
export const subscribeDefaultTabOrder = (cb) => emit(null)(cb);
export const saveUserTabOrder = noop;
export const clearUserTabOrder = noop;
export const publishDefaultTabOrder = noop;

export const SAMPLE_TRIPS = TRIPS;

export const subscribeFratConfig = (cb) => emit(null)(cb);
export const saveFratConfig = noop;
export const fetchFratConfig = async () => null;
