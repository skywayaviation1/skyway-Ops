// Part 135 §135.267 duty/rest tracking — data layer.
//
// ISOLATION: this is a standalone module. The UI that uses it is wrapped in
// an error boundary and gated behind config.dutyTrackerEnabled (default OFF),
// so a fault here cannot affect the rest of the app.
//
// Firestore collection: duty-state/{periodId}
//   periodId = `${pilotUid}_${dutyOnAt}` (stable, unique per period)
//
// Model:
//   {
//     id, pilotUid, pilotName,
//     role: 'PIC',                     // tracked period owner
//     sicUid, sicName,                 // linked SIC (optional)
//     dutyOnAt,                        // ms — duty period start
//     fboArrivalAt,                    // ms — crew-at-FBO stamp (may == dutyOnAt)
//     dutyOffAt,                       // ms — null while on duty
//     restUntil,                       // ms — dutyOffAt + 10h (set on duty-off)
//     over14,                          // bool — flagged if duty exceeded 14h
//     over14ReasonPic, over14ReasonSic,// required to close an over-14 period
//     restOverride,                    // { by, at, reason } if started before rest done
//     status: 'on' | 'off',
//     adminEdits: [{ by, at, field, from, to, note }],   // append-only audit
//     createdAt, updatedAt
//   }

import { db } from './firebase.js';
import {
  doc, setDoc, updateDoc, getDoc, collection, query, where,
  onSnapshot,
} from 'firebase/firestore';

export const DUTY_MAX_MS = 14 * 60 * 60 * 1000;  // 14h legal duty
export const REST_MIN_MS = 10 * 60 * 60 * 1000;  // 10h legal rest

function periodId(pilotUid, dutyOnAt) {
  return `${String(pilotUid).replace(/[^a-zA-Z0-9_-]/g, '_')}_${dutyOnAt}`;
}

/**
 * Subscribe to the MOST RECENT duty period for a pilot (by dutyOnAt desc).
 * onUpdate(periodOrNull). Returns unsubscribe.
 */
export function subscribeToCurrentDuty(pilotUid, onUpdate) {
  if (!pilotUid) { onUpdate(null); return () => {}; }
  // NOTE: where(pilotUid) + orderBy(dutyOnAt) would require a composite
  // Firestore index. We filter only, then pick the newest period in JS.
  // The per-pilot duty-state set is tiny, so this is cheap and needs no index.
  const q = query(
    collection(db, 'duty-state'),
    where('pilotUid', '==', pilotUid),
  );
  return onSnapshot(
    q,
    (snap) => {
      if (snap.empty) { onUpdate(null); return; }
      let newest = null;
      snap.forEach((d) => {
        const v = { id: d.id, ...d.data() };
        if (!newest || (v.dutyOnAt || 0) > (newest.dutyOnAt || 0)) newest = v;
      });
      onUpdate(newest);
    },
    (err) => {
      console.error('[firebase-duty] subscribe error:', err);
      onUpdate(null);
    }
  );
}

/**
 * Subscribe to ALL currently-on-duty periods (admin overview).
 */
export function subscribeToActiveDuty(onUpdate) {
  const q = query(
    collection(db, 'duty-state'),
    where('status', '==', 'on'),
  );
  return onSnapshot(
    q,
    (snap) => onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => { console.error('[firebase-duty] active subscribe error:', err); onUpdate([]); }
  );
}

/**
 * Start a duty period (duty-on, or crew-at-FBO which also sets duty-on).
 * If a period is already 'on' for this pilot, returns it unchanged.
 *
 * opts: { fboArrival?: bool, restOverride?: {reason}, sic?: {uid,name} }
 */
export async function startDuty(pilot, opts = {}) {
  if (!pilot?.uid) throw new Error('pilot uid required');

  // Don't double-open: if the latest period is still 'on', reuse it.
  const existing = await getLatestDuty(pilot.uid);
  if (existing && existing.status === 'on') {
    // If this is the FBO action and we haven't stamped arrival yet, stamp it.
    if (opts.fboArrival && !existing.fboArrivalAt) {
      await updateDoc(doc(db, 'duty-state', existing.id), {
        fboArrivalAt: Date.now(), updatedAt: Date.now(),
      });
    }
    return existing.id;
  }

  const now = Date.now();
  const id = periodId(pilot.uid, now);
  const record = {
    id,
    pilotUid: pilot.uid,
    pilotName: pilot.name || pilot.displayName || 'Unknown',
    role: 'PIC',
    sicUid: opts.sic?.uid || null,
    sicName: opts.sic?.name || null,
    dutyOnAt: now,
    fboArrivalAt: now,                 // hitting either action stamps arrival
    dutyOffAt: null,
    restUntil: null,
    over14: false,
    over14ReasonPic: '',
    over14ReasonSic: '',
    restOverride: opts.restOverride
      ? { by: pilot.name || pilot.uid, at: now, reason: String(opts.restOverride.reason || '').slice(0, 1000) }
      : null,
    status: 'on',
    adminEdits: [],
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(doc(db, 'duty-state', id), record);
  return id;
}

/**
 * End a duty period (duty-off). If the period exceeded 14h, BOTH reasons are
 * required (caller must supply them) or this throws.
 */
export async function endDuty(periodDocId, { over14ReasonPic, over14ReasonSic } = {}) {
  if (!periodDocId) throw new Error('period id required');
  const ref = doc(db, 'duty-state', periodDocId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();
  if (cur.status === 'off') return; // already closed

  const now = Date.now();
  const elapsed = now - (cur.dutyOnAt || now);
  const over14 = elapsed > DUTY_MAX_MS;

  if (over14) {
    const pic = String(over14ReasonPic || '').trim();
    const sic = String(over14ReasonSic || '').trim();
    if (!pic || !sic) {
      const e = new Error('Over-14h: PIC and SIC reasons are both required to close this duty period.');
      e.code = 'OVER14_REASON_REQUIRED';
      throw e;
    }
  }

  await updateDoc(ref, {
    dutyOffAt: now,
    restUntil: now + REST_MIN_MS,
    over14,
    over14ReasonPic: over14 ? String(over14ReasonPic).trim().slice(0, 2000) : '',
    over14ReasonSic: over14 ? String(over14ReasonSic).trim().slice(0, 2000) : '',
    status: 'off',
    updatedAt: now,
  });

  return { over14, elapsed };
}

/**
 * Admin edit of duty-on / duty-off time. Appends to adminEdits[] (audit) —
 * never silently overwrites.
 */
export async function adminEditDuty(periodDocId, { field, newValueMs, editor, note }) {
  if (!periodDocId) throw new Error('period id required');
  if (!['dutyOnAt', 'dutyOffAt'].includes(field)) {
    throw new Error("field must be 'dutyOnAt' or 'dutyOffAt'");
  }
  const ref = doc(db, 'duty-state', periodDocId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();

  const from = cur[field] || null;
  const to = newValueMs || null;
  const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];

  const patch = {
    [field]: to,
    adminEdits: [...edits, {
      by: editor?.displayName || editor?.name || 'Admin',
      at: Date.now(),
      field,
      from,
      to,
      note: String(note || '').slice(0, 500),
    }],
    updatedAt: Date.now(),
  };

  // Keep derived fields consistent if duty-off moved.
  if (field === 'dutyOffAt' && to) {
    patch.restUntil = to + REST_MIN_MS;
    patch.status = 'off';
  }
  if (field === 'dutyOnAt' && to && cur.dutyOffAt) {
    patch.over14 = (cur.dutyOffAt - to) > DUTY_MAX_MS;
  }

  await updateDoc(ref, patch);
}

async function getLatestDuty(pilotUid) {
  // Lightweight one-shot of the latest period (used by startDuty guard).
  return new Promise((resolve) => {
    const unsub = subscribeToCurrentDuty(pilotUid, (p) => {
      unsub();
      resolve(p);
    });
  });
}
