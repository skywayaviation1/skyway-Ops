import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  publicMovementNotification,
  sanitizePublicLeg,
} from '../src/broker-share-privacy.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('private previous leg is forced to repositioning and strips private fields', () => {
  const sanitized = sanitizePublicLeg({
    tripId: 'previous-private-trip',
    legNumber: 1,
    from: 'TVC',
    to: 'IAD',
    fromFbo: 'Private Client FBO',
    toFbo: 'Confidential Destination FBO',
    category: 'REVENUE',
    picName: 'Captain Private',
    sicName: 'First Officer Private',
    showPax: true,
    hasCatering: true,
    pax: [{ name: 'Private Passenger', status: 'checked_in' }],
    privacyMode: 'repositioning',
    notifyBroker: true,
    status: {
      crew_onsite: { at: 1 },
      pax_boarded: { at: 2 },
      taxi_dep: { at: 3 },
      wheels_up: { at: 4 },
      landed: { at: 5 },
    },
  });

  assert.equal(sanitized.category, 'REPOSITIONING');
  assert.equal(sanitized.fromFbo, null);
  assert.equal(sanitized.toFbo, null);
  assert.equal(sanitized.picName, null);
  assert.equal(sanitized.sicName, null);
  assert.equal(sanitized.showPax, false);
  assert.deepEqual(sanitized.pax, []);
  assert.equal(sanitized.hasCatering, false);
  assert.deepEqual(Object.keys(sanitized.status), ['taxi_dep', 'wheels_up', 'landed']);
  assert.equal(sanitized.notifyBroker, true);
});

test('linked-leg notification describes repositioning without private trip data', () => {
  const notification = publicMovementNotification({
    tail: 'N286N',
    from: 'TVC',
    to: 'IAD',
    stepId: 'wheels_up',
    eventTimeText: '14:05 EDT',
    trackingUrl: 'https://example.test/trip-track?token=safe',
  });
  assert.match(notification.subject, /N286N repositioning update/);
  assert.match(notification.text, /TVC → IAD/);
  assert.match(notification.text, /Passenger, customer, broker, crew, and other private trip details are not shared/);
  assert.match(notification.text, /https:\/\/example\.test\/trip-track/);
  assert.doesNotMatch(notification.text, /Private Passenger|Captain Private|original broker/i);
});

test('share, manual, webhook, and cron paths wire linked-leg notifications', async () => {
  const share = await source('api/trip-share.js');
  const manual = await source('api/broker-share-notify.js');
  const webhook = await source('api/flightaware-webhook.js');
  const cron = await source('api/flightaware-cron-poll.js');
  const publicApi = await source('api/trip-public.js');
  const app = await source('src/App.jsx');

  assert.match(share, /syncBrokerShareSubscriptions/);
  assert.match(share, /removeBrokerShareSubscriptions/);
  assert.match(manual, /notifyBrokerShareSubscribers/);
  assert.match(webhook, /notifyBrokerShareSubscribers/);
  assert.match(cron, /notifyBrokerShareSubscribers/);
  assert.match(publicApi, /privacyMode === 'repositioning'/);
  assert.match(app, /previousShareableLegs/);
  assert.match(app, /\/api\/broker-share-notify/);
});
