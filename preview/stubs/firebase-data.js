import { fleetPositions, TRIPS, tripStates } from '../sample-data.js';

const emit = (value) => (cb) => {
  if (typeof cb === 'function') cb(value);
  return () => {};
};

// Parsed trip-sheet flight numbers exist only for legs that are already in
// motion, so the tracking ID row can show a segment without inventing one
// for a leg that has no sheet.
function previewTripStates() {
  const map = tripStates();
  let serial = 3218;
  for (const trip of TRIPS) {
    const state = map.get(trip.uid);
    if (!state?.statuses?.wheels_up || state.statuses.landed) continue;
    const tripCode = trip.info?.tripCode || null;
    state.tripCode = tripCode;
    state.tripSheetData = {
      ...(state.tripSheetData || {}),
      tripCode,
      flightNumber: String(serial),
    };
    serial += 11;
  }
  return map;
}

const noop = async () => {};

export const subscribeFleetPositions = (cb) => emit(fleetPositions())(cb);
export const subscribeAllTripStates = (cb) => emit(previewTripStates())(cb);
export const subscribeAirportCache = (cb) => emit({})(cb);
export const subscribeManualTrips = (cb) => emit([])(cb);
export const subscribeToManualTrips = (cb) => emit([])(cb);
export const subscribeTripState = (uid, cb) => emit(previewTripStates().get(uid) || { statuses: {} })(cb);
export const subscribeToTripState = (uid, cb) => emit(previewTripStates().get(uid) || { statuses: {} })(cb);
export const fetchTripState = async (uid) => previewTripStates().get(uid)
  || { statuses: {}, preloadedPax: [], passengers: [] };
export const fetchTripStateForShare = async (uid) => previewTripStates().get(uid)
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
