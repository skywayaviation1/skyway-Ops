// Pilot logbook hours and the operator's safety-rating standards.
//
// Collections:
//   pilot-logbooks/{uid}     hours, certificate summary, drug/alcohol enrollment
//   app-config/pilot-safety  configurable minimums (see src/pilot-safety.js)
//
// Checks, training, and the medical stay in pilot-currencies/{uid}.
// Certificate scans stay in pilot-docs. This module never writes those.
//
// Who can write is enforced by Firestore rules (see docs/pilot-safety.md).
// The UI also limits editing to admin and ops. Pilots read their own record.

import { db } from './firebase.js';
import { doc, setDoc, collection, onSnapshot } from 'firebase/firestore';
import { normalizeLogbook, normalizeStandards } from './pilot-safety.js';

export function subscribePilotLogbooks(onUpdate) {
  return onSnapshot(
    collection(db, 'pilot-logbooks'),
    (snap) => {
      const byUid = {};
      snap.forEach((entry) => {
        const book = normalizeLogbook({ ...entry.data(), uid: entry.id }, entry.id);
        book.updatedAt = entry.data()?.updatedAt || null;
        byUid[entry.id] = book;
      });
      onUpdate(byUid);
    },
    (err) => {
      console.warn('[pilot-logbooks] subscribe error:', err?.message || err);
      onUpdate({});
    },
  );
}

export function subscribeMyPilotLogbook(uid, onUpdate) {
  if (!uid) {
    onUpdate(null);
    return () => {};
  }
  return onSnapshot(
    doc(db, 'pilot-logbooks', uid),
    (snap) => {
      if (!snap.exists()) {
        onUpdate(null);
        return;
      }
      const book = normalizeLogbook({ ...snap.data(), uid }, uid);
      book.updatedAt = snap.data()?.updatedAt || null;
      onUpdate(book);
    },
    (err) => {
      console.warn('[pilot-logbooks] self subscribe error:', err?.message || err);
      onUpdate(null);
    },
  );
}

export async function savePilotLogbook(uid, draft, editor) {
  if (!uid) throw new Error('uid required');
  const book = normalizeLogbook(draft, uid);
  await setDoc(doc(db, 'pilot-logbooks', uid), {
    ...book,
    uid,
    updatedAt: Date.now(),
    updatedBy: editor?.uid || null,
    updatedByName: editor?.name || editor?.email || null,
  });
}

export function subscribePilotSafetyStandards(onUpdate) {
  return onSnapshot(
    doc(db, 'app-config', 'pilot-safety'),
    (snap) => {
      onUpdate(snap.exists() ? normalizeStandards({ ...snap.data(), customized: snap.data()?.customized !== false }) : null);
    },
    (err) => {
      console.warn('[pilot-safety] standards subscribe error:', err?.message || err);
      onUpdate(null);
    },
  );
}

export async function savePilotSafetyStandards(draft, editor) {
  const standards = normalizeStandards({ ...draft, customized: true });
  standards.customized = true;
  await setDoc(doc(db, 'app-config', 'pilot-safety'), {
    ...standards,
    updatedAt: Date.now(),
    updatedByUid: editor?.uid || null,
    updatedByName: editor?.name || editor?.email || null,
  });
}
