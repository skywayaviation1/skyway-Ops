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
 * Start the presser's duty period AND, if a registered partner pilot is
 * supplied, auto-create a LINKED period for them (flagged linkedAuto +
 * linkPending so it is not silently treated as their authoritative record
 * until they confirm on their own card).
 *
 * presser: { uid, name }
 * partner: { uid, name } | null   (only pass if a registered app user)
 * opts:    same as startDuty (fboArrival, restOverride)
 */
export async function startDutyLinked(presser, partner, opts = {}) {
  const myId = await startDuty(presser, opts);

  if (!partner?.uid || partner.uid === presser.uid) {
    return { myId, linkedId: null };
  }

  // Don't create/duplicate if the partner already has an open period.
  const partnerExisting = await getLatestDuty(partner.uid);
  if (partnerExisting && partnerExisting.status === 'on') {
    // Cross-link the two periods if not already linked.
    if (!partnerExisting.linkedPeriodId) {
      await updateDoc(doc(db, 'duty-state', partnerExisting.id), {
        linkedPeriodId: myId, updatedAt: Date.now(),
      });
    }
    await updateDoc(doc(db, 'duty-state', myId), {
      linkedPeriodId: partnerExisting.id, updatedAt: Date.now(),
    });
    return { myId, linkedId: partnerExisting.id };
  }

  const now = Date.now();
  const linkedId = periodId(partner.uid, now);
  await setDoc(doc(db, 'duty-state', linkedId), {
    id: linkedId,
    pilotUid: partner.uid,
    pilotName: partner.name || 'Unknown',
    role: 'PIC',
    sicUid: null,
    sicName: null,
    dutyOnAt: now,
    fboArrivalAt: now,
    dutyOffAt: null,
    restUntil: null,
    over14: false,
    over14ReasonPic: '',
    over14ReasonSic: '',
    restOverride: null,
    status: 'on',
    adminEdits: [],
    // Linking metadata:
    linkedAuto: true,                       // created by partner's action
    linkPending: true,                      // partner must confirm it's theirs
    linkedPeriodId: myId,                   // the period that spawned this
    linkedFromName: presser.name || '',
    createdAt: now,
    updatedAt: now,
  });

  await updateDoc(doc(db, 'duty-state', myId), {
    linkedPeriodId: linkedId, updatedAt: Date.now(),
  });

  return { myId, linkedId };
}

/**
 * The linked pilot confirms the auto-created period is genuinely theirs.
 * Clears linkPending. (Does NOT remove linkedAuto — we keep that as
 * provenance for the audit trail.)
 */
export async function confirmLinkedDuty(periodDocId) {
  if (!periodDocId) throw new Error('period id required');
  const ref = doc(db, 'duty-state', periodDocId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  await updateDoc(ref, { linkPending: false, updatedAt: Date.now() });
}

/**
 * The linked pilot rejects the auto-created period (it wasn't theirs / wrong
 * pairing). Marks it rejected and closes it so it doesn't pollute their
 * record or the oversight panel.
 */
export async function rejectLinkedDuty(periodDocId) {
  if (!periodDocId) throw new Error('period id required');
  const ref = doc(db, 'duty-state', periodDocId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const now = Date.now();
  await updateDoc(ref, {
    linkPending: false,
    linkRejected: true,
    status: 'off',
    dutyOffAt: now,
    restUntil: null,
    updatedAt: now,
  });
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

  // The linked partner may be over 14h even if the pressing pilot is not
  // (different duty-on times). An over-14 close with no documented reason
  // is a compliance gap, so the reason gate must consider BOTH periods.
  let partnerOver14 = false;
  const partnerIdPre = cur.linkedPeriodId || null;
  if (partnerIdPre && partnerIdPre !== periodDocId) {
    try {
      const pSnapPre = await getDoc(doc(db, 'duty-state', partnerIdPre));
      if (pSnapPre.exists()) {
        const pPre = pSnapPre.data();
        if (pPre.status !== 'off') {
          partnerOver14 = (now - (pPre.dutyOnAt || now)) > DUTY_MAX_MS;
        }
      }
    } catch (e) {
      console.warn('[duty] partner over-14 pre-check failed:', e);
    }
  }

  if (over14 || partnerOver14) {
    const pic = String(over14ReasonPic || '').trim();
    const sic = String(over14ReasonSic || '').trim();
    if (!pic || !sic) {
      const e = new Error(
        (over14 && partnerOver14)
          ? 'Over-14h: both crew exceeded 14h. PIC and SIC reasons are both required to close.'
          : over14
            ? 'Over-14h: PIC and SIC reasons are both required to close this duty period.'
            : 'Over-14h: your paired crew exceeded 14h. PIC and SIC reasons are both required to close.'
      );
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

  // Crew-pair sync: when one pilot duties off, the linked partner's period
  // is closed too, with the SAME dutyOffAt and rest clock (so both pilots'
  // rest windows are identical). This is a deliberate operational choice —
  // it can under-report the partner's duty if they were genuinely still on
  // duty, so the partner close is stamped with an audit marker showing it
  // was a paired auto-close triggered by this period, not the pilot's own
  // duty-off action.
  const partnerId = cur.linkedPeriodId || null;
  if (partnerId && partnerId !== periodDocId) {
    try {
      const pRef = doc(db, 'duty-state', partnerId);
      const pSnap = await getDoc(pRef);
      if (pSnap.exists()) {
        const p = pSnap.data();
        // SAFETY: only cascade-close the partner when the link is MUTUAL —
        // the partner's period must point back at THIS exact period. A
        // one-directional or stale link (e.g. a re-pair pointed A→B but B
        // still points at an old period, or B was resolved to the wrong
        // period) must NEVER auto-close the partner. Without this guard,
        // pairing a freshly-dutied-on pilot could wrongly duty them off.
        const mutual = p.linkedPeriodId === periodDocId;
        if (mutual && p.status !== 'off') {
          const pElapsed = now - (p.dutyOnAt || now);
          const pOver14 = pElapsed > DUTY_MAX_MS;
          await updateDoc(pRef, {
            dutyOffAt: now,
            restUntil: now + REST_MIN_MS,
            over14: pOver14,
            over14ReasonPic: pOver14 ? String(over14ReasonPic || '').trim().slice(0, 2000) : (p.over14ReasonPic || ''),
            over14ReasonSic: pOver14 ? String(over14ReasonSic || '').trim().slice(0, 2000) : (p.over14ReasonSic || ''),
            status: 'off',
            updatedAt: now,
            adminEdits: [
              ...(Array.isArray(p.adminEdits) ? p.adminEdits : []),
              {
                by: 'System (crew-pair sync)',
                at: now,
                field: 'dutyOffAt',
                from: p.dutyOffAt || null,
                to: now,
                note: `Auto-closed because paired crew (period ${periodDocId}) went off duty. Rest clock started at the same time.`,
              },
            ],
          });
        }
      }
    } catch (e) {
      console.warn('[duty] partner crew-pair sync failed:', e);
    }
  }

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
  const reason = String(note || '').trim();
  if (!reason) {
    const e = new Error('A reason note is required for every admin duty edit.');
    e.code = 'REASON_REQUIRED';
    throw e;
  }
  if (!Number.isFinite(newValueMs)) {
    throw new Error('A valid new time is required.');
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
      note: reason.slice(0, 500),
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

  // Crew-pair sync: an admin correcting one pilot's duty-on/off applies the
  // same correction to the linked partner so the pair doesn't drift. This
  // assumes both pilots' actual times were identical (usually true for a
  // crew pair). The partner edit is stamped with an audit marker showing it
  // was a paired sync triggered by the admin's edit on the other pilot, so
  // the record is honest about how the time was set and an admin can still
  // individually re-edit the partner if their real time genuinely differed.
  const partnerId = cur.linkedPeriodId || null;
  if (partnerId && partnerId !== periodDocId) {
    try {
      const pRef = doc(db, 'duty-state', partnerId);
      const pSnap = await getDoc(pRef);
      if (pSnap.exists()) {
        const p = pSnap.data();
        // SAFETY: mutual-link guard — see endDuty. An edit (especially a
        // dutyOffAt edit, which sets status:'off' below) must NOT cascade
        // onto a partner whose period doesn't point back at this one.
        const mutual = p.linkedPeriodId === periodDocId;
        if (mutual) {
          const pFrom = p[field] || null;
          const pEdits = Array.isArray(p.adminEdits) ? p.adminEdits : [];
          const pPatch = {
            [field]: to,
            adminEdits: [...pEdits, {
              by: editor?.displayName || editor?.name || 'Admin',
              at: Date.now(),
              field,
              from: pFrom,
              to,
              note: `Crew-pair sync: matched to paired crew (period ${periodDocId}). Original admin reason: ${reason.slice(0, 400)}`,
            }],
            updatedAt: Date.now(),
          };
          if (field === 'dutyOffAt' && to) {
            pPatch.restUntil = to + REST_MIN_MS;
            pPatch.status = 'off';
          }
          if (field === 'dutyOnAt' && to && p.dutyOffAt) {
            pPatch.over14 = (p.dutyOffAt - to) > DUTY_MAX_MS;
          }
          await updateDoc(pRef, pPatch);
        }
      }
    } catch (e) {
      // Non-fatal: the primary pilot's edit is already saved correctly.
      console.warn('[duty] partner admin-edit sync failed:', e);
    }
  }
}

/**
 * Force-close a stuck/forgotten duty period. Sets duty-off to the supplied
 * time (or now), starts the rest clock, and records an audited admin entry.
 * Reason note required.
 */
export async function forceCloseDuty(periodDocId, { closeAtMs, editor, note } = {}) {
  if (!periodDocId) throw new Error('period id required');
  const reason = String(note || '').trim();
  if (!reason) {
    const e = new Error('A reason note is required to force-close a duty period.');
    e.code = 'REASON_REQUIRED';
    throw e;
  }
  const ref = doc(db, 'duty-state', periodDocId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();

  const closeAt = Number.isFinite(closeAtMs) ? closeAtMs : Date.now();
  const from = cur.dutyOffAt || null;
  const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];
  const elapsed = closeAt - (cur.dutyOnAt || closeAt);
  const over14 = elapsed > DUTY_MAX_MS;

  await updateDoc(ref, {
    dutyOffAt: closeAt,
    restUntil: closeAt + REST_MIN_MS,
    over14,
    status: 'off',
    adminEdits: [...edits, {
      by: editor?.displayName || editor?.name || 'Admin',
      at: Date.now(),
      field: 'forceClose',
      from,
      to: closeAt,
      note: reason.slice(0, 500),
    }],
    updatedAt: Date.now(),
  });

  // Crew-pair sync: force-closing one pilot force-closes the linked partner
  // at the same time with the same rest clock, audit-marked as a paired sync.
  const partnerId = cur.linkedPeriodId || null;
  if (partnerId && partnerId !== periodDocId) {
    try {
      const pRef = doc(db, 'duty-state', partnerId);
      const pSnap = await getDoc(pRef);
      if (pSnap.exists()) {
        const p = pSnap.data();
        // SAFETY: mutual-link guard — see endDuty. A stale/one-directional
        // link must never cascade a force-close onto the wrong pilot.
        const mutual = p.linkedPeriodId === periodDocId;
        if (mutual && p.status !== 'off') {
          const pElapsed = closeAt - (p.dutyOnAt || closeAt);
          const pEdits = Array.isArray(p.adminEdits) ? p.adminEdits : [];
          await updateDoc(pRef, {
            dutyOffAt: closeAt,
            restUntil: closeAt + REST_MIN_MS,
            over14: pElapsed > DUTY_MAX_MS,
            status: 'off',
            adminEdits: [...pEdits, {
              by: editor?.displayName || editor?.name || 'Admin',
              at: Date.now(),
              field: 'forceClose',
              from: p.dutyOffAt || null,
              to: closeAt,
              note: `Crew-pair sync: force-closed with paired crew (period ${periodDocId}). Original admin reason: ${reason.slice(0, 400)}`,
            }],
            updatedAt: Date.now(),
          });
        }
      }
    } catch (e) {
      console.warn('[duty] partner force-close sync failed:', e);
    }
  }
  return { over14, elapsed };
}

/**
 * Admin override: set (or clear) the crew pairing for a duty period.
 *
 * Auto-linking at DUTY-ON can be wrong when crew swap mid-trip-day. This lets
 * an admin authoritatively bind `periodDocId` to `partnerPeriodDocId` (each
 * period's linkedPeriodId points at the other — the bidirectional form the
 * dashboard requires), or unbind it entirely. Audited on both periods.
 *
 * - To re-pair:  adminSetDutyPair(periodId, { partnerPeriodId, editor, note })
 * - To unpair:   adminSetDutyPair(periodId, { partnerPeriodId: null, editor, note })
 */
export async function adminSetDutyPair(periodDocId, { partnerPeriodId, editor, note }) {
  if (!periodDocId) throw new Error('period id required');
  const reason = String(note || '').trim();
  if (!reason) {
    const e = new Error('A reason note is required to change a crew pairing.');
    e.code = 'REASON_REQUIRED';
    throw e;
  }
  const ref = doc(db, 'duty-state', periodDocId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('duty period not found');
  const cur = snap.data();
  const stamp = (d, extra) => ({
    by: editor?.displayName || editor?.name || 'Admin',
    at: Date.now(),
    field: 'crewPair',
    from: d.linkedPeriodId || null,
    to: extra,
    note: reason.slice(0, 500),
  });

  // First, detach any period that currently points back at THIS one but
  // isn't the new partner (so we don't leave a dangling half-link).
  const oldPartnerId = cur.linkedPeriodId || null;
  if (oldPartnerId && oldPartnerId !== partnerPeriodId) {
    try {
      const oldRef = doc(db, 'duty-state', oldPartnerId);
      const oldSnap = await getDoc(oldRef);
      if (oldSnap.exists() && oldSnap.data().linkedPeriodId === periodDocId) {
        const od = oldSnap.data();
        await updateDoc(oldRef, {
          linkedPeriodId: null,
          linkPending: false,
          adminEdits: [...(Array.isArray(od.adminEdits) ? od.adminEdits : []), stamp(od, null)],
          updatedAt: Date.now(),
        });
      }
    } catch (e) {
      // Non-fatal — proceed with the primary change.
      console.warn('[duty] old-partner detach skipped:', e);
    }
  }

  if (!partnerPeriodId) {
    // Unpair this period.
    await updateDoc(ref, {
      linkedPeriodId: null,
      linkPending: false,
      adminEdits: [...(Array.isArray(cur.adminEdits) ? cur.adminEdits : []), stamp(cur, null)],
      updatedAt: Date.now(),
    });
    return { paired: false };
  }

  // Bind partner -> this (and confirm it, since an admin is asserting it).
  const pRef = doc(db, 'duty-state', partnerPeriodId);
  const pSnap = await getDoc(pRef);
  if (!pSnap.exists()) throw new Error('partner duty period not found');
  const pCur = pSnap.data();
  await updateDoc(pRef, {
    linkedPeriodId: periodDocId,
    linkPending: false,
    adminEdits: [...(Array.isArray(pCur.adminEdits) ? pCur.adminEdits : []), stamp(pCur, periodDocId)],
    updatedAt: Date.now(),
  });
  // Bind this -> partner.
  await updateDoc(ref, {
    linkedPeriodId: partnerPeriodId,
    linkPending: false,
    adminEdits: [...(Array.isArray(cur.adminEdits) ? cur.adminEdits : []), stamp(cur, partnerPeriodId)],
    updatedAt: Date.now(),
  });
  return { paired: true };
}

/**
 * Admin: pair an on-duty pilot's period (A) with partner pilot B, and make
 * B's duty state MATCH A — creating B's duty period if B has none, or
 * aligning B's existing open period's duty-on time to A's. Both periods are
 * bidirectionally linked. Every B-side change is audit-marked as an
 * admin crew-pair action carrying the required reason.
 *
 *   periodDocId   : A's period id (the on-duty pilot you're pairing FROM)
 *   partnerPeriodId: B's existing period id, if B already has one (optional)
 *   partnerPilot  : { uid, name } — required if B has no open period so we
 *                   can create one
 *   editor        : { displayName } admin performing this
 *   note          : required reason (audit)
 *
 * Returns { paired, createdPartner, alignedTo }.
 */
export async function adminPairAndSyncDuty(periodDocId, { partnerPeriodId, partnerPilot, editor, note }) {
  if (!periodDocId) throw new Error('period id required');
  const reason = String(note || '').trim();
  if (!reason) {
    const e = new Error('A reason note is required to pair and sync crew duty.');
    e.code = 'REASON_REQUIRED';
    throw e;
  }
  const aRef = doc(db, 'duty-state', periodDocId);
  const aSnap = await getDoc(aRef);
  if (!aSnap.exists()) throw new Error('duty period not found');
  const a = aSnap.data();
  if (!Number.isFinite(a.dutyOnAt)) {
    throw new Error('The source pilot has no valid duty-on time to sync from.');
  }
  const now = Date.now();
  const adminName = editor?.displayName || editor?.name || 'Admin';
  const mkStamp = (from, to, extra) => ({
    by: adminName,
    at: now,
    field: 'crewPairSync',
    from,
    to,
    note: `${extra} Admin reason: ${reason.slice(0, 400)}`,
  });

  // Resolve B's period: explicit partnerPeriodId, else look up B's open one.
  let bId = partnerPeriodId || null;
  let bSnap = null;
  if (bId) {
    bSnap = await getDoc(doc(db, 'duty-state', bId));
    if (!bSnap.exists()) bSnap = null;
  }
  if ((!bSnap || bSnap.data().status === 'off') && partnerPilot?.uid) {
    // Try B's current open period by uid before creating a new one.
    const existing = await getLatestDuty(partnerPilot.uid);
    if (existing && existing.status === 'on' && existing.id) {
      bId = existing.id;
      bSnap = await getDoc(doc(db, 'duty-state', bId));
    }
  }

  let createdPartner = false;

  if (bSnap && bSnap.data().status === 'on') {
    // B already on duty — align B's duty-on to A's and link.
    const b = bSnap.data();
    const bRef = doc(db, 'duty-state', bId);
    const bEdits = Array.isArray(b.adminEdits) ? b.adminEdits : [];
    const patch = {
      dutyOnAt: a.dutyOnAt,
      linkedPeriodId: periodDocId,
      linkPending: false,
      updatedAt: now,
      adminEdits: [...bEdits, mkStamp(b.dutyOnAt || null, a.dutyOnAt,
        `Duty-on aligned to paired crew (period ${periodDocId}).`)],
    };
    if (b.dutyOffAt) patch.over14 = (b.dutyOffAt - a.dutyOnAt) > DUTY_MAX_MS;
    await updateDoc(bRef, patch);
  } else {
    // B has no open period — create one matching A's duty-on time.
    if (!partnerPilot?.uid) {
      throw new Error('Partner pilot identity required to start their duty period.');
    }
    bId = periodId(partnerPilot.uid, a.dutyOnAt);
    const record = {
      id: bId,
      pilotUid: partnerPilot.uid,
      pilotName: partnerPilot.name || partnerPilot.displayName || 'Unknown',
      role: 'SIC',
      sicUid: null,
      sicName: null,
      dutyOnAt: a.dutyOnAt,
      fboArrivalAt: a.dutyOnAt,
      dutyOffAt: null,
      restUntil: null,
      over14: false,
      over14ReasonPic: '',
      over14ReasonSic: '',
      restOverride: null,
      status: 'on',
      linkedPeriodId: periodDocId,
      linkPending: false,
      adminEdits: [mkStamp(null, a.dutyOnAt,
        `Duty period created by admin to match paired crew (period ${periodDocId}); duty-on set to paired crew's start.`)],
      createdAt: now,
      updatedAt: now,
    };
    await setDoc(doc(db, 'duty-state', bId), record);
    createdPartner = true;
  }

  // Link A -> B (audit on A too).
  const aEdits = Array.isArray(a.adminEdits) ? a.adminEdits : [];
  await updateDoc(aRef, {
    linkedPeriodId: bId,
    linkPending: false,
    updatedAt: now,
    adminEdits: [...aEdits, mkStamp(a.linkedPeriodId || null, bId,
      `Paired with crew period ${bId}${createdPartner ? ' (partner duty period created)' : ' (partner duty-on aligned)'}.`)],
  });

  return { paired: true, createdPartner, alignedTo: a.dutyOnAt };
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
