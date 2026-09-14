const HOUR = 3600_000;
const MAX_CHAIN_GAP = 30 * HOUR;

export function normalizeAirport(code) {
  const value = String(code || '').toUpperCase().trim();
  return value.length === 4 && value.startsWith('K') ? value.slice(1) : value;
}

export function isRepoLeg(trip) {
  const type = String(trip?.info?.legType || trip?.info?.category || '').toUpperCase();
  return type === 'REPO' || type === 'FERRY' || type === 'DEADHEAD';
}

export function isLiveLeg(trip) {
  if (!trip?.info || trip.info.isFlight === false || isRepoLeg(trip)) return false;
  const type = String(trip.info.legType || trip.info.category || '').toUpperCase();
  return !['HOLD', 'MX', 'TRAINING'].includes(type);
}

function sameTail(a, b) {
  return String(a?.info?.tail || '').toUpperCase()
    === String(b?.info?.tail || '').toUpperCase();
}

function time(trip, field = 'start') {
  const value = new Date(trip?.[field] || trip?.start || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function precedingRepoChain(liveLeg, allTrips) {
  if (!liveLeg?.uid || !Array.isArray(allTrips)) return [];
  const ordered = allTrips
    .filter((trip) => trip?.uid && sameTail(trip, liveLeg) && trip.info?.isFlight !== false)
    .sort((a, b) => time(a) - time(b));
  const index = ordered.findIndex((trip) => trip.uid === liveLeg.uid);
  if (index < 0) return [];
  const chain = [];
  let nextOrigin = normalizeAirport(liveLeg.info?.from);
  let nextStart = time(liveLeg);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const leg = ordered[cursor];
    if (!isRepoLeg(leg)) break;
    if (normalizeAirport(leg.info?.to) !== nextOrigin) break;
    const legEnd = time(leg, 'end');
    if (nextStart - legEnd > MAX_CHAIN_GAP) break;
    chain.unshift(leg);
    nextOrigin = normalizeAirport(leg.info?.from);
    nextStart = time(leg);
  }
  return chain;
}

function tripCodeFor(trip, statesByUid) {
  return String(
    statesByUid?.[trip?.uid]?.tripSheetData?.tripCode
    || statesByUid?.[trip?.uid]?.tripCode
    || '',
  ).trim().toUpperCase();
}

export function relatedBrokerLegs({ sourceTrip, allTrips = [], statesByUid = {} } = {}) {
  if (!sourceTrip?.uid) return [];
  let anchor = sourceTrip;
  if (isRepoLeg(sourceTrip)) {
    anchor = allTrips
      .filter((trip) => isLiveLeg(trip) && sameTail(trip, sourceTrip) && time(trip) >= time(sourceTrip))
      .sort((a, b) => time(a) - time(b))
      .find((trip) => precedingRepoChain(trip, allTrips).some((repo) => repo.uid === sourceTrip.uid))
      || sourceTrip;
  }
  const code = tripCodeFor(anchor, statesByUid) || tripCodeFor(sourceTrip, statesByUid);
  const live = code
    ? allTrips.filter((trip) => (
      isLiveLeg(trip)
      && sameTail(trip, anchor)
      && tripCodeFor(trip, statesByUid) === code
    ))
    : (isLiveLeg(anchor) ? [anchor] : []);
  const byUid = new Map([[sourceTrip.uid, sourceTrip]]);
  for (const leg of live) {
    byUid.set(leg.uid, leg);
    precedingRepoChain(leg, allTrips).forEach((repo) => byUid.set(repo.uid, repo));
  }
  return Array.from(byUid.values()).sort((a, b) => time(a) - time(b));
}

export function autoSelectedShareUids(candidateLegs = []) {
  return new Set(candidateLegs
    .filter((leg) => ['anchor', 'positioning-in', 'same-trip-sheet'].includes(leg?._shareReason))
    .map((leg) => leg.uid));
}

