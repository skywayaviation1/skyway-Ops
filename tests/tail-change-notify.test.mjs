import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { applyNotifySafety, isNotifyTestMode, notifyTestRecipient } from '../api/_lib/notifySafety.js';
import {
  applyLegTailUpdate,
  buildTailChangeEmail,
  isAssignedTail,
  legIsClosed,
  planTailUpdate,
} from '../api/_tail-change.js';
import { REPLY_TO_CONTACT } from '../api/_email-signature.js';

const BROKER = 'dispatch@example-broker.test';
const LIVE = { NOTIFY_TEST_MODE: 'false' };

function leg(tail, extra = {}) {
  return {
    tripMeta: {
      tail,
      from: 'KAPF',
      to: 'KTEB',
      start: '2026-09-28T14:00:00.000Z',
      end: '2026-09-28T17:30:00.000Z',
      aircraftType: extra.oldType || 'Citation CJ3',
      tripCode: 'TEST01',
    },
    brokerEmail: BROKER,
    completed: false,
    ...extra.doc,
  };
}

const incoming = (tail, extra = {}) => ({
  tail,
  from: 'KAPF',
  to: 'KTEB',
  start: '2026-09-28T14:00:00.000Z',
  end: '2026-09-28T17:30:00.000Z',
  legType: 'REVENUE',
  aircraftType: extra.aircraftType || 'Lear 45',
  tripCode: 'TEST01',
  isFlight: true,
  ...extra,
});

test('notify safety defaults to test mode and a single test recipient', () => {
  assert.equal(isNotifyTestMode({}), true);
  assert.equal(isNotifyTestMode({ NOTIFY_TEST_MODE: '' }), true);
  assert.equal(isNotifyTestMode({ NOTIFY_TEST_MODE: 'true' }), true);
  assert.equal(isNotifyTestMode({ NOTIFY_TEST_MODE: 'false' }), false);
  assert.equal(notifyTestRecipient({}), 'jake@flyskyway.com');
  assert.equal(notifyTestRecipient({ NOTIFY_TEST_RECIPIENT: 'qa@example.test' }), 'qa@example.test');

  const safe = applyNotifySafety({
    to: [BROKER, 'second@example.test'],
    cc: [REPLY_TO_CONTACT],
    bcc: ['hidden@example.test'],
    subject: 'Tail change: TEST01 KAPF-KTEB now N222',
    text: 'Previous tail: N111',
    html: '<p>Previous tail: N111</p>',
  }, {});

  assert.equal(safe.testMode, true);
  assert.deepEqual(safe.to, ['jake@flyskyway.com']);
  assert.deepEqual(safe.cc, []);
  assert.deepEqual(safe.bcc, []);
  assert.equal(safe.subject, '[TEST] Tail change: TEST01 KAPF-KTEB now N222');
  assert.match(safe.text, /Intended To: dispatch@example-broker\.test, second@example\.test/);
  assert.match(safe.text, new RegExp(`Intended Cc: ${REPLY_TO_CONTACT}`));
  assert.match(safe.text, /Intended Bcc: hidden@example\.test/);
  assert.match(safe.html, /Intended To:/);
  assert.match(safe.html, /Previous tail: N111/);
  assert.doesNotMatch(safe.to.join(' '), /example-broker/);
});

test('live mode leaves the real recipients alone', () => {
  const safe = applyNotifySafety({
    to: [BROKER],
    cc: [REPLY_TO_CONTACT],
    subject: 'Tail change: TEST01 KAPF-KTEB now N222',
    text: 'body',
  }, LIVE);
  assert.equal(safe.testMode, false);
  assert.deepEqual(safe.to, [BROKER]);
  assert.deepEqual(safe.cc, [REPLY_TO_CONTACT]);
  assert.equal(safe.subject, 'Tail change: TEST01 KAPF-KTEB now N222');
  assert.equal(safe.text, 'body');
});

test('a tail set for the first time is not a change', () => {
  assert.equal(isAssignedTail(''), false);
  assert.equal(isAssignedTail('TBD'), false);
  for (const previous of [null, {}, { tripMeta: { tail: '' } }, { tripMeta: { tail: 'TBD' } }]) {
    const plan = planTailUpdate(previous, incoming('N222AA'), { docId: 'leg-1' });
    assert.equal(plan.action, 'write');
    assert.equal(plan.reason, 'first-assignment');
    assert.equal(plan.email, null);
  }
});

test('completed and cancelled legs do not send', () => {
  assert.equal(legIsClosed({ completed: true }, {}), true);
  assert.equal(legIsClosed({}, { cancelled: true }), true);
  assert.equal(legIsClosed({}, { summary: 'CANCELLED charter' }), true);

  const completed = planTailUpdate(
    leg('N111AA', { doc: { completed: true } }),
    incoming('N222AA'),
    { docId: 'leg-1' },
  );
  assert.equal(completed.reason, 'not-live');
  assert.equal(completed.email, null);

  const cancelled = planTailUpdate(
    leg('N111AA'),
    incoming('N222AA', { summary: 'Cancelled by broker', cancelled: true }),
    { docId: 'leg-1' },
  );
  assert.equal(cancelled.reason, 'not-live');
});

test('a real tail change builds one broker email and ignores a repeat save', () => {
  const first = planTailUpdate(leg('N111AA'), incoming('N222AA'), {
    docId: 'leg-1',
    trackingUrl: 'https://ops.example.test/trip-track.html?token=synthetic',
  });
  assert.equal(first.action, 'send');
  assert.equal(first.reason, 'tail-changed');
  assert.equal(first.email.subject, 'Tail change: TEST01 KAPF-KTEB now N222AA');
  assert.deepEqual(first.email.to, [BROKER]);
  assert.deepEqual(first.email.cc, [REPLY_TO_CONTACT]);
  assert.match(first.email.text, /Previous tail: N111AA/);
  assert.match(first.email.text, /New tail: N222AA/);
  assert.match(first.email.text, /Trip: TEST01/);
  assert.match(first.email.text, /Route: KAPF-KTEB/);
  assert.match(first.email.text, /Departure: 2026-09-28 14:00Z/);
  assert.match(first.email.text, /Arrival: 2026-09-28 17:30Z/);
  assert.match(first.email.text, /Aircraft type: Lear 45/);
  assert.match(first.email.text, /Previous aircraft type: Citation CJ3/);
  assert.match(first.email.text, /token=synthetic/);

  const saved = {
    ...leg('N222AA'),
    tripMeta: first.patch.tripMeta,
    tailNotice: first.patch.tailNotice,
  };
  const repeat = planTailUpdate(saved, incoming('N222AA'), { docId: 'leg-1' });
  assert.equal(repeat.action, 'unchanged');
  assert.equal(repeat.email, null);
});

test('the same aircraft type is not repeated as a previous type', () => {
  const email = buildTailChangeEmail({
    tripId: 'TEST01',
    route: 'KAPF-KTEB',
    oldTail: 'N111AA',
    newTail: 'N222AA',
    aircraftType: 'Citation CJ3',
    oldAircraftType: 'Citation CJ3',
    trackingUrl: null,
  });
  assert.match(email.text, /Aircraft type: Citation CJ3/);
  assert.doesNotMatch(email.text, /Previous aircraft type/);
});

test('apply sends exactly one email per change, including under test mode', async () => {
  const db = memoryDb(leg('N111AA'));
  const sent = [];
  const deliver = async (message) => {
    sent.push(message);
    return { ok: true };
  };

  const first = await applyLegTailUpdate(db, 'leg-1', incoming('N222AA'), {
    env: {},
    deliver,
    trackingUrl: 'https://ops.example.test/trip-track.html?token=synthetic',
    recordSend: async (ref, entry) => {
      const data = (await ref.get()).data();
      await ref.set({
        activity: [...(data.activity || []), entry],
        tailNotice: { ...(data.tailNotice || {}), status: 'sent', sentAt: entry.at },
      }, { merge: true });
    },
  });
  assert.equal(first.sent, true);
  assert.equal(first.testMode, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['jake@flyskyway.com']);
  assert.deepEqual(sent[0].cc, []);
  assert.match(sent[0].subject, /^\[TEST\] Tail change: TEST01 KAPF-KTEB now N222AA/);
  assert.match(sent[0].html, /Intended To: dispatch@example-broker\.test/);
  assert.match(sent[0].html, new RegExp(REPLY_TO_CONTACT.replace(/[.]/g, '\\.')));
  assert.doesNotMatch(sent[0].to.join(','), /example-broker/);

  const activity = db.store.data.activity;
  assert.equal(activity.length, 1);
  assert.equal(activity[0].type, 'tail-change');
  assert.equal(activity[0].oldTail, 'N111AA');
  assert.equal(activity[0].newTail, 'N222AA');
  assert.ok(activity[0].at);
  assert.ok(activity[0].recipients.includes(BROKER));
  assert.ok(activity[0].recipients.includes(REPLY_TO_CONTACT));

  const repeat = await applyLegTailUpdate(db, 'leg-1', incoming('N222AA'), {
    env: {},
    deliver,
    trackingUrl: null,
  });
  assert.equal(repeat.sent, false);
  assert.equal(sent.length, 1);

  const next = await applyLegTailUpdate(db, 'leg-1', incoming('N333AA', { aircraftType: 'Citation CJ3' }), {
    env: LIVE,
    deliver,
    trackingUrl: null,
    recordSend: async (ref, entry) => {
      const data = (await ref.get()).data();
      await ref.set({
        activity: [...(data.activity || []), entry],
        tailNotice: { ...(data.tailNotice || {}), status: 'sent', sentAt: entry.at },
      }, { merge: true });
    },
  });
  assert.equal(next.sent, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].to, [BROKER]);
  assert.deepEqual(sent[1].cc, [REPLY_TO_CONTACT]);
  assert.match(sent[1].subject, /^Tail change: TEST01 KAPF-KTEB now N333AA/);
  assert.equal(db.store.data.activity.length, 2);
});

test('a failed send can be retried once, then stops', async () => {
  const db = memoryDb(leg('N111AA'));
  let calls = 0;
  const deliver = async () => {
    calls += 1;
    return { ok: false, error: 'mailbox down' };
  };
  const recordFailure = async (ref) => {
    const data = (await ref.get()).data();
    await ref.set({
      tailNotice: { ...(data.tailNotice || {}), status: 'failed', error: 'mailbox down' },
    }, { merge: true });
  };

  const failed = await applyLegTailUpdate(db, 'leg-1', incoming('N222AA'), {
    env: LIVE,
    deliver,
    trackingUrl: null,
    recordFailure,
  });
  assert.equal(failed.sent, false);
  assert.equal(calls, 1);
  assert.equal(db.store.data.tripMeta.tail, 'N222AA');

  const retry = await applyLegTailUpdate(db, 'leg-1', incoming('N222AA'), {
    env: LIVE,
    deliver: async () => {
      calls += 1;
      return { ok: true };
    },
    trackingUrl: null,
    recordSend: async (ref, entry) => {
      const data = (await ref.get()).data();
      await ref.set({
        activity: [entry],
        tailNotice: { ...(data.tailNotice || {}), status: 'sent' },
      }, { merge: true });
    },
  });
  assert.equal(retry.sent, true);
  assert.equal(retry.reason, 'retry-failed');
  assert.equal(calls, 2);

  await applyLegTailUpdate(db, 'leg-1', incoming('N222AA'), {
    env: LIVE,
    deliver: async () => {
      calls += 1;
      return { ok: true };
    },
    trackingUrl: null,
  });
  assert.equal(calls, 2);
});

test('an empty notify list updates the tail and does not send', () => {
  const plan = planTailUpdate(
    { ...leg('N111AA'), brokerEmail: '' },
    incoming('N222AA', { brokerEmail: '' }),
    { docId: 'leg-1' },
  );
  assert.equal(plan.reason, 'no-recipients');
  assert.equal(plan.email, null);
  assert.equal(plan.patch.tripMeta.tail, 'N222AA');
});

test('schedule sync, manual save, and operator mint all reach the notice', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = (file) => readFile(path.join(root, file), 'utf8');
  const data = await read('src/firebase-data.js');
  const app = await read('src/App.jsx');
  const backfill = await read('api/flightaware-backfill-tripmeta.js');
  const operator = await read('api/operator-link.js');
  assert.match(data, /export async function syncLegTail/);
  assert.match(data, /export async function saveManualTrip/);
  assert.match(data, /syncLegTail\(trip\.uid, legTailInput/);
  assert.match(app, /syncUpcomingLegTails/);
  assert.match(app, /LEG ACTIVITY/);
  assert.match(backfill, /applyLegTailUpdate/);
  assert.match(operator, /applyLegTailUpdate/);
});

function memoryDb(initial) {
  const store = { data: initial ? structuredClone(initial) : null, exists: Boolean(initial) };
  const merge = (base, patch) => {
    const next = { ...(base || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        next[key] = { ...(next[key] || {}), ...value };
      } else {
        next[key] = value;
      }
    }
    return next;
  };
  const ref = {
    async get() {
      return { exists: store.exists, data: () => store.data };
    },
    async update(patch) {
      store.exists = true;
      const next = { ...(store.data || {}) };
      for (const [key, value] of Object.entries(patch)) {
        if (key.includes('.')) {
          const [parent, child] = key.split('.');
          next[parent] = { ...(next[parent] || {}), [child]: value };
        } else {
          next[key] = value;
        }
      }
      store.data = next;
    },
    async set(patch, opts) {
      store.exists = true;
      store.data = opts?.merge ? merge(store.data, patch) : patch;
    },
  };
  return {
    store,
    collection() {
      return { doc() { return ref; } };
    },
    async runTransaction(fn) {
      const tx = {
        async get() {
          return { exists: store.exists, data: () => store.data };
        },
        set(_ref, patch, opts) {
          store.exists = true;
          store.data = opts?.merge ? merge(store.data, patch) : patch;
        },
      };
      return fn(tx);
    },
  };
}
