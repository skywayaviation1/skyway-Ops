import assert from 'node:assert/strict';
import test from 'node:test';

import { cronArrivalFollowUp, hasUndefined, omitUndefined, scrubFirestoreWrites } from '../src/omit-undefined.js';

test('omitUndefined drops arrival.timeChangeForEnd and keeps nulls', () => {
  const raw = {
    arrival: {
      email: 'teb@example.com',
      arrivalStatus: 'sent',
      timeChangeForEnd: undefined,
      sentForEnd: undefined,
      services: null,
    },
    updatedAt: 1,
  };
  assert.equal(hasUndefined(raw), 'arrival.timeChangeForEnd');
  const clean = omitUndefined(raw);
  assert.equal(hasUndefined(clean), null);
  assert.equal(Object.hasOwn(clean.arrival, 'timeChangeForEnd'), false);
  assert.equal(Object.hasOwn(clean.arrival, 'sentForEnd'), false);
  assert.equal(clean.arrival.services, null);
  assert.equal(clean.updatedAt, 1);
});

test('a schedule send with no prior time-change does not write undefined', () => {
  const leg = {
    end: '2026-10-11T18:00:00.000Z',
    arrival: {
      email: 'teb@example.com',
      arrivalStatus: 'not_sent',
    },
  };
  const broken = {
    arrival: {
      ...leg.arrival,
      arrivalStatus: 'sent',
      sentForEnd: leg.end,
      timeChangeForEnd: leg.arrival.timeChangeForEnd,
    },
  };
  assert.equal(hasUndefined(broken), 'arrival.timeChangeForEnd');
  const followUp = cronArrivalFollowUp(leg, 'schedule');
  assert.equal(hasUndefined({ arrival: followUp }), null);
  assert.equal(followUp.timeChangeForEnd, null);
  assert.equal(followUp.email, 'teb@example.com');
  assert.equal(followUp.arrivalStatus, 'sent');
  const changed = cronArrivalFollowUp(leg, 'time-change');
  assert.equal(changed.timeChangeForEnd, leg.end);
  assert.equal(changed.arrivalStatus, 'needs_reconfirm');
});

test('Firestore writes drop undefined arrival.timeChangeForEnd', async () => {
  const written = [];
  const ref = {
    set(data) { written.push(data); return Promise.resolve(); },
  };
  const db = {
    collection() {
      return { doc() { return ref; } };
    },
  };
  scrubFirestoreWrites(db);
  await db.collection('fbo-legs').doc('leg-1').set({
    arrival: {
      email: 'teb@example.com',
      timeChangeForEnd: undefined,
    },
    updatedAt: 5,
  });
  assert.equal(written.length, 1);
  assert.equal(hasUndefined(written[0]), null);
  assert.equal(Object.hasOwn(written[0].arrival, 'timeChangeForEnd'), false);
  assert.equal(written[0].arrival.email, 'teb@example.com');
});
