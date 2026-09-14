import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  WEAR_LANDINGS_PER_CHECK,
  landingCountSinceSession,
} from '../api/_wear-cadence.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('wear cadence counts unique actual landings since the latest check', () => {
  const sessionAt = 1_000_000;
  const trips = Array.from({ length: 10 }, (_, index) => ({
    id: `trip-${index + 1}`,
    statuses: { landed: { timestamp: sessionAt + (index + 1) * 1000 } },
  }));
  // A duplicate trip and a landing before the session do not count.
  trips.push({ id: 'trip-1', statuses: { landed: { timestamp: sessionAt + 5000 } } });
  trips.push({ id: 'old-trip', statuses: { landed: { timestamp: sessionAt - 1 } } });
  const result = landingCountSinceSession(trips, sessionAt);
  assert.equal(WEAR_LANDINGS_PER_CHECK, 10);
  assert.equal(result.count, 10);
  assert.equal(new Set(result.tripIds).size, 10);
});

test('manual and FlightAware reports for one trip remain idempotent', () => {
  const result = landingCountSinceSession([
    { id: 'trip-10', statuses: { landed: { at: 2_000_000 } } },
  ], 1_000_000, {
    tripUid: 'trip-10',
    landedAtMs: 2_000_100,
  });
  assert.equal(result.count, 1);
  assert.deepEqual(result.tripIds, ['trip-10']);
});

test('10th landing atomically marks due and repeats the crew push each landing', async () => {
  const cadence = await source('api/_wear-cadence.js');
  assert.match(cadence, /landings\.count >= WEAR_LANDINGS_PER_CHECK/);
  assert.match(cadence, /database\.runTransaction/);
  // Keyed on the landing count, not just the cycle, so every landing past
  // the threshold reminds the crew again while duplicates stay deduped.
  assert.match(cadence, /const notifyKey = `\$\{cycleId\}:\$\{landings\.count\}`/);
  assert.match(cadence, /pushNotifiedForCycle !== notifyKey/);
  assert.match(cadence, /pushPendingForCycle !== notifyKey/);
  assert.match(cadence, /sendEachForMulticast/);
  assert.match(cadence, /WEAR CHECK DUE/);
  assert.match(cadence, /departures are never blocked/);
  assert.match(cadence, /Urgency: 'high'/);
});

test('all landing writers feed the cadence and a due check never blocks departure', async () => {
  const app = await source('src/App.jsx');
  const webhook = await source('api/flightaware-webhook.js');
  const cron = await source('api/flightaware-cron-poll.js');
  assert.match(app, /action: 'landing'/);
  assert.match(app, /\['taxi_dep', 'wheels_up'\]/);
  assert.match(app, /wearBadgeState\?\.due === true/);
  assert.match(app, /onDueChange=\{setWearBadgeState\}/);
  assert.doesNotMatch(app, /Wear check required before departure/);

  const trigger = app.slice(
    app.indexOf('const handleStatusTrigger'),
    app.indexOf('const handleStatusUntrigger'),
  );
  assert.ok(trigger.length > 0);
  const dueBranch = trigger.slice(
    trigger.indexOf("wearCadenceState?.due === true"),
    trigger.indexOf('let gpsCoords'),
  );
  assert.match(dueBranch, /notify\.warning\('Wear check due — not blocking departure'/);
  assert.match(dueBranch, /Open wear check/);
  assert.doesNotMatch(dueBranch, /\breturn\b/);
  assert.match(trigger, /await updateStatus\(step, gpsCoords, autoNotify\)/);

  assert.match(webhook, /recordWearLanding/);
  assert.match(webhook, /source: 'flightaware-webhook'/);
  assert.match(cron, /recordWearLanding/);
  assert.match(cron, /source: 'flightaware-cron'/);
});

test('completed wear session resets due state and server count', async () => {
  const wear = await source('src/firebase-wear.js');
  const cadence = await source('api/_wear-cadence.js');
  assert.match(wear, /action: 'session-complete'/);
  assert.match(cadence, /landingsSinceSession: 0/);
  assert.match(cadence, /due: false/);
  assert.match(cadence, /pushNotifiedForCycle: null/);
});

