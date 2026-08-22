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
//     // FAA / Part 135 recent experience — exact-day or calendar-month
//     // windows. Admin records LAST completion date; system computes due.
//     takeoffLanding:        { lastDate: 'YYYY-MM-DD', notes: '' },
//     nightCurrency:         { lastDate: 'YYYY-MM-DD', notes: '' },
//     instrumentCurrency:    { lastDate: 'YYYY-MM-DD', notes: '' },
//
//     // Part 135 checkrides — same shape, different intervals
//     competencyCheck293:    { lastDate: 'YYYY-MM-DD', notes: '' },
//     instrumentCheck297:    { lastDate: 'YYYY-MM-DD', notes: '' },
//     lineCheck299:          { lastDate: 'YYYY-MM-DD', notes: '' },
//
//     // Recurrent training (§§135.343/351 — 12-calendar-month cycle)
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
import {
  computeMedicalStatus,
  computeStatus,
  STATUS_THRESHOLDS,
} from './currency-status.js';

export { computeMedicalStatus, computeStatus, STATUS_THRESHOLDS };

// Currency / qualification types displayed in the dashboard. Order here =
// render order. Regulatory checks use calendar-month periods, not rough
// 180/365-day periods. `graceMonths: 1` reflects the preceding/base/following
// eligibility window where the cited rule provides it.
//
// Applicability is explicit because not every item applies to every Part 135
// pilot. Admins mark conditional items N/A per pilot rather than the software
// pretending, for example, that every SIC needs a PIC line check.
export const CURRENCY_TYPES = [
  {
    key: 'takeoffLanding',
    label: '§135.247(a)(1) PIC Day T/O & Landing',
    abbrev: 'T/O + LDG',
    interval: 90,
    category: 'FAA RECENCY',
    applicability: 'PIC carrying passengers; same category/class/type when required',
    citation: '14 CFR 135.247(a)(1)',
    notes: '3 takeoffs and 3 landings as sole manipulator within 90 days; §61.57 governs applicable non-Part-135 use',
  },
  {
    key: 'nightCurrency',
    label: '§135.247(a)(2) PIC Night T/O & Landing',
    abbrev: 'NIGHT',
    interval: 90,
    category: 'FAA RECENCY',
    applicability: 'PIC carrying passengers at night; §135.247(a)(3) alternatives may apply',
    citation: '14 CFR 135.247(a)(2)-(3)',
    notes: '3 night takeoffs/landings in the defined night period; track an approved turbine alternative separately',
  },
  {
    key: 'instrumentCurrency',
    label: '§135.245(c) SIC IFR Instrument Recency',
    abbrev: 'INSTRUMENT',
    intervalMonths: 6,
    category: 'FAA RECENCY',
    applicability: 'SIC serving under IFR; PIC IFR uses §135.297 instead',
    citation: '14 CFR 135.245(c)-(d)',
    notes: '6 approaches + holding + intercepting/tracking within 6 calendar months; §61.57(c) governs applicable non-Part-135 use',
  },
  {
    key: 'flightReview61_56',
    label: '§61.56 Flight Review / Qualifying Check',
    abbrev: 'FLIGHT REV',
    intervalMonths: 24,
    category: 'FAA RECENCY',
    applicability: 'Any person acting as PIC; a qualifying proficiency/competency check may substitute',
    citation: '14 CFR 61.56(c)-(d)',
    notes: '24 calendar months; record the qualifying §135 check in notes if used instead',
  },
  {
    key: 'sicQualification61_55',
    label: '§61.55 SIC Qualification / Familiarization',
    abbrev: 'SIC QUAL',
    intervalMonths: 12,
    graceMonths: 1,
    category: 'FAA RECENCY',
    applicability: 'SIC in aircraft/operations requiring an SIC; per aircraft type',
    citation: '14 CFR 61.55',
    notes: '12 calendar months; approved Part 135 training/check may satisfy as applicable',
  },
  {
    key: 'picQualification135_243',
    label: '§135.243 PIC Qualification',
    abbrev: 'PIC QUAL',
    noExpiration: true,
    category: 'PART 135 GENERAL',
    applicability: 'PIC; certificate/rating and aeronautical-experience minimums vary by operation',
    citation: '14 CFR 135.243',
    notes: 'Qualification basis verified and on file; hours are not a recurrent interval',
  },
  {
    key: 'sicQualification135_245',
    label: '§135.245 SIC Qualification',
    abbrev: 'SIC 135',
    noExpiration: true,
    category: 'PART 135 GENERAL',
    applicability: 'SIC; certificate/category/class/instrument qualifications as applicable',
    citation: '14 CFR 135.245(a)-(b)',
    notes: 'Qualification basis verified and on file; IFR recency is tracked separately',
  },
  {
    key: 'basicIndoctrination',
    label: 'Basic Indoctrination',
    abbrev: 'BASIC INDOC',
    noExpiration: true,
    category: 'PART 135 GENERAL',
    applicability: 'Crewmember under the operator’s FAA-approved training program',
    citation: '14 CFR 135.323, 135.327, 135.329',
    notes: 'Initial operator indoctrination; recurrent subjects are tracked separately',
  },
  {
    key: 'groundOralGeneral293a',
    label: '§135.293(a) Knowledge Test — General',
    abbrev: '293(a) GEN',
    intervalMonths: 12,
    graceMonths: 1,
    category: 'PART 135 GENERAL',
    applicability: 'Every Part 135 pilot',
    citation: '14 CFR 135.293(a), 135.301(a)',
    notes: 'Written or oral knowledge test within 12 calendar months',
  },
  ...[
    ['groundOral293a_LR60', '§135.293(a)(2)-(3) Aircraft Knowledge — LR-60', '293(a) LR60', 'LR-60'],
    ['groundOral293a_CE525', '§135.293(a)(2)-(3) Aircraft Knowledge — CE-525', '293(a) 525', 'CE-525'],
    ['groundOral293a_SF50', '§135.293(a)(2)-(3) Aircraft Knowledge — SF-50', '293(a) SF50', 'SF-50'],
    ['groundOral293a_untyped', '§135.293(a)(2)-(3) Aircraft Knowledge — Other', '293(a) OTHER', 'assigned aircraft'],
  ].map(([key, label, abbrev, aircraft]) => ({
    key,
    label,
    abbrev,
    intervalMonths: 12,
    graceMonths: 1,
    category: 'AIRCRAFT-SPECIFIC',
    applicability: `Pilot assigned to ${aircraft}; mark N/A otherwise`,
    citation: '14 CFR 135.293(a)(2)-(3), 135.301(a)',
    notes: 'Aircraft equipment, systems, performance, limitations, and procedures',
  })),
  ...[
    ['sim293b_LR60', '§135.293(b) Competency Check — LR-60', '293(b) LR60', 'LR-60'],
    ['sim293b_CE525', '§135.293(b) Competency Check — CE-525', '293(b) 525', 'CE-525'],
    ['sim293b_SF50', '§135.293(b) Competency Check — SF-50', '293(b) SF50', 'SF-50'],
    ['sim293b_untyped', '§135.293(b) Competency Check — Other', '293(b) OTHER', 'assigned class/type'],
  ].map(([key, label, abbrev, aircraft]) => ({
    key,
    label,
    abbrev,
    intervalMonths: 12,
    graceMonths: 1,
    category: 'AIRCRAFT-SPECIFIC',
    applicability: `Pilot assigned to ${aircraft}; mark N/A otherwise`,
    citation: '14 CFR 135.293(b), 135.301(a)',
    notes: 'Competency check in the required aircraft class/type',
  })),
  {
    key: 'competencyCheck293',
    label: '§135.293(b) Competency Check — Legacy/General',
    abbrev: '293 LEGACY',
    intervalMonths: 12,
    graceMonths: 1,
    category: 'AIRCRAFT-SPECIFIC',
    applicability: 'Use only for existing generic records; prefer the aircraft-specific item',
    citation: '14 CFR 135.293(b), 135.301(a)',
    notes: 'Retained so existing competency dates are not hidden',
  },
  {
    key: 'instrumentCheck297',
    label: '§135.297 PIC Instrument Proficiency Check',
    abbrev: '297 IPC',
    intervalMonths: 6,
    graceMonths: 1,
    category: 'PART 135 CHECKS',
    applicability: 'PIC conducting IFR operations; per assigned aircraft rotation rules',
    citation: '14 CFR 135.297, 135.301(a)',
    notes: '6-calendar-month PIC instrument proficiency check',
  },
  {
    key: 'lineCheck299',
    label: '§135.299 PIC Line Check',
    abbrev: '299 LINE',
    intervalMonths: 12,
    graceMonths: 1,
    category: 'PART 135 CHECKS',
    applicability: 'PIC only',
    citation: '14 CFR 135.299(a), 135.301(a)',
    notes: 'At least one route segment with representative takeoffs and landings',
  },
  {
    key: 'autopilotCheck297g',
    label: '§135.297(g) Single-Pilot Autopilot Check',
    abbrev: 'AP CHECK',
    intervalMonths: 12,
    graceMonths: 1,
    category: 'PART 135 CHECKS',
    applicability: 'PIC authorized to use autopilot in place of an SIC',
    citation: '14 CFR 135.297(g)',
    notes: 'Demonstrated during the IPC at least once every 12 calendar months',
  },
  {
    key: 'routeAirportReview299c',
    label: '§135.299(c) Route / Airport Familiarization',
    abbrev: 'ROUTE REV',
    category: 'PART 135 CHECKS',
    operatorDefined: true,
    applicability: 'PIC who has not flown the specific route/airport in the preceding 90 days',
    citation: '14 CFR 135.299(c)',
    notes: 'Per-route/airport preflight review, not one global 90-day currency; enter operator tracking due date if used',
  },
  {
    key: 'picTurbineNightAlternative247',
    label: '§135.247(a)(3) Turbine Multi-Pilot Night Alternative',
    abbrev: 'NIGHT ALT',
    category: 'PART 135 CHECKS',
    operatorDefined: true,
    applicability: 'PIC electing the turbine airplane night-currency alternative only',
    citation: '14 CFR 135.247(a)(3)',
    notes: 'Track day 3/3, 15 hr type/90 days, and night landing or approved Part 142 pathway in notes/due date',
  },
  {
    key: 'recurrentTraining351',
    label: '§§135.343 / 135.351 Recurrent Training',
    abbrev: 'RECURRENT',
    intervalMonths: 12,
    graceMonths: 1,
    category: 'TRAINING',
    applicability: 'Crewmembers; §135.343 exception for a certificate holder using only one pilot',
    citation: '14 CFR 135.343, 135.351, 135.323(b)',
    notes: '12 calendar months — corrects the former 6-month setting',
  },
  {
    key: 'crmTraining330',
    label: '§135.330 CRM Training',
    abbrev: 'CRM',
    operatorDefined: true,
    category: 'TRAINING',
    applicability: 'Flightcrew under the operator’s approved CRM program',
    citation: '14 CFR 135.330, 135.351(b)(2)',
    notes: 'Initial and recurrent CRM; interval/content follow the approved program and may be included in recurrent ground training',
  },
  {
    key: 'emergencyTraining',
    label: '§135.331 Emergency Training',
    abbrev: 'EMERGENCY',
    operatorDefined: true,
    category: 'TRAINING',
    applicability: 'Crewmember, as appropriate to aircraft/configuration and operation',
    citation: '14 CFR 135.331, 135.351(b)(2)',
    notes: 'Emergency subjects/drills recur through the approved §135.351 program; enter its due date',
  },
  {
    key: 'windshearIcingTraining',
    label: '§135.351 Windshear / Ground Icing',
    abbrev: 'WS/ICING',
    operatorDefined: true,
    category: 'TRAINING',
    applicability: 'As appropriate under the operator’s approved training program',
    citation: '14 CFR 135.341, 135.345, 135.351(b)(2)',
    notes: 'Low-altitude windshear and ground-icing recurrent subjects; approved-program interval',
  },
  {
    key: 'hazmatTraining',
    label: '§135.505 Hazardous Materials Training',
    abbrev: 'HAZMAT',
    intervalMonths: 24,
    graceMonths: 1,
    category: 'TRAINING',
    applicability: 'Crewmember/person performing or supervising §135.501(a) functions',
    citation: '14 CFR 135.501, 135.503, 135.505',
    notes: 'FAA-approved initial/recurrent hazmat program within 24 months',
  },
  {
    key: 'checkPilotObservation339',
    label: '§135.339 Check Pilot Observation',
    abbrev: 'CHK OBS',
    intervalMonths: 24,
    graceMonths: 1,
    category: 'TRAINING',
    applicability: 'Authorized check pilots only',
    citation: '14 CFR 135.339(a)-(b)',
    notes: 'Conduct a check under required observation within 24 calendar months',
  },
  {
    key: 'checkPilotFstdRecency337',
    label: '§135.337(d) Check Pilot FSTD Recency',
    abbrev: 'CHK FSTD',
    intervalMonths: 12,
    graceMonths: 1,
    category: 'TRAINING',
    applicability: 'Check pilot performing duties in an FSTD only',
    citation: '14 CFR 135.337(d)-(e)',
    notes: 'Two required-crewmember segments or approved line-observation program',
  },
  {
    key: 'flightInstructorObservation340',
    label: '§135.340 Flight Instructor Observation',
    abbrev: 'FI OBS',
    intervalMonths: 24,
    graceMonths: 1,
    category: 'TRAINING',
    applicability: 'Part 135 flight instructors only',
    citation: '14 CFR 135.340(a)-(b)',
    notes: 'Conduct instruction under required observation within 24 calendar months',
  },
  {
    key: 'flightInstructorFstdRecency338',
    label: '§135.338(d) Instructor FSTD Recency',
    abbrev: 'FI FSTD',
    intervalMonths: 12,
    graceMonths: 1,
    category: 'TRAINING',
    applicability: 'Flight instructor performing duties in an FSTD only',
    citation: '14 CFR 135.338(d)-(e)',
    notes: 'Two required-crewmember segments or approved line-observation program',
  },
  {
    key: 'rvsmTraining',
    label: 'RVSM Qualification',
    abbrev: 'RVSM',
    category: 'SPECIAL OPS',
    operatorDefined: true,
    applicability: 'Pilots assigned to RVSM operations per OpSpecs/training program',
    notes: 'No universal Part 135 recurrence interval; enter operator-program due date',
  },
  {
    key: 'tfsspTraining',
    label: 'TFSSP Training',
    abbrev: 'TFSSP',
    category: 'SPECIAL OPS',
    operatorDefined: true,
    applicability: 'Only when required by the operator’s TSA security program',
    notes: 'Enter the due date required by the approved security program',
  },
  {
    key: 'dasspTraining',
    label: 'DASSP Training',
    abbrev: 'DASSP',
    category: 'SPECIAL OPS',
    operatorDefined: true,
    applicability: 'Only for DASSP-covered operations/personnel',
    notes: 'Enter the due date required by the approved security program',
  },
  {
    key: 'kcmBadge',
    label: 'Known Crewmember Badge',
    abbrev: 'KCM',
    noExpiration: true,
    category: 'BADGES',
    applicability: 'Only enrolled crewmembers',
    notes: 'Administrative credential, not a Part 135 pilot currency rule',
  },
];

// Color palette per status. Matches the wear-watch coloring so pilots
// see consistent visual cues across the app.
export const STATUS_COLORS = {
  current:  { bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', text: 'text-emerald-300', label: 'CURRENT' },
  caution:  { bg: 'bg-yellow-500/15',  border: 'border-yellow-500/30',  text: 'text-yellow-300',  label: 'CAUTION' },
  warning:  { bg: 'bg-orange-500/15',  border: 'border-orange-500/30',  text: 'text-orange-300',  label: 'WARNING' },
  critical: { bg: 'bg-red-500/15',     border: 'border-red-500/30',    text: 'text-red-300',     label: 'CRITICAL' },
  expired:  { bg: 'bg-red-500/30',     border: 'border-red-500/60',    text: 'text-red-200',     label: 'EXPIRED' },
  unknown:  { bg: 'bg-slate-500/15',   border: 'border-slate-500/30',  text: 'text-slate-400',   label: 'NOT SET' },
  na:       { bg: 'bg-slate-900/20',   border: 'border-slate-800',     text: 'text-slate-600',   label: 'N/A' },
  noExpiration: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', text: 'text-cyan-300', label: 'ON FILE' },
};

// Roll up worst-case status across every tracked item for one pilot.
// Used by the pilot-card "summary" line and by the top-of-screen counts.
export function rollupPilotStatus(currencyDoc, todayMs = Date.now()) {
  if (!currencyDoc) {
    return {
      status: 'unknown',
      worstDays: null,
      expiredCount: 0,
      warningCount: 0,
      unknownCount: CURRENCY_TYPES.length + 1,
      applicableCount: CURRENCY_TYPES.length + 1,
    };
  }
  let worstDays = Infinity;
  let worstStatus = 'current';
  let expiredCount = 0;
  let warningCount = 0;
  let unknownCount = 0;
  let applicableCount = 0;
  const statusRank = {
    expired: 6,
    critical: 5,
    warning: 4,
    caution: 3,
    unknown: 2,
    current: 1,
    noExpiration: 1,
    na: 0,
  };
  const fold = (r) => {
    if (r.status === 'na') return;
    applicableCount++;
    if (r.status === 'expired') expiredCount++;
    if (['warning', 'critical'].includes(r.status)) warningCount++;
    if (r.status === 'unknown') unknownCount++;
    if (
      statusRank[r.status] > statusRank[worstStatus]
      || (
        statusRank[r.status] === statusRank[worstStatus]
        && r.daysUntil != null
        && r.daysUntil < worstDays
      )
    ) {
      worstDays = r.daysUntil;
      worstStatus = r.status;
    }
  };
  for (const type of CURRENCY_TYPES) {
    fold(computeStatus(currencyDoc[type.key], type.interval, todayMs, type));
  }
  fold(computeMedicalStatus(currencyDoc.medical, todayMs));
  return {
    status: worstStatus,
    worstDays: Number.isFinite(worstDays) ? worstDays : null,
    expiredCount,
    warningCount,
    unknownCount,
    applicableCount,
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
