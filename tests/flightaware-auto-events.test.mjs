import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  aircraftIdentFromFlight,
  airportCode,
  eventTimestamp,
  flightAwareEventCode,
  observedFlightMilestones,
} from '../src/flightaware-event-utils.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('AeroAPI event_code and registration drive webhook matching', () => {
  const payload = {
    event_code: 'on',
    flight: {
      ident: 'WUP286',
      registration: 'N-286N',
      actual_off: '2026-09-13T00:10:00Z',
      actual_on: '2026-09-13T01:10:00Z',
    },
  };
  assert.equal(flightAwareEventCode(payload), 'on');
  assert.equal(aircraftIdentFromFlight(payload.flight), 'N286N');
  assert.equal(eventTimestamp(payload.flight, 'on'), payload.flight.actual_on);
});

test('bundled event names and string airport codes normalize safely', () => {
  assert.equal(flightAwareEventCode({ event_code: 'departure' }), 'off');
  assert.equal(flightAwareEventCode({ event_code: 'arrival' }), 'on');
  assert.equal(airportCode(' ktvc '), 'KTVC');
  assert.equal(airportCode({ code_icao: 'KIAD' }), 'KIAD');
});

test('poll reconciliation derives every durable departure and landing fact', () => {
  const state = {
    actualOut: '2026-09-13T00:00:00Z',
    actualOff: '2026-09-13T00:05:00Z',
    actualOn: '2026-09-13T01:05:00Z',
  };
  assert.deepEqual(
    observedFlightMilestones(state).map(({ stepId, eventType }) => ({ stepId, eventType })),
    [
      { stepId: 'taxi_dep', eventType: 'out' },
      { stepId: 'wheels_up', eventType: 'off' },
      { stepId: 'landed', eventType: 'on' },
    ],
  );
});

test('webhook parses event_code and cron reconciles timestamps without requiring a transition', async () => {
  const webhook = await source('api/flightaware-webhook.js');
  const cron = await source('api/flightaware-cron-poll.js');

  assert.match(webhook, /flightAwareEventCode\(body\)/);
  assert.match(webhook, /aircraftIdentFromFlight\(flight\)/);
  assert.match(webhook, /eventTimestamp\(flight, eventType\)/);
  assert.doesNotMatch(webhook, /body\.event \|\| body\['@type'\]/);

  assert.match(cron, /for \(const milestone of observedFlightMilestones\(observed\)\)/);
  assert.match(cron, /\(f\.actual_out \|\| f\.actual_off\) && !f\.actual_on/);
  assert.match(cron, /Taxiing for Departure/);
  assert.doesNotMatch(cron, /previous\.airborne === false && current\.airborne === true/);
  assert.doesNotMatch(cron, /autoFiredEvents\[stepId\]\) \{\s*return \{ skipped: 'already-auto-fired'/);
});
