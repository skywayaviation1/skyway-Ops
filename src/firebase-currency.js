// src/firebase-currency.js
//
// Pilot currency & training tracking — Firestore helpers.
//
// Why this exists: Part 135 §135.247 makes the certificate holder
// responsible for not assigning a pilot whose currency has lapsed. An
// expired §135.297 IPC, an out-of-date competency check, or a stale
// medical can all end the AOC. The Wear Watch system already tracks
// aircraft compliance the same way; this is the crew side.
//
// Collection: pilot-currencies/{uid}
//
// Shape:
//   {
//     uid: 'firebase-uid',
//     pilotName: 'Hagberg',         // denormalized for display
//
//     // FAA currencies (61.57) — interval-based ("3 T/O+L in 90 days",
//     // etc). Admin records LAST completion date; system computes due.
//     takeoffLanding:        { lastDate: 'YYYY-MM-DD', notes: '' },
//     nightCurrency:         { lastDate: 'YYYY-MM-DD', notes: '' },
//     instrumentCurrency:    { lastDate: 'YYYY-MM-DD', notes: '' },
//
//     // Part 135 checkrides — same shape, different intervals
//     competencyCheck293:    { lastDate: 'YYYY-MM-DD', notes: '' },
//     instrumentCheck297:    { lastDate: 'YYYY-MM-DD', notes: '' },
//     lineCheck299:          { lastDate: 'YYYY-MM-DD', notes: '' },
//
//     // Recurrent training (§135.351 — 6-mo ground/sim cycle)
//     recurrentTraining351:  { lastDate: 'YYYY-MM-DD', notes: '' },
//
//     // Medical — explicit expirationDate, NOT interval. FAA medical
//     // durations vary (Class 1 under 40 = 12mo, over 40 = 6mo,
//     // BasicMed = 48mo, etc). Cleaner to record actual exp than to
//     // compute one based on issue date + age.
//     medical: {
//       class: 'First' | 'Second' | 'Third' | 'BasicMed',
//       expirationDate: 'YYYY-MM-DD',
//       notes: '',
//     },
//
//     updatedAt: ms,
//     updatedBy: 'uid',
//   }

import { db } from './firebase.js';
import {
  doc, setDoc, collection, onSnapshot,
} from 'firebase/firestore';

// Currency types displayed in the dashboard. Order here = render order.
// `interval` is in days. To add a new type: append to this array — the
// UI loops over CURRENCY_TYPES so nothing else needs to change.
export const CURRENCY_TYPES = [
  {
    key: 'takeoffLanding',
    label: '61.57(a) Takeoff & Landing',
    abbrev: 'T/O + LDG',
    interval: 90,
    category: 'FAA',
    notes: '3 T/O + landings in 90 days (category/class/type)',
  },
  {
    key: 'nightCurrency',
    label: '61.57(b) Night',
    abbrev: 'NIGHT',
    interval: 90,
    category: 'FAA',
    notes: '3 night T/O + full-stop landings in 90 days',
  },
  {
    key: 'instrumentCurrency',
    label: '61.57(c) Instrument',
    abbrev: 'INSTRUMENT',
    interval: 180,
    category: 'FAA',
    notes: '6 approaches + holding + intercepting/tracking in 6 months',
  },
  {
    key: 'competencyCheck293',
    label: '§135.293 Competency Check',
    abbrev: '293 CHECK',
    interval: 365,
    category: 'PART 135',
    notes: 'Annual pilot competency check',
  },
  {
    key: 'instrumentCheck297',
    label: '§135.297 Instrument Proficiency',
    abbrev: '297 IPC',
    interval: 180,
    category: 'PART 135',
    notes: '6-month instrument proficiency check',
  },
  {
    key: 'lineCheck299',
    label: '§135.299 Line Check',
    abbrev: '299 LINE',
    interval: 365,
    category: 'PART 135',
    notes: 'Annual line check',
  },
  {
    key: 'recurrentTraining351',
    label: '§135.351 Recurrent Training',
    abbrev: 'RECURRENT',
    interval: 180,
    category: 'TRAINING',
    notes: '6-month recurrent ground/sim',
  },
];

// Days-out thresholds. Change here to tune the entire dashboard.
// CRITICAL = the "do something this week" bucket. WARNING = "schedule
// the check now." CAUTION = "we'll need to look at this soon."
export const STATUS_THRESHOLDS = {
  CRITICAL: 14,
  WARNING: 30,
  CAUTION: 60,
};

// Color palette per status. Matches the wear-watch coloring so pilots
// see consistent visual cues across the app.
export const STATUS_COLORS = {
  current:  { bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', text: 'text-emerald-300', label: 'CURRENT' },
  caution:  { bg: 'bg-yellow-500/15',  border: 'border-yellow-500/30',  text: 'text-yellow-300',  label: 'CAUTION' },
  warning:  { bg: 'bg-orange-500/15',  border: 'border-orange-500/30',  text: 'text-orange-300',  label: 'WARNING' },
  critical: { bg: 'bg-red-500/15',     border: 'border-red-500/30',    text: 'text-red-300',     label: 'CRITICAL' },
  expired:  { bg: 'bg-red-500/30',     border: 'border-red-500/60',    text: 'text-red-200',     label: 'EXPIRED' },
  unknown:  { bg: 'bg-slate-500/15',   border: 'border-slate-500/30',  text: 'text-slate-400',   label: 'NOT SET' },
};

// Compute status for a {lastDate, notes} item plus an interval (days).
// Returns { status, dueDate (YYYY-MM-DD), daysUntil (signed) }.
//
// Negative daysUntil = expired. Positive = days remaining.
// Sentinel 'unknown' when the lastDate is missing/malformed.
export function computeStatus(item, intervalDays, todayMs = Date.now()) {
  if (!item || !item.lastDate) {
    return { status: 'unknown', dueDate: null, daysUntil: null };
  }
  const last = new Date(item.lastDate);
  if (!Number.isFinite(last.getTime())) {
    return { status: 'unknown', dueDate: null, daysUntil: null };
  }
  const dueDateMs = last.getTime() + intervalDays * 86400000;
  const daysUntil = Math.floor((dueDateMs - todayMs) / 86400000);
  return {
    status: bucketize(daysUntil),
    dueDate: new Date(dueDateMs).toISOString().slice(0, 10),
    daysUntil,
  };
}

// Medical is special: uses an explicit expirationDate rather than an
// interval (FAA medical validity periods depend on age + class — easier
// to store the date that's printed on the certificate).
export function computeMedicalStatus(med, todayMs = Date.now()) {
  if (!med || !med.expirationDate) {
    return { status: 'unknown', dueDate: null, daysUntil: null };
  }
  const due = new Date(med.expirationDate);
  if (!Number.isFinite(due.getTime())) {
    return { status: 'unknown', dueDate: null, daysUntil: null };
  }
  const daysUntil = Math.floor((due.getTime() - todayMs) / 86400000);
  return {
    status: bucketize(daysUntil),
    dueDate: med.expirationDate,
    daysUntil,
  };
}

function bucketize(daysUntil) {
  if (daysUntil < 0) return 'expired';
  if (daysUntil <= STATUS_THRESHOLDS.CRITICAL) return 'critical';
  if (daysUntil <= STATUS_THRESHOLDS.WARNING) return 'warning';
  if (daysUntil <= STATUS_THRESHOLDS.CAUTION) return 'caution';
  return 'current';
}

// Roll up worst-case status across every tracked item for one pilot.
// Used by the pilot-card "summary" line and by the top-of-screen counts.
export function rollupPilotStatus(currencyDoc, todayMs = Date.now()) {
  if (!currencyDoc) {
    return { status: 'unknown', worstDays: null, expiredCount: 0, warningCount: 0 };
  }
  let worstDays = Infinity;
  let worstStatus = 'current';
  let expiredCount = 0;
  let warningCount = 0;
  const fold = (r) => {
    if (r.status === 'expired') expiredCount++;
    if (['warning', 'critical'].includes(r.status)) warningCount++;
    if (r.daysUntil != null && r.daysUntil < worstDays) {
      worstDays = r.daysUntil;
      worstStatus = r.status;
    }
  };
  for (const type of CURRENCY_TYPES) {
    fold(computeStatus(currencyDoc[type.key], type.interval, todayMs));
  }
  fold(computeMedicalStatus(currencyDoc.medical, todayMs));
  return {
    status: worstStatus,
    worstDays: Number.isFinite(worstDays) ? worstDays : null,
    expiredCount,
    warningCount,
  };
}

// Subscribe to ALL pilot currency docs (admin/ops dashboard view).
// Returns an unsubscribe function. Result is a {uid: doc} map.
export function subscribePilotCurrencies(onUpdate) {
  const ref = collection(db, 'pilot-currencies');
  return onSnapshot(
    ref,
    (snap) => {
      const byUid = {};
      snap.forEach((d) => {
        byUid[d.id] = { uid: d.id, ...d.data() };
      });
      onUpdate(byUid);
    },
    (err) => {
      console.warn('[pilot-currencies] subscribe error:', err.message);
      onUpdate({});
    }
  );
}

// Subscribe to a single pilot's currency doc (crew self-view).
export function subscribeMyPilotCurrency(uid, onUpdate) {
  if (!uid) {
    onUpdate(null);
    return () => {};
  }
  return onSnapshot(
    doc(db, 'pilot-currencies', uid),
    (snap) => {
      onUpdate(snap.exists() ? { uid, ...snap.data() } : null);
    },
    (err) => {
      console.warn('[pilot-currencies] self subscribe error:', err.message);
      onUpdate(null);
    }
  );
}

// Save / merge updates for a pilot's currency doc.
// Admin-only by Firestore rules. Caller passes the editor's draft state.
export async function savePilotCurrency(uid, updates, currentUserUid, pilotName = null) {
  if (!uid) throw new Error('uid required');
  const payload = {
    ...updates,
    uid,
    updatedAt: Date.now(),
    updatedBy: currentUserUid || null,
  };
  if (pilotName) payload.pilotName = pilotName;
  await setDoc(doc(db, 'pilot-currencies', uid), payload, { merge: true });
}
