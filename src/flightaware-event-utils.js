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

const eventFieldForStep = {
  taxi_dep: 'actual_out',
  wheels_up: 'actual_off',
  landed: 'actual_on',
};

function airportsMatch(a, b) {
  const left = clean(a).replace(/^K/, '');
  const right = clean(b).replace(/^K/, '');
  return !left || !right || left === right;
}

export function selectFlightAwareEvent(flights, {
  ident,
  stepId,
  from,
  to,
  scheduledStartMs,
  maxDistanceMs = 48 * 60 * 60 * 1000,
} = {}) {
  const eventField = eventFieldForStep[stepId];
  if (!eventField) return null;
  const targetTail = normalizeAircraftIdent(ident);
  const targetStart = Number(scheduledStartMs);
  const hasTargetStart = Number.isFinite(targetStart) && targetStart > 0;

  const candidates = (Array.isArray(flights) ? flights : [])
    .map((flight) => {
      const timestamp = flight?.[eventField];
      const eventTimeMs = new Date(timestamp || 0).getTime();
      const flightStartMs = new Date(
        flight?.actual_out
          || flight?.actual_off
          || flight?.scheduled_out
          || flight?.scheduled_off
          || 0,
      ).getTime();
      return {
        flight,
        timestamp,
        eventTimeMs,
        flightStartMs,
        tail: aircraftIdentFromFlight(flight),
        origin: airportCode(flight?.origin),
        destination: airportCode(flight?.destination),
      };
    })
    .filter((item) => (
      item.timestamp
      && Number.isFinite(item.eventTimeMs)
      && (!targetTail || item.tail === targetTail)
      && airportsMatch(item.origin, from)
      && airportsMatch(item.destination, to)
      && (
        !hasTargetStart
        || (
          Number.isFinite(item.flightStartMs)
          && Math.abs(item.flightStartMs - targetStart) <= maxDistanceMs
        )
      )
    ));

  candidates.sort((a, b) => {
    if (!hasTargetStart) return b.eventTimeMs - a.eventTimeMs;
    return Math.abs(a.flightStartMs - targetStart) - Math.abs(b.flightStartMs - targetStart);
  });

  const match = candidates[0];
  if (!match) return null;
  return {
    timestamp: match.timestamp,
    timestampMs: match.eventTimeMs,
    faFlightId: match.flight?.fa_flight_id || null,
    ident: match.tail,
    origin: match.origin,
    destination: match.destination,
  };
}
