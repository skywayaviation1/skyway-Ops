import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  brokersMatch,
  passengerDisclosureEligibility,
  previousTailFlight,
} from '../src/broker-share.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');
const DAY = 24 * 60 * 60 * 1000;

function leg({
  uid,
  tail = 'N123AB',
  broker = '',
  start,
  category = 'REVENUE',
  from = 'APF',
  to = 'TEB',
  isFlight = true,
}) {
  return {
    uid,
    start: new Date(start),
    info: {
      tail, broker, category,
      legType: category === 'REVENUE' ? 'REVENUE' : category,
      from, to, isFlight,
    },
  };
}

test('immediately previous tail flight is offered without a same-day limit', () => {
  const anchorMs = Date.parse('2026-09-10T15:00:00Z');
  const anchor = leg({ uid: 'anchor', start: anchorMs, broker: 'Live Broker' });
  const severalDaysAgo = leg({
    uid: 'previous',
    start: anchorMs - 4 * DAY,
    broker: 'Other Broker',
    from: 'HPN',
    to: 'APF',
  });
  const older = leg({ uid: 'older', start: anchorMs - 12 * DAY });
  const otherTail = leg({ uid: 'other-tail', tail: 'N999ZZ', start: anchorMs - DAY });
  const hold = leg({
    uid: 'hold',
    start: anchorMs - 2 * 60 * 60 * 1000,
    category: 'HOLD',
    from: 'APF',
    to: 'APF',
    isFlight: false,
  });

  assert.equal(
    previousTailFlight(anchor, [older, severalDaysAgo, otherTail, hold, anchor])?.uid,
    'previous',
  );
});

test('previous tail lookup returns only an earlier real flight', () => {
  const anchorMs = Date.parse('2026-09-10T15:00:00Z');
  const anchor = leg({ uid: 'anchor', start: anchorMs });
  const future = leg({ uid: 'future', start: anchorMs + DAY });
  const sameAirport = leg({
    uid: 'pseudo',
    start: anchorMs - DAY,
    from: 'KAPF',
    to: 'APF',
  });
  assert.equal(previousTailFlight(anchor, [future, sameAirport]), null);
});

test('broker matching tolerates display-name and email-style variants', () => {
  assert.equal(brokersMatch('Platinum Air', 'krysty.platinumair@gmail.com'), true);
  assert.equal(brokersMatch('Platinum Air', 'Different Broker'), false);
  assert.equal(brokersMatch('', 'Different Broker'), false);
});

test('anchor passenger details are eligible but remain operator-controlled', () => {
  const anchor = leg({
    uid: 'anchor',
    start: Date.parse('2026-09-10T15:00:00Z'),
    broker: 'Live Broker',
  });
  assert.deepEqual(
    passengerDisclosureEligibility({ anchor, leg: anchor }),
    { allowed: true, reason: 'Broker live leg' },
  );
});

test('another broker passenger list is locked hidden even on the same tail', () => {
  const start = Date.parse('2026-09-10T15:00:00Z');
  const anchor = leg({ uid: 'anchor', start, broker: 'Live Broker' });
  const previous = leg({
    uid: 'previous',
    start: start - 3 * DAY,
    broker: 'Private Broker',
  });
  const result = passengerDisclosureEligibility({
    anchor,
    leg: previous,
    anchorState: { preloadedPax: [{ firstName: 'Same', lastName: 'Person' }] },
    legState: { preloadedPax: [{ firstName: 'Same', lastName: 'Person' }] },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Different broker/);
});

test('same broker and same trip sheet can disclose when operator opts in', () => {
  const start = Date.parse('2026-09-10T15:00:00Z');
  const anchor = leg({ uid: 'anchor', start, broker: 'Live Broker' });
  const sameBroker = leg({ uid: 'same-broker', start: start - DAY, broker: 'livebroker' });
  assert.equal(passengerDisclosureEligibility({ anchor, leg: sameBroker }).allowed, true);

  const unassigned = leg({ uid: 'same-sheet', start: start - DAY, broker: '' });
  assert.deepEqual(
    passengerDisclosureEligibility({
      anchor,
      leg: unassigned,
      anchorState: { tripSheetData: { tripCode: 'ABC123' } },
      legState: { tripSheetData: { tripCode: 'ABC123' } },
    }),
    { allowed: true, reason: 'Same trip sheet' },
  );
});

test('unassigned leg with overlapping passengers is eligible, positioning never is', () => {
  const start = Date.parse('2026-09-10T15:00:00Z');
  const anchor = leg({ uid: 'anchor', start, broker: 'Live Broker' });
  const sibling = leg({ uid: 'sibling', start: start + DAY, broker: '' });
  const states = {
    anchorState: { preloadedPax: [{ firstName: 'Jane', lastName: 'Doe' }] },
    legState: { preloadedPax: [{ firstName: 'Jane', lastName: 'Doe' }] },
  };
  assert.deepEqual(
    passengerDisclosureEligibility({ anchor, leg: sibling, ...states }),
    { allowed: true, reason: 'Same passenger group' },
  );
  const repo = leg({ uid: 'repo', start: start - DAY, category: 'REPO' });
  assert.equal(passengerDisclosureEligibility({ anchor, leg: repo, ...states }).allowed, false);
});

test('share dialog offers previous tail flight and per-leg passenger controls', async () => {
  const app = await source('src/App.jsx');
  assert.match(app, /previousTailFlight\(anchor, allTrips\)/);
  assert.match(app, /'previous-tail'/);
  assert.match(app, /PREVIOUS TAIL FLIGHT/);
  assert.match(app, /SHOW PASSENGER DETAILS/);
  assert.match(app, /showPaxByUid/);
  // Even a single-leg share must expose the anchor's hide-passengers control.
  assert.match(app, /\{allCandidateLegs\.length > 0 && \(/);
  assert.match(app, /disclosure\.allowed && showPaxByUid\[t\.uid\] === true/);
  // Changing either selection or privacy updates the same URL snapshot.
  assert.match(app, /\[selectedUids, showPaxByUid, liveAnchorFromFbo, liveAnchorToFbo\]/);
});

test('hidden passenger records are removed from the persisted public snapshot', async () => {
  const api = await source('api/trip-share.js');
  assert.match(api, /pax: leg\.showPax === true && Array\.isArray\(leg\.pax\)/);
  const publicApi = await source('api/trip-public.js');
  assert.match(publicApi, /if \(leg\.showPax !== true\) return \[\]/);
});

test('share-state fetch includes the trip evidence used by privacy rules', async () => {
  const firebase = await source('src/firebase-data.js');
  assert.match(firebase, /tripSheetData:/);
  assert.match(firebase, /fromFbo: data\.fromFbo/);
  assert.match(firebase, /hasCatering: data\.hasCatering !== false/);
});

