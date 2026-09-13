const clean = (value) => String(value || '').trim().toUpperCase();

export function normalizeAircraftIdent(value) {
  return clean(value).replace(/[\s-]+/g, '');
}

export function aircraftIdentFromFlight(flight, fallback = '') {
  const registration = normalizeAircraftIdent(flight?.registration);
  if (registration) return registration;
  return normalizeAircraftIdent(flight?.ident || fallback);
}

export function flightAwareEventCode(payload) {
  const raw = clean(payload?.event_code || payload?.event || payload?.['@type']);
  if (raw === 'DEPARTURE') return 'off';
  if (raw === 'ARRIVAL') return 'on';
  return raw.toLowerCase();
}

export function airportCode(value) {
  if (typeof value === 'string') return clean(value) || null;
  return clean(value?.code_icao || value?.code || value?.code_iata) || null;
}

export function eventTimestamp(flight, eventCode) {
  const byEvent = {
    out: flight?.actual_out,
    off: flight?.actual_off,
    on: flight?.actual_on,
    in: flight?.actual_in,
  };
  return byEvent[eventCode]
    || flight?.actual_on
    || flight?.actual_off
    || flight?.actual_out
    || flight?.actual_in
    || null;
}

export function observedFlightMilestones(state) {
  const milestones = [
    { stepId: 'taxi_dep', eventType: 'out', timestamp: state?.actualOut },
    { stepId: 'wheels_up', eventType: 'off', timestamp: state?.actualOff },
    { stepId: 'landed', eventType: 'on', timestamp: state?.actualOn },
  ];
  return milestones
    .map((item) => ({ ...item, eventTimeMs: new Date(item.timestamp || 0).getTime() }))
    .filter((item) => item.timestamp && Number.isFinite(item.eventTimeMs));
}
