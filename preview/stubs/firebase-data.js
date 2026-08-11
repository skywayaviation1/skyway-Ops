import { fleetPositions, tripStates } from '../sample-data.js';

const emit = (value) => (cb) => {
  if (typeof cb === 'function') cb(value);
  return () => {};
};

export const subscribeFleetPositions = (cb) => emit(fleetPositions())(cb);
export const subscribeAllTripStates = (cb) => emit(tripStates())(cb);
export const subscribeAirportCache = (cb) => emit({})(cb);
export const subscribeManualTrips = (cb) => emit([])(cb);
export const subscribeTripState = (_uid, cb) => emit({ statuses: {} })(cb);
export const fetchTripState = async () => ({ statuses: {}, preloadedPax: [], passengers: [] });
export const saveTripState = async () => {};
export const attachTripSheetToLeg = async () => {};
