import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildActiveOpsTrips,
  computeOutstanding,
  readinessLevel,
  readinessProgress,
  showsCateringStatus,
} from '../src/ops-readiness.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

const NOW = Date.UTC(2026, 7, 4, 12);

function trip(overrides = {}) {
  return {
    uid: overrides.uid || 'trip-1',
    start: new Date(NOW + (overrides.hours ?? 2) * 3600_000),
    end: new Date(NOW + (overrides.hours ?? 2) * 3600_000 + 2 * 3600_000),
    info: {
      tail: 'N20UF',
      from: 'KTEB',
      to: 'KPBI',
      legType: 'REVENUE',
      isOps: true,
      isFlight: true,
      pax: 4,
      pic: 'Pilot One',
      sic: 'Pilot Two',
      ...(overrides.info || {}),
    },
  };
}

test('rolling board includes next 48h and recent incomplete legs only', () => {
  const states = new Map([['done', { completed: true }]]);
  const result = buildActiveOpsTrips([
    trip({ uid: 'recent', hours: -6 }),
    trip({ uid: 'soon', hours: 30 }),
    trip({ uid: 'too-far', hours: 49 }),
    trip({ uid: 'too-old', hours: -25 }),
    trip({ uid: 'done', hours: 1 }),
  ], states, NOW);
  assert.deepEqual(result.map((item) => item.uid), ['recent', 'soon']);
});

test('imminent revenue leg reports complete operational gaps', () => {
  const gaps = computeOutstanding(trip({ hours: 0.5 }), {
    statuses: {},
    passengers: [],
    dispatcherUids: [],
  }, NOW);
  const codes = new Set(gaps.map((item) => item.code));
  for (const code of [
    'no-sheet',
    'no-dispatch',
    'no-broker',
    'no-pax',
    'no-origin-fbo',
    'no-destination-fbo',
  ]) assert.equal(codes.has(code), true, code);
  assert.equal(gaps.find((item) => item.code === 'no-sheet').severity, 'critical');
});

test('operational hold is always the highest readiness level', () => {
  const gaps = computeOutstanding(trip(), {
    tripSheetUrl: 'https://example.test/sheet.pdf',
    dispatcherUids: ['ops-1'],
    brokerEmail: 'broker@example.com',
    paxOverride: 4,
    fromFbo: 'Atlantic',
    toFbo: 'Signature',
    opsDisposition: 'hold',
    opsDispositionReason: 'Weather below minimums',
  }, NOW);
  assert.equal(gaps[0].code, 'ops-hold');
  assert.equal(readinessLevel(gaps), 'critical');
});

test('status progress omits catering when trip says it does not apply', () => {
  const progress = readinessProgress(trip(), {
    hasCatering: false,
    statuses: {
      crew_onsite: { at: NOW },
      aircraft_ready: { at: NOW },
    },
  });
  assert.equal(progress.total, 7);
  assert.equal(progress.done, 2);
  assert.equal(progress.next.id, 'pax_arrived');
});

test('broker page hides catering only when there is none and none was recorded', () => {
  // No catering on the trip and nothing recorded — hide it.
  assert.equal(showsCateringStatus({ hasCatering: false, status: {} }), false);
  // Catering on the trip but not yet aboard — still show the pending milestone.
  assert.equal(showsCateringStatus({ hasCatering: true, status: {} }), true);
  // Recorded catering always shows, even if the flag was turned off later.
  assert.equal(
    showsCateringStatus({ hasCatering: false, status: { catering_aboard: { at: NOW } } }),
    true,
  );
  // Older shares predate the flag; those trips had catering.
  assert.equal(showsCateringStatus({ status: {} }), true);
  assert.equal(showsCateringStatus(undefined), true);
});

test('catering flag reaches the broker page through share, API and render', async () => {
  const app = await source('src/App.jsx');
  const share = await source('api/trip-share.js');
  const publicApi = await source('api/trip-public.js');
  const page = await source('src/TripTrack.jsx');
  assert.match(app, /hasCatering: state\.hasCatering !== false/);
  assert.match(share, /hasCatering: leg\.hasCatering !== false/);
  assert.match(publicApi, /hasCatering/);
  assert.match(page, /showsCateringStatus\(leg\) &&/);
});
