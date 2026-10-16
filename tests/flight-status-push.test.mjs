import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildPushMessage,
  dispatchToRecipients,
  resolveTripPushRecipients,
} from '../api/send-push.js';
import {
  CREW_STATUS_PUSH_WINDOW_MS,
  buildFlightStatusPushText,
  claimFlightStatusPush,
  formatPushClock,
  notifyFlightStatusPush,
  recentCrewStatusTap,
  resolveFlightPushContext,
} from '../api/flightaware-cron-poll.js';

const ETA = '2026-10-16T15:42:00.000Z';
const TRIP_UID = '7a32dd47-6a5c-4c9c-b53b-864381bacebf';

function memoryDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  function collection(path) {
    return {
      doc(id) {
        const docPath = `${path}/${id}`;
        return {
          async get() {
            const data = store.has(docPath) ? store.get(docPath) : undefined;
            return { exists: data !== undefined, id, data: () => data };
          },
          async create(data) {
            if (store.has(docPath)) {
              const err = new Error('6 ALREADY_EXISTS: Document already exists');
              err.code = 6;
              throw err;
            }
            store.set(docPath, { ...data });
          },
          async set(data, opts = {}) {
            const prev = store.get(docPath) || {};
            store.set(docPath, opts.merge ? { ...prev, ...data } : { ...data });
          },
          async update(data) {
            store.set(docPath, { ...(store.get(docPath) || {}), ...data });
          },
          async delete() {
            store.delete(docPath);
          },
          collection(name) {
            return collection(`${docPath}/${name}`);
          },
        };
      },
      async get() {
        const prefix = `${path}/`;
        const docs = [];
        for (const [key, data] of store) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (rest.includes('/')) continue;
          docs.push({ id: rest, data: () => data });
        }
        return {
          empty: docs.length === 0,
          docs,
          forEach(fn) { for (const doc of docs) fn(doc); },
        };
      },
    };
  }
  return { collection, store };
}

function user(uid, extra) {
  return [`users/${uid}`, { name: extra.name, role: extra.role || 'pilot', approved: extra.approved !== false, ...extra.profile }];
}

function token(uid, value) {
  return [`users/${uid}/push-tokens/${value}`, { token: value }];
}

const QUIET = {
  quietHours: { enabled: true, startHour: 0, endHour: 24, tz: 'UTC' },
};

function crewDb() {
  return memoryDb(Object.fromEntries([
    user('ada', { name: 'Ada Lovelace' }),
    token('ada', 'tok-ada'),
    user('grace', { name: 'Grace Hopper' }),
    token('grace', 'tok-grace'),
    user('ops', { name: 'Olivia Ops', role: 'ops' }),
    token('ops', 'tok-ops'),
    user('quiet', { name: 'Quinn Quiet', role: 'ops', profile: QUIET }),
    token('quiet', 'tok-quiet'),
    user('other', { name: 'Other Pilot' }),
    token('other', 'tok-other'),
    user('blocked', { name: 'Ada Lovelace', approved: false }),
    token('blocked', 'tok-blocked'),
  ]));
}

function recordingMessaging() {
  const sent = [];
  return {
    sent,
    async sendEachForMulticast(message) {
      sent.push(message);
      return {
        successCount: message.tokens.length,
        failureCount: 0,
        responses: message.tokens.map(() => ({ success: true })),
      };
    },
  };
}

function sentTokens(messaging) {
  return messaging.sent.flatMap((message) => message.tokens).sort();
}

const eventState = {
  ident: 'n341cj',
  origin: 'kteb',
  destination: 'kpbi',
  destinationTz: 'America/New_York',
  estimatedOn: ETA,
  actualOn: ETA,
};

test('native pushes show an alert and web stays data-only', () => {
  const message = buildPushMessage({
    title: 'Wheels up',
    body: 'N341CJ wheels up KTEB → KPBI',
    data: {
      url: '/?trip=leg#status',
      tripId: 'leg',
      conversationId: '',
      senderUid: 'flightaware',
      senderName: 'FlightAware Tracking',
      kind: 'trip-status',
    },
  });

  assert.equal(Object.hasOwn(message, 'notification'), false);
  assert.equal(Object.hasOwn(message.webpush, 'notification'), false);
  assert.equal(message.webpush.headers.Urgency, 'high');
  assert.deepEqual(message.apns.payload.aps.alert, {
    title: 'Wheels up',
    body: 'N341CJ wheels up KTEB → KPBI',
  });
  assert.equal(message.apns.payload.aps.sound, 'default');
  assert.equal(Object.hasOwn(message.apns.payload.aps, 'contentAvailable'), false);
  assert.equal(message.apns.headers['apns-priority'], '10');
  assert.equal(message.apns.headers['apns-push-type'], 'alert');
  assert.equal(message.android.priority, 'high');
  assert.deepEqual(message.android.notification, {
    title: 'Wheels up',
    body: 'N341CJ wheels up KTEB → KPBI',
    sound: 'default',
  });
  assert.equal(message.data.kind, 'trip-status');
  assert.equal(message.data.url, '/?trip=leg#status');
  assert.equal(message.data.title, 'Wheels up');
  assert.equal(JSON.stringify(message).includes('contentAvailable'), false);
  assert.equal(JSON.stringify(message).includes('content-available'), false);
});

test('status-step recipients are PIC, SIC, and dispatchers', () => {
  const users = [
    { uid: 'pic', name: 'David Chiles', role: 'pilot', approved: true },
    { uid: 'sic', name: 'Mia Chen', role: 'pilot', approved: true },
    { uid: 'ops', name: 'Pat Ops', role: 'ops', approved: true },
    { uid: 'other-ops', name: 'Other Ops', role: 'ops', approved: true },
    { uid: 'stranger', name: 'Sam Stranger', role: 'pilot', approved: true },
    { uid: 'nope', name: 'David Chiles', role: 'pilot', approved: false },
  ];
  const matched = resolveTripPushRecipients({
    users,
    picName: 'David Michael Chiles',
    sicName: 'Mia Chen',
    dispatcherUids: ['ops'],
    excludeUid: 'pic',
  });
  assert.deepEqual(matched.recipients.sort(), ['ops', 'sic']);
  assert.deepEqual(matched.why.sic, ['SIC']);
  assert.deepEqual(matched.why.ops, ['dispatcher']);
  assert.ok(matched.why.pic.includes('PIC'));

  const fallback = resolveTripPushRecipients({
    users,
    picName: 'David Michael Chiles',
    sicName: '',
    dispatcherUids: [],
  });
  assert.deepEqual(fallback.recipients.sort(), ['ops', 'other-ops', 'pic']);
});

test('push clocks use destination local time with a short zone', () => {
  assert.equal(formatPushClock(ETA, 'America/New_York'), '11:42 ET');
  assert.equal(formatPushClock('2026-01-15T16:42:00.000Z', 'America/New_York'), '11:42 ET');
  assert.equal(formatPushClock('2026-07-15T19:05:00.000Z', 'America/Chicago'), '14:05 CT');
  assert.equal(formatPushClock(ETA, ''), '15:42Z');
});

test('wheels-up and landed copy use the trip ID and never a trip number', () => {
  const ctx = resolveFlightPushContext({
    tripState: {
      tripNumber: '104281',
      tripSheetData: { tripCode: 'ABC123' },
      tripMeta: { tripNumber: '999001' },
    },
    leg: { tripNumber: '3218', pic: 'Ada Lovelace', sic: { name: 'Grace Hopper' } },
    tripDoc: { info: { tripNumber: '104281', tripId: '104281' }, dispatcherUids: ['ops'] },
    eventState,
    stepId: 'wheels_up',
  });
  assert.equal(ctx.tripId, 'ABC123');
  assert.equal(ctx.picName, 'Ada Lovelace');
  assert.equal(ctx.sicName, 'Grace Hopper');
  assert.equal(
    buildFlightStatusPushText({ ...ctx, stepId: 'wheels_up', etaIso: ETA, timeZone: ctx.timeZone }),
    'N341CJ wheels up KTEB → KPBI · Trip ABC123 · ETA 11:42 ET',
  );
  assert.equal(
    buildFlightStatusPushText({ ...ctx, stepId: 'landed', eventIso: ETA, timeZone: ctx.timeZone }),
    'N341CJ landed KTEB → KPBI · Trip ABC123 · 11:42 ET',
  );

  const numbersOnly = resolveFlightPushContext({
    tripState: { tripNumber: '104281', tripCode: '104281' },
    leg: { tripNumber: '3218' },
    tripDoc: { info: { tripNumber: '88', tripId: '104281' } },
    eventState,
    stepId: 'wheels_up',
  });
  assert.equal(numbersOnly.tripId, null);
  const unlabeled = buildFlightStatusPushText({
    ...numbersOnly,
    stepId: 'wheels_up',
    etaIso: ETA,
    timeZone: 'America/New_York',
  });
  assert.equal(unlabeled, 'N341CJ wheels up KTEB → KPBI · ETA 11:42 ET');
  assert.doesNotMatch(unlabeled, /104281|3218|Trip /);
});

test('a crew tap inside 10 minutes suppresses the automatic push', () => {
  const now = Date.parse('2026-10-16T15:00:00.000Z');
  const tapped = { timestamp: now - 2 * 60 * 1000, author: 'Ada Lovelace', notified: true };
  assert.equal(recentCrewStatusTap(tapped, now), true);
  assert.equal(recentCrewStatusTap({
    timestamp: now - CREW_STATUS_PUSH_WINDOW_MS,
    author: 'Ada Lovelace',
  }, now), true);
  assert.equal(recentCrewStatusTap({
    timestamp: now - CREW_STATUS_PUSH_WINDOW_MS - 1,
    author: 'Ada Lovelace',
  }, now), false);
  assert.equal(recentCrewStatusTap({
    timestamp: now - 60 * 1000,
    author: 'FlightAware Tracking',
    autoFired: true,
  }, now), false);
  assert.equal(recentCrewStatusTap(null, now), false);
});

test('each leg sends at most one wheels-up and one landed push', async () => {
  const db = crewDb();
  const messaging = recordingMessaging();
  const leg = { pic: 'Ada Lovelace', sic: 'Grace Hopper', tripCode: 'ABC123' };
  const args = {
    db,
    messaging,
    tripUid: TRIP_UID,
    tripState: { tripSheetData: { tripCode: 'ABC123' }, statuses: {} },
    stepId: 'wheels_up',
    eventState,
    users: [
      { uid: 'ada', name: 'Ada Lovelace', role: 'pilot', approved: true },
      { uid: 'grace', name: 'Grace Hopper', role: 'pilot', approved: true },
      { uid: 'ops', name: 'Olivia Ops', role: 'ops', approved: true },
      { uid: 'quiet', name: 'Quinn Quiet', role: 'ops', approved: true, ...QUIET },
      { uid: 'other', name: 'Other Pilot', role: 'pilot', approved: true },
    ],
    leg,
    tripDoc: null,
  };

  const first = await notifyFlightStatusPush(args);
  assert.equal(first.body, 'N341CJ wheels up KTEB → KPBI · Trip ABC123 · ETA 11:42 ET');
  assert.equal(first.title, 'Wheels up');
  assert.equal(messaging.sent.length, 3);
  assert.deepEqual(sentTokens(messaging), ['tok-ada', 'tok-grace', 'tok-ops']);
  for (const message of messaging.sent) {
    assert.equal(message.data.kind, 'trip-status');
    assert.equal(message.data.tripId, TRIP_UID);
    assert.match(message.data.url, new RegExp(`${TRIP_UID}#status`));
    assert.equal(Object.hasOwn(message, 'notification'), false);
    assert.equal(Object.hasOwn(message.webpush, 'notification'), false);
    assert.deepEqual(message.apns.payload.aps.alert, { title: 'Wheels up', body: first.body });
    assert.equal(Object.hasOwn(message.apns.payload.aps, 'contentAvailable'), false);
    assert.deepEqual(message.android.notification, {
      title: 'Wheels up',
      body: first.body,
      sound: 'default',
    });
  }
  assert.doesNotMatch(first.body, /104281|7a32dd47/);

  const retry = await notifyFlightStatusPush(args);
  assert.equal(retry.skipped, 'already-claimed');
  assert.equal(messaging.sent.length, 3);

  const landed = await notifyFlightStatusPush({ ...args, stepId: 'landed' });
  assert.equal(landed.body, 'N341CJ landed KTEB → KPBI · Trip ABC123 · 11:42 ET');
  assert.equal(messaging.sent.length, 6);
  assert.equal(messaging.sent[3].data.kind, 'trip-status');
  assert.doesNotMatch(landed.body, /ETA/);
});

test('a recent crew tap is claimed so a later poll still does not send', async () => {
  const now = Date.parse('2026-10-16T15:00:00.000Z');
  const db = crewDb();
  const messaging = recordingMessaging();
  const args = {
    db,
    messaging,
    tripUid: 'leg-1',
    tripState: {
      tripCode: 'ABC123',
      statuses: {
        wheels_up: { timestamp: now - 3 * 60 * 1000, author: 'Ada Lovelace', notified: true },
      },
    },
    stepId: 'wheels_up',
    eventState,
    now,
    leg: { pic: 'Ada Lovelace', sic: 'Grace Hopper', tripCode: 'ABC123' },
    tripDoc: null,
    users: [{ uid: 'ada', name: 'Ada Lovelace', role: 'pilot', approved: true }],
  };
  const skipped = await notifyFlightStatusPush(args);
  assert.equal(skipped.skipped, 'recent-crew-tap');
  assert.equal(messaging.sent.length, 0);

  const later = await notifyFlightStatusPush({
    ...args,
    now: now + 30 * 60 * 1000,
    tripState: { tripCode: 'ABC123', statuses: {} },
  });
  assert.equal(later.skipped, 'already-claimed');
  assert.equal(messaging.sent.length, 0);
});

test('overlapping claims allow one send', async () => {
  const db = memoryDb();
  const [first, second] = await Promise.all([
    claimFlightStatusPush(db, { tripUid: 'leg-9', stepId: 'wheels_up' }),
    claimFlightStatusPush(db, { tripUid: 'leg-9', stepId: 'wheels_up' }),
  ]);
  assert.equal(Number(first.claimed) + Number(second.claimed), 1);
  const again = await claimFlightStatusPush(db, { tripUid: 'leg-9', stepId: 'landed' });
  assert.equal(again.claimed, true);
});

test('explicit dispatchers replace the all-ops fallback', async () => {
  const db = crewDb();
  const messaging = recordingMessaging();
  const result = await notifyFlightStatusPush({
    db,
    messaging,
    tripUid: 'leg-explicit',
    tripState: { tripCode: 'M8VTQD' },
    stepId: 'wheels_up',
    eventState,
    leg: { pic: 'Ada Lovelace', sic: 'Grace Hopper' },
    tripDoc: { dispatcherUids: ['ops'], info: {} },
    users: [
      { uid: 'ada', name: 'Ada Lovelace', role: 'pilot', approved: true },
      { uid: 'grace', name: 'Grace Hopper', role: 'pilot', approved: true },
      { uid: 'ops', name: 'Olivia Ops', role: 'ops', approved: true },
      { uid: 'quiet', name: 'Quinn Quiet', role: 'ops', approved: true },
    ],
  });
  assert.equal(result.dispatched, 3);
  assert.deepEqual(sentTokens(messaging), ['tok-ada', 'tok-grace', 'tok-ops']);
});

test('dead device tokens are pruned', async () => {
  const db = memoryDb(Object.fromEntries([
    user('ada', { name: 'Ada Lovelace' }),
    token('ada', 'stale'),
  ]));
  const messaging = {
    async sendEachForMulticast() {
      return {
        successCount: 0,
        failureCount: 1,
        responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }],
      };
    },
  };
  const summary = await dispatchToRecipients({
    db,
    messaging,
    recipients: ['ada'],
    title: 'Wheels up',
    body: 'body',
    data: { kind: 'trip-status', url: '/', tripId: 'leg', conversationId: '', senderUid: '', senderName: 'Skyway' },
    muteKey: 'trip:leg',
  });
  assert.equal(summary.pruned, 1);
  const leftover = await db.collection('users').doc('ada').collection('push-tokens').doc('stale').get();
  assert.equal(leftover.exists, false);
});

test('cron push does not change broker email or FBO gating', async () => {
  const cron = await readFile(new URL('../api/flightaware-cron-poll.js', import.meta.url), 'utf8');
  const fbo = await readFile(new URL('../api/fbo-departure-cron.js', import.meta.url), 'utf8');
  assert.match(cron, /notifyFlightStatusPush/);
  assert.match(cron, /buildBrokerEmail/);
  assert.match(cron, /tripState\.autoNotify !== true/);
  assert.match(cron, /sendEmail\(host, brokerEmails, subject, body\)/);
  assert.doesNotMatch(cron, /FBO_AUTO_NOTIFY_DISABLED/);
  assert.match(fbo, /FBO_AUTO_NOTIFY_DISABLED === '1'/);
  assert.match(cron, /skipped: 'already-auto-fired'/);
});
