import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  CALL_STATUSES,
  SKYWAY_CALLER_ID,
  assistantSystemPrompt,
  buildSpeakableFacts,
  fboCallOutstanding,
  firstMessage,
  groundTransportRequested,
  hoursFromRecord,
  leadPassengerName,
  matchFboRecord,
  materialHash,
  resolveDialAt,
  scheduledDialAt,
  shouldQueueUpdate,
  toE164,
  unverifiedCallPurposes,
  vendorConfigured,
} from '../src/fbo-call.js';
import { computeOutstanding } from '../src/ops-readiness.js';
import { summarizeWebhook, validVapiSignature } from '../api/fbo-call-webhook.js';
import { vapiCallPayload } from '../api/_fbo-call.js';
import { normalizeFboRecord } from '../api/_iflightplanner.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

const trip = {
  uid: 'leg-1',
  start: '2026-09-01T16:00:00.000Z',
  end: '2026-09-01T18:30:00.000Z',
  info: {
    tail: 'N444AM',
    from: 'KTEB',
    to: 'KPBI',
    pax: 3,
    pic: 'Hagberg',
    sic: 'Woods',
    fromFbo: 'Signature Flight Support',
    toFbo: 'Atlantic Aviation',
    legType: 'REVENUE',
  },
};

test('caller ID is Skyway Aviation +1-727-605-5000', () => {
  assert.equal(SKYWAY_CALLER_ID, '+17276055000');
});

test('US phone numbers normalize to E.164', () => {
  assert.equal(toE164('(201) 555-0100'), '+12015550100');
  assert.equal(toE164('1-727-605-5000'), '+17276055000');
  assert.equal(toE164('not a phone'), '');
});

test('FBO name matching prefers a unique high-score provider', () => {
  const records = [
    { name: 'Signature Flight Support', phone: '201-555-0100' },
    { name: 'Atlantic Aviation', phone: '201-555-0199' },
  ];
  const hit = matchFboRecord(records, 'Signature');
  assert.equal(hit.record.name, 'Signature Flight Support');
  assert.equal(hit.confidence, 'high');
  const miss = matchFboRecord(records, 'Million Air');
  assert.equal(miss.record, null);
});

test('lead passenger is omitted unless ground transportation is requested', () => {
  const state = {
    fromFbo: 'Signature Flight Support',
    preloadedPax: [{ firstName: 'Ada', lastName: 'Lovelace', primary: true }],
    tripSheetNotes: { specialItems: 'Limo on arrival' },
  };
  assert.equal(groundTransportRequested(state, {}), true);
  assert.equal(leadPassengerName(state), 'Ada Lovelace');
  const fbo = { name: 'Signature Flight Support', phone: '201-555-0100' };
  const withGround = buildSpeakableFacts({
    trip, state, purpose: 'departure', fbo, match: { confidence: 'high' },
  });
  assert.equal(withGround.facts.leadPassengerName, 'Ada Lovelace');
  const prompt = assistantSystemPrompt(withGround.facts);
  assert.match(prompt, /Ada Lovelace/);
  assert.match(prompt, /ONLY when discussing ground transportation/);

  const noGround = buildSpeakableFacts({
    trip,
    state: { ...state, tripSheetNotes: { specialItems: 'Pets in cabin' } },
    purpose: 'departure',
    fbo,
    match: { confidence: 'high' },
  });
  assert.equal(noGround.facts.leadPassengerName, '');
  assert.doesNotMatch(assistantSystemPrompt(noGround.facts), /Ada Lovelace/);
  assert.match(assistantSystemPrompt(noGround.facts), /Do not speak any passenger names/);
});

test('hours unknown is spoken as unverified and does not block a phone-ready call', () => {
  const fbo = { name: 'Signature Flight Support', phone: '201-555-0100', raw: {} };
  const result = buildSpeakableFacts({
    trip,
    state: { fromFbo: 'Signature' },
    purpose: 'departure',
    fbo,
    match: { confidence: 'high' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.facts.hoursKnown, false);
  assert.match(assistantSystemPrompt(result.facts), /Hours are not in the verified dataset/);
});

test('hours column is read from iFlightPlanner raw fields when present', () => {
  const record = normalizeFboRecord({
    ICAO: 'KTEB',
    'FBO Name': 'Signature',
    Phone: '201-555-0100',
    'Hours of Operation': '0600-2200',
  });
  assert.equal(record.hours, '0600-2200');
  assert.equal(hoursFromRecord(record), '0600-2200');
});

test('missing phone blocks the call', () => {
  const result = buildSpeakableFacts({
    trip,
    state: { fromFbo: 'Signature' },
    purpose: 'departure',
    fbo: { name: 'Signature Flight Support' },
    match: { confidence: 'high' },
  });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(' '), /phone/i);
});

test('trip-sheet FBO name stays authoritative and arming requires verification', () => {
  const result = buildSpeakableFacts({
    trip,
    state: { fromFbo: 'Signature Trip Sheet Name' },
    purpose: 'departure',
    fbo: { name: 'Signature Flight Support Database Name', phone: '201-555-0100' },
    match: { confidence: 'high' },
  });
  assert.equal(result.facts.fboName, 'Signature Trip Sheet Name');
  assert.equal(result.facts.fboNameSource, 'trip_sheet');
  assert.equal(result.facts.phoneSource, 'iflightplanner');
  assert.deepEqual(
    unverifiedCallPurposes(['departure', 'arrival'], ['departure']),
    ['arrival'],
  );
  assert.deepEqual(
    unverifiedCallPurposes(['departure'], ['departure']),
    [],
  );
});

test('a calendar FBO fallback cannot replace a missing trip-sheet FBO', () => {
  const result = buildSpeakableFacts({
    trip,
    state: {},
    purpose: 'departure',
    fbo: { name: 'Signature Flight Support', phone: '201-555-0100' },
    match: { confidence: 'unique_airport' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.facts.fboName, '');
  assert.match(result.blockers.join(' '), /trip sheet/i);
});

test('dial window is two hours before departure and 90 minutes before arrival', () => {
  const start = Date.parse(trip.start);
  const end = Date.parse(trip.end);
  assert.equal(scheduledDialAt({ purpose: 'departure', startMs: start, endMs: end }), start - 120 * 60_000);
  assert.equal(scheduledDialAt({ purpose: 'arrival', startMs: start, endMs: end }), end - 90 * 60_000);
  const tooLate = resolveDialAt(start - 120 * 60_000, start + 40 * 60_000, start);
  assert.equal(tooLate.ok, false);
});

test('material trip changes queue an update after a completed call', () => {
  const first = materialHash({ from: 'KTEB', pax: 3 });
  const second = materialHash({ from: 'KTEB', pax: 4 });
  assert.equal(shouldQueueUpdate(first, second, 'completed'), true);
  assert.equal(shouldQueueUpdate(first, first, 'completed'), false);
  assert.equal(shouldQueueUpdate(first, second, 'dialing'), false);
});

test('readiness flags unarmed FBO calls on imminent revenue legs', () => {
  const now = Date.parse(trip.start) - 90 * 60_000;
  const items = fboCallOutstanding(trip, {}, now);
  assert.equal(items[0].code, 'fbo-call-unarmed');
  const gaps = computeOutstanding({ ...trip, info: { ...trip.info, isOps: true, isFlight: true } }, {
    tripSheetUrl: 'https://example.test/sheet.pdf',
    dispatcherUids: ['ops-1'],
    brokerEmail: 'broker@example.com',
    paxOverride: 3,
    fromFbo: 'Signature',
    toFbo: 'Atlantic',
  }, now);
  assert.equal(gaps.some((item) => item.code === 'fbo-call-unarmed'), true);
});

test('Vapi payload never includes a passenger name without ground transport', () => {
  const facts = buildSpeakableFacts({
    trip,
    state: {
      fromFbo: 'Signature',
      preloadedPax: [{ firstName: 'Secret', lastName: 'Passenger' }],
    },
    purpose: 'departure',
    fbo: { name: 'Signature', phone: '201-555-0100' },
    match: { confidence: 'high' },
  }).facts;
  const body = vapiCallPayload({
    id: 'fbo_1',
    tripId: 'leg-1',
    purpose: 'departure',
    phoneE164: '+12015550100',
    facts,
  }, { opsTransferNumber: SKYWAY_CALLER_ID }, {
    VAPI_ASSISTANT_ID: 'asst_1',
    VAPI_PHONE_NUMBER_ID: 'pn_1',
  });
  assert.equal(body.customer.number, '+12015550100');
  assert.equal(body.assistantOverrides.variableValues.leadPassengerName, '');
  assert.match(firstMessage(facts), /Skyway Aviation/);
  assert.equal(vendorConfigured({ VAPI_API_KEY: 'k', VAPI_PHONE_NUMBER_ID: 'pn_1' }), true);
});

test('webhook HMAC and end-of-call mapping', async () => {
  const raw = Buffer.from('{"ok":true}');
  const secret = 'hook-secret';
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(validVapiSignature(raw, sig, secret), true);
  assert.equal(validVapiSignature(raw, 'nope', secret), false);
  const parsed = summarizeWebhook({
    message: {
      type: 'end-of-call-report',
      status: 'ended',
      transcript: 'Hello',
      analysis: { summary: 'Fuel confirmed', structuredData: { fuelConfirmed: true, needsFollowUp: false } },
      call: { id: 'vapi_1', metadata: { skywayCallId: 'fbo_1' } },
    },
  });
  assert.equal(parsed.nextStatus, CALL_STATUSES.completed);
  assert.equal(parsed.confirmations.fuelConfirmed, true);
});

test('routes, cron, and secrets stay server-side', async () => {
  const app = await source('src/App.jsx');
  const vercel = await source('vercel.json');
  const desk = await source('src/FboCallDesk.jsx');
  const helper = await source('api/_fbo-call.js');
  assert.match(app, /FboCallDeskLazy/);
  assert.match(app, /TripFboCallsLazy/);
  assert.match(app, /id: 'fbo-calls'/);
  assert.match(vercel, /\/api\/fbo-call-schedule/);
  assert.match(desk, /\/api\/fbo-call/);
  assert.match(helper, /VAPI_API_KEY/);
  assert.doesNotMatch(desk, /VAPI_API_KEY/);
  assert.doesNotMatch(app, /VITE_VAPI/);
});
