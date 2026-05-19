// Maintenance department data layer.
//
// SCOPE / COMPLIANCE BOUNDARY (read this before extending):
//   This module is a COORDINATION + VISIBILITY layer. It is NOT the
//   airworthiness system of record. Veryon Tracking is the system of record
//   for times, cycles, inspections, AD/SB compliance and logbooks. Nothing
//   here confers airworthiness, return-to-service authority, or constitutes a
//   14 CFR 43.9/43.11 maintenance record. Squawk "close" here records that a
//   named person STATES an action was taken, time-stamped — it is not the
//   regulatory approval for return to service, which is made by certificated
//   personnel and recorded in the official records. deriveAircraftStatus() is
//   a dispatch-visibility aid, not an airworthiness determination.
//
//   Per-trip times/cycles flow: capture (at trip close) -> STAGED ->
//   an authorized maint user REVIEWS & CONFIRMS -> only a CONFIRMED entry is
//   eligible to sync to Veryon, and that sync is always an explicit,
//   authorized call. There is deliberately NO code path in this module that
//   pushes to Veryon automatically or silently. See the VERYON ADAPTER SEAM
//   section at the bottom.
//
// Firestore: named database `appusers` (db is imported from ./firebase.js,
// which calls initializeFirestore(app, ..., 'appusers')). Timestamps are
// epoch ms via Date.now() to match the rest of the codebase. Queries use a
// single where() (or none) + client-side sort so NO Firestore composite
// index is ever required (Jake has no console-side index to create).
//
// Collections:
//   maint-aircraft   doc id = tail (e.g. "N20UF")
//   maint-squawks    doc id = auto
//   maint-mel        doc id = auto
//   maint-timelog    doc id = auto   (per-trip staged times/cycles)

import { db } from './firebase.js';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';

// Known fleet (handoff). upsertAircraft can add/seed others.
export const FLEET_TAILS = [
  'N20UF', 'N168ZZ', 'N286N', 'N444AM',
  'N651TW', 'N551FP', 'N85AH', 'N525CR',
];

function nid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function safeTail(t) {
  return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/* ============================================================
   AIRCRAFT
   ------------------------------------------------------------
   One doc per tail. `times` is the app's WORKING view of the
   last CONFIRMED times entry — Veryon remains the reconciling
   truth. Never treated as authoritative for airworthiness.
   ============================================================ */

function emptyTimes() {
  return {
    airframe: { hours: null, cycles: null },
    engines: [],            // [{ position, hours, cycles }]
    apu: { hours: null, cycles: null },
  };
}

export async function upsertAircraft(tail, patch = {}) {
  const id = safeTail(tail);
  if (!id) throw new Error('upsertAircraft: invalid tail');
  const now = Date.now();
  const ref = doc(db, 'maint-aircraft', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      tail: id,
      model: '',
      active: true,
      times: emptyTimes(),
      timesAsOf: null,                 // ms epoch of the source trip
      timesSource: null,               // 'entry:{id}' | 'veryon' | 'manual'
      veryon: { lastPullAt: null, lastPushAt: null, lastError: null },
      createdAt: now,
      updatedAt: now,
      ...patch,
    });
  } else {
    await updateDoc(ref, { ...patch, updatedAt: now });
  }
  return id;
}

// One-time / idempotent seeding of the known fleet.
export async function seedFleet() {
  for (const t of FLEET_TAILS) {
    // eslint-disable-next-line no-await-in-loop
    await upsertAircraft(t);
  }
}

export function subscribeFleet(onUpdate) {
  const qy = query(collection(db, 'maint-aircraft'));
  return onSnapshot(
    qy,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      list.sort((a, b) => String(a.tail).localeCompare(String(b.tail)));
      onUpdate(list);
    },
    (err) => { console.error('[maint] subscribeFleet:', err); onUpdate([]); }
  );
}

/* ============================================================
   SQUAWKS / DISCREPANCIES
   ------------------------------------------------------------
   reported -> triaged (grounding? or deferred under MEL?) ->
   closed. `history` is append-only. Closing records a STATED
   corrective action by a named user — NOT regulatory RTS.
   ============================================================ */

export async function createSquawk(input) {
  const tail = safeTail(input.tail);
  if (!tail) throw new Error('createSquawk: tail required');
  if (!input.description) throw new Error('createSquawk: description required');
  const now = Date.now();
  const id = nid('sqwk');
  const rec = {
    id,
    tail,
    reportedAt: now,
    reportedByUid: input.byUid || null,
    reportedByName: input.byName || 'Unknown',
    reportedByRole: input.byRole || null,
    tripUid: input.tripUid || null,
    tripLabel: input.tripLabel || null,
    description: String(input.description).slice(0, 4000),
    status: 'open',                    // open | deferred | closed
    grounding: input.grounding === true,
    melItemId: null,
    correctiveAction: null,
    closedAt: null,
    closedByUid: null,
    closedByName: null,
    history: [{
      at: now, byUid: input.byUid || null, byName: input.byName || 'Unknown',
      action: 'reported', note: input.grounding ? 'Reported as grounding' : 'Reported',
    }],
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(doc(db, 'maint-squawks', id), rec);
  return id;
}

// Triage: set/clear grounding, optionally link a created MEL deferral.
export async function triageSquawk(squawkId, opts = {}) {
  const ref = doc(db, 'maint-squawks', squawkId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('triageSquawk: not found');
  const cur = snap.data();
  const now = Date.now();
  const patch = { updatedAt: now };
  const hist = Array.isArray(cur.history) ? cur.history.slice() : [];
  if (typeof opts.grounding === 'boolean' && opts.grounding !== cur.grounding) {
    patch.grounding = opts.grounding;
    hist.push({ at: now, byUid: opts.byUid || null, byName: opts.byName || 'Unknown',
      action: 'triage', note: opts.grounding ? 'Marked grounding' : 'Cleared grounding flag' });
  }
  if (opts.melItemId) {
    patch.melItemId = opts.melItemId;
    patch.status = 'deferred';
    hist.push({ at: now, byUid: opts.byUid || null, byName: opts.byName || 'Unknown',
      action: 'deferred', note: `Deferred under MEL item ${opts.melItemId}` });
  }
  patch.history = hist;
  await updateDoc(ref, patch);
}

// Close: records a STATED corrective action. Not regulatory return-to-service.
export async function closeSquawk(squawkId, opts = {}) {
  if (!opts.correctiveAction) throw new Error('closeSquawk: correctiveAction required');
  const ref = doc(db, 'maint-squawks', squawkId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('closeSquawk: not found');
  const cur = snap.data();
  const now = Date.now();
  const hist = Array.isArray(cur.history) ? cur.history.slice() : [];
  hist.push({ at: now, byUid: opts.byUid || null, byName: opts.byName || 'Unknown',
    action: 'closed', note: 'Corrective action recorded (stated, not regulatory RTS)' });
  await updateDoc(ref, {
    status: 'closed',
    grounding: false,
    correctiveAction: String(opts.correctiveAction).slice(0, 4000),
    closedAt: now,
    closedByUid: opts.byUid || null,
    closedByName: opts.byName || 'Unknown',
    history: hist,
    updatedAt: now,
  });
}

export function subscribeSquawks(onUpdate, opts = {}) {
  const qy = opts.tail
    ? query(collection(db, 'maint-squawks'), where('tail', '==', safeTail(opts.tail)))
    : query(collection(db, 'maint-squawks'));
  return onSnapshot(
    qy,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      list.sort((a, b) => (b.reportedAt || 0) - (a.reportedAt || 0));
      onUpdate(list);
    },
    (err) => { console.error('[maint] subscribeSquawks:', err); onUpdate([]); }
  );
}

/* ============================================================
   MEL / DEFERRED ITEMS
   ------------------------------------------------------------
   FAA MEL repair categories. Calendar limits (consecutive
   calendar days, excluding the day of discovery):
     A = per the item's remarks (no fixed default)
     B = 3   C = 10   D = 120
   This MIRRORS the operator's approved MEL deferral log; the
   approved log governs. This is a countdown/visibility aid.
   ============================================================ */

export const MEL_CATEGORY_LIMITS = { A: null, B: 3, C: 10, D: 120 };

export function melLimitDays(category, manualDays) {
  const c = String(category || '').toUpperCase();
  if (c === 'A') return Number.isFinite(manualDays) ? manualDays : null;
  return MEL_CATEGORY_LIMITS[c] ?? null;
}

// Whole days remaining. Excludes the day of discovery (deferredAt). Negative
// => OVER the limit. null => no fixed limit (Category A w/o manual days).
export function melDaysRemaining(item, now = Date.now()) {
  if (!item || !Number.isFinite(item.deferredAt)) return null;
  const limit = Number.isFinite(item.limitDays)
    ? item.limitDays
    : melLimitDays(item.category, item.limitDays);
  if (!Number.isFinite(limit)) return null;
  const DAY = 86400000;
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const elapsedDays = Math.floor((startOfDay(now) - startOfDay(item.deferredAt)) / DAY);
  return limit - elapsedDays;
}

export async function createMelDeferral(input) {
  const tail = safeTail(input.tail);
  if (!tail) throw new Error('createMelDeferral: tail required');
  if (!input.description) throw new Error('createMelDeferral: description required');
  const cat = String(input.category || '').toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(cat)) {
    throw new Error('createMelDeferral: category must be A, B, C, or D');
  }
  const now = Date.now();
  const id = nid('mel');
  const limitDays = melLimitDays(cat, input.limitDays);
  await setDoc(doc(db, 'maint-mel', id), {
    id,
    tail,
    squawkId: input.squawkId || null,
    description: String(input.description).slice(0, 4000),
    category: cat,
    deferredAt: Number.isFinite(input.deferredAt) ? input.deferredAt : now,
    limitDays,                          // null for Cat A without manual days
    remarks: input.remarks ? String(input.remarks).slice(0, 4000) : null,
    status: 'open',                     // open | cleared
    clearedAt: null,
    clearedByUid: null,
    clearedByName: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function clearMelDeferral(melId, opts = {}) {
  const ref = doc(db, 'maint-mel', melId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('clearMelDeferral: not found');
  const now = Date.now();
  await updateDoc(ref, {
    status: 'cleared',
    clearedAt: now,
    clearedByUid: opts.byUid || null,
    clearedByName: opts.byName || 'Unknown',
    updatedAt: now,
  });
}

export function subscribeMel(onUpdate, opts = {}) {
  const qy = opts.tail
    ? query(collection(db, 'maint-mel'), where('tail', '==', safeTail(opts.tail)))
    : query(collection(db, 'maint-mel'));
  return onSnapshot(
    qy,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      list.sort((a, b) => (b.deferredAt || 0) - (a.deferredAt || 0));
      onUpdate(list);
    },
    (err) => { console.error('[maint] subscribeMel:', err); onUpdate([]); }
  );
}

/* ============================================================
   STATUS DERIVATION (dispatch-visibility aid — NOT an
   airworthiness determination)
   ------------------------------------------------------------
   AOG        : an OPEN grounding squawk exists
   RESTRICTED : no grounding, but >=1 OPEN MEL deferral
   AIRWORTHY  : neither of the above
   ============================================================ */

export function deriveAircraftStatus(tail, squawks = [], melItems = []) {
  const t = safeTail(tail);
  const mySquawks = squawks.filter((s) => safeTail(s.tail) === t);
  const myMel = melItems.filter((m) => safeTail(m.tail) === t);
  const groundOpen = mySquawks.filter((s) => s.status !== 'closed' && s.grounding === true);
  const melOpen = myMel.filter((m) => m.status === 'open');
  if (groundOpen.length > 0) {
    return { status: 'AOG', reasons: groundOpen.map((s) => s.description), melOpen: melOpen.length };
  }
  if (melOpen.length > 0) {
    return {
      status: 'RESTRICTED',
      reasons: melOpen.map((m) => `MEL ${m.category}: ${m.description}`),
      melOpen: melOpen.length,
    };
  }
  return { status: 'AIRWORTHY', reasons: [], melOpen: 0 };
}

/* ============================================================
   PER-TRIP TIMES / CYCLES  (capture -> stage -> confirm)
   ------------------------------------------------------------
   times shape:
     { airframe:{hours,cycles},
       engines:[{position,hours,cycles}],
       apu:{hours,cycles} }
   status: staged -> confirmed -> synced   (or -> rejected)
   ============================================================ */

function normTimes(t) {
  const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null);
  const src = t || {};
  return {
    airframe: {
      hours: num(src.airframe?.hours),
      cycles: num(src.airframe?.cycles),
    },
    engines: Array.isArray(src.engines)
      ? src.engines.slice(0, 4).map((e, i) => ({
          position: Number.isFinite(e?.position) ? e.position : i + 1,
          hours: num(e?.hours),
          cycles: num(e?.cycles),
        }))
      : [],
    apu: { hours: num(src.apu?.hours), cycles: num(src.apu?.cycles) },
  };
}

// Called at trip close (by crew/ops). Creates a STAGED entry only — it does
// not touch the aircraft snapshot and does not sync anything.
export async function stageTripTimes(input) {
  const tail = safeTail(input.tail);
  if (!tail) throw new Error('stageTripTimes: tail required');
  const now = Date.now();
  const id = nid('tlog');
  await setDoc(doc(db, 'maint-timelog', id), {
    id,
    tail,
    tripUid: input.tripUid || null,
    tripLabel: input.tripLabel || null,
    enteredAt: now,
    enteredByUid: input.byUid || null,
    enteredByName: input.byName || 'Unknown',
    enteredByRole: input.byRole || null,
    source: input.source || 'trip-close',
    times: normTimes(input.times),
    status: 'staged',                  // staged | confirmed | rejected | synced
    confirmedAt: null,
    confirmedByUid: null,
    confirmedByName: null,
    rejectedReason: null,
    veryon: { pushedAt: null, error: null },
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// The maint review queue: only STAGED entries. Single where() + client sort.
export function subscribeStagedTimes(onUpdate) {
  const qy = query(collection(db, 'maint-timelog'), where('status', '==', 'staged'));
  return onSnapshot(
    qy,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      list.sort((a, b) => (a.enteredAt || 0) - (b.enteredAt || 0)); // oldest first
      onUpdate(list);
    },
    (err) => { console.error('[maint] subscribeStagedTimes:', err); onUpdate([]); }
  );
}

export function subscribeTimelog(onUpdate, opts = {}) {
  const qy = opts.tail
    ? query(collection(db, 'maint-timelog'), where('tail', '==', safeTail(opts.tail)))
    : query(collection(db, 'maint-timelog'));
  return onSnapshot(
    qy,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      list.sort((a, b) => (b.enteredAt || 0) - (a.enteredAt || 0));
      onUpdate(list);
    },
    (err) => { console.error('[maint] subscribeTimelog:', err); onUpdate([]); }
  );
}

// Authorized maint action. staged -> confirmed. Updates the aircraft working
// snapshot ONLY IF this entry is newer than what's there. Explicitly does
// NOT call Veryon (see seam). Confirming makes the entry *eligible* to sync.
export async function confirmTimeEntry(entryId, opts = {}) {
  const ref = doc(db, 'maint-timelog', entryId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('confirmTimeEntry: not found');
  const e = snap.data();
  if (e.status !== 'staged') {
    throw new Error(`confirmTimeEntry: entry is '${e.status}', expected 'staged'`);
  }
  const now = Date.now();
  await updateDoc(ref, {
    status: 'confirmed',
    confirmedAt: now,
    confirmedByUid: opts.byUid || null,
    confirmedByName: opts.byName || 'Unknown',
    updatedAt: now,
  });

  // Update the aircraft working snapshot if this confirmed entry is newer.
  try {
    const acRef = doc(db, 'maint-aircraft', safeTail(e.tail));
    const acSnap = await getDoc(acRef);
    const prevAsOf = acSnap.exists() ? (acSnap.data().timesAsOf || 0) : 0;
    const thisAsOf = e.enteredAt || now;
    if (!acSnap.exists()) {
      await upsertAircraft(e.tail, {
        times: e.times, timesAsOf: thisAsOf, timesSource: `entry:${entryId}`,
      });
    } else if (thisAsOf >= prevAsOf) {
      await updateDoc(acRef, {
        times: e.times, timesAsOf: thisAsOf,
        timesSource: `entry:${entryId}`, updatedAt: now,
      });
    }
  } catch (err) {
    console.warn('[maint] snapshot update after confirm failed:', err.message);
  }
  return true;
}

export async function rejectTimeEntry(entryId, opts = {}) {
  if (!opts.reason) throw new Error('rejectTimeEntry: reason required');
  const ref = doc(db, 'maint-timelog', entryId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('rejectTimeEntry: not found');
  const now = Date.now();
  await updateDoc(ref, {
    status: 'rejected',
    rejectedReason: String(opts.reason).slice(0, 2000),
    confirmedByUid: opts.byUid || null,
    confirmedByName: opts.byName || 'Unknown',
    updatedAt: now,
  });
}

/* ============================================================
   VERYON ADAPTER SEAM   (Phase 2 — currently INERT)
   ------------------------------------------------------------
   Veryon is the system of record. Veryon's API is partner /
   contract-gated; until the real API spec + credentials are
   supplied and a SERVER-SIDE endpoint (/api/veryon-sync) is
   built (credentials in Vercel env, never client-side), every
   function here is a no-op that fails safe.

   HARD RULE — enforced by code, not just convention:
     * pushConfirmedEntryToVeryon() refuses any entry whose
       status !== 'confirmed'. There is NO function anywhere in
       this module that pushes a 'staged' entry, and nothing
       calls push automatically. A human confirm is always the
       gate, and the push is always a separate explicit call.
     * With VERYON_ENABLED false, push performs NO network call
       and does NOT mutate the entry — it returns a structured
       disabled result the UI can show ("pending Veryon setup").
   ============================================================ */

export const VERYON_ENABLED = false;          // Phase 2 flips this on
export const VERYON_SYNC_ENDPOINT = '/api/veryon-sync'; // built in Phase 2

export async function veryonPullStatus(tail) {
  if (!VERYON_ENABLED) {
    return { ok: false, disabled: true, reason: 'Veryon integration not yet configured', tail: safeTail(tail) };
  }
  // Phase 2: GET via the server-side endpoint (credentials server-side only).
  try {
    const r = await fetch(`${VERYON_SYNC_ENDPOINT}?op=pull&tail=${encodeURIComponent(safeTail(tail))}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data.error || `pull ${r.status}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Explicit, authorized push of a SINGLE already-confirmed entry. Never called
// automatically. Refuses anything not 'confirmed'.
export async function pushConfirmedEntryToVeryon(entryId, opts = {}) {
  const ref = doc(db, 'maint-timelog', entryId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('pushConfirmedEntryToVeryon: not found');
  const e = snap.data();
  if (e.status !== 'confirmed') {
    // Hard refusal — confirm gate enforced in code.
    throw new Error(`pushConfirmedEntryToVeryon: entry is '${e.status}', only 'confirmed' may sync`);
  }
  if (!VERYON_ENABLED) {
    return { ok: false, disabled: true, reason: 'Veryon integration not yet configured (Phase 2)' };
  }
  // Phase 2: POST to the server-side endpoint, then on success:
  //   updateDoc(ref, { status:'synced', veryon:{ pushedAt:Date.now(), error:null } })
  try {
    const r = await fetch(VERYON_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'push', entryId, idToken: opts.idToken || null }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      await updateDoc(ref, { veryon: { pushedAt: null, error: data.error || `push ${r.status}` }, updatedAt: Date.now() });
      return { ok: false, error: data.error || `push ${r.status}` };
    }
    await updateDoc(ref, {
      status: 'synced',
      veryon: { pushedAt: Date.now(), error: null },
      updatedAt: Date.now(),
    });
    return { ok: true };
  } catch (err) {
    await updateDoc(ref, { veryon: { pushedAt: null, error: err.message }, updatedAt: Date.now() });
    return { ok: false, error: err.message };
  }
}
