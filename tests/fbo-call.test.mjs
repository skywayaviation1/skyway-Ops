import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  CALL_STATUSES,
  SKYWAY_CALLER_ID,
  armDialPlan,
  assistantSystemPrompt,
  buildSpeakableFacts,
  fboCallOutstanding,
  firstMessage,
  groundTransportRequested,
  isFinishedCallStatus,
  leadPassengerName,
  materialHash,
  publicCallSummary,
  resolveDialPhone,
  resolveDialAt,
  scheduledDialAt,
  shouldQueueUpdate,
  spokenTailNumber,
  speakMilitaryClock,
  formatLocalMilitaryTime,
  toE164,
  tripSheetDialPhone,
  unverifiedCallPurposes,
  vapiEnvValue,
  vendorConfigured,
  vendorEnvDiagnostics,
} from '../src/fbo-call.js';
import { computeOutstanding } from '../src/ops-readiness.js';
import { summarizeWebhook, validVapiSignature } from '../api/fbo-call-webhook.js';
import { resolveVapiPhoneNumberId, vapiCallPayload } from '../api/_fbo-call.js';

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
    aircraftType: 'Gulfstream G450',
    fromFbo: 'Signature Flight Support',
    toFbo: 'Atlantic Aviation',
    legType: 'REVENUE',
  },
};

test('caller ID is Skyway Aviation +1-813-859-5943', () => {
  assert.equal(SKYWAY_CALLER_ID, '+18138595943');
});

test('US phone numbers normalize to E.164', () => {
  assert.equal(toE164('(201) 555-0100'), '+12015550100');
  assert.equal(toE164('+1 (813) 859-5943'), '+18138595943');
  assert.equal(toE164('not a phone'), '');
});

test('times are spoken in local military clock', () => {
  assert.equal(speakMilitaryClock(16, 30), 'sixteen thirty');
  assert.equal(speakMilitaryClock(9, 5), 'zero nine zero five');
  assert.equal(speakMilitaryClock(12, 0), 'twelve hundred');
  const local = formatLocalMilitaryTime('2026-09-01T16:00:00.000Z', 'KTEB');
  assert.equal(local.display, '1200');
  assert.equal(local.spoken, 'twelve hundred');
  assert.match(local.line, /1200 local/);
  const facts = buildSpeakableFacts({
    trip,
    state: {
      fromFbo: 'Signature',
      tripSheetUrl: 'https://example.test/trip-sheet.pdf',
      tripSheetData: { fromAirportPhone: '201-555-0100' },
    },
    purpose: 'departure',
  });
  assert.equal(facts.facts.scheduledLocalDisplay, '1200');
  assert.equal(facts.facts.routeSpoken, 'Kilo Tango Echo Bravo to Kilo Papa Bravo India');
  assert.match(assistantSystemPrompt(facts.facts), /local military/);
  assert.doesNotMatch(assistantSystemPrompt(facts.facts), /2026-09-01T16:00:00.000Z/);
});

test('tail numbers are spoken with aviation phonetics and individual digits', () => {
  assert.equal(spokenTailNumber('N444AM'), 'November 4, 4, 4, Alpha Mike');
  assert.equal(spokenTailNumber('N90-SW'), 'November 9, 0, Sierra Whiskey');
  assert.equal(spokenTailNumber(''), '');
});

test('lead passenger is omitted unless ground transportation is requested', () => {
  const state = {
    fromFbo: 'Signature Flight Support',
    tripSheetUrl: 'https://example.test/trip-sheet.pdf',
    tripSheetData: { fromAirportPhone: '201-555-0100' },
    preloadedPax: [{ firstName: 'Ada', lastName: 'Lovelace', primary: true }],
    tripSheetNotes: { specialItems: 'Limo on arrival' },
  };
  assert.equal(groundTransportRequested(state, {}), true);
  assert.equal(leadPassengerName(state), 'Ada Lovelace');
  const withGround = buildSpeakableFacts({
    trip, state, purpose: 'departure',
  });
  assert.equal(withGround.facts.leadPassengerName, 'Ada Lovelace');
  const prompt = assistantSystemPrompt(withGround.facts);
  assert.doesNotMatch(prompt, /Ada Lovelace/);
  assert.match(prompt, /Your name is Peter/);
  assert.match(prompt, /Logistics Specialist with Skyway Aviation/);
  assert.match(prompt, /# CALL FLOW/);
  assert.match(prompt, /Can you confirm you have the trip notification/);
  assert.match(prompt, /I don’t have that confirmed on my trip details/);
  assert.match(prompt, /Do not guess, provide passenger names/);

  const noGround = buildSpeakableFacts({
    trip,
    state: { ...state, tripSheetNotes: { specialItems: 'Pets in cabin' } },
    purpose: 'departure',
  });
  assert.equal(noGround.facts.leadPassengerName, '');
  assert.doesNotMatch(assistantSystemPrompt(noGround.facts), /Ada Lovelace/);
  assert.match(assistantSystemPrompt(noGround.facts), /Do not guess, provide passenger names/);
});

test('hours unknown is spoken as unverified and does not block a phone-ready call', () => {
  const result = buildSpeakableFacts({
    trip,
    state: {
      fromFbo: 'Signature',
      tripSheetUrl: 'https://example.test/trip-sheet.pdf',
      tripSheetData: { fromAirportPhone: '201-555-0100' },
    },
    purpose: 'departure',
  });
  assert.equal(result.ok, true);
  assert.equal(result.facts.hoursKnown, false);
  assert.match(assistantSystemPrompt(result.facts), /I don’t have that confirmed on my trip details/);
});

test('missing phone blocks the call', () => {
  const result = buildSpeakableFacts({
    trip,
    state: {
      fromFbo: 'Signature',
      tripSheetUrl: 'https://example.test/trip-sheet.pdf',
      tripSheetData: {},
    },
    purpose: 'departure',
  });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(' '), /phone/i);
});

test('trip-sheet FBO name stays authoritative and arming requires verification', () => {
  const result = buildSpeakableFacts({
    trip,
    state: {
      fromFbo: 'Signature Trip Sheet Name',
      tripSheetUrl: 'https://example.test/trip-sheet.pdf',
      tripSheetData: { fromAirportPhone: '201-555-0100' },
    },
    purpose: 'departure',
  });
  assert.equal(result.facts.fboName, 'Signature Trip Sheet Name');
  assert.equal(result.facts.fboNameSource, 'trip_sheet');
  assert.equal(result.facts.phoneSource, 'trip_sheet');
  assert.equal(result.facts.phoneE164, '+12015550100');
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
    state: {
      tripSheetUrl: 'https://example.test/trip-sheet.pdf',
      tripSheetData: { fromAirportPhone: '201-555-0100' },
    },
    purpose: 'departure',
  });
  assert.equal(result.ok, false);
  assert.equal(result.facts.fboName, '');
  assert.match(result.blockers.join(' '), /trip sheet/i);
});

test('departure and arrival dialing phones come only from trip-sheet data', () => {
  const state = {
    tripSheetData: {
      fromAirportPhone: '(201) 555-0100',
      toAirportPhone: '561-555-0199',
    },
  };
  assert.equal(tripSheetDialPhone(state, 'departure'), '(201) 555-0100');
  assert.equal(tripSheetDialPhone(state, 'arrival'), '561-555-0199');
});

test('an operator phone override replaces the sheet number and is hashed', () => {
  const state = {
    fromFbo: 'Signature',
    tripSheetUrl: 'https://example.test/trip-sheet.pdf',
    tripSheetData: { fromAirportPhone: '201-555-0100' },
    fboCallDialOverrides: { departure: '727-555-0199' },
  };
  assert.deepEqual(resolveDialPhone(state, 'departure'), {
    display: '727-555-0199',
    source: 'override',
    isOverride: true,
  });
  const result = buildSpeakableFacts({ trip, state, purpose: 'departure' });
  assert.equal(result.facts.phoneE164, '+17275550199');
  assert.equal(result.facts.phoneSource, 'override');
  assert.notEqual(
    result.hash,
    buildSpeakableFacts({
      trip,
      state: { ...state, fboCallDialOverrides: {} },
      purpose: 'departure',
    }).hash,
  );
});

test('departure and arrival follow-up windows are both two hours', () => {
  const start = Date.parse(trip.start);
  const end = Date.parse(trip.end);
  assert.equal(scheduledDialAt({ purpose: 'departure', startMs: start, endMs: end }), start - 120 * 60_000);
  assert.equal(scheduledDialAt({ purpose: 'arrival', startMs: start, endMs: end }), end - 120 * 60_000);
  const tooLate = resolveDialAt(start - 120 * 60_000, start + 40 * 60_000, start);
  assert.equal(tooLate.ok, false);
});

test('immediate arrival arming creates now and two-hour follow-up jobs', () => {
  const now = Date.parse(trip.start) - 6 * 60 * 60_000;
  const plannedAt = Date.parse(trip.end) - 2 * 60 * 60_000;
  assert.deepEqual(armDialPlan({
    purpose: 'arrival',
    plannedAt,
    resolvedDialAt: plannedAt,
    now,
    dialImmediately: true,
  }), [
    { callPhase: 'initial', dialAt: now, dialMode: 'immediate' },
    { callPhase: 'arrival_reverification', dialAt: plannedAt, dialMode: 'scheduled' },
  ]);
  assert.deepEqual(armDialPlan({
    purpose: 'arrival',
    plannedAt,
    resolvedDialAt: plannedAt,
    now,
    dialImmediately: false,
  }), [
    { callPhase: 'arrival_reverification', dialAt: plannedAt, dialMode: 'scheduled' },
  ]);
});

test('active calls expose listen availability without exposing monitor URLs', () => {
  const summary = publicCallSummary({
    id: 'fbo_1',
    status: 'in_progress',
    vendorCallId: 'vapi_1',
    monitorListenUrl: 'wss://private.example/listen',
  });
  assert.equal(summary.listenAvailable, true);
  assert.equal('monitorListenUrl' in summary, false);
  const completed = publicCallSummary({
    id: 'fbo_2',
    status: 'completed',
    vendorCallId: 'vapi_2',
    recordingUrl: 'https://private.example/recording.wav',
  });
  assert.equal(completed.recordingAvailable, true);
  assert.equal('recordingUrl' in completed, false);
});

test('material trip changes queue an update after a completed call', () => {
  const first = materialHash({ from: 'KTEB', pax: 3 });
  const second = materialHash({ from: 'KTEB', pax: 4 });
  assert.equal(shouldQueueUpdate(first, second, 'completed'), true);
  assert.equal(shouldQueueUpdate(first, first, 'completed'), false);
  assert.equal(shouldQueueUpdate(first, second, 'dialing'), false);
});

test('only finished calls can be retried or deleted', () => {
  for (const status of ['completed', 'failed', 'needs_followup', 'cancelled']) {
    assert.equal(isFinishedCallStatus(status), true);
  }
  for (const status of ['armed', 'scheduled', 'dialing', 'in_progress']) {
    assert.equal(isFinishedCallStatus(status), false);
  }
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
      tripSheetUrl: 'https://example.test/trip-sheet.pdf',
      tripSheetData: { fromAirportPhone: '201-555-0100' },
      preloadedPax: [{ firstName: 'Secret', lastName: 'Passenger' }],
    },
    purpose: 'departure',
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
  assert.equal(body.assistantOverrides.variableValues.tail, 'November 4, 4, 4, Alpha Mike');
  assert.equal(body.assistantOverrides.variableValues.tailRegistration, 'N444AM');
  assert.equal(body.assistantOverrides.variableValues.tail_number, 'November 4, 4, 4, Alpha Mike');
  assert.equal(body.assistantOverrides.variableValues.aircraft_type, 'Gulfstream G450');
  assert.equal(body.assistantOverrides.variableValues.arrival_time_local, 'fourteen thirty local');
  assert.equal(body.assistantOverrides.variableValues.departure_time_local, 'twelve hundred local');
  assert.equal(body.assistantOverrides.variableValues.arriving_pax_count, '3');
  assert.equal(body.assistantOverrides.variableValues.departing_pax_count, '3');
  assert.equal(body.assistantOverrides.variableValues.leadPassengerName, '');
  assert.equal(body.assistantOverrides.artifactPlan.recordingEnabled, true);
  assert.equal(
    body.assistantOverrides.analysisPlan.structuredDataSchema.properties.arrivalTimeConfirmed.type,
    'boolean',
  );
  assert.equal(
    body.assistantOverrides.analysisPlan.structuredDataSchema.properties.departingPaxConfirmed.type,
    'boolean',
  );
  assert.match(
    body.assistantOverrides.model.messages[0].content,
    /Your name is Peter/,
  );
  assert.match(firstMessage(facts), /Skyway Aviation/);
  assert.match(firstMessage(facts), /may be recorded for operational accuracy/);
  assert.equal(vendorConfigured({ VAPI_API_KEY: 'k', VAPI_PHONE_NUMBER_ID: 'pn_1' }), true);
});

test('Vapi credentials survive pasted quotes, newlines, and Vapi own key naming', () => {
  assert.equal(vapiEnvValue({ VAPI_API_KEY: '"key-123"\n' }, 'apiKey'), 'key-123');
  assert.equal(vapiEnvValue({ VAPI_PRIVATE_KEY: ' key-456 ' }, 'apiKey'), 'key-456');
  assert.equal(vapiEnvValue({ VAPI_PHONE_ID: "'pn_1'" }, 'phoneNumberId'), 'pn_1');
  assert.equal(vendorConfigured({ VAPI_API_KEY: '"k"\n', VAPI_PHONE_NUMBER_ID: '"pn_1"' }), true);
  const body = vapiCallPayload(
    { id: 'fbo_1', tripId: 'leg-1', purpose: 'departure', phoneE164: '+12015550100', facts: {} },
    { opsTransferNumber: SKYWAY_CALLER_ID },
    { VAPI_PHONE_NUMBER_ID: '"pn_1"\n' },
  );
  assert.equal(body.phoneNumberId, 'pn_1');
});

test('an unconfigured deployment names the variable it cannot see', () => {
  const diagnostics = vendorEnvDiagnostics({ VAPI_API_KEY: 'k' });
  assert.deepEqual(diagnostics.missing, []);
  assert.equal(diagnostics.hasApiKey, true);
  assert.equal(diagnostics.hasPhoneNumber, false);
  assert.equal(diagnostics.phoneNumberLookup, 'automatic_by_number');
  assert.deepEqual(vendorEnvDiagnostics({}).missing, ['VAPI_API_KEY']);
  const warned = vendorEnvDiagnostics({ VITE_VAPI_API_KEY: 'k', VAPI_PHONE_NUMBER_ID: 'pn_1' });
  assert.match(warned.warnings.join(' '), /exposed to browsers/);
  assert.deepEqual(warned.missing, ['VAPI_API_KEY']);
});

test('Skyway caller number resolves to its Vapi phone record ID', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /api\.vapi\.ai\/phone-number/);
    assert.equal(options.headers.Authorization, 'Bearer key-1');
    return new Response(JSON.stringify([
      { id: 'phone-record-1', number: '+18138595943' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.equal(await resolveVapiPhoneNumberId({
      VAPI_API_KEY: 'key-1',
      VAPI_PHONE_NUMBER_ID: '+1 (813) 859-5943',
    }), 'phone-record-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
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
      artifact: { recording: { monoUrl: 'https://private.example/call.wav' } },
      analysis: { summary: 'Fuel confirmed', structuredData: { fuelConfirmed: true, needsFollowUp: false } },
      call: { id: 'vapi_1', metadata: { skywayCallId: 'fbo_1' } },
    },
  });
  assert.equal(parsed.nextStatus, CALL_STATUSES.completed);
  assert.equal(parsed.confirmations.fuelConfirmed, true);
  assert.equal(parsed.recordingAvailable, true);
  assert.equal('recordingUrl' in parsed, false);
  const active = summarizeWebhook({
    message: {
      type: 'status-update',
      status: 'in-progress',
      call: {
        id: 'vapi_1',
        metadata: { skywayCallId: 'fbo_1' },
        monitor: { listenUrl: 'wss://vapi.example/listen' },
      },
    },
  });
  assert.equal(active.nextStatus, CALL_STATUSES.in_progress);
  assert.equal(active.monitorListenUrl, 'wss://vapi.example/listen');
});

test('routes, cron, and secrets stay server-side', async () => {
  const app = await source('src/App.jsx');
  const vercel = await source('vercel.json');
  const desk = await source('src/FboCallDesk.jsx');
  const listener = await source('src/FboCallListener.jsx');
  const review = await source('src/FboCallReview.jsx');
  const helper = await source('api/_fbo-call.js');
  const schedule = await source('api/fbo-call-schedule.js');
  assert.match(app, /FboCallDeskLazy/);
  assert.match(app, /TripFboCallsLazy/);
  assert.match(app, /id: 'fbo-calls'/);
  assert.match(vercel, /\/api\/fbo-call-schedule/);
  assert.match(desk, /\/api\/fbo-call/);
  assert.match(await source('src/fbo-call.js'), /VAPI_API_KEY/);
  assert.match(helper, /vapiEnvValue\(env, 'apiKey'\)/);
  assert.match(helper, /monitorListenUrl/);
  assert.match(helper, /dialJobNow/);
  assert.match(helper, /deleteFinishedJob/);
  assert.match(helper, /parentCallId: original.id/);
  assert.match(schedule, /dialJobNow/);
  assert.match(listener, /WebSocket/);
  assert.match(review, /FBO confirmation checklist/);
  assert.match(review, /action: 'recording'/);
  assert.doesNotMatch(desk, /VAPI_API_KEY/);
  assert.doesNotMatch(listener, /VAPI_API_KEY/);
  assert.doesNotMatch(app, /VITE_VAPI/);
});
