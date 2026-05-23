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
  collection, doc, addDoc, setDoc, updateDoc, serverTimestamp,
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
 */
export async function updateAMLStage(id, stage, extra = {}) {
  await updateDoc(doc(db, COLLECTION, id), {
    stage,
    [`stageChangedAt_${stage}`]: serverTimestamp(),
    ...extra,
  });
}
