/**
 * Merge current schedule metadata into one broker-share leg.
 *
 * The share snapshot decides which legs are visible. Route and schedule times
 * remain live: when dispatch changes them, the same public link must update on
 * its next poll without the operator reopening the share dialog.
 */

const airport = (value) => String(value || '').trim().toUpperCase();
const airportIdentity = (value) => {
  const code = airport(value);
  return code.length === 4 && code.startsWith('K') ? code.slice(1) : code;
};

export function mergeSharedLegRoute(leg = {}, liveTripMeta = {}, anchorState = {}) {
  const live = liveTripMeta && typeof liveTripMeta === 'object' ? liveTripMeta : {};
  const liveFrom = airport(live.from);
  const liveTo = airport(live.to);
  const snapshotFrom = airport(leg.from);
  const snapshotTo = airport(leg.to);
  const fromChanged = Boolean(
    liveFrom && airportIdentity(liveFrom) !== airportIdentity(snapshotFrom),
  );
  const toChanged = Boolean(
    liveTo && airportIdentity(liveTo) !== airportIdentity(snapshotTo),
  );

  return {
    from: liveFrom || leg.from || null,
    to: liveTo || leg.to || null,
    // FBO assignments belong to the original airport. Clear them on a route
    // change rather than displaying an old-airport FBO under the new airport.
    fromFbo: fromChanged ? null : (leg.fromFbo || anchorState.fromFbo || null),
    toFbo: toChanged ? null : (leg.toFbo || anchorState.toFbo || null),
    departure: live.start || leg.departure || null,
    arrival: live.end || leg.arrival || null,
    category: live.legType || leg.category || 'REVENUE',
    routeChanged: fromChanged || toChanged,
  };
}

