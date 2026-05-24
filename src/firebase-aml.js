// firebase-aml.js — Aircraft Maintenance Log (AML) data layer.
//
// AML entries are the digital form of Skyway Aviation's paper AML
// (form S-3-2/R-31). Each entry corresponds to one discrepancy/maint
// request and progresses through these stages:
//
//   1. CREATED  — Part I filled in by pilot or maintenance person.
//                 Discrepancy described, aircraft hours captured.
//   2. DEFERRED — (optional) MEL reference attached, DOM has confirmed
//                 the deferral. AOG record created.
//   3. CLEARED  — Part II filled in by mechanic performing corrective
//                 action. Return to service authorization captured.
//   4. RTS      — DOM approves return to service (Part III).
//   5. CLOSED   — DOM has updated permanent records / tracking
//                 system (Part IV). Entry is complete.
//
// IMPORTANT — REGULATORY POSTURE:
// This is a prototype digital workflow. Whether it satisfies §43.9 /
// §43.11 record-keeping requirements is a determination only Skyway's
// DOM (and ultimately the operator's FAA POI) can make. Until the
// digital workflow is approved for operational use, AML records here
// are a parallel record to whatever paper or other system Skyway uses.
// Both should be maintained until the DOM signs off.

import { db } from './firebase.js';
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, serverTimestamp,
  query, where, orderBy, onSnapshot, getDoc,
} from 'firebase/firestore';

const COLLECTION = 'aml-entries';

/**
 * Create a new AML entry (Part I — discrepancy/maintenance request).
 * Returns the new entry's ID.
 *
 * @param {Object} entry
 * @param {string} entry.tail               e.g. "N525CR"
 * @param {string} entry.serialNumber       optional
 * @param {string} entry.aftt               airframe total time (hours)
 * @param {string} entry.hobbs              hobbs meter
 * @param {string} entry.landings           landings count
 * @param {string} entry.discrepancy        text description
 * @param {string} entry.requestedBy        user uid (typed name auto-filled)
 * @param {string} entry.requestedByName    display name at time of signing
 * @param {string} entry.requestedByCert    optional cert# if requester has one
 * @param {Object} entry.createdAtClient    client-side timestamp ms (for offline tolerance)
 */
export async function createAML(entry) {
  const docRef = await addDoc(collection(db, COLLECTION), {
    ...entry,
    stage: 'CREATED',
    createdAt: serverTimestamp(),
    createdAtClient: entry.createdAtClient || Date.now(),
    // Audit trail — append-only list of state transitions
    history: [{
      stage: 'CREATED',
      at: entry.createdAtClient || Date.now(),
      by: entry.requestedBy,
      byName: entry.requestedByName,
    }],
  });
  return docRef.id;
}

/**
 * Subscribe to all AML entries, sorted by creation time descending.
 * Returns the unsubscribe function.
 *
 * Note: queries the full collection. For Skyway's volume this is fine.
 * If the collection grows past ~10k entries, add a where('archived', '==', false)
 * filter or limit(N) here.
 */
export function subscribeAMLEntries(onUpdate) {
  const q = query(collection(db, COLLECTION), orderBy('createdAtClient', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      onUpdate(list);
    },
    (err) => {
      console.error('[aml] subscribe error:', err);
      onUpdate([]);
    },
  );
}

/**
 * Subscribe to AML entries for a specific tail. Used by the MAINT
 * screen's per-tail view.
 */
export function subscribeAMLByTail(tail, onUpdate) {
  if (!tail) { onUpdate([]); return () => {}; }
  const q = query(
    collection(db, COLLECTION),
    where('tail', '==', tail.toUpperCase()),
    orderBy('createdAtClient', 'desc'),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      onUpdate(list);
    },
    (err) => {
      console.error('[aml] tail subscribe error:', err);
      onUpdate([]);
    },
  );
}

/**
 * Fetch a single AML by ID (one-shot, not subscription).
 */
export async function getAML(id) {
  const snap = await getDoc(doc(db, COLLECTION, id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Append a history event to an AML entry. Used during state transitions
 * (deferral, clearance, RTS, close) so the audit trail is complete.
 * This is a helper for Turn 2+ work — exported here so the API is in
 * one place.
 */
export async function appendAMLHistory(id, event) {
  const ref = doc(db, COLLECTION, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('AML not found');
  const history = Array.isArray(snap.data().history) ? snap.data().history : [];
  history.push({
    ...event,
    at: event.at || Date.now(),
  });
  await updateDoc(ref, { history });
}

/**
 * Update an AML's stage. Convenience wrapper around updateDoc.
 * Used internally by deferAMLAsMELable/groundAML, available for
 * future Part II/III/IV transitions.
 */
export async function updateAMLStage(id, stage, extra = {}) {
  await updateDoc(doc(db, COLLECTION, id), {
    stage,
    [`stageChangedAt_${stage}`]: serverTimestamp(),
    ...extra,
  });
}

/**
 * Delete an AML record. ADMIN ONLY operation — gated by caller's role,
 * not enforced server-side here. Because AMLs are regulatory records
 * (§43.9 / §43.11), this should only be used to remove records
 * created in error.
 *
 * Safety: if the AML has downstream records (squawk, MEL deferral,
 * service request), refuses to delete unless those have been
 * explicitly cleared/closed/deleted first. That prevents an orphaned
 * MEL or SR sitting on an aircraft after its parent AML is gone.
 *
 * Hard-deletes the document. The history is captured in the deletion
 * audit record stored under `aml-deletions/{id}` so we don't completely
 * lose the trail.
 *
 * @param {Object} args
 * @param {string} args.amlId
 * @param {Object} args.deleter      { uid, name, role }
 * @param {string} [args.reason]
 * @param {boolean} [args.force]     if true, skip downstream check (super-admin)
 */
export async function deleteAML({ amlId, deleter, reason, force }) {
  if (!amlId) throw new Error('deleteAML: amlId required');
  if (!deleter?.name) throw new Error('deleteAML: deleter required');
  const ref = doc(db, COLLECTION, amlId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('AML not found');
  const data = snap.data();

  // Downstream safety check
  if (!force) {
    const downstream = [];
    if (data.squawkId)         downstream.push(`squawk ${data.squawkId}`);
    if (data.melItemId)        downstream.push(`MEL deferral ${data.melItemId}`);
    if (data.serviceRequestId) downstream.push(`service request ${data.serviceRequestId}`);
    if (downstream.length > 0) {
      throw new Error(
        `AML has downstream records: ${downstream.join(', ')}. Clear/close those before deleting, or pass force=true.`
      );
    }
  }

  // Write audit trail BEFORE deleting — so we keep a record of what
  // was deleted, who deleted it, and when.
  await setDoc(doc(db, 'aml-deletions', amlId), {
    deletedAt: Date.now(),
    deletedBy: deleter.uid || null,
    deletedByName: deleter.name,
    deletedByRole: deleter.role || null,
    reason: reason || null,
    originalRecord: data,
  });

  await deleteDoc(ref);
  return { ok: true };
}

/**
 * Update editable fields on an AML. Strict about what's allowed to
 * change based on stage:
 *
 *   - Before DEFERRED/GROUNDED: requester can edit anything they
 *     entered. Discrepancy, meter times, aircraft fields.
 *   - After DEFERRED/GROUNDED: only remarks/notes are editable, NOT
 *     the discrepancy itself (that's been used to create the
 *     downstream squawk/MEL/SR records and changing it after-the-fact
 *     would be inconsistent).
 *
 * Once an AML is CLEARED or beyond, no field edits at all — the
 * record is a regulatory document.
 *
 * The edit is appended to the history with the editor's identity.
 *
 * @param {Object} args
 * @param {string} args.amlId
 * @param {Object} args.updates     fields to set
 * @param {Object} args.editor      { uid, name }
 * @param {string} [args.reason]    why the edit (optional)
 */
export async function updateAML({ amlId, updates, editor, reason }) {
  if (!amlId) throw new Error('updateAML: amlId required');
  if (!editor?.name) throw new Error('updateAML: editor name required');
  const ref = doc(db, COLLECTION, amlId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('AML not found');
  const current = snap.data();
  const stage = current.stage || 'CREATED';

  // Whitelist allowed fields per stage. This is the regulatory guardrail —
  // editing a signed-off field would be a record falsification.
  const allowedByStage = {
    CREATED:  ['discrepancy', 'aftt', 'hobbs', 'landings', 'serialNumber', 'tail', 'date'],
    DEFERRED: ['melRemarks', 'melItemRef', 'melItemDescription', 'melPartDeferred'],
    GROUNDED: ['groundingReason'],
    CLEARED:  [],
    RTS:      [],
    CLOSED:   [],
  };
  const allowed = allowedByStage[stage] || [];
  if (allowed.length === 0) {
    throw new Error(`AML in stage ${stage} is locked; no edits permitted`);
  }

  // Filter to allowed fields, ignore the rest
  const safeUpdates = {};
  const changedFields = [];
  for (const key of Object.keys(updates || {})) {
    if (allowed.includes(key)) {
      const before = current[key];
      const after = updates[key];
      if (before !== after) {
        safeUpdates[key] = after;
        changedFields.push({ field: key, before, after });
      }
    }
  }
  if (changedFields.length === 0) {
    return { updated: false };
  }

  // Append history event
  const history = Array.isArray(current.history) ? current.history : [];
  history.push({
    stage,                    // stays same — edit doesn't change stage
    action: 'EDITED',
    at: Date.now(),
    by: editor.uid || null,
    byName: editor.name,
    note: reason || `Edited: ${changedFields.map((c) => c.field).join(', ')}`,
    changes: changedFields,
  });

  await updateDoc(ref, {
    ...safeUpdates,
    history,
    lastEditedAt: Date.now(),
    lastEditedBy: editor.uid || null,
    lastEditedByName: editor.name,
  });
  return { updated: true, changedFields };
}

/**
 * Defer an AML under the MEL. The aircraft REMAINS AIRWORTHY under
 * MEL provisos — this is the correct behavior because deferring an
 * item under the MEL means the operator has determined the aircraft
 * can fly with that item inoperative (with whatever provisos the MEL
 * specifies).
 *
 * This creates:
 *   1. A Service Request (NOT a grounding squawk) so maintenance has
 *      a tracked task to clear the deferral within the MEL time limit.
 *   2. A maint-mel entry (the MEL deferral with category/limit days)
 *      — what gets cleared when the deferral is repaired.
 *   3. Updates the AML to stage=DEFERRED with refs to both above.
 *
 * @param {Object} args
 * @param {string} args.amlId
 * @param {Object} args.aml                 the AML doc (for tail/discrepancy)
 * @param {string} args.melCategory         A | B | C | D
 * @param {number} [args.melLimitDays]      manual override for Cat A
 * @param {string} [args.melRemarks]
 * @param {string} [args.melItemRef]        ATA item reference from MEL
 * @param {string} [args.ataCode]
 * @param {string} [args.dueDate]           ISO date
 * @param {string} [args.location]          airport code where aircraft is
 * @param {string} [args.fboName]           FBO where service will happen
 * @param {Object} args.approver            { uid, name, certificateNumber }
 * @param {string} [args.approverSignature] base64 PNG drawn signature
 */
export async function deferAMLAsMELable(args) {
  const {
    amlId, aml, melCategory, melLimitDays, melRemarks,
    melItemRef, melItemDescription, partDeferred,
    ataCode, dueDate, location, fboName,
    approver, approverSignature,
  } = args;
  if (!amlId || !aml) throw new Error('deferAMLAsMELable: amlId + aml required');
  if (!aml.tail) throw new Error('deferAMLAsMELable: aml missing tail');
  if (!melCategory) throw new Error('deferAMLAsMELable: melCategory required');
  if (!approver?.name) throw new Error('deferAMLAsMELable: approver name required');

  const maint = await import('./firebase-maint.js');
  const service = await import('./firebase-service.js');

  // 1. MEL deferral entry — now carries the structured ref + part info
  //    so the FleetStatus board can show specifically what's deferred.
  const melId = await maint.createMelDeferral({
    tail: aml.tail,
    squawkId: null,           // no squawk — aircraft is airworthy
    description: aml.discrepancy || '(see AML)',
    melItemRef: melItemRef || null,
    melItemDescription: melItemDescription || null,
    partDeferred: partDeferred || null,
    category: melCategory,
    limitDays: melLimitDays,
    remarks: melRemarks || null,
    deferredAt: Date.now(),
  });

  // 2. Service Request so maintenance has a tracked task to clear
  //    the deferral within the time limit. NOT an AOG record —
  //    aircraft remains airworthy under MEL provisos.
  const srTitle = melItemRef
    ? `Clear MEL ${melItemRef}${partDeferred ? ` (${partDeferred})` : ''}`
    : 'Clear MEL deferral';
  const srId = await service.createServiceRequest({
    tail: aml.tail,
    location: location || aml.tail,   // best-guess fallback
    fboName: fboName || '',
    serviceDescription: `${srTitle}: ${aml.discrepancy || '(see AML)'}`.slice(0, 4000),
    serviceType: `MEL Cat ${melCategory}${dueDate ? ` · Due ${dueDate}` : ''}`,
    requestedDate: dueDate || new Date().toISOString().slice(0, 10),
    recipients: [],
    requester: {
      uid: approver.uid,
      displayName: approver.name,
    },
  });

  // 3. Update AML
  const ref = doc(db, COLLECTION, amlId);
  const snap = await getDoc(ref);
  const history = Array.isArray(snap.data().history) ? snap.data().history : [];
  history.push({
    stage: 'DEFERRED',
    at: Date.now(),
    by: approver.uid,
    byName: approver.name,
    byCert: approver.certificateNumber || null,
    note: `Approved deferral under MEL ${melItemRef || ''}${partDeferred ? ` (${partDeferred})` : ''} (Cat ${melCategory}) — aircraft remains airworthy. SR ${srId} created.`.trim(),
    signatureDataUrl: approverSignature || null,
  });
  await updateDoc(ref, {
    stage: 'DEFERRED',
    melItemId: melId,
    serviceRequestId: srId,
    melItemRef: melItemRef || null,
    melItemDescription: melItemDescription || null,
    melPartDeferred: partDeferred || null,
    ataCode: ataCode || null,
    melCategory,
    melLimitDays: melLimitDays || null,
    melDueDate: dueDate || null,
    melRemarks: melRemarks || null,
    deferralApprovedBy: approver.uid,
    deferralApprovedByName: approver.name,
    deferralApprovedByCert: approver.certificateNumber || null,
    deferralApprovedAt: Date.now(),
    deferralSignatureDataUrl: approverSignature || null,
    history,
  });

  return { melId, serviceRequestId: srId };
}

/**
 * Ground the aircraft for an AML that CANNOT be deferred under the
 * MEL. This is the path the DOM takes when the discrepancy isn't a
 * MEL'able item, or doesn't meet the provisos for deferral.
 *
 * This creates:
 *   1. A maint-squawk record with grounding=true. Feeds the existing
 *      FleetStatus board and AOG infrastructure.
 *   2. Updates the AML to stage=GROUNDED with the grounding rationale.
 *
 * NO MEL deferral entry, NO Service Request — those are only for the
 * MEL'able path. The aircraft is AOG until repaired and DOM signs off
 * on the return-to-service.
 */
export async function groundAML(args) {
  const { amlId, aml, reason, approver, approverSignature } = args;
  if (!amlId || !aml) throw new Error('groundAML: amlId + aml required');
  if (!aml.tail) throw new Error('groundAML: aml missing tail');
  if (!approver?.name) throw new Error('groundAML: approver name required');

  const maint = await import('./firebase-maint.js');

  // 1. Grounding squawk
  const squawkId = await maint.createSquawk({
    tail: aml.tail,
    description: aml.discrepancy || '(see AML)',
    grounding: true,
    byUid: approver.uid,
    byName: approver.name,
    byRole: 'aml',
  });

  // 2. Update AML
  const ref = doc(db, COLLECTION, amlId);
  const snap = await getDoc(ref);
  const history = Array.isArray(snap.data().history) ? snap.data().history : [];
  history.push({
    stage: 'GROUNDED',
    at: Date.now(),
    by: approver.uid,
    byName: approver.name,
    byCert: approver.certificateNumber || null,
    note: `Aircraft grounded — discrepancy non-MEL'able. ${reason || ''}`.trim(),
    signatureDataUrl: approverSignature || null,
  });
  await updateDoc(ref, {
    stage: 'GROUNDED',
    squawkId,
    groundingReason: reason || null,
    groundedBy: approver.uid,
    groundedByName: approver.name,
    groundedByCert: approver.certificateNumber || null,
    groundedAt: Date.now(),
    groundingSignatureDataUrl: approverSignature || null,
    history,
  });

  return { squawkId };
}
