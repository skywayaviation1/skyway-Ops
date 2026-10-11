import assert from 'node:assert/strict';
import test from 'node:test';

import { runFboCron, sendArrivalSchedule } from '../api/_fbo-server.js';

const HOUR = 60 * 60 * 1000;
const SECRET = 'test-fbo-link-secret-value-24';

function assertFirestoreValue(value, path = '') {
  if (value === undefined) {
    throw new Error(
      'Value for argument "data" is not a valid Firestore document. '
      + `Cannot use "undefined" as a Firestore value (found in field "${path}"). `
      + 'If you want to ignore undefined values, enable `ignoreUndefinedProperties`.',
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFirestoreValue(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertFirestoreValue(value[key], path ? `${path}.${key}` : key);
    }
  }
}

function isPlain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function deepMerge(base, patch) {
  const out = isPlain(base) ? { ...base } : {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (isPlain(value) && isPlain(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

function memoryDb({ failInboundSentWrites = 0 } = {}) {
  const store = new Map();
  let remainingFailures = failInboundSentWrites;
  const writes = [];

  function docRef(collection, id) {
    const key = `${collection}/${id}`;
    return {
      id,
      path: key,
      async get() {
        const data = store.get(key);
        return {
          id,
          exists: data !== undefined,
          ref: docRef(collection, id),
          data: () => (data === undefined ? undefined : structuredClone(data)),
        };
      },
      set(data, options) {
        assertFirestoreValue(data);
        writes.push({ path: key, data: structuredClone(data) });
        if (collection === 'fbo-legs' && data?.arrival?.inboundStatus === 'sent' && remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error('simulated Firestore failure after the inbound email was accepted');
        }
        const prev = store.get(key);
        const next = options?.merge ? deepMerge(prev, data) : data;
        store.set(key, structuredClone(next));
        return Promise.resolve();
      },
    };
  }

  function querySnap(rows) {
    const docs = rows.map(([id, data, collection]) => ({
      id,
      ref: docRef(collection, id),
      data: () => structuredClone(data),
    }));
    return {
      size: docs.length,
      empty: docs.length === 0,
      docs,
      forEach(fn) { docs.forEach(fn); },
    };
  }

  function collection(name) {
    return {
      doc(id) { return docRef(name, id); },
      async get() {
        const rows = [...store.entries()]
          .filter(([key]) => key.startsWith(`${name}/`))
          .map(([key, data]) => [key.slice(name.length + 1), data, name]);
        return querySnap(rows);
      },
      where(field, op, value) {
        if (op !== '==') throw new Error(`unsupported operator ${op}`);
        return {
          async get() {
            const rows = [...store.entries()]
              .filter(([key]) => key.startsWith(`${name}/`))
              .map(([key, data]) => [key.slice(name.length + 1), data, name])
              .filter(([, data]) => data?.[field] === value);
            return querySnap(rows);
          },
        };
      },
    };
  }

  return {
    writes,
    collection,
    async runTransaction(fn) {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, options) => ref.set(data, options),
      };
      return fn(tx);
    },
    read(path) {
      const data = store.get(path);
      return data === undefined ? undefined : structuredClone(data);
    },
    seed(path, data) {
      assertFirestoreValue(data);
      store.set(path, structuredClone(data));
    },
  };
}

function departedLeg(now) {
  return {
    legUid: 'leg-undefined',
    tripId: 'WEQVQD',
    tail: 'N444AM',
    from: 'KAPF',
    to: 'KTEB',
    start: new Date(now - 30 * 60 * 1000).toISOString(),
    end: new Date(now + 2 * HOUR).toISOString(),
    pax: 3,
    legType: 'REVENUE',
    actualOff: new Date(now - 20 * 60 * 1000).toISOString(),
    departure: {
      airport: 'KAPF',
      aid: 'sig',
      name: 'Signature Aviation',
      email: 'csr@signature.example',
      matchStatus: 'confirmed',
      reminderStatus: 'sent',
    },
    arrival: {
      airport: 'KTEB',
      aid: 'mer',
      name: 'Meridian',
      email: 'teb@meridian.example',
      matchStatus: 'confirmed',
      arrivalStatus: 'not_sent',
      services: 'GPU',
      opsNotes: 'Call on final',
    },
  };
}

function guardNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`FBO test tried to use the network: ${url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function assertNoUndefined(value, path = '') {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const next = path ? `${path}.${key}` : key;
      assert.notEqual(value[key], undefined, `${next} is undefined`);
      assertNoUndefined(value[key], next);
    }
  }
}

async function withSecret(fn) {
  const previous = process.env.FBO_LINK_SECRET;
  process.env.FBO_LINK_SECRET = SECRET;
  const restoreFetch = guardNetwork();
  try {
    return await fn();
  } finally {
    restoreFetch();
    if (previous === undefined) delete process.env.FBO_LINK_SECRET;
    else process.env.FBO_LINK_SECRET = previous;
  }
}

test('arrival then inbound does not write undefined timeChangeForEnd', async () => {
  await withSecret(async () => {
    const now = Date.parse('2026-10-11T15:20:34Z');
    const db = memoryDb();
    const leg = departedLeg(now);
    assert.equal(Object.hasOwn(leg.arrival, 'timeChangeForEnd'), false);
    db.seed('app-config/fbo-notify', { testMode: true, live: false, arrivalAutoLeadHours: 24 });
    db.seed('fbo-legs/leg-undefined', leg);
    const sent = [];
    const transport = async (message) => {
      sent.push({ to: message.to, cc: message.cc, subject: message.subject });
      return { ok: true };
    };

    const first = await runFboCron({ db, now, transport });
    assert.equal(first.arrivalSent, 1);
    assert.equal(first.inboundSent, 1);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((message) => message.to.includes('jake@flyskyway.com')));
    assert.ok(sent.every((message) => !message.to.join(',').includes('teb@meridian.example')));
    assert.ok(sent.every((message) => !message.to.join(',').includes('csr@signature.example')));

    const saved = db.read('fbo-legs/leg-undefined');
    assert.equal(saved.arrival.timeChangeForEnd, null);
    assert.equal(saved.arrival.arrivalStatus, 'sent');
    assert.equal(saved.arrival.inboundStatus, 'sent');
    for (const write of db.writes) assertNoUndefined(write.data, write.path);
    assertNoUndefined(saved, 'fbo-legs/leg-undefined');

    await runFboCron({ db, now: now + 5 * 60 * 1000, transport });
    assert.equal(sent.length, 2);
  });
});

test('ops can schedule again after the cron key is already sent', async () => {
  await withSecret(async () => {
    const now = Date.parse('2026-10-11T16:00:00Z');
    const db = memoryDb();
    const leg = departedLeg(now);
    leg.arrival.inboundStatus = 'sent';
    db.seed('app-config/fbo-notify', { testMode: true, live: false, arrivalAutoLeadHours: 24 });
    db.seed(`fbo-legs/${leg.legUid}`, leg);
    const sent = [];
    const transport = async () => {
      sent.push(1);
      return { ok: true };
    };
    const first = await sendArrivalSchedule(leg, {
      db, now, settings: { testMode: true, live: false }, transport, actor: { name: 'Ops' },
    });
    assert.equal(first.ok, true);
    assert.equal(first.skipped, undefined);
    assert.equal(sent.length, 1);

    const replay = await sendArrivalSchedule(leg, {
      db, now: now + 1000, settings: { testMode: true, live: false }, transport, actor: { name: 'Ops' },
    });
    assert.equal(replay.skipped, 'already-sent');
    assert.equal(sent.length, 1);

    const again = await sendArrivalSchedule({
      ...leg,
      arrival: { ...leg.arrival, arrivalStatus: 'sent', sentForEnd: leg.end, timeChangeForEnd: null },
    }, {
      db, now: now + 2000, settings: { testMode: true, live: false }, transport, actor: { name: 'Ops' }, force: true,
    });
    assert.equal(again.ok, true);
    assert.equal(again.skipped, undefined);
    assert.equal(sent.length, 2);
  });
});

test('a failed leg write after the email does not send that FBO mail again', async () => {
  await withSecret(async () => {
    const now = Date.parse('2026-10-11T15:22:52Z');
    const db = memoryDb({ failInboundSentWrites: 1 });
    db.seed('app-config/fbo-notify', { testMode: true, live: false, arrivalAutoLeadHours: 24 });
    db.seed('fbo-legs/leg-undefined', departedLeg(now));
    const sent = [];
    const transport = async (message) => {
      sent.push(message.subject);
      return { ok: true };
    };

    await assert.rejects(
      () => runFboCron({ db, now, transport }),
      /simulated Firestore failure after the inbound email/,
    );
    assert.equal(sent.length, 2);
    assert.notEqual(db.read('fbo-legs/leg-undefined').arrival.inboundStatus, 'sent');

    const second = await runFboCron({ db, now: now + 5 * 60 * 1000, transport });
    assert.equal(sent.length, 2);
    assert.equal(second.inboundSent, 0);
    assert.equal(second.arrivalSent, 0);
    const saved = db.read('fbo-legs/leg-undefined');
    assert.equal(saved.arrival.inboundStatus, 'sent');
    assert.equal(saved.arrival.timeChangeForEnd, null);
    assertNoUndefined(saved, 'fbo-legs/leg-undefined');
  });
});
