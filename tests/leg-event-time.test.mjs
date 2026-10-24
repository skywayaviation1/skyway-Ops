import assert from 'node:assert/strict';
import test from 'node:test';

import { statusEventAt } from '../src/trip-status.js';
import {
  airborneEta,
  displayedMilestoneAt,
  etaInstant,
  flightAwareEventMs,
  preserveClearedEvent,
  resolveMilestoneOn,
} from '../src/leg-event-time.js';

// Jake's example, America/New_York: wheels up 8:43, retoggle 8:55.
const WHEELS_UP = Date.parse('2026-08-10T12:43:00Z');
const RETOGGLE = Date.parse('2026-08-10T12:55:00Z');
const SCHEDULED_OFF = Date.parse('2026-08-10T12:30:00Z');
const SCHEDULED_ON = Date.parse('2026-08-10T14:00:00Z');
const BLOCK_MS = SCHEDULED_ON - SCHEDULED_OFF;

test('a wheels-up retoggle keeps 8:43 and does not stamp 8:55', () => {
  const existing = {
    timestamp: WHEELS_UP,
    originalTimestamp: WHEELS_UP,
    timestampSource: 'manual',
    author: 'Jake',
    notified: true,
  };
  const again = resolveMilestoneOn({
    stepId: 'wheels_up',
    existing,
    clickedAt: RETOGGLE,
    from: 'TEB',
    to: 'PBI',
    now: RETOGGLE,
  });
  assert.equal(again.kept, true);
  assert.equal(again.timestamp, WHEELS_UP);
  assert.equal(again.originalTimestamp, WHEELS_UP);
  assert.equal(again.recordedAt, RETOGGLE);
  assert.equal(again.notified, true);
  assert.equal(displayedMilestoneAt({ stepId: 'wheels_up', entry: existing }).atMs, WHEELS_UP);
});

test('turning wheels-up off and back on restores 8:43', () => {
  const cleared = preserveClearedEvent({
    timestamp: WHEELS_UP,
    originalTimestamp: WHEELS_UP,
    timestampSource: 'manual',
    author: 'Jake',
    notified: true,
  }, RETOGGLE);
  const restored = resolveMilestoneOn({
    stepId: 'wheels_up',
    existing: null,
    preserved: cleared,
    clickedAt: RETOGGLE,
    now: RETOGGLE,
  });
  assert.equal(restored.timestamp, WHEELS_UP);
  assert.equal(restored.originalTimestamp, WHEELS_UP);
  assert.equal(restored.recordedAt, RETOGGLE);
  assert.equal(restored.author, 'Jake');
});

test('the first wheels-up uses FlightAware actual_off when the leg matches', () => {
  const resolved = resolveMilestoneOn({
    stepId: 'wheels_up',
    clickedAt: RETOGGLE,
    from: 'TEB',
    to: 'PBI',
    now: RETOGGLE,
    flightAware: {
      airborne: true,
      origin: 'KTEB',
      destination: 'KPBI',
      actualOff: new Date(WHEELS_UP).toISOString(),
      faFlightId: 'fa-1',
    },
  });
  assert.equal(resolved.kept, false);
  assert.equal(resolved.timestamp, WHEELS_UP);
  assert.equal(resolved.timestampSource, 'flightaware');
  assert.equal(resolved.recordedAt, RETOGGLE);
  assert.equal(resolved.faFlightId, 'fa-1');
});

test('a previous flight actual_off is not reused for a new wheels-up', () => {
  const resolved = resolveMilestoneOn({
    stepId: 'wheels_up',
    clickedAt: RETOGGLE,
    from: 'TEB',
    to: 'PBI',
    now: RETOGGLE,
    flightAware: {
      airborne: false,
      origin: 'KTEB',
      actualOff: new Date(WHEELS_UP).toISOString(),
      actualOn: new Date(WHEELS_UP + 60 * 60 * 1000).toISOString(),
    },
  });
  assert.equal(resolved.timestamp, RETOGGLE);
  assert.equal(resolved.timestampSource, 'manual');
});

test('landing keeps its original time, and FlightAware actual_on fills an empty one', () => {
  const landedAt = Date.parse('2026-08-10T14:10:00Z');
  const click = Date.parse('2026-08-10T14:22:00Z');
  const kept = resolveMilestoneOn({
    stepId: 'landed',
    existing: { timestamp: landedAt, originalTimestamp: landedAt, timestampSource: 'manual', notified: true },
    clickedAt: click,
    now: click,
    to: 'PBI',
    flightAware: { airborne: false, destination: 'KPBI', actualOn: '2026-08-10T14:08:00Z' },
  });
  assert.equal(kept.timestamp, landedAt);
  assert.equal(kept.recordedAt, click);

  const fromFa = resolveMilestoneOn({
    stepId: 'landed',
    clickedAt: click,
    now: click,
    to: 'PBI',
    flightAware: {
      airborne: false,
      destination: 'KPBI',
      actualOn: '2026-08-10T14:08:00Z',
    },
  });
  assert.equal(fromFa.timestamp, Date.parse('2026-08-10T14:08:00Z'));
  assert.equal(fromFa.timestampSource, 'flightaware');
  assert.equal(flightAwareEventMs('landed', { airborne: true, actualOn: '2026-08-10T14:08:00Z' }, { to: 'PBI', now: click }), null);
});

test('ETA prefers FlightAware estimated_on, else original wheels-up plus the block', () => {
  const live = airborneEta({
    flightAware: { airborne: true, destination: 'KPBI', estimatedOn: '2026-08-10T14:05:00Z' },
    wheelsUpAt: WHEELS_UP,
    scheduledStart: SCHEDULED_OFF,
    scheduledEnd: SCHEDULED_ON,
    to: 'PBI',
  });
  assert.equal(live.source, 'flightaware');
  assert.equal(live.etaMs, Date.parse('2026-08-10T14:05:00Z'));
  assert.equal(etaInstant(live), '2026-08-10T14:05:00Z');

  const calculated = airborneEta({
    flightAware: { airborne: true, destination: 'KTEB', estimatedOn: '2026-08-10T14:05:00Z' },
    wheelsUpAt: WHEELS_UP,
    scheduledStart: SCHEDULED_OFF,
    scheduledEnd: SCHEDULED_ON,
    to: 'PBI',
  });
  assert.equal(calculated.source, 'wheels-up-block');
  assert.equal(calculated.etaMs, WHEELS_UP + BLOCK_MS);
  assert.notEqual(calculated.etaMs, RETOGGLE + BLOCK_MS);

  const scheduled = airborneEta({
    scheduledStart: SCHEDULED_OFF,
    scheduledEnd: SCHEDULED_ON,
    to: 'PBI',
  });
  assert.equal(scheduled.source, 'scheduled');
  assert.equal(scheduled.etaMs, SCHEDULED_ON);
});

test('readers keep the original milestone when a later timestamp was written over it', () => {
  const entry = { originalTimestamp: WHEELS_UP, timestamp: RETOGGLE };
  assert.equal(statusEventAt(entry), WHEELS_UP);
  assert.equal(displayedMilestoneAt({ stepId: 'wheels_up', entry }).atMs, WHEELS_UP);
});
