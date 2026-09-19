import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autoSelectedShareUids,
  precedingRepoChain,
  previousShareableLegs,
  relatedBrokerLegs,
  shouldRedactPreviousLeg,
} from '../src/broker-leg-grouping.js';

const at = (hour) => new Date(`2030-01-01T${String(hour).padStart(2, '0')}:00:00Z`);
const leg = (uid, from, to, hour, type, tripCode = '') => ({
  uid,
  start: at(hour),
  end: at(hour + 1),
  info: {
    tail: 'N444AM',
    from,
    to,
    legType: type,
    category: type,
    isFlight: true,
  },
  tripCode,
});

test('same trip-number live legs and each positioning-in chain share one broker', () => {
  const repo = leg('repo-1', 'TPA', 'APF', 8, 'REPO');
  const live1 = leg('live-1', 'APF', 'PBI', 10, 'REVENUE');
  const live2 = leg('live-2', 'PBI', 'TEB', 15, 'REVENUE');
  const unrelated = leg('live-other', 'TEB', 'BOS', 18, 'REVENUE');
  const trips = [repo, live1, live2, unrelated];
  const states = {
    'live-1': { tripSheetData: { tripCode: 'ABC123' } },
    'live-2': { tripSheetData: { tripCode: 'ABC123' } },
    'live-other': { tripSheetData: { tripCode: 'OTHER' } },
  };
  assert.deepEqual(
    relatedBrokerLegs({ sourceTrip: live1, allTrips: trips, statesByUid: states })
      .map((trip) => trip.uid),
    ['repo-1', 'live-1', 'live-2'],
  );
  assert.deepEqual(precedingRepoChain(live1, trips).map((trip) => trip.uid), ['repo-1']);
});

test('a revenue leg or broken airport chain stops repo inheritance', () => {
  const oldRepo = leg('repo-old', 'MCO', 'TPA', 4, 'REPO');
  const otherLive = leg('other-live', 'TPA', 'MIA', 6, 'REVENUE');
  const wrongRepo = leg('repo-wrong', 'MIA', 'RSW', 8, 'REPO');
  const live = leg('live', 'APF', 'PBI', 10, 'REVENUE');
  assert.deepEqual(
    precedingRepoChain(live, [oldRepo, otherLive, wrongRepo, live]),
    [],
  );
});

test('broker share automatically checks anchor, preceding repo, and trip-code legs', () => {
  const selected = autoSelectedShareUids([
    { uid: 'anchor', _shareReason: 'anchor' },
    { uid: 'repo-in', _shareReason: 'positioning-in' },
    { uid: 'same-code', _shareReason: 'same-trip-sheet' },
    { uid: 'repo-out', _shareReason: 'positioning-out' },
    { uid: 'pax-only', _shareReason: 'same-pax' },
  ]);
  assert.deepEqual([...selected], ['anchor', 'repo-in', 'same-code']);
});

test('earlier same-tail flights are offered but never auto-selected', () => {
  const previous = leg('previous', 'TVC', 'IAD', 7, 'REVENUE');
  const anchor = leg('anchor', 'IAD', 'TEB', 10, 'REVENUE');
  const future = leg('future', 'TEB', 'BOS', 13, 'REVENUE');
  const offered = previousShareableLegs(anchor, [previous, anchor, future]);
  assert.deepEqual(offered.map((item) => item.uid), ['previous']);
  assert.equal(offered[0]._shareReason, 'previous-private');
  assert.deepEqual([...autoSelectedShareUids(offered)], []);
});

test('different-passenger previous revenue leg is privacy-redacted as repositioning', () => {
  const previous = leg('previous', 'TVC', 'IAD', 7, 'REVENUE');
  const anchor = leg('anchor', 'IAD', 'TEB', 10, 'REVENUE');
  const states = {
    previous: { preloadedPax: [{ firstName: 'Private', lastName: 'Client' }] },
    anchor: { preloadedPax: [{ firstName: 'Next', lastName: 'Passenger' }] },
  };
  assert.equal(shouldRedactPreviousLeg({
    leg: previous,
    anchor,
    statesByUid: states,
  }), true);
  states.previous.tripSheetData = { tripCode: 'SAME1' };
  states.anchor.tripSheetData = { tripCode: 'SAME1' };
  assert.equal(shouldRedactPreviousLeg({
    leg: previous,
    anchor,
    statesByUid: states,
  }), false);
});

