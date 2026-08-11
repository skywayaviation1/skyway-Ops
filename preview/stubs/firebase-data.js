import { fleetPositions, tripStates } from '../sample-data.js';

const emit = (value) => (cb) => {
  if (typeof cb === 'function') cb(value);
  return () => {};
};

import { TRIPS } from '../sample-data.js';

const noop = async () => {};

export const subscribeFleetPositions = (cb) => emit(fleetPositions())(cb);
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
