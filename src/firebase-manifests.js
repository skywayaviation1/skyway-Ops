// Firebase helpers for Load Manifests (Skyway form S-5/R-37).
//
// Each manifest is one Firestore doc, keyed by trip UID.
// Multiple manifests can exist per trip (e.g. revised version) — we use a
// composite ID `${tripUid}-${createdAt}` to allow multiple, but we treat the
// most recent one as the active manifest in the UI.
//
// Document shape:
//   {
//     id, tripUid, tripCode, tail, tripDate,
//     // Hobbs
//     hobbsOut, hobbsIn, hobbsTotal,
//     waitTime,
//     // Per-leg block — array of up to 7 legs
//     legs: [
//       {
//         from, to,
//         timeOut, timeIn, total,
//         airport,
//         cycles, nightLdgs,
//         passengers: [...up to 7 names],
//         toWeight, maxAllowable, fwdCG, toCG, aftCG,
//         numPax, configuration,
//       }
//     ],
//     // Duty time totals (overall)
//     dutyTimeIn, dutyTimeOut, dutyTimeTotal,
//     // E-signatures (typed name + saved drawn signature image + audit fields)
//     picSig: { name, uid, email, signatureImg, timestamp, ip },
//     sicSig: { name, uid, email, signatureImg, timestamp, ip },
//     // Status
//     status, // 'draft' | 'submitted'
//     submittedAt, submittedBy,
//     pdfUrl, // populated after submit
//     // Metadata
//     createdAt, updatedAt, createdBy,
//   }

import { db } from './firebase.js';
import {
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
} from 'firebase/firestore';

/**
 * Save (upsert) a manifest doc.
 */
export async function saveManifest(manifest) {
  if (!manifest.id) throw new Error('Manifest must have an id');
  const safeId = String(manifest.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const now = Date.now();
  await setDoc(
    doc(db, 'manifests', safeId),
    {
      ...manifest,
      updatedAt: now,
      createdAt: manifest.createdAt || now,
    },
    { merge: true }
  );
}

/**
 * Subscribe to manifests for a specific trip. Returns unsubscribe.
 */
export function subscribeToTripManifests(tripUid, onUpdate) {
  if (!tripUid) return () => {};
  const q = query(
    collection(db, 'manifests'),
    where('tripUid', '==', tripUid),
    orderBy('createdAt', 'desc')
  );
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
 * Generate a unique manifest ID for a new manifest.
 */
export function newManifestId(tripUid) {
  const ts = Date.now();
  const prefix = String(tripUid || 'manifest').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return `${prefix}-${ts}`;
}
