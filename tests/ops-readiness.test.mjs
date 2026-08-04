import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildActiveOpsTrips,
  computeOutstanding,
  readinessLevel,
  readinessProgress,
} from '../src/ops-readiness.js';

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
