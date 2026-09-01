/**
 * Server helpers for the FBO calling agent.
 *
 * Jobs live in `fbo-call-jobs/{id}` so cron can query due dials. A compact
 * copy is mirrored on `trip-state/{tripId}.fboCalls` for the trip UI.
 */

import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { applySkywaySignature, textToHtml } from './_email-signature.js';
import {
  CALL_STATUSES,
  DEFAULT_ARR_LEAD_MINUTES,
  DEFAULT_DEP_LEAD_MINUTES,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_MINUTES,
  SKYWAY_CALLER_ID,
  SKYWAY_CALLER_NAME,
  VOICE_VENDOR,
  armDialPlan,
  assistantSystemPrompt,
  buildSpeakableFacts,
  firstMessage,
  isFinishedCallStatus,
  materialHash,
  nextRetryAt,
  publicCallSummary,
  resolveDialAt,
  scheduledDialAt,
  toE164,
  unverifiedCallPurposes,
  vapiEnvValue,
  vendorConfigured,
  vendorEnvDiagnostics,
} from '../src/fbo-call.js';
import { normalizeTranscriberKeywords } from '../src/vapi-call-artifacts.js';

const CONFIG_PATH = ['app-config', 'fbo-call'];
const JOBS = 'fbo-call-jobs';
const EVENTS = 'fbo-call-events';

let app = null;
let db = null;
let vapiPhoneCache = null;

export function getAdminApp() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return app;
}

export function getDb() {
  if (!db) db = getFirestore(getAdminApp(), 'appusers');
  return db;
}

export function sanitizeKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

export function newCallId() {
  return `fbo_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export async function authorizeFboCaller(idToken, roles = ['ops', 'admin']) {
  if (!idToken) {
    const error = new Error('Sign in required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = await admin.auth(getAdminApp()).verifyIdToken(idToken, true);
  } catch {
    const error = new Error('Invalid or expired session');
    error.status = 401;
    throw error;
  }
  const snap = await getDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (
    !snap.exists
    || !roles.includes(String(profile.role || '').toLowerCase())
    || profile.active === false
    || profile.approved !== true
  ) {
    const error = new Error(`${roles.join(' or ')} access required`);
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    email: decoded.email || profile.email || '',
    name: profile.name || decoded.name || decoded.email || 'User',
    role: String(profile.role || '').toLowerCase(),
  };
}

export function defaultConfig() {
  return {
    enabled: false,
    depLeadMinutes: DEFAULT_DEP_LEAD_MINUTES,
    arrLeadMinutes: DEFAULT_ARR_LEAD_MINUTES,
    retryMinutes: DEFAULT_RETRY_MINUTES,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    opsTransferNumber: toE164(process.env.FBO_CALL_OPS_TRANSFER_NUMBER) || SKYWAY_CALLER_ID,
    callerId: SKYWAY_CALLER_ID,
    callerName: SKYWAY_CALLER_NAME,
  };
}

export function publicVendorStatus(env = process.env) {
  const diagnostics = vendorEnvDiagnostics(env);
  return {
    vendor: VOICE_VENDOR,
    pstn: 'twilio',
    callerId: SKYWAY_CALLER_ID,
    callerName: SKYWAY_CALLER_NAME,
    configured: diagnostics.missing.length === 0,
    ...diagnostics,
  };
}

export function vapiAssistantReliability(env = process.env) {
  const secret = vapiEnvValue(env, 'webhookSecret');
  const server = {
    url: String(env.VAPI_WEBHOOK_URL || 'https://www.skyway.app/api/fbo-call-webhook').trim(),
    timeoutSeconds: 20,
    backoffPlan: {
      type: 'exponential',
      maxRetries: 4,
      baseDelaySeconds: 2,
    },
  };
  if (secret) server.headers = { 'X-Vapi-Secret': secret };
  return {
    server,
    serverMessages: [
      'status-update',
      'transcript',
      'conversation-update',
      'end-of-call-report',
      'hang',
      'tool-calls',
    ],
    transcriber: {
      provider: 'deepgram',
      // Telephony-tuned model: every Skyway voice call is a PSTN call.
      model: 'nova-2-phonecall',
      language: 'en',
      smartFormat: true,
      // Deepgram rejects multi-word keywords, so these stay single tokens.
      keywords: normalizeTranscriberKeywords([
        'Skyway:2',
        'Aviation',
        'FBO:2',
        'tail',
        'registration',
        'hangar',
        'catering',
        'confirmation',
      ]),
    },
    artifactPlan: {
      recordingEnabled: true,
      fullMessageHistoryEnabled: true,
      transcriptPlan: {
        enabled: true,
        assistantName: 'Skyway assistant',
        userName: 'Contact',
      },
    },
    monitorPlan: {
      listenEnabled: true,
      controlEnabled: true,
    },
  };
}

export async function readCallConfig() {
  const snap = await getDb().doc(CONFIG_PATH.join('/')).get();
  const stored = snap.exists ? snap.data() : {};
  const merged = { ...defaultConfig(), ...stored, ...publicVendorStatus() };
  if (!snap.exists && merged.configured) merged.enabled = true;
  return merged;
}

export async function writeCallConfig(patch, actor) {
  const next = {
    ...patch,
    updatedAt: Date.now(),
    updatedByUid: actor?.uid || '',
    updatedByName: actor?.name || '',
  };
  await getDb().doc(CONFIG_PATH.join('/')).set(next, { merge: true });
  return readCallConfig();
}

export async function resolveFboFacts(trip, state, purpose) {
  return buildSpeakableFacts({ trip, state, purpose });
}

function jobPublic(job) {
  return publicCallSummary(job);
}

async function mirrorTripCalls(tripId) {
  const safeId = sanitizeKey(tripId);
  const snap = await getDb().collection(JOBS).where('tripId', '==', tripId).get();
  const calls = snap.docs
    .map((doc) => jobPublic(doc.data()))
    .filter(Boolean)
    .sort((a, b) => (a.armedAt || 0) - (b.armedAt || 0));
  const ref = getDb().collection('trip-state').doc(safeId);
  try {
    await ref.update({ fboCalls: calls, fboCallsUpdatedAt: Date.now() });
  } catch (error) {
    if (error?.code === 'not-found' || /No document to update/i.test(String(error.message || ''))) {
      await ref.set({ fboCalls: calls, fboCallsUpdatedAt: Date.now() }, { merge: true });
    } else {
      throw error;
    }
  }
  return calls;
}

export async function listTripCalls(tripId) {
  const snap = await getDb().collection(JOBS).where('tripId', '==', tripId).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => (a.armedAt || 0) - (b.armedAt || 0));
}

export async function writeJob(job) {
  await getDb().collection(JOBS).doc(job.id).set(job, { merge: true });
  await mirrorTripCalls(job.tripId);
  return job;
}

export async function loadJob(id) {
  const snap = await getDb().collection(JOBS).doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function dueJobs(now = Date.now()) {
  const snap = await getDb().collection(JOBS)
    .where('dialAt', '<=', now)
    .get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((job) => ['armed', 'scheduled', 'retry'].includes(job.status));
}

export async function recordEvent(id, payload) {
  const ref = getDb().collection(EVENTS).doc(id);
  const created = await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { ...payload, createdAt: Date.now() });
    return true;
  });
  return created;
}

function opsAlertEmails() {
  return String(process.env.OPS_ALERT_EMAILS || 'charters@flyskyway.com')
    .split(/[,;\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

export async function notifyOps({ subject, text, tripId, source }) {
  const to = opsAlertEmails();
  if (to.length === 0) return null;
  const id = `q_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const html = applySkywaySignature(textToHtml(text));
  await getDb().collection('email-queue').doc(id).set({
    status: 'pending',
    to,
    cc: [],
    subject,
    html,
    from: null,
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    queuedAt: Date.now(),
    nextAttemptAt: Date.now(),
    source: source || 'fbo-call',
    tripId: tripId || null,
    statusKey: 'fbo_call',
  });
  return id;
}

export function vapiCallPayload(job, config, env = process.env) {
  const facts = job.facts || {};
  const reliability = vapiAssistantReliability(env);
  const transfer = toE164(config.opsTransferNumber) || SKYWAY_CALLER_ID;
  const variableValues = {
    callerName: facts.callerName,
    fboName: facts.fboName,
    airport: facts.airport,
    airportSpoken: facts.airportSpoken,
    routeSpoken: facts.routeSpoken,
    tail: facts.tailSpoken || facts.tail,
    tailRegistration: facts.tail,
    tailSpoken: facts.tailSpoken,
    purpose: facts.purpose,
    paxCount: String(facts.paxCount ?? ''),
    hasCatering: facts.hasCatering ? 'yes' : 'no',
    groundTransport: facts.groundTransport ? 'yes' : 'no',
    leadPassengerName: '',
    hours: facts.hoursKnown ? facts.hours : 'not on file',
    specialItems: facts.specialItems || 'none on file',
    scheduledTime: facts.scheduledLocalDisplay || '',
    scheduledTimeSpoken: facts.scheduledLocalSpokenLine || facts.scheduledLocalSpoken || '',
    // Snake-case aliases support the saved Vapi prompt supplied by operations.
    tail_number: facts.tailSpoken || facts.tail || 'not confirmed',
    tail_number_written: facts.tail || 'not confirmed',
    aircraft_type: facts.aircraftType || 'not confirmed',
    arrival_date: facts.arrivalDateLocal || 'not confirmed',
    arrival_time_local: facts.arrivalTimeSpoken
      ? `${facts.arrivalTimeSpoken} local`
      : 'not confirmed',
    arriving_pax_count: String(facts.arrivingPaxCount ?? 'not confirmed'),
    departure_date: facts.departureDateLocal || 'not confirmed',
    departure_time_local: facts.departureTimeSpoken
      ? `${facts.departureTimeSpoken} local`
      : 'not confirmed',
    departing_pax_count: String(facts.departingPaxCount ?? 'not confirmed'),
    parking_request: facts.parkingRequest || 'not confirmed',
    special_instructions: facts.specialInstructions || 'none confirmed',
  };
  const assistant = {
    ...reliability,
    firstMessage: firstMessage(facts),
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'system', content: assistantSystemPrompt(facts) }],
      temperature: 0.2,
    },
    voice: { provider: 'openai', voiceId: 'alloy' },
    firstMessageInterruptionsEnabled: false,
    analysisPlan: {
      summaryPrompt: [
        'Write a concise Skyway operations report.',
        'Separate: confirmed movement, confirmed services, unconfirmed or declined items, restrictions, and required human follow-up.',
        'Never describe an item as confirmed unless the FBO representative explicitly confirmed it.',
        'Include the representative’s corrections and promised actions.',
      ].join(' '),
      structuredDataSchema: {
        type: 'object',
        properties: {
          movementConfirmed: {
            type: 'boolean',
            description: 'True only if the FBO explicitly confirmed it has the trip notification.',
          },
          arrivalTimeConfirmed: {
            type: 'boolean',
            description: 'True only if the FBO explicitly confirmed the supplied arrival local time.',
          },
          departureTimeConfirmed: {
            type: 'boolean',
            description: 'True only if the FBO explicitly confirmed the supplied departure local time.',
          },
          arrivingPaxConfirmed: {
            type: 'boolean',
            description: 'True only if the FBO explicitly confirmed the arriving passenger count.',
          },
          departingPaxConfirmed: {
            type: 'boolean',
            description: 'True only if the FBO explicitly confirmed the departing passenger count.',
          },
          fuelConfirmed: {
            type: 'boolean',
            description: 'True only if the applicable fuel or handling request was explicitly confirmed.',
          },
          hangarConfirmed: {
            type: 'boolean',
            description: 'True only if an applicable hangar or overnight request was explicitly confirmed.',
          },
          cateringConfirmed: {
            type: 'boolean',
            description: 'True only if requested catering was explicitly confirmed.',
          },
          groundTransportConfirmed: {
            type: 'boolean',
            description: 'True only if requested ground transportation was explicitly confirmed.',
          },
          hoursVerified: {
            type: 'string',
            description: 'Operating hours or after-hours restrictions exactly as stated by the representative; empty when not discussed.',
          },
          needsFollowUp: {
            type: 'boolean',
            description: 'True if any applicable detail is missing, uncertain, changed, declined, or requires Skyway authorization.',
          },
          transferredToOps: {
            type: 'boolean',
            description: 'True only if the live call was transferred to Skyway operations.',
          },
          notes: {
            type: 'string',
            description: 'Differences supplied by the FBO, corrections, restrictions, representative promises, and open questions.',
          },
        },
      },
    },
  };
  if (transfer) {
    assistant.model.tools = [{
      type: 'transferCall',
      destinations: [{
        type: 'number',
        number: transfer,
        message: 'Please hold while I connect you to Skyway Aviation operations.',
      }],
    }];
  }
  const customer = {
    number: job.phoneE164,
    name: facts.fboName || 'FBO',
  };
  const body = {
    customer,
    assistantOverrides: {
      variableValues,
      firstMessage: assistant.firstMessage,
      artifactPlan: reliability.artifactPlan,
      analysisPlan: assistant.analysisPlan,
      server: reliability.server,
      serverMessages: reliability.serverMessages,
      transcriber: reliability.transcriber,
      monitorPlan: reliability.monitorPlan,
      // Apply Skyway's aviation playbook even when VAPI_ASSISTANT_ID points to
      // a saved assistant whose dashboard prompt is stale or generic.
      model: assistant.model,
    },
    metadata: {
      skywayCallId: job.id,
      skywayJobKind: 'fbo_call',
      tripId: job.tripId,
      purpose: job.purpose,
    },
  };
  const assistantId = vapiEnvValue(env, 'assistantId');
  if (assistantId) body.assistantId = assistantId;
  else body.assistant = assistant;
  const phoneNumberId = vapiEnvValue(env, 'phoneNumberId');
  const phoneNumber = vapiEnvValue(env, 'phoneNumber');
  if (phoneNumberId) body.phoneNumberId = phoneNumberId;
  else if (phoneNumber) body.phoneNumber = { twilioPhoneNumber: phoneNumber };
  return body;
}

export async function resolveVapiPhoneNumberId(env = process.env) {
  const configuredId = vapiEnvValue(env, 'phoneNumberId');
  const configuredNumber = vapiEnvValue(env, 'phoneNumber');
  const targetNumber = toE164(configuredNumber || SKYWAY_CALLER_ID);
  // A phone number is occasionally pasted into VAPI_PHONE_NUMBER_ID. Treat it
  // as the lookup target instead of sending it to Vapi as an invalid UUID.
  if (configuredId && !toE164(configuredId)) return configuredId;
  const lookupNumber = toE164(configuredId) || targetNumber;
  if (
    vapiPhoneCache?.id
    && vapiPhoneCache.number === lookupNumber
    && vapiPhoneCache.expiresAt > Date.now()
  ) {
    return vapiPhoneCache.id;
  }
  const apiKey = vapiEnvValue(env, 'apiKey');
  if (!apiKey) {
    const error = new Error('VAPI_API_KEY is missing on this deployment.');
    error.status = 503;
    throw error;
  }
  const response = await fetch('https://api.vapi.ai/phone-number?limit=100', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const records = await response.json().catch(() => []);
  if (!response.ok) {
    const error = new Error(
      records?.message || records?.error || `Vapi phone-number lookup failed (${response.status})`,
    );
    error.status = 502;
    throw error;
  }
  const match = (Array.isArray(records) ? records : records?.results || [])
    .find((record) => toE164(record?.number) === lookupNumber);
  if (!match?.id) {
    const error = new Error(
      `Vapi does not have ${lookupNumber || SKYWAY_CALLER_ID} attached as a phone number. Import the Twilio number in Vapi or set VAPI_PHONE_NUMBER_ID to its Vapi record ID.`,
    );
    error.status = 503;
    throw error;
  }
  vapiPhoneCache = { id: match.id, number: lookupNumber, expiresAt: Date.now() + 5 * 60_000 };
  return match.id;
}

export async function placeVapiPayload(payload, env = process.env) {
  const diagnostics = vendorEnvDiagnostics(env);
  if (diagnostics.missing.length) {
    const error = new Error(
      `Vapi is not configured on this deployment. Set ${diagnostics.missing.join(' and ')} in Vercel, then redeploy.`,
    );
    error.status = 503;
    throw error;
  }
  const phoneNumberId = await resolveVapiPhoneNumberId(env);
  const body = { ...payload, phoneNumberId };
  delete body.phoneNumber;
  const response = await fetch('https://api.vapi.ai/call', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vapiEnvValue(env, 'apiKey')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    const error = new Error(data.message || data.error || `Vapi rejected the call (${response.status})`);
    error.status = 502;
    error.detail = data;
    throw error;
  }
  return data;
}

export async function placeVapiCall(job, config, env = process.env) {
  return placeVapiPayload(vapiCallPayload(job, config, env), env);
}

export async function armCalls({
  trip,
  state,
  purposes,
  verifiedPurposes,
  dialImmediately = true,
  actor,
  now = Date.now(),
}) {
  const config = await readCallConfig();
  if (!config.enabled && !vendorConfigured()) {
    const error = new Error('FBO calling is not enabled. Add Vapi credentials and turn it on in Settings.');
    error.status = 409;
    throw error;
  }
  const wanted = (Array.isArray(purposes) && purposes.length ? purposes : ['departure', 'arrival'])
    .filter((purpose) => purpose === 'departure' || purpose === 'arrival');
  const unverified = unverifiedCallPurposes(wanted, verifiedPurposes);
  if (unverified.length) {
    const error = new Error(`Verify the trip-sheet FBO details before arming: ${unverified.join(', ')}`);
    error.status = 409;
    throw error;
  }
  const created = [];
  const immediateJobIds = [];
  const blocked = [];
  for (const purpose of wanted) {
    const resolved = await resolveFboFacts(trip, state, purpose);
    if (!resolved.ok) {
      blocked.push({ purpose, blockers: resolved.blockers });
      continue;
    }
    const eventMs = purpose === 'arrival'
      ? (resolved.facts.endMs || resolved.facts.startMs)
      : resolved.facts.startMs;
    const planned = scheduledDialAt({
      purpose,
      startMs: resolved.facts.startMs,
      endMs: resolved.facts.endMs,
      depLeadMinutes: config.depLeadMinutes,
      arrLeadMinutes: DEFAULT_ARR_LEAD_MINUTES,
    });
    const when = resolveDialAt(planned, now, eventMs);
    if (!when.ok) {
      blocked.push({ purpose, blockers: [when.reason] });
      continue;
    }
    const makeJob = async ({ callPhase, dialAt, dialMode }) => {
      const id = newCallId();
      const job = {
        id,
        tripId: trip.uid,
        purpose,
        callPhase,
        dialMode,
        status: dialAt > now ? CALL_STATUSES.scheduled : CALL_STATUSES.armed,
        isUpdate: false,
        airport: resolved.facts.airport,
        fboName: resolved.facts.fboName,
        phoneE164: resolved.facts.phoneE164,
        phoneDisplay: resolved.facts.phoneDisplay,
        phoneSource: resolved.facts.phoneSource,
        phoneOverride: resolved.facts.phoneSource === 'override' ? resolved.facts.phoneDisplay : '',
        hours: resolved.facts.hours,
        facts: resolved.facts,
        factsHash: resolved.hash,
        material: resolved.material,
        tripSnapshot: trip,
        dialAt,
        scheduledDialAt: planned,
        attempts: 0,
        maxAttempts: config.maxAttempts,
        callerId: SKYWAY_CALLER_ID,
        callerName: SKYWAY_CALLER_NAME,
        vendor: VOICE_VENDOR,
        leadPassengerDisclosed: resolved.facts.groundTransport === true,
        armedByUid: actor.uid,
        armedByName: actor.name,
        armedAt: now,
        fboDetailsVerifiedAt: now,
        fboDetailsVerifiedByUid: actor.uid,
        fboDetailsVerifiedByName: actor.name,
        lastError: '',
      };
      await writeJob(job);
      created.push(jobPublic(job));
      if (dialAt <= now) immediateJobIds.push(id);
    };

    const dialPlan = armDialPlan({
      purpose,
      plannedAt: planned,
      resolvedDialAt: when.dialAt,
      now,
      dialImmediately,
    });
    for (const plannedJob of dialPlan) await makeJob(plannedJob);
  }
  const dialResults = [];
  for (const id of immediateJobIds) {
    dialResults.push(await dialJobNow(id, { actor, now, force: true }));
  }
  return { created, blocked, dialResults, vendor: publicVendorStatus() };
}

export async function cancelJob(id, actor) {
  const job = await loadJob(id);
  if (!job) {
    const error = new Error('Call not found');
    error.status = 404;
    throw error;
  }
  if (['completed', 'in_progress', 'dialing'].includes(job.status)) {
    const error = new Error('This call can no longer be cancelled from Skyway');
    error.status = 409;
    throw error;
  }
  job.status = CALL_STATUSES.cancelled;
  job.cancelledAt = Date.now();
  job.cancelledByUid = actor.uid;
  job.cancelledByName = actor.name;
  await writeJob(job);
  return jobPublic(job);
}

export async function retryJob(id, actor, now = Date.now()) {
  const original = await loadJob(id);
  if (!original) {
    const error = new Error('Call not found');
    error.status = 404;
    throw error;
  }
  if (!isFinishedCallStatus(original.status)) {
    const error = new Error(`Call cannot be retried while ${original.status}`);
    error.status = 409;
    throw error;
  }
  const idForRetry = newCallId();
  const retry = {
    ...original,
    id: idForRetry,
    status: CALL_STATUSES.armed,
    isUpdate: true,
    callPhase: 'retry',
    dialMode: 'immediate',
    parentCallId: original.id,
    dialAt: now,
    scheduledDialAt: now,
    attempts: 0,
    lastAttemptAt: null,
    lastError: '',
    armedAt: now,
    armedByUid: actor.uid,
    armedByName: actor.name,
    retriedAt: now,
    retriedByUid: actor.uid,
    retriedByName: actor.name,
    summary: '',
    transcript: '',
    confirmations: null,
    vendorCallId: null,
    monitorListenUrl: '',
    monitorControlUrl: '',
    recordingAvailable: false,
    startedAt: null,
    endedAt: null,
    endedReason: '',
  };
  await writeJob(retry);
  await dialJobNow(idForRetry, { actor, now, force: true });
  return jobPublic((await loadJob(idForRetry)) || retry);
}

export async function deleteFinishedJob(id, actor) {
  const job = await loadJob(id);
  if (!job) {
    const error = new Error('Call not found');
    error.status = 404;
    throw error;
  }
  if (!isFinishedCallStatus(job.status)) {
    const error = new Error('Only finished FBO calls can be deleted');
    error.status = 409;
    throw error;
  }
  const deletedAt = Date.now();
  await getDb().collection(EVENTS).doc(`deleted_${sanitizeKey(id)}_${deletedAt}`).set({
    type: 'call-deleted',
    callId: id,
    tripId: job.tripId,
    status: job.status,
    deletedAt,
    deletedByUid: actor.uid,
    deletedByName: actor.name,
  });
  await getDb().collection(JOBS).doc(id).delete();
  await mirrorTripCalls(job.tripId);
  return { id, tripId: job.tripId, deletedAt };
}

export async function applyVendorStatus(job, patch) {
  const next = { ...job, ...patch, updatedAt: Date.now() };
  await writeJob(next);
  return next;
}

async function refreshFollowUpFacts(job) {
  if (job.callPhase !== 'arrival_reverification' || !job.tripSnapshot) return job;
  const stateSnap = await getDb().collection('trip-state').doc(sanitizeKey(job.tripId)).get();
  const state = stateSnap.exists ? stateSnap.data() : {};
  const resolved = await resolveFboFacts(job.tripSnapshot, state, job.purpose);
  if (!resolved.ok) {
    const error = new Error(`Follow-up call blocked: ${resolved.blockers.join('; ')}`);
    error.status = 409;
    throw error;
  }
  return {
    ...job,
    airport: resolved.facts.airport,
    fboName: resolved.facts.fboName,
    phoneE164: resolved.facts.phoneE164,
    phoneDisplay: resolved.facts.phoneDisplay,
    phoneSource: resolved.facts.phoneSource,
    phoneOverride: resolved.facts.phoneSource === 'override' ? resolved.facts.phoneDisplay : '',
    facts: resolved.facts,
    factsHash: resolved.hash,
    material: resolved.material,
  };
}

export async function dialJobNow(id, {
  actor = null,
  now = Date.now(),
  force = false,
} = {}) {
  const ref = getDb().collection(JOBS).doc(id);
  const claimed = await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const error = new Error('Call not found');
      error.status = 404;
      throw error;
    }
    const job = { id: snap.id, ...snap.data() };
    if (!['armed', 'scheduled', 'retry'].includes(job.status)) {
      const error = new Error(`Call cannot be started while ${job.status}`);
      error.status = 409;
      throw error;
    }
    if (!force && Number(job.dialAt) > now) return null;
    const attempts = (job.attempts || 0) + 1;
    tx.update(ref, {
      status: CALL_STATUSES.dialing,
      attempts,
      lastAttemptAt: now,
      dialNowRequestedAt: force ? now : (job.dialNowRequestedAt || null),
      dialNowRequestedByUid: force ? (actor?.uid || '') : (job.dialNowRequestedByUid || ''),
      updatedAt: now,
    });
    return {
      ...job,
      status: CALL_STATUSES.dialing,
      attempts,
      lastAttemptAt: now,
    };
  });
  if (!claimed) return { id, ok: true, skipped: 'not_due' };
  await mirrorTripCalls(claimed.tripId);

  let job = claimed;
  try {
    job = await refreshFollowUpFacts(job);
    const settings = await readCallConfig();
    const placed = await placeVapiCall(job, settings);
    await applyVendorStatus(job, {
      status: CALL_STATUSES.dialing,
      attempts: job.attempts,
      vendorCallId: placed.id,
      monitorListenUrl: placed.monitor?.listenUrl || '',
      monitorControlUrl: placed.monitor?.controlUrl || '',
      monitorUrlsUpdatedAt: placed.monitor?.listenUrl ? now : null,
      lastAttemptAt: now,
      lastError: '',
    });
    return { id, ok: true, vendorCallId: placed.id };
  } catch (error) {
    const settings = await readCallConfig().catch(() => ({
      retryMinutes: DEFAULT_RETRY_MINUTES,
    }));
    const max = job.maxAttempts || DEFAULT_MAX_ATTEMPTS;
    const failed = (job.attempts || 0) >= max || error.status === 409;
    await applyVendorStatus(job, {
      status: failed ? CALL_STATUSES.failed : 'retry',
      attempts: job.attempts,
      lastError: error.message,
      dialAt: failed ? job.dialAt : nextRetryAt(now, settings.retryMinutes),
    });
    if (failed) {
      await notifyOps({
        tripId: job.tripId,
        source: 'fbo-call-failed',
        subject: `FBO call failed — ${job.fboName || ''} ${job.airport || ''}`,
        text: [
          `Skyway could not complete the ${job.purpose} FBO call.`,
          `${job.fboName} ${job.airport} ${job.phoneE164}`,
          `Error: ${error.message}`,
          'Ops should call the FBO directly.',
        ].join('\n'),
      });
    }
    return { id, ok: false, error: error.message, failed };
  }
}

export async function getListenCredentials(id, env = process.env) {
  let job = await loadJob(id);
  if (!job) {
    const error = new Error('Call not found');
    error.status = 404;
    throw error;
  }
  if (!['dialing', 'in_progress'].includes(job.status) || !job.vendorCallId) {
    const error = new Error('Live listening is available only while the call is active');
    error.status = 409;
    throw error;
  }
  if (!job.monitorListenUrl) {
    const response = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(job.vendorCallId)}`, {
      headers: { Authorization: `Bearer ${vapiEnvValue(env, 'apiKey')}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || `Vapi call lookup failed (${response.status})`);
      error.status = 502;
      throw error;
    }
    job = await applyVendorStatus(job, {
      monitorListenUrl: data.monitor?.listenUrl || '',
      monitorControlUrl: data.monitor?.controlUrl || '',
      monitorUrlsUpdatedAt: Date.now(),
    });
  }
  if (!job.monitorListenUrl) {
    const error = new Error('Vapi did not provide a live listen stream for this call');
    error.status = 409;
    throw error;
  }
  return { callId: job.id, listenUrl: job.monitorListenUrl };
}

export async function getRecordingCredentials(id, env = process.env) {
  const job = await loadJob(id);
  if (!job) {
    const error = new Error('Call not found');
    error.status = 404;
    throw error;
  }
  if (!job.vendorCallId || !['completed', 'failed', 'needs_followup'].includes(job.status)) {
    const error = new Error('The call recording is available after the call ends');
    error.status = 409;
    throw error;
  }
  const apiKey = vapiEnvValue(env, 'apiKey');
  if (!apiKey) {
    const error = new Error('VAPI_API_KEY is missing on this deployment');
    error.status = 503;
    throw error;
  }
  const response = await fetch(
    `https://api.vapi.ai/call/${encodeURIComponent(job.vendorCallId)}/mono-recording`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'manual',
    },
  );
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) {
    return { callId: job.id, recordingUrl: location };
  }
  const data = await response.json().catch(() => ({}));
  const recordingUrl = data.url || data.recordingUrl || data.monoUrl || '';
  if (!response.ok || !recordingUrl) {
    const error = new Error(
      data.message || data.error || `Vapi recording is not ready (${response.status})`,
    );
    error.status = response.status === 404 ? 409 : 502;
    throw error;
  }
  return { callId: job.id, recordingUrl };
}

export async function maybeQueueMaterialUpdates({
  trip,
  state,
  verifiedPurposes,
  actor,
  now = Date.now(),
}) {
  const jobs = await listTripCalls(trip.uid);
  const armedFamily = jobs.filter((job) => job.status !== CALL_STATUSES.cancelled);
  if (armedFamily.length === 0) return [];
  const verified = new Set(Array.isArray(verifiedPurposes) ? verifiedPurposes : []);
  const created = [];
  const createdIds = [];
  for (const purpose of ['departure', 'arrival']) {
    const latest = [...armedFamily].reverse().find((job) => job.purpose === purpose);
    if (!latest) continue;
    const resolved = await resolveFboFacts(trip, state, purpose);
    if (!resolved.ok) continue;
    if (resolved.hash === latest.factsHash) continue;
    if (!['completed', 'needs_followup', 'failed', 'armed', 'scheduled'].includes(latest.status)) continue;
    if (['dialing', 'in_progress'].includes(latest.status)) continue;
    if (!verified.has(purpose)) {
      const error = new Error(`Verify the updated trip-sheet FBO details before arming: ${purpose}`);
      error.status = 409;
      throw error;
    }
    const id = newCallId();
    const job = {
      ...latest,
      id,
      status: CALL_STATUSES.armed,
      isUpdate: true,
      callPhase: 'update',
      dialMode: 'immediate',
      parentCallId: latest.id,
      facts: resolved.facts,
      factsHash: resolved.hash,
      material: resolved.material,
      phoneE164: resolved.facts.phoneE164,
      phoneDisplay: resolved.facts.phoneDisplay,
      phoneSource: resolved.facts.phoneSource,
      phoneOverride: resolved.facts.phoneSource === 'override' ? resolved.facts.phoneDisplay : '',
      hours: resolved.facts.hours,
      fboName: resolved.facts.fboName,
      tripSnapshot: trip,
      dialAt: now,
      scheduledDialAt: now,
      attempts: 0,
      lastError: '',
      armedAt: now,
      armedByUid: actor?.uid || latest.armedByUid || '',
      armedByName: actor?.name || latest.armedByName || '',
      fboDetailsVerifiedAt: now,
      fboDetailsVerifiedByUid: actor?.uid || '',
      fboDetailsVerifiedByName: actor?.name || '',
      summary: '',
      transcript: '',
      confirmations: null,
      vendorCallId: null,
      monitorListenUrl: '',
      monitorControlUrl: '',
    };
    await writeJob(job);
    created.push(jobPublic(job));
    createdIds.push(id);
  }
  for (const id of createdIds) await dialJobNow(id, { actor, now, force: true });
  if (created.length) {
    await notifyOps({
      tripId: trip.uid,
      source: 'fbo-call-update',
      subject: `FBO update call queued — ${trip.info?.tail || ''} ${trip.info?.from || ''}-${trip.info?.to || ''}`,
      text: `A material trip change was detected. ${created.length} update call(s) were armed to the FBO.\n\n${created.map((call) => `${call.purpose}: ${call.fboName} ${call.airport}`).join('\n')}`,
    });
  }
  return created;
}

export { materialHash, nextRetryAt, CALL_STATUSES };
