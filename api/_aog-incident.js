// Ops reports an AOG. Every report notifies Charter Flight Support.
// The document id is the idempotency key, so a double submit does not send
// a second email. Coverage percentage is included only when 100% is bound.

import crypto from 'crypto';
import { CFS_BIND_CC, CFS_BIND_TO } from '../src/aog-recovery.js';
import { isHundredCoverage } from '../src/aog-reporting.js';
import {
  cfsIncidentView,
  coverageIsBound,
  incidentCfsLetter,
  validateAogReport,
} from '../src/aog-incident.js';
import {
  COLLECTION,
  appendCoverageEvent,
  hashOfferToken,
  newOfferToken,
  sendRecoveryEmail,
} from './_aog-recovery.js';

export const INCIDENTS = 'aogIncidents';

function docId(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function coverageForTrip(db, tripId) {
  const snap = await db.collection(COLLECTION).where('tripId', '==', tripId).limit(8).get();
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

async function notifyCfs(db, ref, incident, baseUrl) {
  const now = new Date().toISOString();
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() || {};
    if (data.cfsNotified === true) return false;
    tx.set(ref, { cfsNotifiedAt: now }, { merge: true });
    return true;
  });
  if (!claimed) return { notified: true, duplicate: true };
  const token = newOfferToken();
  const url = `${String(baseUrl || '').replace(/\/$/, '')}/cfs?aog=${encodeURIComponent(token)}`;
  const letter = incidentCfsLetter(incident, url);
  let sent = { ok: false, error: 'send failed' };
  try {
    sent = await sendRecoveryEmail({
      to: CFS_BIND_TO,
      cc: CFS_BIND_CC,
      subject: letter.subject,
      html: letter.html,
      text: letter.text,
    });
  } catch (err) {
    sent = { ok: false, error: err.message || 'send failed' };
  }
  await ref.set({
    cfsNotified: true,
    tokenHash: hashOfferToken(token),
    emailError: sent.ok ? '' : (sent.error || 'send failed'),
  }, { merge: true });
  return { notified: sent.ok, duplicate: false, emailError: sent.ok ? '' : (sent.error || 'send failed') };
}

export async function createAogIncident(db, input, { actor, baseUrl } = {}) {
  const parsed = validateAogReport(input);
  if (!parsed.ok) throw httpError(parsed.error, 400);
  const value = parsed.value;
  if (!value.idempotencyKey) throw httpError('Missing idempotency key', 400);
  const ref = db.collection(INCIDENTS).doc(docId(value.idempotencyKey));
  const existing = await ref.get();
  if (existing.exists) {
    const data = existing.data() || {};
    return {
      incident: { id: ref.id, ...data },
      duplicate: true,
      notified: data.cfsNotified === true,
      reason: data.notifyBlockReason || '',
    };
  }
  const records = await coverageForTrip(db, value.tripId);
  const now = new Date().toISOString();
  const hundred = records.find((row) => isHundredCoverage(row.coverageLevel));
  const data = {
    ...value,
    status: 'active',
    createdAt: now,
    createdBy: actor || '',
    cfsNotified: false,
    coverageBound: coverageIsBound(records),
    notifyBlockReason: '',
    updates: [{ at: now, text: 'AOG reported', by: actor || 'ops', role: 'ops' }],
    coverageId: hundred?.id || records[0]?.id || '',
  };
  await ref.set(data);
  if (data.coverageId) {
    await appendCoverageEvent(db, data.coverageId, {
      type: 'aog_reported',
      atUtc: now,
      actor: actor || '',
      detail: `${value.location}: ${value.issue}`.slice(0, 500),
      tripId: value.tripId,
    }).catch(() => {});
  }
  const sent = await notifyCfs(db, ref, { id: ref.id, ...data }, baseUrl);
  return {
    incident: { id: ref.id, ...data, cfsNotified: true },
    duplicate: sent.duplicate,
    notified: sent.notified === true,
    emailError: sent.emailError || '',
    reason: '',
  };
}

export async function postAogUpdate(db, { id, text, actor, resolve = false, role = 'ops' } = {}) {
  const ref = db.collection(INCIDENTS).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw httpError('AOG incident not found', 404);
  const note = String(text || '').trim().slice(0, 1000);
  if (!resolve && note.length < 2) throw httpError('Enter an update', 400);
  const now = new Date().toISOString();
  const current = snap.data() || {};
  const row = {
    at: now,
    text: resolve ? (note || 'Marked resolved') : note,
    by: actor || role,
    role,
  };
  const patch = {
    updates: [...(current.updates || []), row].slice(-40),
    updatedAt: now,
  };
  if (resolve) {
    patch.status = 'resolved';
    patch.resolvedAt = now;
  } else if (role === 'cfs' && current.status === 'active') {
    patch.status = 'acknowledged';
  }
  await ref.set(patch, { merge: true });
  return { id: ref.id, ...current, ...patch };
}

export async function listAogIncidents(db, { cfsOnly = false } = {}) {
  const snap = await db.collection(INCIDENTS).limit(40).get();
  return snap.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((row) => (cfsOnly ? row.cfsNotified === true && row.status !== 'resolved' : true))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function findIncidentByToken(db, token) {
  const hash = hashOfferToken(token);
  if (!hash) return null;
  const snap = await db.collection(INCIDENTS).where('tokenHash', '==', hash).limit(1).get();
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { id: docSnap.id, ...docSnap.data() };
}

export function presentIncident(incident, { cfs = false } = {}) {
  if (!cfs) return incident;
  return cfsIncidentView(incident);
}
