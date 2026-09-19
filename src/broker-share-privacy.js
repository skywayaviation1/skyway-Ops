const ALL_STATUS_KEYS = [
  'crew_onsite',
  'aircraft_ready',
  'catering_aboard',
  'pax_arrived',
  'pax_boarded',
  'taxi_dep',
  'wheels_up',
  'landed',
];

const MOVEMENT_STATUS_KEYS = ['taxi_dep', 'wheels_up', 'landed'];

export function sanitizePublicLeg(leg, index = 0) {
  const privateRepositioning = leg?.privacyMode === 'repositioning';
  const statusKeys = privateRepositioning ? MOVEMENT_STATUS_KEYS : ALL_STATUS_KEYS;
  const status = leg?.status && typeof leg.status === 'object'
    ? statusKeys.reduce((acc, key) => {
        const value = leg.status[key];
        if (value && typeof value === 'object' && Number.isFinite(value.at)) {
          acc[key] = { at: value.at };
        }
        return acc;
      }, {})
    : {};

  const showPax = !privateRepositioning && leg?.showPax === true;
  return {
    tripId: leg?.tripId ? String(leg.tripId).slice(0, 200) : null,
    legNumber: Number.isFinite(leg?.legNumber) ? leg.legNumber : index + 1,
    from: leg?.from ? String(leg.from).slice(0, 8) : null,
    to: leg?.to ? String(leg.to).slice(0, 8) : null,
    fromFbo: !privateRepositioning && leg?.fromFbo
      ? String(leg.fromFbo).slice(0, 120) : null,
    toFbo: !privateRepositioning && leg?.toFbo
      ? String(leg.toFbo).slice(0, 120) : null,
    departure: leg?.departure || null,
    arrival: leg?.arrival || null,
    category: privateRepositioning
      ? 'REPOSITIONING'
      : (leg?.category ? String(leg.category).slice(0, 16) : 'REVENUE'),
    picName: !privateRepositioning && leg?.picName
      ? String(leg.picName).slice(0, 80) : null,
    sicName: !privateRepositioning && leg?.sicName
      ? String(leg.sicName).slice(0, 80) : null,
    showPax,
    hasCatering: privateRepositioning ? false : leg?.hasCatering !== false,
    pax: showPax && Array.isArray(leg?.pax)
      ? leg.pax.slice(0, 30).map((passenger) => {
          if (!passenger || typeof passenger !== 'object') return null;
          const name = String(passenger.name || '').slice(0, 80).trim();
          if (!name) return null;
          const passengerStatus = ['checked_in', 'pending', 'skipped', 'no_show']
            .includes(passenger.status) ? passenger.status : 'pending';
          const checkedInAt = Number.isFinite(passenger.checkedInAt)
            ? passenger.checkedInAt : null;
          return {
            name,
            status: passengerStatus,
            checkedInAt,
            walkUp: passenger.walkUp === true,
          };
        }).filter(Boolean)
      : [],
    status,
    privacyMode: privateRepositioning ? 'repositioning' : 'standard',
    notifyBroker: leg?.notifyBroker === true,
  };
}

export function publicMovementNotification({
  tail,
  from,
  to,
  stepId,
  eventTimeText,
  trackingUrl,
}) {
  const movement = {
    taxi_dep: 'began taxiing for departure',
    wheels_up: 'is wheels up',
    landed: 'has landed',
  }[stepId];
  if (!movement) return null;
  const route = [from, to].filter(Boolean).join(' → ');
  return {
    subject: `${tail || 'Aircraft'} repositioning update — ${movement}`,
    text: [
      'Hello,',
      '',
      `The aircraft assigned to your upcoming Skyway flight ${movement}${route ? ` on ${route}` : ''}${eventTimeText ? ` at ${eventTimeText}` : ''}.`,
      '',
      'This previous flight is displayed as a repositioning leg. Passenger, customer, broker, crew, and other private trip details are not shared.',
      trackingUrl ? '' : null,
      trackingUrl ? `Track the aircraft and your upcoming trip: ${trackingUrl}` : null,
      '',
      '— Skyway Aviation',
      'Private Jet & Helicopter Charter Services',
    ].filter((line) => line !== null).join('\n'),
  };
}
