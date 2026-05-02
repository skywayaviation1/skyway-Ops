// Firebase helpers for Skyway Load Manifests (form S-5/R-37).
//
// DATA MODEL: One manifest per (date, tail). PIC fills out at start of day,
// adds legs throughout the day. Different aircraft same day = separate
// manifests (W&B fields and configuration are aircraft-specific).
//
// Document ID: `${YYYY-MM-DD}_${tail}` (sanitized)

import { db } from './firebase.js';
import {
  doc, setDoc, getDoc, collection, query, orderBy, onSnapshot,
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

  const newLeg = {
    tripUid: trip.uid,
    from: trip.info.from || '',
    to: trip.info.to || '',
    timeOut: '', timeIn: '', total: '',
    airport: trip.info.from || '',
    cycles: '', nightLdgs: '',
    passengers: Array.isArray(preloadedPax)
      ? preloadedPax
          .filter(p => p.checkInStatus !== 'skipped')
          .slice(0, 7)
          .map(p => `${p.firstName || ''} ${p.lastName || ''}`.trim())
          .filter(Boolean)
      : [],
    toWeight: '', maxAllowable: '', fwdCG: '', toCG: '', aftCG: '',
    numPax: Array.isArray(preloadedPax)
      ? preloadedPax.filter(p => p.checkInStatus !== 'skipped').length || ''
      : '',
    configuration: '',
    addedAt: Date.now(),
    addedBy: addedBy || 'auto',
  };

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
