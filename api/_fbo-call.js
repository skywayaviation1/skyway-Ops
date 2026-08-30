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
  assistantSystemPrompt,
  buildSpeakableFacts,
  firstMessage,
  materialHash,
  nextRetryAt,
  publicCallSummary,
  resolveDialAt,
  scheduledDialAt,
  toE164,
  unverifiedCallPurposes,
  vendorConfigured,
} from '../src/fbo-call.js';

const CONFIG_PATH = ['app-config', 'fbo-call'];
const JOBS = 'fbo-call-jobs';
const EVENTS = 'fbo-call-events';

let app = null;
let db = null;

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
  return {
    vendor: VOICE_VENDOR,
    pstn: 'twilio',
    callerId: SKYWAY_CALLER_ID,
    callerName: SKYWAY_CALLER_NAME,
    configured: vendorConfigured(env),
    hasAssistant: Boolean(String(env.VAPI_ASSISTANT_ID || '').trim()),
    hasWebhookSecret: Boolean(String(env.VAPI_WEBHOOK_SECRET || '').trim()),
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
  const transfer = toE164(config.opsTransferNumber) || SKYWAY_CALLER_ID;
  const variableValues = {
    callerName: facts.callerName,
    fboName: facts.fboName,
    airport: facts.airport,
    tail: facts.tail,
    purpose: facts.purpose,
    paxCount: String(facts.paxCount ?? ''),
    hasCatering: facts.hasCatering ? 'yes' : 'no',
    groundTransport: facts.groundTransport ? 'yes' : 'no',
    leadPassengerName: facts.groundTransport ? (facts.leadPassengerName || '') : '',
    hours: facts.hoursKnown ? facts.hours : 'not on file',
    specialItems: facts.specialItems || 'none on file',
  };
  const assistant = {
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
      summaryPrompt: 'Summarize the FBO call for Skyway operations in 6 short bullets. Include confirmations and anything that needs a human.',
      structuredDataSchema: {
        type: 'object',
        properties: {
          movementConfirmed: { type: 'boolean' },
          fuelConfirmed: { type: 'boolean' },
          hangarConfirmed: { type: 'boolean' },
          cateringConfirmed: { type: 'boolean' },
          groundTransportConfirmed: { type: 'boolean' },
          hoursVerified: { type: 'string' },
          needsFollowUp: { type: 'boolean' },
          transferredToOps: { type: 'boolean' },
          notes: { type: 'string' },
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
    },
    metadata: {
      skywayCallId: job.id,
      tripId: job.tripId,
      purpose: job.purpose,
    },
  };
  const assistantId = String(env.VAPI_ASSISTANT_ID || '').trim();
  if (assistantId) body.assistantId = assistantId;
  else body.assistant = assistant;
  const phoneNumberId = String(env.VAPI_PHONE_NUMBER_ID || '').trim();
  if (phoneNumberId) body.phoneNumberId = phoneNumberId;
  else if (env.VAPI_PHONE_NUMBER) body.phoneNumber = { twilioPhoneNumber: env.VAPI_PHONE_NUMBER };
  return body;
}

export async function placeVapiCall(job, config, env = process.env) {
  if (!vendorConfigured(env)) {
    const error = new Error('Vapi is not configured. Set VAPI_API_KEY and VAPI_PHONE_NUMBER_ID.');
    error.status = 503;
    throw error;
  }
  const response = await fetch('https://api.vapi.ai/call', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(vapiCallPayload(job, config, env)),
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

    if (dialImmediately !== false) {
      await makeJob({ callPhase: 'initial', dialAt: now, dialMode: 'immediate' });
      if (purpose === 'arrival' && planned > now + 60_000) {
        await makeJob({
          callPhase: 'arrival_reverification',
          dialAt: planned,
          dialMode: 'scheduled',
        });
      }
    } else {
      await makeJob({
        callPhase: purpose === 'arrival' ? 'arrival_reverification' : 'initial',
        dialAt: when.dialAt,
        dialMode: 'scheduled',
      });
    }
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
  const job = await loadJob(id);
  if (!job) {
    const error = new Error('Call not found');
    error.status = 404;
    throw error;
  }
  job.status = 'retry';
  job.dialAt = now;
  job.lastError = '';
  job.retriedByUid = actor.uid;
  job.retriedByName = actor.name;
  await writeJob(job);
  return jobPublic(job);
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
      headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` },
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
