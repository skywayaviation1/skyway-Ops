// Firebase helpers for PILOT DOCS — per-crew-member personal documents
// (FAA certificate, medical certificate, passport, driver's license).
//
// These are sensitive PII. Access model:
//   - A crew member can read/write/delete their OWN docs.
//   - Admin and ops (chief-pilot-equivalent) can read ALL docs.
// This is enforced in the UI here; for real security you MUST add matching
// Firestore + Storage rules. See deploy notes.
//
// Document shape (collection: 'pilot-docs'):
//   {
//     id,
//     uid,               // owner's uid
//     ownerName,         // denormalized for the admin all-crew view
//     ownerEmail,
//     docType,           // 'certificate' | 'medical' | 'passport' | 'drivers_license'
//     fileUrl, filePath, fileContentType, fileName, fileKind, fileSizeBytes,
//     // Parsed/entered fields (which apply depends on docType):
//     holderName,
//     documentNumber,    // cert number / passport number / license number
//     issuingAuthority,  // FAA / country / state
//     issueDate,         // YYYY-MM-DD or null
//     expiration,        // YYYY-MM-DD or null  (see expiresFor* helpers)
//     certType,          // e.g. 'ATP', 'Commercial', 'Private' (certificate)
//     ratings,           // free text list of ratings/type ratings (certificate)
//     medicalClass,      // '1' | '2' | '3' (medical)
//     dob,               // YYYY-MM-DD or null (passport/license)
//     parsedAt, parsedBy, confidence, notes,
//     uploadedAt, uploadedBy, updatedAt,
//   }

import { db } from './firebase.js';
import {
  doc, setDoc, deleteDoc, collection, query, where, orderBy, onSnapshot,
} from 'firebase/firestore';

export const PILOT_DOC_TYPES = [
  { id: 'certificate',    label: 'Airman Certificate', hasExpiration: false },
  { id: 'medical',        label: 'Medical Certificate', hasExpiration: true },
  { id: 'passport',       label: 'Passport',            hasExpiration: true },
  { id: 'drivers_license',label: "Driver's License",    hasExpiration: true },
];

export function docTypeLabel(t) {
  const found = PILOT_DOC_TYPES.find((d) => d.id === t);
  return found ? found.label : t;
}

export function newPilotDocId() {
  return `pdoc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function savePilotDoc(d) {
  if (!d.id) throw new Error('Doc must have an id');
  if (!d.uid) throw new Error('Doc must have a uid');
  const safeId = String(d.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  await setDoc(
    doc(db, 'pilot-docs', safeId),
    {
      ...d,
      updatedAt: Date.now(),
      uploadedAt: d.uploadedAt || Date.now(),
    },
    { merge: true }
  );
}

export async function deletePilotDocRecord(id) {
  if (!id) throw new Error('Missing doc id');
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  await deleteDoc(doc(db, 'pilot-docs', safeId));
}

// Subscribe to a single crew member's own docs.
export function subscribeToUserPilotDocs(uid, onUpdate) {
  if (!uid) { onUpdate([]); return () => {}; }
  // No orderBy here to avoid requiring a composite index on (uid, ...).
  // We sort client-side instead.
  const q = query(collection(db, 'pilot-docs'), where('uid', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((dd) => list.push({ ...dd.data(), id: dd.id }));
      list.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
      onUpdate(list);
    },
    (err) => {
      console.error('[pilot-docs] user subscribe error:', err);
      onUpdate([]);
    }
  );
}

// Subscribe to ALL crew docs — admin / ops only. The caller is responsible
// for gating this behind a role check (and Firestore rules must enforce it).
export function subscribeToAllPilotDocs(onUpdate) {
  const q = query(collection(db, 'pilot-docs'), orderBy('uploadedAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((dd) => list.push({ ...dd.data(), id: dd.id }));
      onUpdate(list);
    },
    (err) => {
      console.error('[pilot-docs] all subscribe error:', err);
      onUpdate([]);
    }
  );
}

// --- Expiration helpers ----------------------------------------------------
// Returns { state: 'ok'|'soon'|'expired'|'none', days: number|null }.
// FAA airman certificates don't expire, so docType 'certificate' is always
// 'none' regardless of any expiration value.
export function expirationStatus(d, now = Date.now()) {
  const meta = PILOT_DOC_TYPES.find((t) => t.id === d.docType);
  if (!meta || !meta.hasExpiration || !d.expiration) {
    return { state: 'none', days: null };
  }
  const exp = Date.parse(d.expiration + 'T23:59:59');
  if (Number.isNaN(exp)) return { state: 'none', days: null };
  const days = Math.floor((exp - now) / 86400000);
  if (days < 0) return { state: 'expired', days };
  if (days <= 60) return { state: 'soon', days };
  return { state: 'ok', days };
}
