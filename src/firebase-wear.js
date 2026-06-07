// src/firebase-wear.js
//
// Wear Watch — tire + brake wear tracking for the Skyway fleet.
//
// Three collections in the `appusers` named Firestore DB:
//
//   wear-items / {tail}-{position}-{itemType}
//     Current state per (tail × position × itemType). Deterministic id =
//     easy upsert. One row per wear item per aircraft. For a CJ3/Lear 60
//     that's 5 items: nose tire, main-l tire, main-l brake, main-r tire,
//     main-r brake.
//
//   wear-inspections / {auto}
//     Append-only log. Every pilot inspection writes one row per item
//     checked. Drives the per-item history chart and the AI vision
//     analysis pipeline.
//
//   wear-training / {auto}
//     Labeled reference photos for AI training (Phase 2). Admin uploads
//     photos and labels them GOOD/MONITOR/REPLACE_SOON/GROUNDED for an
//     (aircraftType × itemType) bucket. Used as comparison set when the
//     vision endpoint analyzes new pilot photos.
//
// All photos live in Firebase Storage under:
//   wear-inspections/{tail}/{timestamp}_{position}_{itemType}.jpg
//   wear-training/{aircraftType}/{itemType}/{status}/{auto}.jpg
//   wear-replacements/{tail}/{timestamp}_{position}_{itemType}.jpg

import {
  collection, doc, setDoc, getDoc, getDocs, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';

import { db, storage } from './firebase.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

// Aircraft type per tail. Edit this when the fleet changes.
export const TAIL_AIRCRAFT_TYPES = {
  N168ZZ: 'lear60',
  N444AM: 'cj3',
  N525CR: 'cj3',
  N286N:  'cj3',
  N20UF:  'cj3',
  N651TW: 'cj3',
  N551FP: 'cj3',
  N85AH:  'cj3',
};

// Per-aircraft-type wear configuration. Adding a new airframe = add a row.
export const AIRCRAFT_WEAR_CONFIGS = {
  cj3: {
    label: 'Citation CJ3',
    positions: [
      { id: 'nose',   label: 'Nose Gear',   items: ['tire'] },
      { id: 'main-l', label: 'Main Gear L', items: ['tire', 'brake'] },
      { id: 'main-r', label: 'Main Gear R', items: ['tire', 'brake'] },
    ],
  },
  lear60: {
    label: 'Lear 60',
    positions: [
      { id: 'nose',   label: 'Nose Gear',   items: ['tire'] },
      { id: 'main-l', label: 'Main Gear L', items: ['tire', 'brake'] },
      { id: 'main-r', label: 'Main Gear R', items: ['tire', 'brake'] },
    ],
  },
};

// Statuses ranked from healthiest to worst. Used for sorting + color logic.
export const WEAR_STATUS = {
  good:         { id: 'good',         label: 'GOOD',         priority: 0, color: 'emerald' },
  monitor:      { id: 'monitor',      label: 'MONITOR',      priority: 1, color: 'amber' },
  replace_soon: { id: 'replace_soon', label: 'REPLACE SOON', priority: 2, color: 'orange' },
  grounded:     { id: 'grounded',     label: 'GROUNDED',     priority: 3, color: 'red' },
};

export const STATUS_ORDER = ['good', 'monitor', 'replace_soon', 'grounded'];

// Inspection types — what triggered the check.
export const INSPECTION_TYPES = {
  first_flight: 'First flight of the day',
  end_of_day:   'End of day (before manifest)',
  ad_hoc:       'Ad-hoc check',
  defer:        'Deferred with reason',
};

// Item types per position — used when iterating the modal.
export const ITEM_LABELS = {
  tire:  'Tire',
  brake: 'Brake',
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

export function configForTail(tail) {
  const type = TAIL_AIRCRAFT_TYPES[tail] || 'cj3';
  return { type, config: AIRCRAFT_WEAR_CONFIGS[type] || AIRCRAFT_WEAR_CONFIGS.cj3 };
}

export function wearItemId(tail, position, itemType) {
  return `${tail}-${position}-${itemType}`;
}

// All wear-item ids for one tail (used to upsert defaults if missing).
export function expectedWearItemIds(tail) {
  const { config } = configForTail(tail);
  const ids = [];
  for (const p of config.positions) {
    for (const it of p.items) ids.push(wearItemId(tail, p.id, it));
  }
  return ids;
}

// Local-date string (YYYY-MM-DD) in the user's TZ. Used to determine
// "today" for first-flight / end-of-day gating.
export function localDateKey(d = new Date()) {
  const tzOffset = d.getTimezoneOffset() * 60_000;
  const local = new Date(d.getTime() - tzOffset);
  return local.toISOString().slice(0, 10);
}

// Returns the highest-priority status across a list of wear items.
// Use for the per-tail rollup badge in the WEAR dashboard.
export function rollupStatus(items) {
  if (!items?.length) return 'good';
  let worst = 'good';
  for (const it of items) {
    if (!it.status) continue;
    if ((WEAR_STATUS[it.status]?.priority || 0) > (WEAR_STATUS[worst]?.priority || 0)) {
      worst = it.status;
    }
  }
  return worst;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHOTO UPLOADS
// ─────────────────────────────────────────────────────────────────────────────

async function uploadPhoto(file, path) {
  const ref = storageRef(storage, path);
  await uploadBytes(ref, file, { contentType: file.type || 'image/jpeg' });
  const url = await getDownloadURL(ref);
  return { url, path };
}

export async function uploadInspectionPhoto({ tail, position, itemType, file }) {
  const ts = Date.now();
  const path = `wear-inspections/${tail}/${ts}_${position}_${itemType}.jpg`;
  return uploadPhoto(file, path);
}

export async function uploadReplacementPhoto({ tail, position, itemType, file }) {
  const ts = Date.now();
  const path = `wear-replacements/${tail}/${ts}_${position}_${itemType}.jpg`;
  return uploadPhoto(file, path);
}

export async function uploadTrainingPhoto({ aircraftType, itemType, status, file }) {
  const ts = Date.now();
  const path = `wear-training/${aircraftType}/${itemType}/${status}/${ts}.jpg`;
  return uploadPhoto(file, path);
}

// ─────────────────────────────────────────────────────────────────────────────
// WEAR-ITEMS (current state, one per tail × position × itemType)
// ─────────────────────────────────────────────────────────────────────────────

// Listen to every wear item across the whole fleet (admin dashboard).
export function subscribeAllWearItems(cb) {
  return onSnapshot(collection(db, 'wear-items'), (snap) => {
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    cb(items);
  });
}

// Listen to a single tail's wear items.
export function subscribeWearItemsForTail(tail, cb) {
  const q = query(collection(db, 'wear-items'), where('tail', '==', tail));
  return onSnapshot(q, (snap) => {
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    cb(items);
  });
}

// One-shot read of current state for a tail.
export async function getWearItemsForTail(tail) {
  const q = query(collection(db, 'wear-items'), where('tail', '==', tail));
  const snap = await getDocs(q);
  const items = [];
  snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
  return items;
}

// Set/update the current state for a single wear item. Caller passes the
// new status + the linked inspection id; we merge so unrelated fields
// (like landingsSinceReplaced, lastReplacedAt) survive.
async function upsertWearItem({
  tail, position, itemType, status, photoUrl, inspectedBy, inspectedByName,
  inspectionId, notes,
}) {
  const id = wearItemId(tail, position, itemType);
  const { type: aircraftType } = configForTail(tail);
  const now = serverTimestamp();
  await setDoc(doc(db, 'wear-items', id), {
    id,
    tail,
    aircraftType,
    position,
    itemType,
    status: status || 'good',
    lastPhotoUrl: photoUrl || null,
    lastInspectedAt: now,
    lastInspectedAtMs: Date.now(),
    lastInspectedBy: inspectedBy || null,
    lastInspectedByName: inspectedByName || null,
    lastInspectionId: inspectionId || null,
    lastNotes: notes || null,
  }, { merge: true });
}

// Mark a wear item as replaced. Resets status to GOOD and writes a
// replacement record.
export async function markItemReplaced({
  tail, position, itemType, photoUrl, photoPath, replacedBy, replacedByName, notes,
}) {
  const id = wearItemId(tail, position, itemType);
  const now = serverTimestamp();
  await setDoc(doc(db, 'wear-items', id), {
    id,
    tail,
    aircraftType: configForTail(tail).type,
    position,
    itemType,
    status: 'good',
    lastReplacedAt: now,
    lastReplacedAtMs: Date.now(),
    lastReplacedBy: replacedBy || null,
    lastReplacedByName: replacedByName || null,
    lastReplacementPhotoUrl: photoUrl || null,
    lastReplacementPhotoPath: photoPath || null,
    landingsSinceReplaced: 0,                  // Phase 3 hook
    lastInspectedAt: now,
    lastInspectedAtMs: Date.now(),
    lastInspectedBy: replacedBy || null,
    lastInspectedByName: replacedByName || null,
    lastNotes: notes || null,
    lastPhotoUrl: photoUrl || null,
  }, { merge: true });
  // Also log a replacement entry for posterity
  const replId = `repl-${tail}-${position}-${itemType}-${Date.now()}`;
  await setDoc(doc(db, 'wear-replacements', replId), {
    tail, position, itemType,
    replacedAt: now,
    replacedAtMs: Date.now(),
    replacedBy: replacedBy || null,
    replacedByName: replacedByName || null,
    photoUrl: photoUrl || null,
    photoPath: photoPath || null,
    notes: notes || null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WEAR-INSPECTIONS (append-only log)
// ─────────────────────────────────────────────────────────────────────────────

// Write a single inspection row AND update the wear-items current state.
// Returns the new inspection's id. Caller may pass `idToken` to also fire
// the immediate MX-notify email (POST /api/wear-notify) for status drops
// and defers — fire-and-forget, doesn't block save success.
export async function saveWearInspection({
  tail, position, itemType, pilotStatus, photoUrl, photoPath,
  inspectedBy, inspectedByName, inspectionType, legId, tripId, notes,
  measurement, // { tread32nds?, brakePinMm? }
  isDeferred, deferReason,
  idToken, // optional — if present, /api/wear-notify is fired
}) {
  const inspectionId = `insp-${tail}-${position}-${itemType}-${Date.now()}`;
  const now = serverTimestamp();
  const data = {
    id: inspectionId,
    tail,
    aircraftType: configForTail(tail).type,
    position,
    itemType,
    inspectionType: inspectionType || 'ad_hoc',
    pilotStatus: pilotStatus || 'good',
    photoUrl: photoUrl || null,
    photoPath: photoPath || null,
    inspectedAt: now,
    inspectedAtMs: Date.now(),
    inspectedAtLocalDateKey: localDateKey(),
    inspectedBy: inspectedBy || null,
    inspectedByName: inspectedByName || null,
    legId: legId || null,
    tripId: tripId || null,
    notes: notes || null,
    measurement: measurement || null,
    isDeferred: !!isDeferred,
    deferReason: deferReason || null,
    aiAssessment: null,           // populated by /api/wear-vision-check
    aiCheckedAt: null,
  };
  await setDoc(doc(db, 'wear-inspections', inspectionId), data);

  // Update current state — unless it was deferred (no actual status pick).
  if (!isDeferred) {
    await upsertWearItem({
      tail, position, itemType, status: pilotStatus, photoUrl,
      inspectedBy, inspectedByName, inspectionId, notes,
    });
  }

  // Fire immediate MX notify for status drops + defers. Fire-and-forget.
  const isDrop = !isDeferred && pilotStatus && pilotStatus !== 'good';
  if ((isDrop || isDeferred) && idToken) {
    try {
      fetch('/api/wear-notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, inspectionId }),
      }).catch((e) => console.warn('[wear] notify failed:', e?.message));
    } catch (_) {}
  }
  return inspectionId;
}

// Listen to a tail's inspection history (admin detail page).
export function subscribeWearInspections(tail, cb, maxRows = 100) {
  const q = query(
    collection(db, 'wear-inspections'),
    where('tail', '==', tail),
    orderBy('inspectedAtMs', 'desc'),
    limit(maxRows),
  );
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    cb(rows);
  });
}

// Listen to inspections filtered by position+itemType (for trend chart).
export function subscribeInspectionsForItem(tail, position, itemType, cb, maxRows = 60) {
  const q = query(
    collection(db, 'wear-inspections'),
    where('tail', '==', tail),
    where('position', '==', position),
    where('itemType', '==', itemType),
    orderBy('inspectedAtMs', 'desc'),
    limit(maxRows),
  );
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    cb(rows);
  });
}

// Find today's inspections for a tail (used by gates).
export async function getTodayInspections(tail) {
  const key = localDateKey();
  const q = query(
    collection(db, 'wear-inspections'),
    where('tail', '==', tail),
    where('inspectedAtLocalDateKey', '==', key),
  );
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

// Live subscription for today's inspections — used by the trip card badge.
export function subscribeTodayInspections(tail, cb) {
  const key = localDateKey();
  const q = query(
    collection(db, 'wear-inspections'),
    where('tail', '==', tail),
    where('inspectedAtLocalDateKey', '==', key),
  );
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    cb(rows);
  });
}

// Quick check helpers — used by the gates.
export function hasInspectionType(inspections, inspectionType) {
  return inspections.some((i) => i.inspectionType === inspectionType && !i.isDeferred);
}

// Is the wear check complete enough to be considered "done" for a type?
// Definition: every expected item has at least one inspection today of the
// matching type (or a defer record at the day level, which we treat as
// passing the gate but flagging MX).
export function checkComplete(tail, inspections, inspectionType) {
  const expected = expectedWearItemIds(tail).map((id) => {
    const parts = id.split('-');
    // ids look like "{TAIL}-{POSITION}-{ITEM}" but TAIL contains no
    // dash; POSITION can be 'nose' or 'main-l' or 'main-r' (has a dash).
    // Reconstruct: first segment is tail, last is item, middle is position.
    const tailPart = parts[0];
    const itemPart = parts[parts.length - 1];
    const positionPart = parts.slice(1, -1).join('-');
    return { tail: tailPart, position: positionPart, itemType: itemPart };
  });
  // Also: if any inspection of this type was deferred, treat the whole
  // check as deferred (still passes gate, MX gets the alert).
  const anyDeferred = inspections.some(
    (i) => i.inspectionType === inspectionType && i.isDeferred,
  );
  if (anyDeferred) return { complete: true, deferred: true };
  // Every expected item must have a matching inspection today.
  for (const exp of expected) {
    const has = inspections.some(
      (i) =>
        i.inspectionType === inspectionType &&
        i.position === exp.position &&
        i.itemType === exp.itemType,
    );
    if (!has) return { complete: false, deferred: false };
  }
  return { complete: true, deferred: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// WEAR-TRAINING (Phase 2 — labeled reference photos)
// ─────────────────────────────────────────────────────────────────────────────

export async function saveTrainingPhoto({
  aircraftType, itemType, status, photoUrl, photoPath, addedBy, addedByName, notes,
}) {
  const id = `train-${aircraftType}-${itemType}-${status}-${Date.now()}`;
  await setDoc(doc(db, 'wear-training', id), {
    id,
    aircraftType,
    itemType,
    status,
    photoUrl,
    photoPath,
    addedBy: addedBy || null,
    addedByName: addedByName || null,
    addedAt: serverTimestamp(),
    addedAtMs: Date.now(),
    notes: notes || null,
  });
  return id;
}

export async function deleteTrainingPhoto(id) {
  await deleteDoc(doc(db, 'wear-training', id));
}

// Live subscription to a bucket of training photos (for one aircraft type).
export function subscribeTrainingLibrary(aircraftType, cb) {
  const q = query(
    collection(db, 'wear-training'),
    where('aircraftType', '==', aircraftType),
  );
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    cb(rows);
  });
}

// Read the training set for the AI call (server-side will replicate this
// query using admin SDK; client uses this when admin views the library).
export async function getTrainingPhotos(aircraftType, itemType) {
  const q = query(
    collection(db, 'wear-training'),
    where('aircraftType', '==', aircraftType),
    where('itemType', '==', itemType),
  );
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI ASSESSMENT (Phase 2 — fires the /api/wear-vision-check endpoint)
// ─────────────────────────────────────────────────────────────────────────────

export async function requestAiAssessment({ idToken, inspectionId }) {
  try {
    const resp = await fetch('/api/wear-vision-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, inspectionId }),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${resp.status}`);
    }
    return await resp.json();
  } catch (e) {
    console.warn('[wear] AI assessment request failed:', e?.message);
    return null;
  }
}
