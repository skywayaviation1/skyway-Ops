/**
 * Pure broker-share selection and passenger-privacy rules.
 *
 * Kept outside App.jsx so privacy behavior can be unit tested directly.
 */

const normalizeTail = (value) => String(value || '').trim().toUpperCase();
const normalizeBroker = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

export function brokersMatch(a, b) {
  const left = normalizeBroker(a);
  const right = normalizeBroker(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 5 && longer.includes(shorter);
}

export function isShareEligibleFlight(trip) {
  if (!trip?.info || !trip.start) return false;
  if (trip.info.isFlight === false) return false;
  const category = String(trip.info.category || '').toUpperCase();
  if (['HOLD', 'MX', 'TRAINING'].includes(category)) return false;
  const from = String(trip.info.from || '').trim().toUpperCase().replace(/^K(?=[A-Z]{3}$)/, '');
  const to = String(trip.info.to || '').trim().toUpperCase().replace(/^K(?=[A-Z]{3}$)/, '');
  if (from && to && from === to) return false;
  return Number.isFinite(new Date(trip.start).getTime());
}

/**
 * The immediately preceding real flight assigned to this tail.
 *
 * There is deliberately no same-day or hour window. The operator asked to
 * share where the aircraft was coming from even when that flight occurred on a
 * previous day. Only the nearest earlier flight is returned, so this cannot
 * turn into an unbounded history disclosure.
 */
export function previousTailFlight(anchor, allTrips) {
  if (!anchor?.uid || !anchor?.info) return null;
  const tail = normalizeTail(anchor.info.tail);
  const anchorMs = new Date(anchor.start).getTime();
  if (!tail || !Number.isFinite(anchorMs)) return null;

  return (Array.isArray(allTrips) ? allTrips : [])
    .filter((trip) => trip?.uid !== anchor.uid)
    .filter((trip) => normalizeTail(trip?.info?.tail) === tail)
    .filter(isShareEligibleFlight)
    .filter((trip) => new Date(trip.start).getTime() < anchorMs)
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())[0] || null;
}

const passengerKey = (passenger) => {
  if (!passenger) return '';
  if (typeof passenger === 'string') return passenger.trim().toLowerCase();
  const first = String(passenger.firstName || '').trim().toLowerCase();
  const last = String(passenger.lastName || '').trim().toLowerCase();
  return [first, last].filter(Boolean).join(' ');
};

function passengerKeys(state) {
  return new Set((Array.isArray(state?.preloadedPax) ? state.preloadedPax : [])
    .map(passengerKey)
    .filter(Boolean));
}

function isRepo(trip) {
  const type = String(trip?.info?.legType || trip?.info?.category || '').toUpperCase();
  return type === 'REPO' || type === 'FERRY' || type === 'DEADHEAD';
}

/**
 * Whether the operator may expose passenger names for one shared leg.
 *
 * - Repositioning never has passenger details.
 * - The anchor is the broker's live leg and is eligible, but the operator may
 *   still hide it with the per-leg toggle.
 * - A sibling is eligible only when it belongs to the same broker, the same
 *   trip sheet, or is an unassigned-broker leg carrying the anchor passengers.
 * - A leg explicitly assigned to another broker is always locked hidden.
 */
export function passengerDisclosureEligibility({
  anchor,
  leg,
  anchorState = {},
  legState = {},
}) {
  if (!leg?.uid) return { allowed: false, reason: 'Invalid leg' };
  if (isRepo(leg)) return { allowed: false, reason: 'Positioning leg' };
  if (leg.uid === anchor?.uid) return { allowed: true, reason: 'Broker live leg' };

  const anchorBroker = anchor?.info?.broker;
  const legBroker = leg.info?.broker;
  if (legBroker && !brokersMatch(anchorBroker, legBroker)) {
    return { allowed: false, reason: 'Different broker — passenger details locked' };
  }
  if (brokersMatch(anchorBroker, legBroker)) {
    return { allowed: true, reason: 'Same broker' };
  }

  const anchorTripCode = String(anchorState?.tripSheetData?.tripCode || '').trim();
  const legTripCode = String(legState?.tripSheetData?.tripCode || '').trim();
  if (anchorTripCode && legTripCode && anchorTripCode === legTripCode) {
    return { allowed: true, reason: 'Same trip sheet' };
  }

  // A no-broker leg can belong to the same customer group when manifests
  // overlap. Never use this exception when a different broker is explicitly
  // assigned above.
  const anchorPax = passengerKeys(anchorState);
  const legPax = passengerKeys(legState);
  if (anchorPax.size > 0 && [...legPax].some((key) => anchorPax.has(key))) {
    return { allowed: true, reason: 'Same passenger group' };
  }

  return { allowed: false, reason: 'Not verified as this broker’s passengers' };
}

