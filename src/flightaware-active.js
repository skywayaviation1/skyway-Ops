// How the office wall decides an airplane is airborne.
//
// The FlightAware cron used to require actual_off with no actual_on. AeroAPI
// often reports the airplane out (actual_out) or en route (progress_percent)
// before actual_off is filled, and older state docs store the flag as the
// string "true". Either shape left the TV at AIRBORNE 0 with an ETD callout.

function openFlight(flight) {
  if (!flight || typeof flight !== 'object') return false;
  if (flight.actual_on || flight.actual_in) return false;
  const status = String(flight.status || '').toLowerCase();
  if (flight.cancelled === true || status === 'cancelled' || status === 'canceled') return false;
  return true;
}

/** The enroute record in an AeroAPI /flights/{ident} list, or null. */
export function selectActiveFlight(flights) {
  const list = Array.isArray(flights) ? flights : [];
  const departed = list.find((flight) => openFlight(flight) && (flight.actual_off || flight.actual_out));
  if (departed) return departed;
  return list.find((flight) => {
    const progress = Number(flight?.progress_percent);
    return openFlight(flight) && Number.isFinite(progress) && progress > 0 && progress < 100;
  }) || null;
}

function truthyAirborne(value) {
  return value === true || value === 1 || value === 'true' || value === 'TRUE';
}

/**
 * A flightaware-state document that means "this tail is flying", including
 * the shapes the cron writes when the boolean itself is missing or false.
 */
export function positionSaysAirborne(record) {
  if (!record || typeof record !== 'object') return false;
  if (truthyAirborne(record.airborne)) return true;
  if (record.actualOff && !record.actualOn) return true;
  if (record.actualOut && !record.actualOn && !record.actualIn) return true;
  const progress = Number(record.progressPercent ?? record.progress_percent);
  if (Number.isFinite(progress) && progress > 0 && progress < 100 && !record.actualOn) return true;
  const speed = Number(record.groundspeed);
  const altitude = Number(record.altitude);
  if (Number.isFinite(speed) && speed >= 80) return true;
  if (Number.isFinite(altitude) && altitude >= 1500 && (!Number.isFinite(speed) || speed >= 40)) return true;
  return false;
}
