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
import { getAirportTimezone } from './airports.js';

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

// =====================================================================
// AUTO-COMPUTE: 61.57(a) T/O+L and 61.57(b) Night currency
// =====================================================================
//
// These two currencies are EVENT-COUNT based, not interval based:
//   61.57(a) — 3 takeoffs + landings in last 90 days
//   61.57(b) — 3 night T/O + full-stop landings in last 90 days
//
// Rather than make admins manually enter the last completion date,
// the dashboard scans the pilot's assigned trips in allTrips, counts
// qualifying events, and computes status directly.
//
// Pilot is "assigned" to a trip when nameMatchesPilot returns true
// for either trip.info.pic or trip.info.sic. We don't try to
// distinguish who flew the actual leg — each pilot logs their own
// T/O+L per FAA convention.
//
// Night detection is conservative: a leg counts as night only when
// BOTH the takeoff (local time at FROM airport) AND landing (local
// time at TO airport) fall in [21:00, 05:00). This under-counts at
// high latitudes / summer evenings, but never over-counts. Admins
// can manually adjust by setting `nightCurrency.lastDate` if needed.

// Mirror of App.jsx's nameMatchesPilot — kept local so this module
// stays self-contained. Both first AND last token of pilotName must
// appear as whole words in jetinsightName for a match.
function nameMatchesPilot(jetinsightName, pilotName) {
  if (!jetinsightName || !pilotName) return false;
  const tokens = String(pilotName).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const target = String(jetinsightName).toLowerCase();
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = (w) => new RegExp(`\\b${escape(w)}\\b`, 'i');
  return wordRe(first).test(target) && wordRe(last).test(target);
}

// Local hour at an airport (0-23) for a given UTC instant. Falls back
// to UTC if the airport's timezone isn't in our table.
function localHourAtAirport(utcMs, airportCode) {
  if (!Number.isFinite(utcMs)) return null;
  // airports.js's AIRPORT_TIMEZONES constant is private — use the
  // exported lookup function instead. Returns 'UTC' for unknown codes,
  // which is a safe default (just won't match the night window).
  const tz = getAirportTimezone(airportCode) || 'UTC';
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: tz,
    }).format(new Date(utcMs));
    const hour = parseInt(hourStr, 10);
    return Number.isFinite(hour) ? (hour === 24 ? 0 : hour) : null;
  } catch {
    return null;
  }
}

function isNightHour(h) {
  return h != null && (h >= 21 || h < 5);
}

// Collect every leg in the last 90 days where the pilot was assigned
// (PIC or SIC) and it was an actual flight (not HOLD/MX/TRAINING).
// Returns events ordered most-recent-first with night flag computed.
export function collectRecentLegEvents(pilotName, allTrips, todayMs = Date.now()) {
  if (!pilotName || !Array.isArray(allTrips)) return [];
  const windowStart = todayMs - 90 * 86400000;
  const events = [];
  for (const trip of allTrips) {
    if (!trip?.info?.isFlight) continue;
    if (!trip?.start) continue;
    const startMs = new Date(trip.start).getTime();
    if (!Number.isFinite(startMs)) continue;
    if (startMs < windowStart || startMs > todayMs) continue;
    const wasPic = nameMatchesPilot(trip.info.pic || '', pilotName);
    const wasSic = nameMatchesPilot(trip.info.sic || '', pilotName);
    if (!wasPic && !wasSic) continue;

    const endMs = trip.end ? new Date(trip.end).getTime() : startMs + 90 * 60000;
    const departHour = localHourAtAirport(startMs, trip.info.from);
    const arriveHour = localHourAtAirport(
      Number.isFinite(endMs) ? endMs : startMs + 90 * 60000,
      trip.info.to || trip.info.from
    );
    const isNight = isNightHour(departHour) && isNightHour(arriveHour);
    events.push({
      tripUid: trip.uid,
      startMs,
      endMs: Number.isFinite(endMs) ? endMs : startMs + 90 * 60000,
      from: trip.info.from || null,
      to: trip.info.to || null,
      tail: trip.info.tail || null,
      role: wasPic ? 'PIC' : 'SIC',
      isNight,
    });
  }
  // Most recent first — needed for currency-expiry math
  events.sort((a, b) => b.startMs - a.startMs);
  return events;
}

// Apply the 3-events-in-90-days rule to a list of qualifying flight
// events. Returns { status, count, needed, expiresMs, daysUntil, lastDates }.
//
// When count >= 3: currency stays current until the 3rd-most-recent
// event drops out of the rolling 90-day window. That expiration date
// becomes the "lastDate equivalent" — i.e. 90 days before this is the
// 3rd-most-recent event, after this the pilot has only 2 in window.
//
// When count < 3: status is 'expired' (the pilot is NOT current).
export function rollingNinetyDayStatus(qualifyingEvents, todayMs = Date.now()) {
  const sorted = [...(qualifyingEvents || [])].sort((a, b) => b.startMs - a.startMs);
  const count = sorted.length;
  if (count >= 3) {
    // Currency lasts until the 3rd-most-recent event drops out of the
    // 90-day window. After that the pilot has only 2 events in window,
    // i.e. not current.
    const expiresMs = sorted[2].startMs + 90 * 86400000;
    const daysUntil = Math.floor((expiresMs - todayMs) / 86400000);
    return {
      status: bucketize(daysUntil),
      count,
      needed: 0,
      expiresMs,
      daysUntil,
      dueDate: new Date(expiresMs).toISOString().slice(0, 10),
      lastDate: new Date(sorted[0].startMs).toISOString().slice(0, 10),
    };
  }
  return {
    status: 'expired',
    count,
    needed: 3 - count,
    expiresMs: null,
    daysUntil: null,
    dueDate: null,
    lastDate: count > 0 ? new Date(sorted[0].startMs).toISOString().slice(0, 10) : null,
  };
}

// Convenience: return auto status for a pilot's T/O+L and Night
// currencies in one call. Takes the pilot's name + allTrips and folds
// `collectRecentLegEvents` and `rollingNinetyDayStatus` together.
export function computeAutoTakeoffLanding(pilotName, allTrips, todayMs = Date.now()) {
  const events = collectRecentLegEvents(pilotName, allTrips, todayMs);
  const allLegs = events;
  const nightLegs = events.filter((e) => e.isNight);
  return {
    takeoffLanding: rollingNinetyDayStatus(allLegs, todayMs),
    nightCurrency:  rollingNinetyDayStatus(nightLegs, todayMs),
    rawEvents: events,
  };
}
