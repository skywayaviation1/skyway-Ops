// src/firebase-duty-v2.js
//
// =====================================================================
// FIRESTORE DATA LAYER — Part 135 duty/rest tracking (V2)
// =====================================================================
//
// Collection: duty-periods-v2
//   Separate from the old `duty-state` collection so historical data
//   and the new system don't collide. Old collection can be archived
//   or deleted at your convenience.
//
// Collection: duty-outside-flying-v2
//   Pilots log commercial flying done for OTHER operators here, so the
//   legality engine can include it in the 8/10h rolling-24h check.
//
// Document schema — duty-periods-v2/{id}:
//   {
//     id: string,                  // = `${pilotUid}_${dutyOnAtMs}`
//     pilotUid: string,
//     pilotName: string,
//     // --- Required confirmation fields captured at duty-on ---
//     location: string,            // airport code or freeform location
//     tail: string | null,         // aircraft tail (null for non-flight duty)
//     tripId: string | null,       // app trip uid if linked
//     role: 'PIC' | 'SIC' | null,
//     crewType: 'single' | 'two',  // affects flight-time limits
//     assignmentType: 'unscheduled' | 'regular',  // 135.267(b) vs (c)
//     fitForDuty: boolean,         // pilot self-attests
//     priorRestMs: number | null,  // pilot-attested prior rest amount
//     // --- Timestamps ---
//     dutyOnAt: number (ms),
//     dutyOffAt: number | null,
//     // --- Flight time ---
//     flightTimeMs: number,        // sum of block time recorded against
//                                   // this duty period; updated incrementally
//                                   // OR set at duty-off
//     // --- Excursion handling ---
//     excursionReason: string | null,  // why flight time exceeded limits
//                                        // if claimed "outside control" per
//                                        // 135.267(d)
//     // --- Override workflow ---
//     overrideStatus: 'none' | 'requested' | 'approved',
//     overrideRequestedBy: string | null,
//     overrideRequestedAt: number | null,
//     overrideRequestReason: string | null,
//     overrideApprovedBy: string | null,
//     overrideApprovedAt: number | null,
//     overrideApprovalNotes: string | null,
//     // --- Audit ---
//     adminEdits: Array<{ by, at, field, from, to, note }>,
//     createdAt: number,
//     updatedAt: number,
//     // --- Status helpers (denormalized for query speed) ---
//     status: 'on' | 'off',
//     over14: boolean,             // true if elapsed > 14h regular duty
//   }
//
// Document schema — duty-outside-flying-v2/{id}:
//   {
//     id: string,
//     pilotUid: string,
//     pilotName: string,
//     startAt: number,
//     endAt: number,
//     flightTimeMs: number,
//     source: string,              // freeform: "operator name", "personal", etc.
//     notes: string,
//     createdAt: number,
//     updatedAt: number,
//   }
//
// Security rules notes (for whoever's writing rules):
//   - Pilots can READ their own duty-periods-v2 + duty-outside-flying-v2
//   - Pilots can CREATE / UPDATE their own (own pilotUid)
//   - Pilots can NEVER set overrideApprovedBy / overrideApprovedAt — only
//     admin/ops/chief-pilot roles can approve
//   - Admin / ops / chief-pilot can read ALL pilots' records
//   - Deletes are not permitted — periods are corrected via edits, not removed

import { db } from './firebase.js';
import {
  collection, doc, query, where, onSnapshot, getDoc, getDocs,
  setDoc, updateDoc, addDoc, orderBy, limit, Timestamp
} from 'firebase/firestore';

const COLL = 'duty-periods-v2';
const OUTSIDE_COLL = 'duty-outside-flying-v2';

// -----------------------------------------------------------------
// Subscriptions
// -----------------------------------------------------------------

/**
 * Subscribe to ALL duty periods for one pilot.
 * onUpdate is called with an array sorted by dutyOnAt DESCENDING (newest first).
 * If pilotUid is falsy, calls onUpdate([]) and returns a no-op unsubscribe.
 * Returns an unsubscribe function.
 */
export function subscribePeriodsForPilot(pilotUid, onUpdate) {
  if (!pilotUid) { onUpdate([]); return () => {}; }
  const q = query(collection(db, COLL), where('pilotUid', '==', pilotUid));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.dutyOnAt || 0) - (a.dutyOnAt || 0));
    onUpdate(list);
  }, (err) => {
    console.error('[duty-v2] subscribePeriodsForPilot error:', err);
    onUpdate([]);
  });
}

/**
 * Subscribe to all CURRENTLY ON-DUTY periods across all pilots.
 * Used by the ops crew board.
 */
export function subscribeAllOnDuty(onUpdate) {
  const q = query(collection(db, COLL), where('status', '==', 'on'));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.dutyOnAt || 0) - (b.dutyOnAt || 0));
    onUpdate(list);
  }, (err) => {
    console.error('[duty-v2] subscribeAllOnDuty error:', err);
    onUpdate([]);
  });
}

/**
 * Subscribe to all duty periods for all pilots within the last `days` days.
 * Heavy — used only by admin ops dashboard. Fetches up to 500 records.
 */
export function subscribeRecentForAllPilots(days, onUpdate) {
  const cutoff = Date.now() - (days * 24 * 3600 * 1000);
  const q = query(
    collection(db, COLL),
    where('dutyOnAt', '>=', cutoff),
  );
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.dutyOnAt || 0) - (a.dutyOnAt || 0));
    onUpdate(list.slice(0, 500));
  }, (err) => {
    console.error('[duty-v2] subscribeRecentForAllPilots error:', err);
    onUpdate([]);
  });
}

/**
 * Subscribe to outside commercial flying entries for one pilot.
 */
export function subscribeOutsideFlyingForPilot(pilotUid, onUpdate) {
  if (!pilotUid) { onUpdate([]); return () => {}; }
  const q = query(collection(db, OUTSIDE_COLL), where('pilotUid', '==', pilotUid));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.startAt || 0) - (a.startAt || 0));
    onUpdate(list);
  }, (err) => {
    console.error('[duty-v2] subscribeOutsideFlyingForPilot error:', err);
    onUpdate([]);
  });
}

/**
 * One-shot fetch of all outside flying for a pilot (for engine input
 * when subscriptions aren't needed).
 */
export async function fetchOutsideFlyingForPilot(pilotUid) {
  if (!pilotUid) return [];
  const q = query(collection(db, OUTSIDE_COLL), where('pilotUid', '==', pilotUid));
  const snap = await getDocs(q);
  const list = [];
  snap.forEach(d => list.push({ id: d.id, ...d.data() }));
  return list;
}

// -----------------------------------------------------------------
// Writes — duty periods
// -----------------------------------------------------------------

/**
 * Start a duty period. opts must include the confirmation fields.
 *
 * opts:
 *   {
 *     pilotUid, pilotName,
 *     location,                    required, freeform string
 *     tail,                        optional, aircraft tail
 *     tripId,                      optional, trip uid
 *     role,                        optional, 'PIC' | 'SIC'
 *     crewType,                    required, 'single' | 'two'
 *     assignmentType,              required, 'unscheduled' | 'regular'
 *     fitForDuty,                  required, must be `true`
 *     priorRestMs,                 optional, pilot-attested prior rest
 *     dutyOnAt,                    optional, defaults to now
 *   }
 *
 * Refuses if fitForDuty is not explicitly true (pilots cannot skip the
 * attestation). Refuses if pilot already has an open period — caller
 * must close it first.
 */
export async function startDuty(opts) {
  if (!opts?.pilotUid) throw new Error('pilotUid required');
  if (opts.fitForDuty !== true) throw new Error('fit-for-duty attestation required');
  if (!['unscheduled', 'regular'].includes(opts.assignmentType)) {
    throw new Error('assignmentType must be "unscheduled" or "regular"');
  }
  if (!['single', 'two'].includes(opts.crewType)) {
    throw new Error('crewType must be "single" or "two"');
  }

  // Refuse if there's already an open period for this pilot
  const existingQ = query(
    collection(db, COLL),
    where('pilotUid', '==', opts.pilotUid),
    where('status', '==', 'on')
  );
  const existing = await getDocs(existingQ);
  if (!existing.empty) {
    throw new Error('Pilot already has an open duty period. End it before starting a new one.');
  }

  const dutyOnAt = Number.isFinite(opts.dutyOnAt) ? opts.dutyOnAt : Date.now();
  const id = `${opts.pilotUid}_${dutyOnAt}`;
  const now = Date.now();
  const docData = {
    id,
    pilotUid: opts.pilotUid,
    pilotName: opts.pilotName || 'Unknown',
    location: opts.location || '',
    tail: opts.tail || null,
    tripId: opts.tripId || null,
    role: opts.role || null,
    crewType: opts.crewType,
    assignmentType: opts.assignmentType,
    fitForDuty: true,
    priorRestMs: Number.isFinite(opts.priorRestMs) ? opts.priorRestMs : null,
    dutyOnAt,
    dutyOffAt: null,
    flightTimeMs: 0,
    excursionReason: null,
    overrideStatus: 'none',
    overrideRequestedBy: null,
    overrideRequestedAt: null,
    overrideRequestReason: null,
    overrideApprovedBy: null,
    overrideApprovedAt: null,
    overrideApprovalNotes: null,
    adminEdits: [],
    createdAt: now,
    updatedAt: now,
    status: 'on',
    over14: false,
  };
  await setDoc(doc(db, COLL, id), docData);
  return docData;
}

/**
 * End an open duty period.
 *
 * opts:
 *   {
 *     dutyOffAt,                   optional, defaults to now
 *     flightTimeMs,                optional, total flight time for the period
 *     excursionReason,             optional, required if flight-time excursion
 *                                   was outside pilot/operator control
 *     endedBy,                     optional, for audit
 *   }
 */
export async function endDuty(periodId, opts = {}) {
  if (!periodId) throw new Error('periodId required');
  const ref = doc(db, COLL, periodId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();
  if (cur.status !== 'on') throw new Error('duty period is already closed');

  const dutyOffAt = Number.isFinite(opts.dutyOffAt) ? opts.dutyOffAt : Date.now();
  if (dutyOffAt <= cur.dutyOnAt) {
    throw new Error('dutyOffAt must be after dutyOnAt');
  }

  const flightTimeMs = Number.isFinite(opts.flightTimeMs)
    ? opts.flightTimeMs
    : (cur.flightTimeMs || 0);

  // Compute over14 — only meaningful for regular-assignment periods,
  // but we set the flag generically so UI can show "you went past 14h"
  // even on unscheduled assignments.
  const elapsed = dutyOffAt - cur.dutyOnAt;
  const over14 = elapsed > 14 * 3600 * 1000;

  const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];
  const patch = {
    dutyOffAt,
    flightTimeMs,
    excursionReason: opts.excursionReason || null,
    status: 'off',
    over14,
    updatedAt: Date.now(),
    adminEdits: [...edits, {
      by: opts.endedBy || cur.pilotName || 'pilot',
      at: Date.now(),
      field: 'endDuty',
      from: { status: 'on', dutyOffAt: null },
      to: { status: 'off', dutyOffAt },
      note: opts.excursionReason || null,
    }],
  };
  await updateDoc(ref, patch);
  return { id: periodId, ...cur, ...patch };
}

/**
 * Edit a single field on a duty period. Logs the edit to adminEdits[].
 *
 * Allowed fields:
 *   dutyOnAt, dutyOffAt, flightTimeMs, location, tail, tripId, role,
 *   crewType, assignmentType, excursionReason, priorRestMs
 *
 * Fields the pilot CANNOT self-edit (admin only):
 *   overrideApprovedBy, overrideApprovedAt, overrideApprovalNotes,
 *   overrideStatus when transitioning to 'approved'
 */
const ALLOWED_EDIT_FIELDS = new Set([
  'dutyOnAt', 'dutyOffAt', 'flightTimeMs',
  'location', 'tail', 'tripId', 'role',
  'crewType', 'assignmentType', 'excursionReason', 'priorRestMs',
  'fitForDuty',  // can be re-attested if pilot realized it was wrong
]);

export async function editPeriod(periodId, field, value, opts = {}) {
  if (!periodId) throw new Error('periodId required');
  if (!ALLOWED_EDIT_FIELDS.has(field)) {
    throw new Error(`field "${field}" cannot be edited via editPeriod`);
  }
  const ref = doc(db, COLL, periodId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();

  // Sanity checks for time fields
  if (field === 'dutyOnAt') {
    if (!Number.isFinite(value)) throw new Error('dutyOnAt must be a number');
    if (cur.dutyOffAt && value >= cur.dutyOffAt) {
      throw new Error('dutyOnAt must be before dutyOffAt');
    }
  }
  if (field === 'dutyOffAt') {
    if (!Number.isFinite(value)) throw new Error('dutyOffAt must be a number');
    if (cur.dutyOnAt && value <= cur.dutyOnAt) {
      throw new Error('dutyOffAt must be after dutyOnAt');
    }
  }
  if (field === 'flightTimeMs' && (!Number.isFinite(value) || value < 0)) {
    throw new Error('flightTimeMs must be a non-negative number');
  }

  const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];
  const patch = {
    [field]: value,
    updatedAt: Date.now(),
    adminEdits: [...edits, {
      by: opts.editedBy || cur.pilotName || 'unknown',
      at: Date.now(),
      field,
      from: cur[field] ?? null,
      to: value,
      note: opts.note || null,
    }],
  };
  // Recompute over14 if time fields changed
  if ((field === 'dutyOnAt' || field === 'dutyOffAt') && cur.dutyOnAt && (patch.dutyOffAt ?? cur.dutyOffAt)) {
    const newOnAt = field === 'dutyOnAt' ? value : cur.dutyOnAt;
    const newOffAt = field === 'dutyOffAt' ? value : cur.dutyOffAt;
    patch.over14 = (newOffAt - newOnAt) > 14 * 3600 * 1000;
  }
  await updateDoc(ref, patch);
  return { id: periodId, ...cur, ...patch };
}

/**
 * Update flight time on an ACTIVE duty period without ending it.
 * Used as the duty progresses (e.g. a leg lands, we add its block time).
 */
export async function addFlightTimeToActive(pilotUid, addMs, opts = {}) {
  if (!pilotUid || !Number.isFinite(addMs) || addMs <= 0) return null;
  const q = query(
    collection(db, COLL),
    where('pilotUid', '==', pilotUid),
    where('status', '==', 'on')
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  const cur = docSnap.data();
  const newTotal = (cur.flightTimeMs || 0) + addMs;
  await updateDoc(docSnap.ref, {
    flightTimeMs: newTotal,
    updatedAt: Date.now(),
  });
  return { id: docSnap.id, ...cur, flightTimeMs: newTotal };
}

// -----------------------------------------------------------------
// Override workflow — Chief Pilot / DO can approve a dispatch into
// what would otherwise be an illegal assignment.
// -----------------------------------------------------------------

/**
 * Pilot or dispatcher requests an override for an illegal assignment.
 * The request includes a reason. No effect on legality until approved.
 *
 * In practice this is usually called by DISPATCH on a proposed assignment
 * — but since proposed assignments aren't persisted until duty starts,
 * we attach the request to whatever period the dispatcher creates when
 * starting duty. If dispatch is using the legality check pre-creation,
 * they need to call startDuty FIRST with assignmentType:'unscheduled',
 * then call requestOverride on the new period.
 *
 * Returns the updated period.
 */
export async function requestOverride(periodId, opts = {}) {
  if (!periodId) throw new Error('periodId required');
  if (!opts.requestedBy) throw new Error('requestedBy required');
  if (!opts.reason || !opts.reason.trim()) throw new Error('reason required');
  const ref = doc(db, COLL, periodId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();
  const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];
  const patch = {
    overrideStatus: 'requested',
    overrideRequestedBy: opts.requestedBy,
    overrideRequestedAt: Date.now(),
    overrideRequestReason: opts.reason.trim().slice(0, 2000),
    updatedAt: Date.now(),
    adminEdits: [...edits, {
      by: opts.requestedBy,
      at: Date.now(),
      field: 'requestOverride',
      from: cur.overrideStatus || 'none',
      to: 'requested',
      note: opts.reason.trim().slice(0, 500),
    }],
  };
  await updateDoc(ref, patch);
  return { id: periodId, ...cur, ...patch };
}

/**
 * Chief Pilot / Director of Operations approves an override.
 * The approver UID and notes are recorded. Approval is permanent —
 * to revoke, edit with explanation.
 */
export async function approveOverride(periodId, opts = {}) {
  if (!periodId) throw new Error('periodId required');
  if (!opts.approverUid || !opts.approverName) {
    throw new Error('approverUid and approverName required');
  }
  const ref = doc(db, COLL, periodId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();
  if (cur.overrideStatus !== 'requested') {
    throw new Error('override is not in "requested" state');
  }
  const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];
  const patch = {
    overrideStatus: 'approved',
    overrideApprovedBy: `${opts.approverName} (${opts.approverUid})`,
    overrideApprovedAt: Date.now(),
    overrideApprovalNotes: opts.notes ? String(opts.notes).slice(0, 2000) : '',
    updatedAt: Date.now(),
    adminEdits: [...edits, {
      by: opts.approverName,
      at: Date.now(),
      field: 'approveOverride',
      from: 'requested',
      to: 'approved',
      note: opts.notes || null,
    }],
  };
  await updateDoc(ref, patch);
  return { id: periodId, ...cur, ...patch };
}

// -----------------------------------------------------------------
// Writes — outside flying
// -----------------------------------------------------------------

export async function addOutsideFlying(opts) {
  if (!opts?.pilotUid) throw new Error('pilotUid required');
  if (!Number.isFinite(opts.startAt) || !Number.isFinite(opts.endAt)) {
    throw new Error('startAt and endAt required (ms)');
  }
  if (opts.endAt <= opts.startAt) throw new Error('endAt must be after startAt');
  if (!Number.isFinite(opts.flightTimeMs) || opts.flightTimeMs <= 0) {
    throw new Error('flightTimeMs must be positive');
  }
  const now = Date.now();
  const r = await addDoc(collection(db, OUTSIDE_COLL), {
    pilotUid: opts.pilotUid,
    pilotName: opts.pilotName || 'Unknown',
    startAt: opts.startAt,
    endAt: opts.endAt,
    flightTimeMs: opts.flightTimeMs,
    source: opts.source || 'unspecified',
    notes: opts.notes || '',
    createdAt: now,
    updatedAt: now,
  });
  return r.id;
}

export async function editOutsideFlying(id, patch) {
  if (!id) throw new Error('id required');
  await updateDoc(doc(db, OUTSIDE_COLL, id), {
    ...patch,
    updatedAt: Date.now(),
  });
}

// =====================================================================
// DISPATCH GATE — programmatic legality check for trip release
// =====================================================================
//
// Synchronous-ish hard-gate function the trip release flow can call right
// before committing a dispatch. Returns an object with `legal` (boolean),
// `status`, and `blockers` for each pilot. If `requireBothLegal: true`
// (the default), `legal` is false when EITHER pilot is illegal or when
// the SIC field is provided but PIC is missing (or vice versa).
//
// Usage:
//   const check = await assertPairLegalForDispatch({
//     pic: { pilotUid, pilotName },
//     sic: { pilotUid, pilotName } | null,
//     proposed: { dutyOnAt, dutyOffAt, flightTimeMs, crewType, assignmentType }
//   });
//   if (!check.legal) {
//     // Show override capture UI
//     console.warn('Dispatch blocked:', check.blockers);
//   }
//
// One-shot getDocs (no subscription) — meant for the moment of release,
// not live. Caller is responsible for re-checking if pilot pool changes.

export async function assertPairLegalForDispatch({ pic, sic, proposed, requireBothLegal = true }) {
  if (!proposed) throw new Error('proposed assignment required');
  // Lazy-import the legality engine — it's a pure module so this is cheap.
  const { evaluateProposed } = await import('./duty-legality.js');

  const checkOne = async (pilot, role) => {
    if (!pilot?.pilotUid) return null;
    // Fetch this pilot's recent periods (60 days back is plenty for
    // quarterly 24h checks against the limiting 90-day window). Outside
    // flying same window.
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    const periodsSnap = await getDocs(query(
      collection(db, COLL),
      where('pilotUid', '==', pilot.pilotUid),
      where('dutyOnAt', '>=', cutoff),
    ));
    const periods = [];
    periodsSnap.forEach(d => periods.push({ id: d.id, ...d.data() }));

    const outsideSnap = await getDocs(query(
      collection(db, OUTSIDE_COLL),
      where('pilotUid', '==', pilot.pilotUid),
      where('startAt', '>=', cutoff),
    ));
    const outside = [];
    outsideSnap.forEach(d => outside.push({ id: d.id, ...d.data() }));

    const result = evaluateProposed(periods, outside, proposed, Date.now());
    return { role, pilot, result };
  };

  const picCheck = await checkOne(pic, 'PIC');
  const sicCheck = sic ? await checkOne(sic, 'SIC') : null;

  // Aggregate. Worst status wins.
  const statuses = [picCheck?.result?.status, sicCheck?.result?.status].filter(Boolean);
  let aggregateStatus = 'legal';
  if (statuses.includes('illegal')) aggregateStatus = 'illegal';
  else if (statuses.includes('warning')) aggregateStatus = 'warning';

  const blockers = [];
  if (picCheck?.result?.blockers?.length) {
    blockers.push(...picCheck.result.blockers.map(b => ({ ...b, who: 'PIC', pilot: pic?.pilotName })));
  }
  if (sicCheck?.result?.blockers?.length) {
    blockers.push(...sicCheck.result.blockers.map(b => ({ ...b, who: 'SIC', pilot: sic?.pilotName })));
  }

  const legal = requireBothLegal
    ? aggregateStatus !== 'illegal'
    : true;

  return {
    legal,
    status: aggregateStatus,
    blockers,
    picResult: picCheck?.result || null,
    sicResult: sicCheck?.result || null,
  };
}

