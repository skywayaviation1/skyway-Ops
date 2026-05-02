// Firebase helpers for Skyway Load Manifests (form S-5/R-37).
//
// DATA MODEL: One manifest per (date, tail). PIC fills out at start of day,
// adds legs throughout the day. Different aircraft same day = separate
// manifests (W&B fields and configuration are aircraft-specific).
//
// Document ID: `${YYYY-MM-DD}_${tail}` (sanitized)

import { db } from './firebase.js';
import {
  doc, setDoc, getDoc, deleteDoc, collection, query, orderBy, onSnapshot,
} from 'firebase/firestore';

export function manifestId(date, tail) {
  const d = String(date || '').replace(/[^0-9-]/g, '').slice(0, 10);
  const t = String(tail || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return `${d}_${t}`;
}

export function localDateString(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export async function saveManifest(manifest) {
  if (!manifest.id) throw new Error('Manifest must have an id');
  const safeId = String(manifest.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const now = Date.now();
  await setDoc(
    doc(db, 'manifests', safeId),
    { ...manifest, updatedAt: now, createdAt: manifest.createdAt || now },
    { merge: true }
  );
}

export async function fetchManifest(id) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const snap = await getDoc(doc(db, 'manifests', safeId));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

/**
 * Hard-delete a manifest. Caller must verify admin role first.
 */
export async function deleteManifest(id) {
  if (!id) throw new Error('Missing manifest id');
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  await deleteDoc(doc(db, 'manifests', safeId));
}

export function subscribeToAllManifests(onUpdate) {
  const q = query(collection(db, 'manifests'), orderBy('date', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      onUpdate(list);
    },
    (err) => {
      console.error('[manifests] subscribe error:', err);
      onUpdate([]);
    }
  );
}

/**
 * Auto-add a leg from a completed trip to the matching day+tail manifest.
 * Idempotent: same trip won't be added twice.
 * Returns manifest id if added/already-present, null if skipped (submitted manifest, full, etc).
 */
export async function autoAddTripToManifest({ trip, preloadedPax, addedBy }) {
  if (!trip || !trip.info?.tail || !trip.start) return null;
  const date = localDateString(trip.start);
  const tail = trip.info.tail;
  const id = manifestId(date, tail);

  const existing = await fetchManifest(id);

  if (existing && existing.status === 'submitted') {
    console.warn('[manifests] cannot auto-add to submitted manifest:', id);
    return null;
  }

  const newLeg = buildLegFromTrip(trip, preloadedPax, addedBy);

  let next;
  if (!existing) {
    next = {
      id, date, tail,
      hobbsOut: '', hobbsIn: '', hobbsTotal: '', waitTime: '',
      dutyTimeIn: '', dutyTimeOut: '', dutyTimeTotal: '',
      legs: [newLeg],
      picSig: null, sicSig: null,
      status: 'draft',
      createdBy: addedBy || 'auto',
    };
  } else {
    const existingLegs = Array.isArray(existing.legs) ? existing.legs : [];
    const alreadyHas = existingLegs.some(l => l.tripUid && l.tripUid === trip.uid);
    if (alreadyHas) return id;
    if (existingLegs.length >= 7) {
      console.warn('[manifests] cannot auto-add — already has 7 legs:', id);
      return null;
    }
    next = { ...existing, legs: [...existingLegs, newLeg] };
  }

  await saveManifest(next);
  return id;
}

/**
 * Build a manifest leg from a trip object. Auto-fills:
 *   - All trips: from, to, airport (=destination), passengers (from preloadedPax)
 *   - REPO legs: T/O weight = "91" (Part 91 indicator), Configuration = "A"
 *   - REVENUE legs: just leaves W&B fields empty for crew to fill
 */
export function buildLegFromTrip(trip, preloadedPax, addedBy) {
  const isRepo = trip?.info?.legType === 'REPO';
  return {
    tripUid: trip.uid,
    from: trip.info.from || '',
    to: trip.info.to || '',
    timeOut: '', timeIn: '', total: '',
    airport: trip.info.to || '', // Airport = destination on the form
    cycles: '', nightLdgs: '',
    passengers: Array.isArray(preloadedPax)
      ? preloadedPax
          .filter(p => p.checkInStatus !== 'skipped')
          .slice(0, 7)
          .map(p => `${p.firstName || ''} ${p.lastName || ''}`.trim())
          .filter(Boolean)
      : [],
    // REPO legs: shorthand "91" in T/O weight + standard config "A"
    // REVENUE legs: blank — crew fills with actual W&B numbers
    toWeight: isRepo ? '91' : '',
    maxAllowable: '',
    fwdCG: '',
    toCG: '',
    aftCG: '',
    numPax: isRepo ? '' : (
      Array.isArray(preloadedPax)
        ? preloadedPax.filter(p => p.checkInStatus !== 'skipped').length || ''
        : ''
    ),
    configuration: isRepo ? 'A' : '',
    legType: isRepo ? 'REPO' : 'REVENUE',
    addedAt: Date.now(),
    addedBy: addedBy || 'auto',
  };
}

/**
 * Sync a manifest with the current schedule for that date+tail.
 * Compares stored manifest legs against currently-scheduled trips, returns:
 *   { newLegs: [...], removedLegUids: [...], unchanged: bool }
 *
 * The caller decides whether to apply the changes (safe pattern — show banner,
 * let user accept/reject).
 */
export function diffManifestVsSchedule(manifest, scheduledTrips) {
  const existingLegs = Array.isArray(manifest.legs) ? manifest.legs : [];
  const existingTripUids = new Set(existingLegs.filter(l => l.tripUid).map(l => l.tripUid));
  const scheduledTripUids = new Set(scheduledTrips.map(t => t.uid));

  // New legs: scheduled trips not yet on the manifest
  const newTrips = scheduledTrips.filter(t => !existingTripUids.has(t.uid));

  // Removed legs: legs on the manifest whose trip was cancelled/removed.
  // Manual legs (no tripUid) are NEVER considered for removal — those are
  // crew-added off-schedule entries.
  const removedTripUids = existingLegs
    .filter(l => l.tripUid && !scheduledTripUids.has(l.tripUid))
    .map(l => l.tripUid);

  return {
    newTrips,
    removedTripUids,
    unchanged: newTrips.length === 0 && removedTripUids.length === 0,
  };
}
