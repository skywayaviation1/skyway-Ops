import { reviewerSessionBlock } from '../src/reviewer-account.js';
// Authenticated OCC control actions and shift log. These are coordination
// states, not a regulatory flight release. Every trip mutation writes an
// immutable audit entry with the controller identity.
//
// Shift handoff notes are submitted on create. There is no draft. Any
// active ops or admin user may edit or delete a submitted note; drafts
// and any other non-submitted status are rejected. Notes older than 7
// days are omitted here and deleted by /api/shift-handoff-cleanup.
// Direct client access to `ops-shift-log` is denied — see
// firebase/appusers-ops-shift-log.rules, which must be merged into the
// deployed `appusers` rules (it is not deployed by firebase.json).

import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  HANDOFF_COLLECTION,
  buildHandoffEdit,
  buildSubmittedHandoff,
  handoffMutationBlock,
  normalizeHandoffId,
  visibleHandoffs,
} from '../src/shift-handoff.js';

const ROLES = new Set(['ops', 'admin']);
const DISPOSITIONS = new Set(['monitoring', 'ready', 'hold']);

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

function safeTripId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

async function authorize(idToken) {
  if (!idToken) return null;
  const app = getAdmin();
  const decoded = reviewerSessionBlock(await admin.auth(app).verifyIdToken(idToken, true));
  const db = getFirestore(app, 'appusers');
  const snap = await db.collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (!snap.exists || !ROLES.has(profile.role) || profile.active === false || profile.approved !== true) {
    return null;
  }
  return {
    app,
    db,
    uid: decoded.uid,
    name: profile.name || decoded.name || decoded.email || 'Operations',
    role: profile.role,
  };
}

function auditPayload(caller, action, detail = {}) {
  return {
    action,
    detail,
    actorUid: caller.uid,
    actorName: caller.name,
    actorRole: caller.role,
    createdAt: Date.now(),
  };
}

async function mutateTrip(caller, body) {
  const tripId = safeTripId(body.tripId);
  if (!tripId) throw Object.assign(new Error('tripId required'), { status: 400 });
  const ref = caller.db.collection('trip-state').doc(tripId);
  const now = Date.now();
  let patch = {};
  let detail = {};

  if (body.action === 'claim') {
    patch = {
      dispatcherUids: FieldValue.arrayUnion(caller.uid),
      opsUpdatedAt: now,
      opsUpdatedByName: caller.name,
    };
  } else if (body.action === 'unclaim') {
    patch = {
      dispatcherUids: FieldValue.arrayRemove(caller.uid),
      opsUpdatedAt: now,
      opsUpdatedByName: caller.name,
    };
  } else if (body.action === 'set-disposition') {
    const disposition = String(body.disposition || '').toLowerCase();
    const reason = String(body.reason || '').trim().slice(0, 500);
    if (!DISPOSITIONS.has(disposition)) {
      throw Object.assign(new Error('Invalid disposition'), { status: 400 });
    }
    if (disposition === 'hold' && !reason) {
      throw Object.assign(new Error('A reason is required to place a trip on hold'), { status: 400 });
    }
    patch = {
      opsDisposition: disposition,
      opsDispositionReason: reason || null,
      opsUpdatedAt: now,
      opsUpdatedByUid: caller.uid,
      opsUpdatedByName: caller.name,
    };
    detail = { disposition, reason };
  } else if (body.action === 'add-trip-note') {
    const note = String(body.note || '').trim().slice(0, 1000);
    if (!note) throw Object.assign(new Error('Note required'), { status: 400 });
    patch = {
      opsLatestNote: note,
      opsLatestNoteAt: now,
      opsLatestNoteByName: caller.name,
      opsUpdatedAt: now,
      opsUpdatedByName: caller.name,
    };
    detail = { note };
  } else {
    throw Object.assign(new Error('Unknown trip action'), { status: 400 });
  }

  const auditRef = ref.collection('ops-audit').doc();
  const batch = caller.db.batch();
  batch.set(ref, patch, { merge: true });
  batch.set(auditRef, auditPayload(caller, body.action, detail));
  await batch.commit();
  return { tripId, action: body.action, updatedAt: now };
}

export async function addShiftNote(caller, body) {
  const payload = buildSubmittedHandoff({
    text: body.note,
    category: body.category,
    pinned: body.pinned,
    author: caller,
  });
  const ref = caller.db.collection(HANDOFF_COLLECTION).doc();
  await ref.set(payload);
  return { id: ref.id, ...payload };
}

async function loadShiftNote(caller, noteId) {
  const id = normalizeHandoffId(noteId);
  const snap = await caller.db.collection(HANDOFF_COLLECTION).doc(id).get();
  if (!snap.exists) return { id, data: null };
  return { id, data: snap.data() || null };
}

function assertMutable(data) {
  const block = handoffMutationBlock(data);
  if (!block) return;
  throw Object.assign(new Error(block.error), { status: block.status });
}

export async function updateShiftNote(caller, body) {
  const { id, data } = await loadShiftNote(caller, body.noteId);
  assertMutable(data);
  const patch = buildHandoffEdit(data, {
    text: body.note,
    category: body.category,
    pinned: body.pinned,
    editor: caller,
  });
  await caller.db.collection(HANDOFF_COLLECTION).doc(id).set(patch, { merge: true });
  return { id, ...data, ...patch };
}

export async function deleteShiftNote(caller, body) {
  const { id, data } = await loadShiftNote(caller, body.noteId);
  assertMutable(data);
  await caller.db.collection(HANDOFF_COLLECTION).doc(id).delete();
  return { id };
}

export async function listShiftNotes(caller) {
  const snap = await caller.db.collection(HANDOFF_COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();
  const notes = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return visibleHandoffs(notes).slice(0, 75);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const caller = await authorize(req.body?.idToken);
    if (!caller) {
      res.status(403).json({ error: 'Active operations or administrator access required' });
      return;
    }
    const action = req.body?.action;
    if (action === 'list-shift-notes') {
      res.status(200).json({ ok: true, notes: await listShiftNotes(caller) });
      return;
    }
    if (action === 'add-shift-note') {
      res.status(201).json({ ok: true, note: await addShiftNote(caller, req.body) });
      return;
    }
    if (action === 'update-shift-note') {
      res.status(200).json({ ok: true, note: await updateShiftNote(caller, req.body) });
      return;
    }
    if (action === 'delete-shift-note') {
      res.status(200).json({ ok: true, ...(await deleteShiftNote(caller, req.body)) });
      return;
    }
    const result = await mutateTrip(caller, req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[ops-control-action]', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Operations action failed' });
  }
}
