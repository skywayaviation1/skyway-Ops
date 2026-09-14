import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autoSelectedShareUids,
  precedingRepoChain,
  relatedBrokerLegs,
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

