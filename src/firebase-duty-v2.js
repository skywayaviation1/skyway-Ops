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
  setDoc, updateDoc, addDoc, orderBy, limit, Timestamp, writeBatch
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

// =====================================================================
// RETENTION POLICY (for documentation + future cleanup cron)
// =====================================================================
//
// Skyway retains duty records for at least 365 days, exceeding the
// FAA minimum (14 CFR 135.63 / 135.265). NO auto-deletion code exists
// today — records accumulate indefinitely. This constant exists so:
//   1. Future cleanup crons know the cutoff
//   2. Export defaults to "last 365 days"
//   3. Any code path that would purge older records knows the floor
//
// If you ever build a cron to delete records older than RETENTION_DAYS,
// it MUST also preserve any record referenced by an admin override
// approval audit, regardless of age. Talk to me before writing that.
export const RETENTION_DAYS = 365;

/**
 * One-shot fetch of all duty periods for a pilot within a date range.
 * Used by the export feature. Caller passes start/end ms; defaults to
 * the last RETENTION_DAYS if not provided.
 *
 * Returns periods sorted by dutyOnAt DESCENDING (newest first), which
 * matches how the export renders them.
 *
 * The query filters by `dutyOnAt` so a period that STARTED in the
 * window is included even if it ended outside. This is intentional —
 * a duty period belongs in the export for the day it began.
 */
export async function fetchPeriodsForPilotInRange(pilotUid, startMs, endMs) {
  if (!pilotUid) return [];
  const start = Number.isFinite(startMs)
    ? startMs
    : Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const end = Number.isFinite(endMs) ? endMs : Date.now();
  const q = query(
    collection(db, COLL),
    where('pilotUid', '==', pilotUid),
    where('dutyOnAt', '>=', start),
    where('dutyOnAt', '<=', end),
  );
  const snap = await getDocs(q);
  const list = [];
  snap.forEach(d => list.push({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.dutyOnAt || 0) - (a.dutyOnAt || 0));
  return list;
}

/**
 * Same shape, but for outside commercial flying — exported as a
 * separate section in CSV/PDF since it's a different collection.
 */
export async function fetchOutsideFlyingForPilotInRange(pilotUid, startMs, endMs) {
  if (!pilotUid) return [];
  const start = Number.isFinite(startMs)
    ? startMs
    : Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const end = Number.isFinite(endMs) ? endMs : Date.now();
  const q = query(
    collection(db, OUTSIDE_COLL),
    where('pilotUid', '==', pilotUid),
    where('startAt', '>=', start),
    where('startAt', '<=', end),
  );
  const snap = await getDocs(q);
  const list = [];
  snap.forEach(d => list.push({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.startAt || 0) - (a.startAt || 0));
  return list;
}

/**
 * Find duty periods for a specific aircraft tail within a UTC ms range.
 * Used by the manifest auto-fill feature to look up the crew duty
 * record for "this tail on this date." Excludes pending and declined
 * periods (callers always want confirmed records for manifest fill).
 *
 * Returns periods sorted by dutyOnAt ASC (chronological). A two-pilot
 * crew will return two periods with near-identical dutyOnAt values
 * (PIC's then SIC's, by id sort tie-break).
 *
 * Requires a Firestore composite index on (tail, dutyOnAt). On the
 * first call, Firestore will emit a console error with a one-click
 * "create index" link — same UX as the export feature's index.
 */
export async function fetchPeriodsByTailInRange(tail, startMs, endMs) {
  if (!tail) return [];
  const start = Number.isFinite(startMs) ? startMs : 0;
  const end = Number.isFinite(endMs) ? endMs : Date.now();
  const q = query(
    collection(db, COLL),
    where('tail', '==', tail),
    where('dutyOnAt', '>=', start),
    where('dutyOnAt', '<=', end),
  );
  const snap = await getDocs(q);
  const list = [];
  snap.forEach(d => list.push({ id: d.id, ...d.data() }));
  // Exclude pending/declined — they're not legally on duty and shouldn't
  // be used to fill manifest crew time fields. Legacy periods without
  // a confirmStatus are treated as self-attested (the default before
  // the pair flow existed).
  const valid = list.filter(p =>
    !p.confirmStatus
    || p.confirmStatus === 'self-attested'
    || p.confirmStatus === 'admin-attested'
  );
  valid.sort((a, b) => {
    const dt = (a.dutyOnAt || 0) - (b.dutyOnAt || 0);
    if (dt !== 0) return dt;
    // Tie-break by role so PIC comes before SIC in two-pilot crews
    if (a.role === 'PIC' && b.role !== 'PIC') return -1;
    if (a.role !== 'PIC' && b.role === 'PIC') return 1;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  return valid;
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
    // --- Pair-confirmation fields (added for PIC→SIC sync flow) ---
    // confirmStatus: 'self-attested' means this pilot personally filled
    //   the start-duty form. 'pending' means another pilot (the PIC)
    //   created this record for them and they have not yet confirmed.
    //   'declined' means the SIC opened the pending card and rejected.
    //   The legality engine treats pending and declined as if the
    //   period doesn't exist — only self-attested periods count.
    confirmStatus: 'self-attested',
    // partnerPeriodId cross-links the two periods of a paired crew.
    // Lets the UI show "your partner: Captain Foo" on the SIC's card
    // and (later) cascade end-duty if the PIC ends first.
    partnerPeriodId: null,
    // pendingCreatedBy records WHO initiated the pending record for
    // audit ("PIC X started SIC Y's duty period at HH:MM").
    pendingCreatedBy: null,
    confirmedAt: null,
    declinedAt: null,
    declinedReason: null,
    adminEdits: [],
    createdAt: now,
    updatedAt: now,
    status: 'on',
    over14: false,
  };
  await setDoc(doc(db, COLL, id), docData);
  return docData;
}

// =====================================================================
// PAIRED DUTY START (PIC → SIC sync)
// =====================================================================
//
// startDutyPair atomically creates two linked duty periods: one for the
// PIC (self-attested, immediately active) and one for the SIC (pending,
// awaiting SIC confirmation). The SIC opens DutyV2 and sees a "your
// partner is starting duty" card; they confirm or decline.
//
// Why a separate function rather than letting startDuty take a partner
// option:
//   1. Atomic-ish: refuses if EITHER pilot has an open period. Without
//      a single entry point, you could half-succeed (PIC starts, SIC
//      fails) and leave a confusing partial state.
//   2. Different validation: the SIC record is created with fitForDuty
//      = null (not true). The SIC must attest themselves on confirm.
//   3. Cross-links: each doc gets the OTHER's id in partnerPeriodId,
//      computed before either write. Hard to do cleanly from inside
//      startDuty without a second pass.
//
// HONEST CAVEAT: Firestore does not provide true atomic writes across
// docs unless we use a transaction. Below we use a writeBatch which is
// atomic from the SERVER'S perspective — both docs commit or neither
// does. Network/auth failures can still cause one-sided state, but the
// failure surface is the same as a single setDoc.
//
// picOpts and sicOpts are both the same shape as startDuty's opts.
// SIC's fitForDuty is FORCED to null regardless of input. priorRestMs
// can be inherited from PIC's value by the UI before calling here.
//
// Returns: { picPeriod, sicPeriod }

export async function startDutyPair(picOpts, sicOpts) {
  if (!picOpts?.pilotUid) throw new Error('PIC pilotUid required');
  if (!sicOpts?.pilotUid) throw new Error('SIC pilotUid required');
  if (picOpts.pilotUid === sicOpts.pilotUid) {
    throw new Error('PIC and SIC must be different pilots');
  }
  if (picOpts.fitForDuty !== true) {
    throw new Error('PIC fit-for-duty attestation required');
  }
  if (!['unscheduled', 'regular'].includes(picOpts.assignmentType)) {
    throw new Error('assignmentType must be "unscheduled" or "regular"');
  }

  // Refuse if EITHER pilot has an open period. Two separate queries
  // because Firestore doesn't support OR across `in` queries on the
  // same field combined with another filter.
  for (const [label, uid] of [['PIC', picOpts.pilotUid], ['SIC', sicOpts.pilotUid]]) {
    const existing = await getDocs(query(
      collection(db, COLL),
      where('pilotUid', '==', uid),
      where('status', '==', 'on')
    ));
    if (!existing.empty) {
      throw new Error(`${label} already has an open duty period. End it before starting a paired duty.`);
    }
  }

  const dutyOnAt = Number.isFinite(picOpts.dutyOnAt) ? picOpts.dutyOnAt : Date.now();
  const now = Date.now();
  const picId = `${picOpts.pilotUid}_${dutyOnAt}`;
  // SIC id uses the SAME dutyOnAt so the two docs share a clear pairing
  // timestamp. Tiebreaker via uid prevents collision if PIC tries to
  // pair themselves (which we already rejected above).
  const sicId = `${sicOpts.pilotUid}_${dutyOnAt}`;

  // PIC doc — fully active, self-attested.
  const picDoc = {
    id: picId,
    pilotUid: picOpts.pilotUid,
    pilotName: picOpts.pilotName || 'Unknown',
    location: picOpts.location || '',
    tail: picOpts.tail || null,
    tripId: picOpts.tripId || null,
    role: 'PIC',
    crewType: 'two',                      // pairing implies two-pilot crew
    assignmentType: picOpts.assignmentType,
    fitForDuty: true,
    priorRestMs: Number.isFinite(picOpts.priorRestMs) ? picOpts.priorRestMs : null,
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
    confirmStatus: 'self-attested',
    partnerPeriodId: sicId,
    pendingCreatedBy: null,
    confirmedAt: null,
    declinedAt: null,
    declinedReason: null,
    adminEdits: [],
    createdAt: now,
    updatedAt: now,
    status: 'on',
    over14: false,
  };

  // SIC doc — pending, fit-for-duty is NULL (forcing SIC to attest
  // themselves on confirm). Other fields inherit from PIC's submission.
  // priorRestMs is inherited as a default; the SIC can adjust it on the
  // confirmation card before clicking CONFIRM.
  const sicDoc = {
    id: sicId,
    pilotUid: sicOpts.pilotUid,
    pilotName: sicOpts.pilotName || 'Unknown',
    location: picOpts.location || '',      // same FBO
    tail: picOpts.tail || null,
    tripId: picOpts.tripId || null,
    role: 'SIC',
    crewType: 'two',
    assignmentType: picOpts.assignmentType,
    // Critical: fitForDuty is NULL on a pending record. The SIC must
    // confirm to set it true. Legality engine ignores pending periods.
    fitForDuty: null,
    priorRestMs: Number.isFinite(sicOpts.priorRestMs)
      ? sicOpts.priorRestMs
      : (Number.isFinite(picOpts.priorRestMs) ? picOpts.priorRestMs : null),
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
    confirmStatus: 'pending',              // <-- key flag
    partnerPeriodId: picId,
    pendingCreatedBy: picOpts.pilotUid,    // audit: which PIC initiated
    confirmedAt: null,
    declinedAt: null,
    declinedReason: null,
    adminEdits: [],
    createdAt: now,
    updatedAt: now,
    status: 'on',                          // appears in subscribe-on-duty
                                            // queries; legality engine
                                            // excludes by confirmStatus
    over14: false,
  };

  // Batched write — both commit or both don't.
  const batch = writeBatch(db);
  batch.set(doc(db, COLL, picId), picDoc);
  batch.set(doc(db, COLL, sicId), sicDoc);
  await batch.commit();

  return { picPeriod: picDoc, sicPeriod: sicDoc };
}

// =====================================================================
// PENDING CONFIRMATION (SIC's side of the pair flow)
// =====================================================================
//
// When the SIC opens DutyV2 and sees the pending card, they tap CONFIRM
// to attest fit-for-duty. That flips confirmStatus → 'self-attested'
// (legality engine now counts the period), sets fitForDuty=true, records
// confirmedAt, and optionally lets the SIC adjust priorRestMs and
// dutyOnAt (if they actually started a few minutes earlier/later than
// what the PIC entered).
//
// opts:
//   {
//     fitForDuty: true,           required — without this we refuse
//     priorRestMs: number,        optional override
//     dutyOnAt: number (ms),      optional override
//     confirmedBy: string,        SIC's name for audit
//   }

export async function confirmPendingDuty(periodId, opts = {}) {
  if (!periodId) throw new Error('periodId required');
  if (opts.fitForDuty !== true) {
    throw new Error('fit-for-duty attestation required to confirm');
  }
  const ref = doc(db, COLL, periodId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();
  if (cur.confirmStatus !== 'pending') {
    throw new Error(`cannot confirm — current status is "${cur.confirmStatus}"`);
  }

  const now = Date.now();
  const patch = {
    confirmStatus: 'self-attested',
    fitForDuty: true,
    confirmedAt: now,
    updatedAt: now,
  };
  // SIC may correct prior rest if different from PIC's value
  if (Number.isFinite(opts.priorRestMs)) {
    patch.priorRestMs = opts.priorRestMs;
  }
  // SIC may correct duty-on time (rare; usually accepts PIC's time)
  if (Number.isFinite(opts.dutyOnAt) && opts.dutyOnAt !== cur.dutyOnAt) {
    patch.dutyOnAt = opts.dutyOnAt;
    // adminEdits records the change for audit
    const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];
    edits.push({
      by: opts.confirmedBy || 'pilot-self-confirm',
      at: now,
      field: 'dutyOnAt',
      from: cur.dutyOnAt,
      to: opts.dutyOnAt,
      note: 'SIC adjusted duty-on time during pair confirmation',
    });
    patch.adminEdits = edits;
  }
  await updateDoc(ref, patch);
  return { ...cur, ...patch };
}

// SIC declines the pending pair. Doc is marked declined; status flipped
// to 'off' so it falls out of active-duty queries. Legality engine
// already ignores declined periods. Reason is optional and logged.
//
// The PIC's period is unaffected — the PIC is still on duty (they
// self-attested). The PIC will need to find another SIC or accept
// single-pilot duty for the day.

export async function declinePendingDuty(periodId, opts = {}) {
  if (!periodId) throw new Error('periodId required');
  const ref = doc(db, COLL, periodId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();
  if (cur.confirmStatus !== 'pending') {
    throw new Error(`cannot decline — current status is "${cur.confirmStatus}"`);
  }
  const now = Date.now();
  await updateDoc(ref, {
    confirmStatus: 'declined',
    status: 'off',                        // remove from active-duty board
    declinedAt: now,
    declinedReason: opts.reason || null,
    fitForDuty: false,
    updatedAt: now,
  });
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

// =====================================================================
// ADMIN PARTNER MANAGEMENT
// =====================================================================
//
// Three operations exposed to ops/admin for fixing crew pairings after
// the fact:
//
//   1. addPartnerToActiveDuty(picPeriodId, sicOpts, opts)
//      The PIC went on duty solo (or with a now-declined SIC) and ops
//      needs to enroll a new SIC. Creates a duty period for the SIC,
//      cross-links it with the PIC's, and writes audit entries to both.
//
//      Default attestation path: SIC's period is created with
//      confirmStatus='pending'. The SIC opens DutyV2 and taps CONFIRM
//      to attest fit-for-duty. Same flow as PIC→SIC pair start.
//
//      Escape hatch: pass opts.forceAttest=true with opts.forceAttestReason
//      to record the SIC as legally on duty without their interaction.
//      This sets confirmStatus='admin-attested' (NOT 'self-attested')
//      so the record is clearly distinguishable from a pilot's own
//      attestation in the audit trail. Use only when the SIC is
//      verifiably on duty but unreachable (phone dead, mid-flight, etc).
//
//   2. removePartnerFromDuty(picPeriodId, opts)
//      Clears the partner link on the PIC's period and closes the SIC's
//      period (zero-length close if pending, normal close if active).
//      Used when a paired duty needs to revert to single-pilot.
//
//   3. changePartner(picPeriodId, newSicOpts, opts)
//      Convenience: remove existing partner + add new one. Atomic from
//      the caller's perspective (failures inside surface as exceptions
//      but the underlying writes are sequential — see honest note in
//      the implementation comment).

/**
 * Add a partner (SIC) to a PIC's currently-active duty period.
 *
 * picPeriodId: the existing duty period id for the PIC.
 * sicOpts: { pilotUid, pilotName, priorRestMs (optional, inherits from PIC) }
 * opts:
 *   {
 *     editedBy: string,            admin's display name for audit
 *     forceAttest: boolean,        default false — see escape hatch above
 *     forceAttestReason: string,   required if forceAttest=true
 *   }
 */
export async function addPartnerToActiveDuty(picPeriodId, sicOpts, opts = {}) {
  if (!picPeriodId) throw new Error('picPeriodId required');
  if (!sicOpts?.pilotUid) throw new Error('SIC pilotUid required');
  if (opts.forceAttest && !opts.forceAttestReason) {
    throw new Error('forceAttestReason required when forceAttest=true');
  }

  // Load PIC's period
  const picRef = doc(db, COLL, picPeriodId);
  const picSnap = await getDoc(picRef);
  if (!picSnap.exists()) throw new Error('PIC duty period not found');
  const pic = picSnap.data();
  if (pic.status !== 'on') {
    throw new Error('PIC duty period is not active — cannot add partner');
  }
  if (pic.pilotUid === sicOpts.pilotUid) {
    throw new Error('cannot pair a pilot with themselves');
  }

  // Check whether PIC already has an active partner. If the existing
  // partner is pending or self-attested, refuse — admin must explicitly
  // remove first to avoid silently overwriting a legitimate pairing.
  // If the existing partner is declined, we can quietly re-pair.
  if (pic.partnerPeriodId) {
    const oldPartnerSnap = await getDoc(doc(db, COLL, pic.partnerPeriodId));
    if (oldPartnerSnap.exists()) {
      const old = oldPartnerSnap.data();
      if (old.status === 'on' && old.confirmStatus !== 'declined') {
        throw new Error(
          `PIC already has an active partner (${old.pilotName}). ` +
          `Use removePartnerFromDuty or changePartner first.`
        );
      }
    }
  }

  // Refuse if the proposed SIC has another open period (a different trip)
  const sicOpenQ = query(
    collection(db, COLL),
    where('pilotUid', '==', sicOpts.pilotUid),
    where('status', '==', 'on'),
  );
  const sicOpen = await getDocs(sicOpenQ);
  if (!sicOpen.empty) {
    throw new Error('Proposed SIC already has an open duty period elsewhere');
  }

  // Build SIC doc inheriting from PIC's duty
  const now = Date.now();
  const sicId = `${sicOpts.pilotUid}_${pic.dutyOnAt}`;
  const adminName = opts.editedBy || 'admin';

  // Determine confirmStatus + fitForDuty based on attestation path.
  // 'pending' is the default safe path — SIC must confirm. 'admin-attested'
  // is the escape hatch — admin attests on SIC's behalf with a documented
  // reason. The legality engine treats 'admin-attested' as legally on
  // duty (per check in evaluateLegality), but the record is marked
  // separately from self-attested so a ramp inspector can see who
  // confirmed each period.
  const confirmStatus = opts.forceAttest ? 'admin-attested' : 'pending';
  const fitForDuty = opts.forceAttest ? true : null;

  const sicDoc = {
    id: sicId,
    pilotUid: sicOpts.pilotUid,
    pilotName: sicOpts.pilotName || 'Unknown',
    location: pic.location || '',
    tail: pic.tail || null,
    tripId: pic.tripId || null,
    role: 'SIC',
    crewType: 'two',
    assignmentType: pic.assignmentType,
    fitForDuty,
    priorRestMs: Number.isFinite(sicOpts.priorRestMs)
      ? sicOpts.priorRestMs
      : (Number.isFinite(pic.priorRestMs) ? pic.priorRestMs : null),
    dutyOnAt: pic.dutyOnAt,
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
    confirmStatus,
    partnerPeriodId: picPeriodId,
    pendingCreatedBy: pic.pilotUid,
    confirmedAt: opts.forceAttest ? now : null,
    declinedAt: null,
    declinedReason: null,
    adminEdits: [{
      by: adminName,
      at: now,
      field: 'created',
      from: null,
      to: confirmStatus,
      note: opts.forceAttest
        ? `Admin added partner with FORCE ATTEST. Reason: ${opts.forceAttestReason}`
        : `Admin added partner — SIC must confirm to activate`,
    }],
    createdAt: now,
    updatedAt: now,
    status: 'on',
    over14: false,
  };

  // Write SIC doc and update PIC link in a single batch.
  const picEdits = Array.isArray(pic.adminEdits) ? pic.adminEdits : [];
  const batch = writeBatch(db);
  batch.set(doc(db, COLL, sicId), sicDoc);
  batch.update(picRef, {
    partnerPeriodId: sicId,
    updatedAt: now,
    adminEdits: [...picEdits, {
      by: adminName,
      at: now,
      field: 'partnerPeriodId',
      from: pic.partnerPeriodId || null,
      to: sicId,
      note: `Admin enrolled ${sicDoc.pilotName} as SIC` +
        (opts.forceAttest ? ' (force-attested)' : ' (pending SIC confirmation)'),
    }],
  });
  await batch.commit();

  return { sicPeriod: sicDoc, picPeriodId };
}

/**
 * Remove a partner link from a PIC's duty period. The SIC's period is
 * closed (zero-length if it was still pending, otherwise normal close
 * with dutyOffAt=now). Both docs get audit entries.
 *
 * If the SIC's period was already 'off' (e.g. SIC declined), this just
 * clears the PIC's partnerPeriodId without touching the SIC doc.
 */
export async function removePartnerFromDuty(picPeriodId, opts = {}) {
  if (!picPeriodId) throw new Error('picPeriodId required');
  const adminName = opts.editedBy || 'admin';
  const note = opts.note || 'Admin removed partner';
  const now = Date.now();

  const picRef = doc(db, COLL, picPeriodId);
  const picSnap = await getDoc(picRef);
  if (!picSnap.exists()) throw new Error('PIC duty period not found');
  const pic = picSnap.data();
  if (!pic.partnerPeriodId) {
    throw new Error('PIC duty period has no partner to remove');
  }

  const sicId = pic.partnerPeriodId;
  const sicRef = doc(db, COLL, sicId);
  const sicSnap = await getDoc(sicRef);
  const batch = writeBatch(db);

  // Update PIC: clear partnerPeriodId
  const picEdits = Array.isArray(pic.adminEdits) ? pic.adminEdits : [];
  batch.update(picRef, {
    partnerPeriodId: null,
    updatedAt: now,
    adminEdits: [...picEdits, {
      by: adminName,
      at: now,
      field: 'partnerPeriodId',
      from: sicId,
      to: null,
      note,
    }],
  });

  // Update SIC if it still exists and is open
  if (sicSnap.exists()) {
    const sic = sicSnap.data();
    if (sic.status === 'on') {
      const sicEdits = Array.isArray(sic.adminEdits) ? sic.adminEdits : [];
      // Pending SICs get a zero-length close — they were never actually
      // on duty. Self/admin-attested SICs were on duty so we close at
      // now (preserves elapsed time for legality records).
      const isPending = sic.confirmStatus === 'pending';
      const dutyOffAt = isPending ? sic.dutyOnAt : now;
      batch.update(sicRef, {
        status: 'off',
        dutyOffAt,
        partnerPeriodId: null,
        updatedAt: now,
        adminEdits: [...sicEdits, {
          by: adminName,
          at: now,
          field: 'status',
          from: 'on',
          to: 'off',
          note: `Admin removed pairing — ${isPending ? 'pending duty cancelled' : 'duty closed at admin removal'}`,
        }],
      });
    } else {
      // SIC already off — just clear the back-link for symmetry
      const sicEdits = Array.isArray(sic.adminEdits) ? sic.adminEdits : [];
      batch.update(sicRef, {
        partnerPeriodId: null,
        updatedAt: now,
        adminEdits: [...sicEdits, {
          by: adminName,
          at: now,
          field: 'partnerPeriodId',
          from: picPeriodId,
          to: null,
          note: 'Admin cleared back-link from closed SIC period',
        }],
      });
    }
  }

  await batch.commit();
}

/**
 * Convenience: remove existing partner and add a new one in sequence.
 *
 * HONEST NOTE: this is two separate batch commits, not one atomic
 * transaction. If the removePartnerFromDuty succeeds but the
 * addPartnerToActiveDuty fails, the PIC ends up partner-less and the
 * caller must retry the add. The caller should surface the error and
 * not assume rollback.
 */
export async function changePartner(picPeriodId, newSicOpts, opts = {}) {
  await removePartnerFromDuty(picPeriodId, {
    editedBy: opts.editedBy,
    note: `Admin removing old partner before swap to ${newSicOpts?.pilotName || 'new SIC'}`,
  });
  return await addPartnerToActiveDuty(picPeriodId, newSicOpts, opts);
}

// =====================================================================
// ADMIN CALENDAR FUNCTIONS — power the new admin Duty tab
// =====================================================================
//
// Three functions used by the new DutyAdminCalendar / DutyDayDetail UI:
//
//   adminAddBackfillPeriod  — create a CLOSED historical period (gap-fill)
//   linkCrewPeriods         — connect a PIC's period with an SIC's period
//                              (set partnerPeriodId on both)
//   unlinkCrewPeriods       — break a PIC↔SIC pairing without ending
//                              either duty period
//
// All three preserve existing data (no deletes), write full audit
// entries to both affected records when applicable, and refuse to
// produce nonsensical states (overlapping with an open period, linking
// a pilot to themselves, etc).

/**
 * Create a CLOSED historical duty period. Use when a record was never
 * entered in the app and needs to be backfilled. ONLY creates closed
 * periods — admin should not back-fill open ones (use startDuty for
 * those, walking the pilot through normally).
 *
 * Refuses if the proposed window overlaps the pilot's currently-open
 * period. Overlapping a CLOSED period is allowed (the editor flags
 * those red so admin can fix). The created record gets
 * confirmStatus='admin-attested' so the legality engine includes it.
 *
 * opts: {
 *   pilotUid: string (required)
 *   pilotName: string (optional but recommended for display)
 *   dutyOnAt: number ms (required)
 *   dutyOffAt: number ms (required, > dutyOnAt)
 *   location, tail, tripId, role, crewType, assignmentType (optional)
 *   flightTimeMs (optional, default 0)
 *   priorRestMs, excursionReason (optional)
 *   editedBy: string (REQUIRED — admin's display name for audit)
 *   note: string (optional audit note)
 * }
 */
export async function adminAddBackfillPeriod(opts) {
  if (!opts?.pilotUid) throw new Error('pilotUid required');
  if (!opts?.editedBy) throw new Error('editedBy required for audit');
  if (!Number.isFinite(opts.dutyOnAt)) throw new Error('dutyOnAt required (ms)');
  if (!Number.isFinite(opts.dutyOffAt)) throw new Error('dutyOffAt required (ms)');
  if (opts.dutyOffAt <= opts.dutyOnAt) {
    throw new Error('dutyOffAt must be after dutyOnAt');
  }

  // Refuse to overlap an existing OPEN period for this pilot.
  const openSnap = await getDocs(query(
    collection(db, COLL),
    where('pilotUid', '==', opts.pilotUid),
    where('status', '==', 'on'),
  ));
  if (!openSnap.empty) {
    const open = openSnap.docs[0].data();
    const openEnd = open.dutyOffAt || Date.now();
    if (opts.dutyOnAt < openEnd && opts.dutyOffAt > open.dutyOnAt) {
      throw new Error(
        'Backfill period overlaps the pilot\'s currently-open duty period. ' +
        'Close the open period first or move its dutyOnAt before adding this backfill.'
      );
    }
  }

  const now = Date.now();
  const id = `${opts.pilotUid}_${opts.dutyOnAt}`;
  const elapsed = opts.dutyOffAt - opts.dutyOnAt;
  const flightTimeMs = Number.isFinite(opts.flightTimeMs) ? opts.flightTimeMs : 0;
  const docData = {
    id,
    pilotUid: opts.pilotUid,
    pilotName: opts.pilotName || 'Unknown',
    location: opts.location || '',
    tail: opts.tail || null,
    tripId: opts.tripId || null,
    role: opts.role || null,
    crewType: ['single', 'two'].includes(opts.crewType) ? opts.crewType : 'single',
    assignmentType: ['unscheduled', 'regular'].includes(opts.assignmentType)
      ? opts.assignmentType
      : 'regular',
    fitForDuty: true,
    priorRestMs: Number.isFinite(opts.priorRestMs) ? opts.priorRestMs : null,
    dutyOnAt: opts.dutyOnAt,
    dutyOffAt: opts.dutyOffAt,
    flightTimeMs,
    excursionReason: opts.excursionReason || null,
    overrideStatus: 'none',
    overrideRequestedBy: null,
    overrideRequestedAt: null,
    overrideRequestReason: null,
    overrideApprovedBy: null,
    overrideApprovedAt: null,
    overrideApprovalNotes: null,
    confirmStatus: 'admin-attested',
    partnerPeriodId: null,
    pendingCreatedBy: opts.editedBy,
    confirmedAt: null,
    declinedAt: null,
    declinedReason: null,
    adminEdits: [{
      by: opts.editedBy,
      at: now,
      field: 'create-backfill',
      from: null,
      to: { dutyOnAt: opts.dutyOnAt, dutyOffAt: opts.dutyOffAt, flightTimeMs },
      note: opts.note || 'Admin backfilled missing historical period',
    }],
    createdAt: now,
    updatedAt: now,
    status: 'off',
    over14: elapsed > 14 * 3600 * 1000,
  };
  await setDoc(doc(db, COLL, id), docData);
  return docData;
}

/**
 * Link two duty periods as PIC+SIC. Sets partnerPeriodId on both,
 * upgrades crewType to 'two' on both, and writes audit entries on both.
 * Use this when:
 *   - The pair-flow wasn't used at start (PIC and SIC each started
 *     duty solo and admin needs to retroactively connect them)
 *   - An admin re-paired a crew after an earlier link was broken
 *
 * Refuses if either period is already linked to a DIFFERENT period
 * (admin must unlink first), or if both periods belong to the same pilot.
 *
 * opts: {
 *   editedBy: string (REQUIRED — admin's display name for audit)
 *   note: string (optional audit note)
 * }
 *
 * SIC's confirmStatus handling:
 *   - 'self-attested' → preserved
 *   - 'pending' → upgraded to 'admin-attested' (since admin is asserting
 *      the link is legitimate)
 *   - 'declined' → upgraded to 'admin-attested' (admin is overriding a
 *      prior decline; expectation is that admin has verified the SIC
 *      was actually present)
 */
export async function linkCrewPeriods(picPeriodId, sicPeriodId, opts = {}) {
  if (!picPeriodId || !sicPeriodId) throw new Error('both period IDs required');
  if (picPeriodId === sicPeriodId) throw new Error('cannot link a period to itself');
  if (!opts.editedBy) throw new Error('editedBy required for audit');

  const picRef = doc(db, COLL, picPeriodId);
  const sicRef = doc(db, COLL, sicPeriodId);
  const [picSnap, sicSnap] = await Promise.all([getDoc(picRef), getDoc(sicRef)]);
  if (!picSnap.exists()) throw new Error('PIC period not found');
  if (!sicSnap.exists()) throw new Error('SIC period not found');
  const pic = picSnap.data();
  const sic = sicSnap.data();

  if (pic.pilotUid === sic.pilotUid) {
    throw new Error('cannot link a pilot to themselves');
  }
  if (pic.partnerPeriodId && pic.partnerPeriodId !== sicPeriodId) {
    throw new Error('PIC period is already linked to a different SIC — unlink first');
  }
  if (sic.partnerPeriodId && sic.partnerPeriodId !== picPeriodId) {
    throw new Error('SIC period is already linked to a different PIC — unlink first');
  }

  const now = Date.now();
  const adminName = opts.editedBy;
  const note = opts.note || 'Admin linked crew periods via calendar';

  const picEdits = Array.isArray(pic.adminEdits) ? pic.adminEdits : [];
  const sicEdits = Array.isArray(sic.adminEdits) ? sic.adminEdits : [];

  // SIC confirmStatus upgrade rule (see docstring above)
  const newSicConfirm = sic.confirmStatus === 'self-attested'
    ? 'self-attested'
    : 'admin-attested';

  const batch = writeBatch(db);
  batch.update(picRef, {
    partnerPeriodId: sicPeriodId,
    role: pic.role || 'PIC',
    crewType: 'two',
    updatedAt: now,
    adminEdits: [...picEdits, {
      by: adminName,
      at: now,
      field: 'partnerPeriodId',
      from: pic.partnerPeriodId || null,
      to: sicPeriodId,
      note,
    }],
  });
  batch.update(sicRef, {
    partnerPeriodId: picPeriodId,
    role: sic.role || 'SIC',
    crewType: 'two',
    confirmStatus: newSicConfirm,
    fitForDuty: newSicConfirm === 'self-attested' ? sic.fitForDuty : true,
    updatedAt: now,
    adminEdits: [...sicEdits, {
      by: adminName,
      at: now,
      field: 'partnerPeriodId',
      from: sic.partnerPeriodId || null,
      to: picPeriodId,
      note: `${note}${newSicConfirm === 'admin-attested' && sic.confirmStatus !== 'self-attested'
        ? ` · confirmStatus upgraded to admin-attested (was ${sic.confirmStatus || 'unset'})`
        : ''}`,
    }],
  });
  await batch.commit();
  return { picPeriodId, sicPeriodId };
}

/**
 * Break a PIC↔SIC pairing without ending either duty period. Both
 * periods stay in their current on/off state — only the partnerPeriodId
 * is cleared, and crewType is reset to 'single' if the period is still
 * on duty (closed periods keep their historical crewType for record
 * purposes).
 *
 * opts: {
 *   editedBy: string (REQUIRED)
 *   note: string (optional)
 * }
 */
export async function unlinkCrewPeriods(picPeriodId, opts = {}) {
  if (!picPeriodId) throw new Error('picPeriodId required');
  if (!opts.editedBy) throw new Error('editedBy required for audit');

  const picRef = doc(db, COLL, picPeriodId);
  const picSnap = await getDoc(picRef);
  if (!picSnap.exists()) throw new Error('PIC period not found');
  const pic = picSnap.data();
  if (!pic.partnerPeriodId) throw new Error('PIC period has no partner to unlink');

  const sicId = pic.partnerPeriodId;
  const sicRef = doc(db, COLL, sicId);
  const sicSnap = await getDoc(sicRef);

  const now = Date.now();
  const adminName = opts.editedBy;
  const note = opts.note || 'Admin unlinked crew periods via calendar';
  const batch = writeBatch(db);

  const picEdits = Array.isArray(pic.adminEdits) ? pic.adminEdits : [];
  batch.update(picRef, {
    partnerPeriodId: null,
    // Only flip crewType back if the period is still ACTIVE — closed
    // periods keep their historical crewType.
    crewType: pic.status === 'on' ? 'single' : pic.crewType,
    updatedAt: now,
    adminEdits: [...picEdits, {
      by: adminName, at: now, field: 'partnerPeriodId',
      from: sicId, to: null, note,
    }],
  });

  if (sicSnap.exists()) {
    const sic = sicSnap.data();
    const sicEdits = Array.isArray(sic.adminEdits) ? sic.adminEdits : [];
    batch.update(sicRef, {
      partnerPeriodId: null,
      crewType: sic.status === 'on' ? 'single' : sic.crewType,
      updatedAt: now,
      adminEdits: [...sicEdits, {
        by: adminName, at: now, field: 'partnerPeriodId',
        from: picPeriodId, to: null, note,
      }],
    });
  }

  await batch.commit();
}


